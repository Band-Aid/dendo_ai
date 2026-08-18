/**
 * Workspace ontology — a lightweight typed graph over the org's Pendo data.
 *
 * Three layers:
 *  1. STRUCTURAL (auto-synced from Pendo, never hand-edited): product areas,
 *     features, pages, segments + `belongs_to` edges. Re-syncable at any time.
 *  2. SEMANTIC (human/agent-authored "concepts"): business definitions with an
 *     optional canonical aggDSL template, links to the entities they measure,
 *     and cause/action playbooks that turn a metric into next questions.
 *  3. OVERLAY (computed, cached separately): live usage metrics painted onto
 *     the graph. Never stored inside the ontology blob.
 *
 * Deliberately NOT RDF/OWL — a typed JSON graph is enough for grounding the
 * agent and rendering the product map, and it stays maintainable.
 */

export type OntologyEntityKind = 'productArea' | 'feature' | 'page' | 'segment'
export type OntologyNodeKind = OntologyEntityKind | 'concept'

/**
 * Structural node. `id` is prefixed and stable across syncs so concept
 * references survive re-sync: `feature:<pendoId>`, `page:<id>`,
 * `area:<groupId>`, `segment:<id>`.
 */
export interface OntologyEntityNode {
  id: string
  kind: OntologyEntityKind
  pendoId: string
  name: string
  appId?: number
  /** Pages only. */
  url?: string
  /** Segments only. */
  description?: string
  /** Features only — raw Pendo group id backing the `belongs_to` edge. */
  groupId?: string
}

export type OntologyEdgeType = 'belongs_to' | 'measures' | 'causes'

export interface OntologyEdge {
  from: string
  to: string
  type: OntologyEdgeType
}

/** A hypothesis for why a concept's metric moves — and the question to ask. */
export interface ConceptCause {
  id: string
  /** Typed link to another concept, when the cause is itself modeled. */
  conceptId?: string
  /** Free-text hypothesis when no concept exists yet. */
  text?: string
  /** Question template; `{conceptName}` / `{entityName}` placeholders. */
  questionTemplate?: string
}

/** A playbook step to take when the concept's metric warrants action. */
export interface ConceptAction {
  id: string
  title: string
  description?: string
  questionTemplate?: string
}

export interface OntologyConcept {
  id: string
  name: string
  /** Prose business definition — the "meaning" the workspace agreed on. */
  definition: string
  /** Canonical aggDSL for measuring this concept. The agent prefers this over
   *  re-deriving a query when the user asks about the concept. */
  dslTemplate?: string
  /** Result column to headline as the KPI — overrides the extraction
   *  heuristic when the template returns several numeric columns. */
  kpiColumn?: string
  /** Structural node ids this concept measures. */
  measures: string[]
  causes: ConceptCause[]
  actions: ConceptAction[]
  source: 'manual' | 'suggested'
  createdAt: string
  updatedAt: string
}

export interface OntologyStructural {
  nodes: OntologyEntityNode[]
  /** `belongs_to` edges only — `measures`/`causes` edges are derived from
   *  concepts at read time so sync can never clobber them. */
  edges: OntologyEdge[]
  syncedAt: string | null
  /** True when a sync hit the per-entity caps. */
  truncated: boolean
  counts: { productAreas: number; features: number; pages: number; segments: number }
  /**
   * The appId sync actually used. Normally the configured defaultAppId; when
   * that id matches nothing Pendo returned, sync falls back to the dominant
   * appId found in the data (rather than silently producing an empty map) and
   * records the mismatch below. The usage overlay uses this id too.
   */
  effectiveAppId?: number
  /** Set when the configured defaultAppId matched no fetched entities. */
  appIdMismatch?: { configured: number; found: number[] }
}

export interface OntologyBlob {
  version: 1
  structural: OntologyStructural
  concepts: OntologyConcept[]
}

/**
 * The window an overlay was computed over, as inclusive `YYYY-MM-DD` calendar
 * days. Stored alongside the numbers because the window is user-chosen: a
 * cached blob is only reusable for the range that produced it, and every label
 * has to say which window the number belongs to.
 */
export interface OverlayWindow {
  from: string
  to: string
  /** Inclusive day count — what the DSL asked Pendo for. */
  days: number
  /**
   * True when this came from the rolling default ("last N complete days")
   * rather than a range the user pinned. The dates are then a *description* of
   * what Pendo returned, not the cache key — matching them exactly would miss
   * the cache every time the server's date and the subscription's date differ.
   */
  relative?: boolean
  /**
   * True when the window runs up to Pendo's current day, whose bucket is still
   * filling. The numbers are real but not final, and comparing a part-day
   * against whole days reads as a collapse — so the UI has to say so, and the
   * cache must not treat the result as settled.
   */
  partial?: boolean
}

/** Computed usage overlay, cached under its own kv key with a TTL. */
export interface OverlayMetrics {
  fetchedAt: string
  /**
   * Window these counts cover. The fields below are deliberately NOT named
   * `events30d` any more — the range is configurable, so a fixed name in the
   * data would misdescribe every non-default window.
   */
  window: OverlayWindow
  /** Keyed by structural node id (`feature:...` / `page:...`). */
  metrics: Record<string, { events: number; visitors: number }>
  /** Per-source failures — a half-populated overlay is still useful. */
  errors?: { features?: string; pages?: string }
}

/** Wire shape of GET /api/ontology — graph with derived edges + meta. */
export interface OntologyGraphResponse {
  nodes: Array<OntologyEntityNode | { id: string; kind: 'concept'; name: string }>
  edges: OntologyEdge[]
  concepts: OntologyConcept[]
  meta: {
    syncedAt: string | null
    truncated: boolean
    counts: OntologyStructural['counts']
    conceptCount: number
    danglingMeasures: number
    pendoConfigured: boolean
    appIdMismatch?: { configured: number; found: number[] }
  }
}

/** Live KPI computed for one concept — from its dslTemplate, or a canonical
 *  usage query derived from its measures. Cached like the usage overlay. */
export interface ConceptMetric {
  value: number
  /** What `value` is — encodes the extraction heuristic honestly, e.g.
   *  "events (latest)" or "Σ visitors (12 rows)". */
  label: string
  series?: Array<{ date: string; value: number }>
  /** Fractional change vs the previous window (0.12 = +12%). */
  delta?: number
  source: 'template' | 'measures'
  /** Per-concept degradation — an errored concept is still a cached result. */
  error?: string
}

/** Cached per-concept KPIs, kv key `org:<id>:ontology_concept_metrics`. */
export interface ConceptMetricsBlob {
  fetchedAt: string
  metrics: Record<string, ConceptMetric>
}

/** One LLM-drafted concept proposal from POST /api/ontology/suggest. */
export interface ConceptProposal {
  name: string
  definition: string
  dslTemplate?: string
  kpiColumn?: string
  measures: string[]
  causes: Array<{ text: string; questionTemplate?: string }>
  actions: Array<{ title: string; description?: string; questionTemplate?: string }>
  /** Which mined questions/messages motivated this proposal. */
  evidence: string[]
}
