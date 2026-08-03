import { randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { dbGetJson, dbSetJson } from '../db/client'
import type {
  ConceptMetricsBlob,
  OntologyBlob,
  OntologyConcept,
  OntologyEdge,
  OntologyEntityKind,
  OverlayMetrics
} from '~/types/ontology'

const MAX_CONCEPTS = 50
const MAX_BLOB_BYTES = 500_000

export const ontologyKey = (orgId: string) => `org:${orgId}:ontology`
export const overlayKey = (orgId: string) => `org:${orgId}:ontology_overlay`
export const conceptMetricsKey = (orgId: string) => `org:${orgId}:ontology_concept_metrics`

export function emptyOntology(): OntologyBlob {
  return {
    version: 1,
    structural: {
      nodes: [],
      edges: [],
      syncedAt: null,
      truncated: false,
      counts: { productAreas: 0, features: 0, pages: 0, segments: 0 }
    },
    concepts: []
  }
}

/**
 * Read the org's ontology, defaults-merged so older/partial blobs never
 * surface undefined sections (same posture as readAdminState).
 */
export function readOntology(orgId: string): OntologyBlob {
  const raw = dbGetJson<OntologyBlob | null>(ontologyKey(orgId), null)
  if (!raw) return emptyOntology()
  const empty = emptyOntology()
  return {
    version: 1,
    structural: {
      nodes: raw.structural?.nodes ?? empty.structural.nodes,
      edges: raw.structural?.edges ?? empty.structural.edges,
      syncedAt: raw.structural?.syncedAt ?? null,
      truncated: raw.structural?.truncated ?? false,
      counts: raw.structural?.counts ?? empty.structural.counts,
      effectiveAppId: raw.structural?.effectiveAppId,
      appIdMismatch: raw.structural?.appIdMismatch
    },
    concepts: raw.concepts ?? []
  }
}

export function writeOntology(orgId: string, blob: OntologyBlob): void {
  if (JSON.stringify(blob).length > MAX_BLOB_BYTES) {
    throw createError({ statusCode: 413, message: `Ontology exceeds the ${Math.round(MAX_BLOB_BYTES / 1000)}KB limit` })
  }
  dbSetJson(ontologyKey(orgId), blob)
}

/** Prefixed structural node id — the single derivation both sync and the live
 *  entity search/registration paths share, so references always line up. */
export function entityNodeId(kind: OntologyEntityKind, pendoId: string): string {
  return `${kind === 'productArea' ? 'area' : kind}:${pendoId}`
}

export interface EntityRegistration {
  kind: OntologyEntityKind
  pendoId: string
  name: string
  appId?: number
  url?: string
  description?: string
  groupId?: string
  /** Features only — names the derived product-area node. */
  groupName?: string
}

/**
 * Add live-searched Pendo entities to the structural layer (the sync caps mean
 * the cache never holds everything). Idempotent per id; a feature's product
 * area + `belongs_to` edge come along with it. Synchronous read-modify-write.
 */
export function registerEntities(orgId: string, entities: EntityRegistration[]): number {
  if (entities.length === 0) return 0
  const blob = readOntology(orgId)
  const ids = new Set(blob.structural.nodes.map(n => n.id))
  const edgeKeys = new Set(blob.structural.edges.map(e => `${e.from}|${e.to}|${e.type}`))
  let added = 0

  for (const { groupName, ...entity } of entities) {
    const id = entityNodeId(entity.kind, entity.pendoId)
    if (!ids.has(id)) {
      blob.structural.nodes.push({ id, ...entity })
      ids.add(id)
      added++
    }
    if (entity.kind === 'feature' && entity.groupId) {
      const areaId = entityNodeId('productArea', entity.groupId)
      if (!ids.has(areaId)) {
        blob.structural.nodes.push({
          id: areaId,
          kind: 'productArea',
          pendoId: entity.groupId,
          name: groupName ?? entity.groupId
        })
        ids.add(areaId)
        added++
      }
      const edgeKey = `${id}|${areaId}|belongs_to`
      if (!edgeKeys.has(edgeKey)) {
        blob.structural.edges.push({ from: id, to: areaId, type: 'belongs_to' })
        edgeKeys.add(edgeKey)
      }
    }
  }

  if (added === 0) return 0
  const byKind = (kind: OntologyEntityKind) =>
    blob.structural.nodes.filter(n => n.kind === kind).length
  blob.structural.counts = {
    productAreas: byKind('productArea'),
    features: byKind('feature'),
    pages: byKind('page'),
    segments: byKind('segment')
  }
  writeOntology(orgId, blob)
  return added
}

/**
 * Insert or update one concept. Synchronous read-modify-write (node:sqlite is
 * sync) so there is no await window for a concurrent writer to race into.
 */
export function upsertConcept(
  orgId: string,
  input: Omit<OntologyConcept, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
): OntologyConcept {
  const blob = readOntology(orgId)
  const now = new Date().toISOString()
  const existing = input.id ? blob.concepts.find(c => c.id === input.id) : undefined

  if (!existing && blob.concepts.length >= MAX_CONCEPTS) {
    throw createError({ statusCode: 409, message: `Concept limit reached (${MAX_CONCEPTS}). Delete one to add another.` })
  }

  const concept: OntologyConcept = {
    id: existing?.id ?? input.id ?? randomUUID(),
    name: input.name,
    definition: input.definition,
    dslTemplate: input.dslTemplate,
    kpiColumn: input.kpiColumn,
    measures: input.measures,
    causes: input.causes,
    actions: input.actions,
    source: input.source,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }

  const idx = blob.concepts.findIndex(c => c.id === concept.id)
  if (idx >= 0) blob.concepts[idx] = concept
  else blob.concepts.push(concept)

  writeOntology(orgId, blob)
  invalidateConceptMetric(orgId, concept.id)
  return concept
}

/** Delete a concept and scrub links to it from other concepts' causes. */
export function deleteConcept(orgId: string, conceptId: string): boolean {
  const blob = readOntology(orgId)
  const before = blob.concepts.length
  blob.concepts = blob.concepts.filter(c => c.id !== conceptId)
  if (blob.concepts.length === before) return false
  for (const c of blob.concepts) {
    c.causes = c.causes.map(cause =>
      cause.conceptId === conceptId ? { ...cause, conceptId: undefined } : cause
    )
  }
  writeOntology(orgId, blob)
  invalidateConceptMetric(orgId, conceptId)
  return true
}

/**
 * Derive the full graph: structural nodes + concept nodes, structural
 * `belongs_to` edges + `measures`/`causes` edges computed from concepts.
 * Edges whose endpoint no longer exists (feature deleted upstream, concept
 * removed) are dropped here — never persisted away, since a re-sync may bring
 * the entity back.
 */
export function buildGraph(blob: OntologyBlob): {
  nodes: Array<{ id: string; kind: string; name: string; [k: string]: unknown }>
  edges: OntologyEdge[]
  danglingMeasures: number
} {
  const nodes: Array<{ id: string; kind: string; name: string; [k: string]: unknown }> =
    blob.structural.nodes.map(n => ({ ...n }))
  for (const c of blob.concepts) {
    nodes.push({ id: c.id, kind: 'concept', name: c.name })
  }

  const nodeIds = new Set(nodes.map(n => n.id))
  const edges: OntologyEdge[] = []
  let danglingMeasures = 0

  for (const e of blob.structural.edges) {
    if (nodeIds.has(e.from) && nodeIds.has(e.to)) edges.push(e)
  }
  for (const c of blob.concepts) {
    for (const target of c.measures) {
      if (nodeIds.has(target)) edges.push({ from: c.id, to: target, type: 'measures' })
      else danglingMeasures++
    }
    for (const cause of c.causes) {
      if (cause.conceptId && nodeIds.has(cause.conceptId)) {
        edges.push({ from: cause.conceptId, to: c.id, type: 'causes' })
      }
    }
  }

  return { nodes, edges, danglingMeasures }
}

// --- Overlay cache ------------------------------------------------------------

export function readOverlay(orgId: string): OverlayMetrics | null {
  return dbGetJson<OverlayMetrics | null>(overlayKey(orgId), null)
}

export function writeOverlay(orgId: string, overlay: OverlayMetrics): void {
  dbSetJson(overlayKey(orgId), overlay)
}

// --- Concept metrics cache ------------------------------------------------------

export function readConceptMetrics(orgId: string): ConceptMetricsBlob | null {
  return dbGetJson<ConceptMetricsBlob | null>(conceptMetricsKey(orgId), null)
}

export function writeConceptMetrics(orgId: string, blob: ConceptMetricsBlob): void {
  dbSetJson(conceptMetricsKey(orgId), blob)
}

/**
 * Drop one concept's cached KPI after an edit/delete so a changed template or
 * measure set never serves a stale number for the rest of the TTL. The other
 * concepts' entries stay warm.
 */
function invalidateConceptMetric(orgId: string, conceptId: string): void {
  const cached = readConceptMetrics(orgId)
  if (!cached || !(conceptId in cached.metrics)) return
  const { [conceptId]: _dropped, ...rest } = cached.metrics
  writeConceptMetrics(orgId, { ...cached, metrics: rest })
}
