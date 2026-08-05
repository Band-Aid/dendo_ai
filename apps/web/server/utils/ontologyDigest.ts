import { readOntology } from '~/server/utils/ontologyStore'
import type { OntologyConcept, OntologyEntityNode } from '~/types/ontology'

/** Hard cap so the digest can never crowd out the rest of Layer 3. */
const MAX_DIGEST_CHARS = 6000

/** Per-concept lists (measures/causes/actions) are capped for prompt sanity. */
const MAX_ITEMS = 5

/** No cap — used for the origin concept, which must never lose a measure/segment. */
const FULL_ITEMS = Infinity

function conceptBlock(
  concept: OntologyConcept,
  nodeById: Map<string, OntologyEntityNode>,
  itemCap: number = MAX_ITEMS
): string {
  const lines: string[] = [`- **${concept.name}** — ${concept.definition.slice(0, 300)}`]

  if (concept.dslTemplate?.trim()) {
    lines.push('  DSL template:\n  ```\n  ' + concept.dslTemplate.trim().split('\n').join('\n  ') + '\n  ```')
  }

  // pendoIds are usable directly in DSL (featureId=[...] etc.) — emitting
  // them here is what lets the agent skip live lookup round-trips.
  const measures = concept.measures
    .map(id => nodeById.get(id))
    .filter((n): n is OntologyEntityNode => Boolean(n))
  if (measures.length) {
    const shown = measures
      .slice(0, itemCap)
      .map(n => `${n.name} (${n.kind}, pendoId="${n.pendoId}")`)
      .join(', ')
    const more = measures.length > itemCap ? ` (+${measures.length - itemCap} more — lookup_ontology)` : ''
    lines.push(`  Measures: ${shown}${more}`)
  }

  for (const cause of concept.causes.slice(0, itemCap)) {
    const text = cause.text?.trim() || (cause.conceptId ? `linked concept ${cause.conceptId}` : '')
    if (!text) continue
    const ask = cause.questionTemplate?.trim() ? ` → ask: "${cause.questionTemplate.trim()}"` : ''
    lines.push(`  Cause: ${text}${ask}`)
  }
  if (concept.actions.length) {
    lines.push(`  Actions: ${concept.actions.slice(0, itemCap).map(a => a.title).join('; ')}`)
  }

  return lines.join('\n')
}

/**
 * Compact, prompt-ready summary of the workspace ontology. Injected into the
 * UNCACHED Layer 3 of the system prompt (like custom skills), so edits take
 * effect on the next turn. Returns null when there is nothing to say —
 * callers pass `digest ?? undefined` so empty workspaces cost zero tokens.
 *
 * `originConceptId` names the concept a question was asked FROM (a cause,
 * action, or KPI button on the Product map, or a saved question cell created
 * that way). When it matches a concept, that concept's full record — every
 * measure/cause/action, uncapped — is inlined up front with a hard
 * instruction to use it. The origin concept block is not subject to
 * MAX_DIGEST_CHARS (the generic concept list below is still budget-capped).
 * Without this, a cause-derived question got the same generic, budget-capped digest as any
 * cold question and the agent had to re-search for tags/segments from prose
 */
export function buildOntologyDigest(orgId: string, originConceptId?: string): string | null {
  const blob = readOntology(orgId)
  const { structural, concepts } = blob
  const hasStructure = structural.nodes.length > 0
  if (!hasStructure && concepts.length === 0) return null

  const originConcept = originConceptId ? concepts.find(c => c.id === originConceptId) : undefined
  const nodeById = new Map(structural.nodes.map(n => [n.id, n]))

  const parts: string[] = ['## Workspace product map (ontology)']

  if (originConcept) {
    parts.push(
      '',
      `### This question was asked directly from the "${originConcept.name}" concept`,
      `The user triggered this from a cause, action, or KPI on the "${originConcept.name}" concept in the Product map — it is the subject of the question below, not just a related definition. Use ITS definition, DSL template, and measures right here; they are already resolved to Pendo ids. Do NOT call lookup_ontology / lookup_pendo_segments / lookup_pendo_features / lookup_pendo_pages to re-derive which tags/segments/features this concept cares about — they are already listed below, in full (uncapped). Only fall back to those tools for something this question needs beyond this concept's own measures.`,
      conceptBlock(originConcept, nodeById, FULL_ITEMS)
    )
  }

  if (hasStructure) {
    const c = structural.counts
    // Top product areas by feature count — orientation, not exhaustive listing.
    const areaCounts = new Map<string, { name: string; n: number }>()
    for (const node of structural.nodes) {
      if (node.kind === 'productArea') areaCounts.set(node.id, { name: node.name, n: 0 })
    }
    for (const edge of structural.edges) {
      if (edge.type === 'belongs_to') {
        const area = areaCounts.get(edge.to)
        if (area) area.n++
      }
    }
    const topAreas = [...areaCounts.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 10)
      .map(a => `${a.name} (${a.n})`)
      .join(', ')

    parts.push(
      `Structural: ${c.productAreas} product areas, ${c.features} features, ${c.pages} pages, ${c.segments} segments.` +
        (topAreas ? ` Top areas by feature count: ${topAreas}.` : '')
    )
  }

  // Usage guidance for the agent — lives inside the digest (not the static
  // prompt) so workspaces without an ontology pay zero tokens for it.
  const usage = [
    '### How to use this map',
    '- When the question matches a concept by name or meaning, START from its DSL template — adapt only the time window / segment / grouping. Do not re-derive the query from scratch.',
    '- pendoIds listed here are valid directly in aggDSL (e.g. featureId filters) — no lookup round-trip needed.',
    `- For entities/concepts not listed here, call lookup_ontology first; fall back to lookup_pendo_features/pages/segments only when it has no match (the ontology sync is capped and point-in-time${structural.syncedAt ? `, last synced ${structural.syncedAt}` : ''}).`
  ].join('\n')

  if (concepts.length === 0) {
    return [...parts, usage].join('\n')
  }

  // The origin concept (if any) was already inlined in full above — don't
  // repeat it in the generic, budget-capped list below.
  const remainingConcepts = concepts.filter(c => c.id !== originConcept?.id)

  if (remainingConcepts.length > 0) {
    parts.push(
      'Concepts (workspace business definitions — when the user asks about one of these by name or meaning, use its definition and prefer its DSL template over deriving a new query):'
    )

    // Whole-concept budgeting: never slice mid-block (the old blind tail-slice
    // could cut inside a DSL code fence). Overflowing concepts are reachable
    // via lookup_ontology instead.
    const fixedLen = parts.join('\n').length + usage.length + 2
    let budget = MAX_DIGEST_CHARS - fixedLen
    let omitted = 0
    for (const concept of remainingConcepts) {
      const block = conceptBlock(concept, nodeById)
      if (block.length + 1 > budget) {
        omitted++
        continue
      }
      parts.push(block)
      budget -= block.length + 1
    }
    if (omitted > 0) {
      parts.push(`(+${omitted} concept(s) omitted — use lookup_ontology to fetch them)`)
    }
  }

  parts.push(usage)
  return parts.join('\n')
}
