import { z } from 'zod'
import { getDb } from '~/server/db/client'
import { readAdminState } from '~/server/utils/adminStore'
import { compileDsl } from '~/server/utils/aggregation'
import { callLlm } from '~/server/utils/llmClient'
import { buildMeasuresKpiDsl } from '~/server/utils/conceptKpi'
import { buildEntityCatalogue, createProposalStreamParser, nameMatchedEntities } from '~/server/utils/conceptMapping'
import { readOntology, readOverlay } from '~/server/utils/ontologyStore'
import { ontologySuggestSchema } from '~/server/utils/schemas'
import type { ConceptProposal, OntologyBlob } from '~/types/ontology'

/**
 * LLM-drafted concept proposals, STREAMED over SSE — each proposal is
 * emitted the moment its JSON object completes in the model output (a
 * `proposal` event), then enriched in place when its auto-drafted DSL
 * compiles (a `proposal_update` event). Waiting for the whole 8000-token
 * response made the drawer feel dead for ~45s; streaming shows the first
 * card in the time it takes the model to write ONE proposal.
 *
 * Two evidence sources:
 *  - 'conversations': what the workspace actually asks (saved question cells
 *    + recent user chat messages);
 *  - 'ontology': the product map itself — usage overlay (hot features/pages),
 *    product-area rollups, and concept COVERAGE GAPS (high-usage entities no
 *    concept measures yet).
 * Proposals are for human review — this endpoint NEVER persists anything.
 * Accepting one goes through the normal concepts POST with source:
 * 'suggested'.
 */

function emit(event: any, data: object) {
  event.node.res.write(`data: ${JSON.stringify(data)}\n\n`)
}

// List caps CLAMP rather than reject — an over-enthusiastic model returning
// 21 measures shouldn't void the whole proposal (it did, silently).
const proposalSchema = z.object({
  name: z.string().min(1).max(120),
  definition: z.string().min(1).max(4000),
  dslTemplate: z.string().max(4000).optional(),
  kpiColumn: z.string().max(120).optional(),
  measures: z.array(z.string()).default([]).transform(a => a.slice(0, 20)),
  causes: z.array(z.object({
    text: z.string().min(1).max(500),
    questionTemplate: z.string().max(500).optional()
  })).default([]).transform(a => a.slice(0, 10)),
  actions: z.array(z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    questionTemplate: z.string().max(500).optional()
  })).default([]).transform(a => a.slice(0, 10)),
  evidence: z.array(z.string().max(300)).default([]).transform(a => a.slice(0, 10))
})

function mineCorpus(orgId: string): { questions: string[]; chat: string[] } {
  const db = getDb()
  // notebook_chat_messages has no org column — both queries must join through
  // workspaces for tenant isolation.
  const questionRows = db.prepare(
    `SELECT c.content FROM notebook_cells c
     JOIN workspaces w ON w.id = c.workspace_id
     WHERE w.org_id = ? AND c.cell_type = 'question' AND TRIM(c.content) != ''
     ORDER BY c.updated_at DESC LIMIT 100`
  ).all(orgId) as Array<{ content: string }>
  const chatRows = db.prepare(
    `SELECT m.content FROM notebook_chat_messages m
     JOIN workspaces w ON w.id = m.notebook_id
     WHERE w.org_id = ? AND m.role = 'user' AND TRIM(m.content) != ''
     ORDER BY m.created_at DESC LIMIT 100`
  ).all(orgId) as Array<{ content: string }>
  return {
    questions: questionRows.map(r => r.content.trim()),
    chat: chatRows.map(r => r.content.trim())
  }
}

/**
 * Evidence mined from the map itself: 30d usage leaders, product-area
 * rollups, and — the strongest concept signal — high-usage entities that NO
 * existing concept measures. Works without the overlay (structure-only),
 * just with a weaker data story.
 */
function mineOntology(orgId: string, ontology: OntologyBlob): string {
  const nodes = ontology.structural.nodes
  const overlay = readOverlay(orgId)
  const usage = overlay?.metrics ?? {}
  const nodeName = new Map(nodes.map(n => [n.id, n.name]))
  const areaName = new Map(
    nodes.filter(n => n.kind === 'productArea').map(n => [n.pendoId, n.name])
  )
  const covered = new Set(ontology.concepts.flatMap(c => c.measures))

  const withUsage = Object.entries(usage)
    .filter(([id]) => nodeName.has(id))
    .sort((a, b) => b[1].events30d - a[1].events30d)

  const line = ([id, m]: (typeof withUsage)[number]) => {
    const n = nodes.find(x => x.id === id)!
    const area = n.kind === 'feature' && n.groupId ? areaName.get(n.groupId) : undefined
    return `- ${n.name} (${n.kind}${area ? `, area: ${area}` : ''}) — ${m.events30d.toLocaleString()} events / ${m.visitors30d.toLocaleString()} visitors (30d)${covered.has(id) ? ' [already measured by a concept]' : ''}`
  }

  const top = withUsage.slice(0, 20).map(line)
  const uncoveredHot = withUsage.filter(([id]) => !covered.has(id)).slice(0, 15).map(line)

  // Area rollup: feature count + summed 30d events.
  const areaStats = new Map<string, { name: string; features: number; events: number }>()
  for (const n of nodes) {
    if (n.kind !== 'feature' || !n.groupId) continue
    const key = n.groupId
    if (!areaStats.has(key)) areaStats.set(key, { name: areaName.get(key) ?? key, features: 0, events: 0 })
    const s = areaStats.get(key)!
    s.features++
    s.events += usage[n.id]?.events30d ?? 0
  }
  const areas = [...areaStats.values()]
    .sort((a, b) => b.events - a.events)
    .slice(0, 12)
    .map(a => `- ${a.name}: ${a.features} features, ${a.events.toLocaleString()} events (30d)`)

  const segments = nodes.filter(n => n.kind === 'segment').slice(0, 25).map(s => `- ${s.name}`)

  return [
    overlay
      ? `Usage leaders (30d, from the live overlay):\n${top.join('\n') || '(no usage data)'}`
      : 'Usage overlay unavailable — reason from structure only.',
    uncoveredHot.length
      ? `HIGH-USAGE ENTITIES NOT MEASURED BY ANY CONCEPT (the coverage gaps — strongest candidates):\n${uncoveredHot.join('\n')}`
      : '',
    areas.length ? `Product areas by activity:\n${areas.join('\n')}` : '',
    segments.length ? `Workspace segments (audiences the team already carved out):\n${segments.join('\n')}` : ''
  ].filter(Boolean).join('\n\n')
}

export default defineEventHandler(async (event) => {
  const orgId = (event.context.orgId as string) || 'default'
  const body = await readBody(event).catch(() => ({}))
  const { maxSuggestions, source } = ontologySuggestSchema.parse(body ?? {})

  const state = await readAdminState(orgId)
  const agent = state.agents.filter(a => a.enabled)[0]
  if (!agent) {
    throw createError({ statusCode: 400, message: 'No agents configured. Please configure an agent in Admin.' })
  }
  const provider = state.providers.find(p => p.provider === agent.provider && p.enabled)
  if (!provider?.apiKey) {
    throw createError({ statusCode: 400, message: `Provider "${agent.provider}" not configured or API key missing.` })
  }

  const ontology = readOntology(orgId)
  const existingNames = ontology.concepts.map(c => c.name)
  const nodes = ontology.structural.nodes
  const entityCatalogue = buildEntityCatalogue(nodes)

  let evidenceSection: string
  let groundingInstruction: string
  let questions: string[] = []
  let chat: string[] = []

  if (source === 'ontology') {
    if (nodes.length === 0) {
      throw createError({ statusCode: 400, message: 'The ontology is empty — sync from Pendo first.' })
    }
    evidenceSection = `## What the product map and usage data show (mined evidence)
${mineOntology(orgId, ontology)}`
    groundingInstruction =
      'grounded in the product structure and usage data above: concepts that capture what the usage leaders mean for the business (adoption, engagement depth, retention of hot areas), close the coverage gaps (high-usage entities no concept measures yet), or turn existing segments into measurable definitions (put the motivating observations in "evidence")'
  } else {
    const corpus = mineCorpus(orgId)
    questions = corpus.questions
    chat = corpus.chat
    if (questions.length === 0 && chat.length === 0) {
      throw createError({
        statusCode: 400,
        message: 'Nothing to mine yet — save a few question cells or ask the agent some questions first.'
      })
    }
    evidenceSection = `## What this workspace actually asks (mined evidence)
Saved re-runnable questions:
${questions.slice(0, 60).map(q => `- ${q.slice(0, 200)}`).join('\n') || '(none)'}

Recent chat questions:
${chat.slice(0, 40).map(q => `- ${q.slice(0, 200)}`).join('\n') || '(none)'}`
    groundingInstruction = 'grounded in the mined questions (put the motivating questions in "evidence")'
  }

  const prompt = `You are drafting BUSINESS CONCEPTS for a product-analytics workspace ontology over Pendo data. A concept is a named business definition (e.g. "Activation", "Power account", "Onboarding completion") with: a precise prose definition, optionally a canonical Pendo aggDSL query, links to the product entities it measures, likely causes when its metric moves (each with a follow-up question), and playbook actions (each with a follow-up question).

${evidenceSection}

## Existing concepts (do NOT duplicate these)
${existingNames.length ? existingNames.map(n => `- ${n}`).join('\n') : '(none yet)'}

## Product entity catalogue (for the "measures" field — use these EXACT node ids)
${entityCatalogue || '(not synced yet — leave measures empty)'}

## Instructions
Propose up to ${maxSuggestions} concepts this workspace clearly cares about, ${groundingInstruction}. Only include a dslTemplate if you are confident in aggDSL syntax; otherwise omit it — one will be synthesized from the measures. When you do write one, prefer a daily timeseries (TIMESERIES period=dayRange + group by day) so the concept gets a live trend, and set "kpiColumn" to the result column that should headline as the KPI.

CRITICAL: every concept MUST link to the product entities it measures via "measures" — a concept with an empty "measures" is useless when a relevant entity exists. Pick the 5-15 HIGHEST-SIGNAL entities per concept (obvious name matches are backfilled automatically, so favor precision). Use ONLY exact node ids from the catalogue above. Keep the response compact — it must be complete, valid JSON.

Generate the proposals ONE AT A TIME — complete each proposal object fully before starting the next.

Respond with EXACTLY this JSON and nothing else:
{"proposals": [{"name": "...", "definition": "...", "dslTemplate": "...", "kpiColumn": "...", "measures": ["feature:..."], "causes": [{"text": "...", "questionTemplate": "..."}], "actions": [{"title": "...", "description": "...", "questionTemplate": "..."}], "evidence": ["..."]}]}`

  // ---- Stream side: everything below emits SSE (validation errors above
  // still return normal 4xx because headers aren't flushed yet). ------------
  setResponseHeader(event, 'Content-Type', 'text/event-stream')
  setResponseHeader(event, 'Cache-Control', 'no-cache')
  setResponseHeader(event, 'Connection', 'keep-alive')
  event.node.res.flushHeaders?.()

  const validNodeIds = new Set(ontology.structural.nodes.map(n => n.id))
  const existingByName = new Set(ontology.concepts.map(c => c.name.trim().toLowerCase()))
  const appId = ontology.structural.effectiveAppId ?? state.pendo?.defaultAppId

  /** Validate → dedupe → filter hallucinated ids → backfill → overlap flag. */
  function processProposal(raw: unknown): ConceptProposal | null {
    const result = proposalSchema.safeParse(raw)
    if (!result.success) {
      console.error('[suggest] proposal rejected:', result.error.message.slice(0, 200))
      return null
    }
    const p = result.data
    // Server-side enforcement of "do NOT duplicate" — the prompt asks, but
    // models re-propose anyway and accepting one would silently overwrite
    // nothing (concepts are keyed by id) while cluttering the list.
    if (existingByName.has(p.name.trim().toLowerCase())) return null
    // Drop hallucinated entity references rather than rejecting the proposal.
    p.measures = p.measures.filter(id => validNodeIds.has(id))
    // Deterministic backfill: link entities whose name clearly relates to the
    // concept, so a concept is never left floating with no objects tied to it.
    const linked = new Set(p.measures)
    for (const id of nameMatchedEntities(p.name, nodes)) {
      if (!linked.has(id)) { linked.add(id); p.measures.push(id) }
    }
    p.measures = p.measures.slice(0, 20)
    // Near-duplicate by coverage: same entities as an existing concept is
    // worth a human look, not a silent drop.
    for (const existing of ontology.concepts) {
      if (!existing.measures.length || !p.measures.length) continue
      const overlap = p.measures.filter(id => existing.measures.includes(id)).length
      if (overlap / p.measures.length > 0.8) {
        p.evidence.push(`Note: measures overlap heavily with existing concept "${existing.name}" — possible duplicate.`)
        break
      }
    }
    return p as ConceptProposal
  }

  /** Auto-draft a canonical daily-usage template so the accepted concept gets
   *  a live KPI — emitted as an in-place card update when it compiles. */
  async function autoDraft(p: ConceptProposal, index: number): Promise<void> {
    if (p.dslTemplate?.trim() || p.measures.length === 0) return
    const dsl = buildMeasuresKpiDsl(p.measures, ontology.structural.nodes, appId ?? undefined)
    if (!dsl) return
    try {
      const compiled = await compileDsl(dsl)
      if (compiled.success) {
        emit(event, { type: 'proposal_update', index, dslTemplate: dsl, kpiColumn: p.kpiColumn ?? 'events' })
      }
    } catch { /* leave the card without a template */ }
  }

  const parser = createProposalStreamParser()
  const pending: Promise<void>[] = []
  let emitted = 0

  try {
    const res = await callLlm({
      provider,
      model: agent.model,
      systemPrompt: 'You draft ontology concepts for product analytics. You respond with valid JSON only — no markdown, no commentary.',
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      // Proposals are long (measure id lists × causes × actions × evidence) —
      // an undersized budget truncates the JSON mid-array and yields nothing.
      maxTokens: Math.max(state.settings?.maxTokens ?? 4096, 8000),
      onTextDelta: (delta) => {
        for (const raw of parser.push(delta)) {
          if (emitted >= maxSuggestions) break
          const proposal = processProposal(raw)
          if (!proposal) continue
          const index = emitted++
          emit(event, { type: 'proposal', index, proposal })
          pending.push(autoDraft(proposal, index))
        }
      }
    })

    if (emitted === 0) {
      console.error('[suggest] no proposals extracted | raw tail:', res.textContent.slice(-300))
    }
    await Promise.allSettled(pending)
    emit(event, {
      type: 'done',
      count: emitted,
      ...(emitted === 0 ? { note: 'The model returned no usable proposals — try again or add more questions first.' } : {})
    })
  } catch (err: any) {
    await Promise.allSettled(pending)
    emit(event, { type: 'error', message: err.message || 'Suggestion failed' })
  }
  event.node.res.end()
})
