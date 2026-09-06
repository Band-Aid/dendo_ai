import type { OntologyEntityNode } from '~/types/ontology'

export interface SuggestionEvidence {
  id: string
  text: string
  /** Exact current entities referenced by saved DSL or explicitly named. */
  measures: string[]
}

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const GENERIC_NAMES = new Set(['page', 'feature', 'click', 'view', 'user', 'users', 'account', 'accounts', 'usage', 'events'])

/** Full tag names only: no substring or shared-token expansion. */
export function explicitlyNamedEntities(text: string, nodes: OntologyEntityNode[]): string[] {
  const haystack = ` ${normalize(text)} `
  return nodes.filter(n => {
    const name = normalize(n.name)
    return n.kind !== 'productArea' && name.length >= 3 && !GENERIC_NAMES.has(name)
      && haystack.includes(` ${name} `)
  }).map(n => n.id)
}

/** Read positive, typed ID references, never arbitrary IDs in result rows. */
export function entitiesUsedInDsl(dsl: string, nodes: OntologyEntityNode[]): string[] {
  const fields: Record<string, string> = {
    featureId: 'feature', pageId: 'page', trackTypeId: 'trackEvent', segmentId: 'segment'
  }
  const ids = new Set<string>()
  const refs = /["']?\b(featureId|pageId|trackTypeId|segmentId)["']?\s*(?:==|=(?!=)|:)\s*["']([^"']+)["']/g
  for (const match of dsl.matchAll(refs)) ids.add(`${fields[match[1]]}:${match[2]}`)
  // PES adoption events use {kind, id}; segments use segment: {id}.
  for (const match of dsl.matchAll(/\{[^{}]*\}/g)) {
    const kind = match[0].match(/["']kind["']\s*:\s*["'](feature|page|trackEvent)["']/)?.[1]
    const id = match[0].match(/["']id["']\s*:\s*["']([^"']+)["']/)?.[1]
    if (kind && id) ids.add(`${kind}:${id}`)
  }
  for (const match of dsl.matchAll(/["']?\bsegment["']?\s*[:=]\s*\{\s*["']?id["']?\s*:\s*["']([^"']+)["']/g)) {
    ids.add(`segment:${match[1]}`)
  }
  return nodes.filter(n => ids.has(n.id) && n.kind !== 'productArea').map(n => n.id)
}

function parseJson(value: string | null): any {
  try { return JSON.parse(value || 'null') } catch { return null }
}

function aggregationDsls(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap(a => typeof a?.dsl === 'string' ? [a.dsl] : [])
    : []
}

/** Keep each question paired with its own queries, within the organization. */
export function mineSuggestionEvidence(db: { prepare(sql: string): any }, orgId: string, nodes: OntologyEntityNode[]): SuggestionEvidence[] {
  const cells = db.prepare(`
    SELECT c.id, c.cell_type, c.content, c.meta_json FROM notebook_cells c
    JOIN workspaces w ON w.id = c.workspace_id
    WHERE w.org_id = ? AND c.cell_type IN ('question', 'query') AND TRIM(c.content) != ''
    ORDER BY c.updated_at DESC, c.id LIMIT 100
  `).all(orgId) as Array<{ id: string; cell_type: string; content: string; meta_json: string | null }>
  const messages = db.prepare(`
    SELECT m.id, m.role, m.content, m.dsl, m.aggregations_json,
      (SELECT u.content FROM notebook_chat_messages u
       WHERE u.notebook_id = m.notebook_id AND u.role = 'user'
         AND (u.created_at < m.created_at OR (u.created_at = m.created_at AND u.rowid < m.rowid))
       ORDER BY u.created_at DESC, u.rowid DESC LIMIT 1) AS question
    FROM notebook_chat_messages m
    JOIN workspaces w ON w.id = m.notebook_id
    WHERE w.org_id = ?
    ORDER BY m.created_at DESC, m.rowid DESC LIMIT 200
  `).all(orgId) as Array<{ id: string; role: string; content: string; dsl: string | null; aggregations_json: string | null; question: string | null }>

  const evidence: SuggestionEvidence[] = []
  const add = (id: string, text: string, dsls: string[]) => {
    if (!text.trim() && !dsls.length) return
    evidence.push({
      id, text: text.trim().slice(0, 1200),
      measures: [...new Set([...dsls.flatMap(dsl => entitiesUsedInDsl(dsl, nodes)), ...explicitlyNamedEntities(text, nodes)])]
    })
  }
  for (const c of cells) {
    const meta = parseJson(c.meta_json)
    if (c.cell_type === 'query') {
      add(`cell:${c.id}`, typeof meta?.title === 'string' ? meta.title : 'Saved query', [c.content])
    } else {
      // Edited questions must not inherit the previous question's tag choices.
      const current = !meta?.lastRunQuestion || meta.lastRunQuestion === c.content
      add(`cell:${c.id}`, c.content, current ? aggregationDsls(meta?.aggregations) : [])
    }
  }
  for (const m of messages) {
    if (m.role === 'user') add(`chat:${m.id}`, m.content, [])
    else {
      const dsls = [...(m.dsl ? [m.dsl] : []), ...aggregationDsls(parseJson(m.aggregations_json))]
      if (dsls.length) add(`chat:${m.id}`, m.question || 'Previous conversation query', dsls)
    }
  }
  return evidence
}

/** Model citations must resolve to real tags in the cited conversation. */
export function selectGroundedMeasures(
  proposed: string[],
  citations: Array<{ id: string; sourceIds: string[] }>,
  evidence: SuggestionEvidence[],
  nodes: OntologyEntityNode[],
  statement: string
): string[] {
  const valid = new Set(nodes.filter(n => n.kind !== 'productArea').map(n => n.id))
  const bySource = new Map(evidence.map(e => [e.id, new Set(e.measures)]))
  const supported = new Set(citations.filter(c => c.sourceIds.some(id => bySource.get(id)?.has(c.id))).map(c => c.id))
  const named = new Set(explicitlyNamedEntities(statement, nodes))
  return [...new Set(proposed)].filter(id => valid.has(id)
    && (supported.has(id) || named.has(id)))
    .sort((a, b) => Number(supported.has(b)) - Number(supported.has(a)))
    .slice(0, 8)
}
