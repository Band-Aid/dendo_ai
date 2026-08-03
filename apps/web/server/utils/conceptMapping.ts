import type { OntologyEntityNode } from '~/types/ontology'

/**
 * Concept ↔ entity mapping helpers, shared by the Suggest pipeline and the
 * concept editor's "AI map" (POST /api/ontology/map-entities): the entity
 * catalogue an LLM can pick node ids from, the deterministic phrase-match
 * backfill, and lenient JSON extraction for model output.
 */

/** Generic filler that would over-match hundreds of entities on its own. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'user', 'users', 'account', 'accounts',
  'rate', 'score', 'total', 'count', 'number', 'daily', 'weekly', 'monthly',
  'active', 'usage', 'page', 'pages', 'feature', 'features'
])

const tokenize = (s: string) =>
  s.toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length >= 4 && !STOPWORDS.has(w)) ?? []

/**
 * Node ids whose name contains a meaningful multi-word phrase from the concept
 * name (e.g. "agent mode" from "Agent Mode Retention"). Phrase-only on purpose:
 * matching single tokens like "agent" pulls in 100+ unrelated entities, whereas
 * a 2-word phrase is specific enough to be almost always a true link. A concept
 * with a one-word name simply gets no backfill (the LLM handles those).
 */
export function nameMatchedEntities(
  conceptName: string,
  nodes: Array<{ id: string; kind: string; name: string }>
): string[] {
  const ctoks = tokenize(conceptName)
  if (ctoks.length < 2) return []
  const phrases: string[] = []
  for (let i = 0; i < ctoks.length - 1; i++) phrases.push(`${ctoks[i]} ${ctoks[i + 1]}`)

  const out: string[] = []
  for (const n of nodes) {
    if (n.kind === 'productArea') continue
    const name = n.name.toLowerCase()
    if (phrases.some(ph => name.includes(ph))) out.push(n.id)
  }
  return out
}

/**
 * Entity catalogue for an LLM "measures" pick. The model can only link a
 * concept to entities it can actually SEE, so we give it the whole catalogue
 * (bounded) grouped by product area — a small alphabetical sample left most
 * concepts with no links at all. Features are grouped under their area;
 * ungrouped features, pages and segments follow.
 */
export function buildEntityCatalogue(nodes: OntologyEntityNode[]): string {
  const areaNodes = nodes.filter(n => n.kind === 'productArea')
  const areaName = new Map(areaNodes.map(a => [a.id, a.name]))
  const features = nodes.filter(n => n.kind === 'feature').slice(0, 250)
  const pages = nodes.filter(n => n.kind === 'page').slice(0, 150)
  const segments = nodes.filter(n => n.kind === 'segment').slice(0, 80)

  const featuresByArea = new Map<string, string[]>()
  for (const f of features) {
    const areaId = f.groupId ? `area:${f.groupId}` : '__none__'
    if (!featuresByArea.has(areaId)) featuresByArea.set(areaId, [])
    featuresByArea.get(areaId)!.push(`  ${f.id} — ${f.name}`)
  }
  return [
    ...[...featuresByArea.entries()].map(([areaId, lines]) =>
      `### ${areaId === '__none__' ? 'Features (no product area)' : `Product area: ${areaName.get(areaId) ?? areaId}`}\n${lines.join('\n')}`
    ),
    pages.length ? `### Pages\n${pages.map(p => `  ${p.id} — ${p.name}`).join('\n')}` : '',
    segments.length ? `### Segments\n${segments.map(s => `  ${s.id} — ${s.name}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n')
}

/**
 * Incremental extraction of completed objects from the `"proposals": [...]`
 * array in a streaming LLM response. Feed it raw text deltas; it returns each
 * top-level array object the moment its closing brace arrives — which is what
 * lets the Suggest drawer render card N while the model is still writing N+1.
 * Anything before the array (prose, code fences) is skipped; a truncated
 * final object simply never completes.
 */
export function createProposalStreamParser(): { push(delta: string): unknown[] } {
  let buffer = ''
  let scanned = 0 // index into buffer up to which we've consumed
  let inArray = false
  let depth = 0
  let objStart = -1
  let inString = false
  let escaped = false

  return {
    push(delta: string): unknown[] {
      buffer += delta
      const out: unknown[] = []

      if (!inArray) {
        const m = buffer.match(/"proposals"\s*:\s*\[/)
        if (!m) {
          // Keep a tail in case the marker straddles a chunk boundary.
          if (buffer.length > 4096) {
            buffer = buffer.slice(-64)
          }
          scanned = buffer.length
          return out
        }
        inArray = true
        scanned = m.index! + m[0].length
      }

      for (let i = scanned; i < buffer.length; i++) {
        const ch = buffer[i]
        if (inString) {
          if (escaped) escaped = false
          else if (ch === '\\') escaped = true
          else if (ch === '"') inString = false
          continue
        }
        if (ch === '"') { inString = true; continue }
        if (ch === '{') {
          if (depth === 0) objStart = i
          depth++
        } else if (ch === '}') {
          depth--
          if (depth === 0 && objStart >= 0) {
            try { out.push(JSON.parse(buffer.slice(objStart, i + 1))) } catch { /* skip malformed */ }
            objStart = -1
          }
        } else if (ch === ']' && depth === 0) {
          // Array closed — ignore everything after.
          scanned = buffer.length
          return out
        }
      }
      scanned = buffer.length
      return out
    }
  }
}

/** Lenient JSON extraction from LLM output (raw / fenced / brace-bounded). */
export function extractJson(text: string): unknown {
  try { return JSON.parse(text.trim()) } catch { /* try fenced / braced */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()) } catch { /* fall through */ }
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch { /* give up */ }
  }
  return null
}
