/**
 * Shared node-kind palette for the product map.
 *
 * The graph's legend colours and the list view's kind dots have to agree —
 * a feature that reads as olive on the map must read as olive in the list, or
 * switching views costs the user their bearings. Kept in one place so they
 * can't drift apart.
 */
export const ONTOLOGY_KINDS = ['productArea', 'feature', 'page', 'trackEvent', 'segment', 'concept'] as const

export type OntologyKind = (typeof ONTOLOGY_KINDS)[number]

export const KIND_COLORS = ['#A8412B', '#C98A46', '#7A8B5E', '#5E7A8B', '#427A6B', '#6B5E8B'] as const

export const KIND_INDEX: Record<string, number> = Object.fromEntries(
  ONTOLOGY_KINDS.map((k, i) => [k, i])
)

/** Falls back to the "feature" colour for anything unrecognised. */
export function kindColor(kind: string): string {
  return KIND_COLORS[KIND_INDEX[kind] ?? 1]
}
