import { readOntology, readConceptMetrics } from '~/server/utils/ontologyStore'
import type { ConceptMetric, OntologyEntityNode } from '~/types/ontology'

/**
 * Ontology-backed lookup for the agent — instant, zero-network resolution of
 * names to pendoIds, product-area membership, and concept detail. Reads
 * `readOntology` (not `buildGraph`: that flattens concepts to bare labels;
 * here we need full concepts plus syncedAt/truncated for the staleness story).
 * The live lookup_pendo_* tools remain the fallback for entities beyond the
 * sync caps or created since the last sync.
 */

const MAX_MATCHES = 20
const MAX_AREA_FEATURES = 50

export type OntologyLookupKind = 'feature' | 'page' | 'segment' | 'productArea' | 'concept'

interface EntityMatch {
  type: 'entity'
  id: string
  kind: string
  name: string
  pendoId: string
  url?: string
  area?: string
  /** Names of concepts measuring this entity. */
  concepts?: string[]
  /** productArea only — members whose pendoIds go straight into DSL. */
  features?: Array<{ name: string; pendoId: string }>
  featureCount?: number
}

interface ConceptMatch {
  type: 'concept'
  id: string
  name: string
  definition: string
  dslTemplate?: string
  kpiColumn?: string
  measures: Array<{ name: string; kind: string; pendoId: string }>
  causes: Array<{ text?: string; questionTemplate?: string; conceptName?: string }>
  actions: Array<{ title: string; description?: string; questionTemplate?: string }>
  /** Cached live KPI, when the concept-metrics cache has one. */
  metric?: ConceptMetric
}

export interface OntologyLookupResult {
  matches: Array<EntityMatch | ConceptMatch>
  syncedAt: string | null
  truncatedSync: boolean
  note?: string
}

export function lookupOntology(
  orgId: string,
  query: string,
  kind?: OntologyLookupKind
): OntologyLookupResult {
  const blob = readOntology(orgId)
  const { structural, concepts } = blob
  const base = {
    syncedAt: structural.syncedAt,
    truncatedSync: structural.truncated
  }

  if (structural.nodes.length === 0 && concepts.length === 0) {
    return {
      matches: [],
      ...base,
      note: 'The ontology is empty (never synced). Use the live lookup_pendo_* tools instead.'
    }
  }

  const q = query.trim().toLowerCase()
  if (!q) return { matches: [], ...base, note: 'Empty query.' }

  const nodeById = new Map(structural.nodes.map(n => [n.id, n]))
  const conceptNameById = new Map(concepts.map(c => [c.id, c.name]))
  const cachedMetrics = readConceptMetrics(orgId)?.metrics
  const areaNameByGroupId = new Map(
    structural.nodes.filter(n => n.kind === 'productArea').map(n => [n.pendoId, n.name])
  )

  const conceptsMeasuring = (nodeId: string) =>
    concepts.filter(c => c.measures.includes(nodeId)).map(c => c.name)

  const areaFeatures = (areaId: string) =>
    structural.nodes.filter(n => n.kind === 'feature' && n.groupId && `area:${n.groupId}` === areaId)

  const toEntityMatch = (n: OntologyEntityNode): EntityMatch => {
    const match: EntityMatch = { type: 'entity', id: n.id, kind: n.kind, name: n.name, pendoId: n.pendoId }
    if (n.url) match.url = n.url
    if (n.kind === 'feature' && n.groupId) match.area = areaNameByGroupId.get(n.groupId)
    const linked = conceptsMeasuring(n.id)
    if (linked.length) match.concepts = linked
    if (n.kind === 'productArea') {
      const members = areaFeatures(n.id)
      match.featureCount = members.length
      match.features = members
        .slice(0, MAX_AREA_FEATURES)
        .map(f => ({ name: f.name, pendoId: f.pendoId }))
    }
    return match
  }

  const toConceptMatch = (c: (typeof concepts)[number]): ConceptMatch => ({
    type: 'concept',
    id: c.id,
    name: c.name,
    definition: c.definition,
    ...(c.dslTemplate ? { dslTemplate: c.dslTemplate } : {}),
    ...(c.kpiColumn ? { kpiColumn: c.kpiColumn } : {}),
    measures: c.measures
      .map(id => nodeById.get(id))
      .filter((n): n is OntologyEntityNode => Boolean(n))
      .map(n => ({ name: n.name, kind: n.kind, pendoId: n.pendoId })),
    causes: c.causes.map(cause => ({
      ...(cause.text ? { text: cause.text } : {}),
      ...(cause.questionTemplate ? { questionTemplate: cause.questionTemplate } : {}),
      ...(cause.conceptId ? { conceptName: conceptNameById.get(cause.conceptId) } : {})
    })),
    actions: c.actions.map(a => ({
      title: a.title,
      ...(a.description ? { description: a.description } : {}),
      ...(a.questionTemplate ? { questionTemplate: a.questionTemplate } : {})
    })),
    ...(cachedMetrics?.[c.id] ? { metric: cachedMetrics[c.id] } : {})
  })

  const matches: Array<EntityMatch | ConceptMatch> = []

  // Concepts first (name, then definition as a secondary tier) — they carry
  // the most context per match.
  if (!kind || kind === 'concept') {
    const byName = concepts.filter(c => c.name.toLowerCase().includes(q))
    const byDef = concepts.filter(
      c => !byName.includes(c) && c.definition.toLowerCase().includes(q)
    )
    for (const c of [...byName, ...byDef]) matches.push(toConceptMatch(c))
  }

  if (kind !== 'concept') {
    for (const n of structural.nodes) {
      if (kind && n.kind !== kind) continue
      if (n.name.toLowerCase().includes(q)) matches.push(toEntityMatch(n))
      if (matches.length >= MAX_MATCHES) break
    }
  }

  const result: OntologyLookupResult = { matches: matches.slice(0, MAX_MATCHES), ...base }
  if (result.matches.length === 0) {
    result.note =
      'No ontology match. The sync is capped and point-in-time — try the live lookup_pendo_features / lookup_pendo_pages / lookup_pendo_segments tools.'
  } else if (structural.truncated) {
    result.note = 'Note: the ontology sync was truncated — entities beyond the cap exist only via the live lookup_pendo_* tools.'
  }
  return result
}
