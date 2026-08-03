import { z } from 'zod'
import { readAdminState } from '~/server/utils/adminStore'
import { compileDsl } from '~/server/utils/aggregation'
import { callLlm } from '~/server/utils/llmClient'
import { buildMeasuresKpiDsl } from '~/server/utils/conceptKpi'
import { buildEntityCatalogue, extractJson, nameMatchedEntities } from '~/server/utils/conceptMapping'
import { readOntology } from '~/server/utils/ontologyStore'

const schema = z.object({
  name: z.string().min(1).max(200),
  definition: z.string().max(4000).default('')
})

/** What the LLM may draft. List caps CLAMP rather than reject — an
 *  over-enthusiastic model returning 31 measures shouldn't void the draft. */
const draftSchema = z.object({
  measures: z.array(z.string()).default([]).transform(a => a.slice(0, 30)),
  kpiColumn: z.string().max(120).optional(),
  causes: z.array(z.object({
    text: z.string().min(1).max(500),
    questionTemplate: z.string().max(500).optional()
  })).default([]).transform(a => a.slice(0, 10)),
  actions: z.array(z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    questionTemplate: z.string().max(500).optional()
  })).default([]).transform(a => a.slice(0, 10))
})

const MAX_MEASURES = 20

/**
 * AI-draft a concept from its problem statement (name + definition) — the
 * concept editor's "Map with AI" button. Returns the measured entities
 * (LLM semantic pick over the full catalogue, unioned with the deterministic
 * phrase backfill as a floor), plus a drafted KPI (kpiColumn + compile-gated
 * canonical dslTemplate), likely causes, and playbook actions. Nothing is
 * persisted — the editor merges results into blank fields for the user to
 * prune before saving. Works without a configured agent (phrase tier only).
 */
export default defineEventHandler(async (event) => {
  const orgId = (event.context.orgId as string) || 'default'
  let input: z.infer<typeof schema>
  try {
    input = schema.parse(await readBody(event))
  } catch (err: any) {
    throw createError({ statusCode: 400, message: err.message })
  }

  const ontology = readOntology(orgId)
  const nodes = ontology.structural.nodes
  if (nodes.length === 0) {
    throw createError({ statusCode: 400, message: 'The ontology is empty — sync from Pendo first.' })
  }

  const validNodeIds = new Set(nodes.map(n => n.id))
  const statement = `${input.name}\n${input.definition}`.trim()
  const measures = new Set<string>(nameMatchedEntities(statement, nodes))

  const state = await readAdminState(orgId)
  const agent = state.agents.filter(a => a.enabled)[0]
  const provider = agent
    ? state.providers.find(p => p.provider === agent.provider && p.enabled)
    : undefined

  let llmUsed = false
  let kpiColumn: string | undefined
  let causes: z.infer<typeof draftSchema>['causes'] = []
  let actions: z.infer<typeof draftSchema>['actions'] = []

  if (agent && provider?.apiKey) {
    const prompt = `A product-analytics workspace is defining a BUSINESS CONCEPT over Pendo data. Draft its skeleton from the problem statement: the product entities it measures, the KPI to headline, likely causes when the metric moves, and playbook actions.

## Concept (problem statement)
Name: ${input.name}
Definition: ${input.definition || '(none provided)'}

## Product entity catalogue (use these EXACT node ids for "measures")
${buildEntityCatalogue(nodes)}

## Instructions
- "measures": every feature, page or segment from the catalogue this concept plausibly measures — match on MEANING, not just literal words (e.g. "onboarding retention" links onboarding flows, welcome/setup features, and retention-relevant segments). Prefer precision over recall past ~15 entities. Use ONLY exact node ids from the catalogue.
- "kpiColumn": which result column should headline as the KPI — "events" or "visitors" for usage-style concepts ("visitors" when the concept is about people/adoption/retention, "events" when it is about activity volume).
- "causes": 2-4 plausible hypotheses for why this concept's metric would move, each with a "questionTemplate" — a concrete data question to investigate it ({conceptName} and {entityName} placeholders allowed).
- "actions": 2-3 playbook steps the team would take when the metric warrants action, each with a "questionTemplate" for the data that would justify it.
- Write causes/actions in the same language as the problem statement. Keep each text/questionTemplate under 200 characters — the whole response must stay compact valid JSON.

Respond with EXACTLY this JSON and nothing else:
{"measures": ["feature:..."], "kpiColumn": "visitors", "causes": [{"text": "...", "questionTemplate": "..."}], "actions": [{"title": "...", "description": "...", "questionTemplate": "..."}]}`

    try {
      const res = await callLlm({
        provider,
        model: agent.model,
        systemPrompt: 'You draft ontology concepts for product analytics. You respond with valid JSON only — no markdown, no commentary.',
        messages: [{ role: 'user', content: prompt }],
        tools: [],
        // Verbose drafts (20 measures + causes/actions with question
        // templates) overflow small budgets and truncate the JSON mid-stream.
        maxTokens: Math.max(state.settings?.maxTokens ?? 4096, 4000),
        onTextDelta: () => {}
      })
      const parsed = draftSchema.safeParse(extractJson(res.textContent))
      if (parsed.success) {
        llmUsed = true
        for (const id of parsed.data.measures) {
          if (validNodeIds.has(id)) measures.add(id)
        }
        kpiColumn = parsed.data.kpiColumn
        causes = parsed.data.causes
        actions = parsed.data.actions
      } else {
        console.error('[map-entities] draft parse failed:', parsed.error.message.slice(0, 200), '| raw tail:', res.textContent.slice(-200))
      }
    } catch (err: any) {
      // LLM failure degrades to the phrase tier — never blocks the editor.
      console.error('[map-entities] LLM call failed:', err.message)
    }
  }

  const pickedMeasures = [...measures].slice(0, MAX_MEASURES)

  // Compile-gated canonical template so the concept gets a live KPI on save.
  let dslTemplate: string | undefined
  if (pickedMeasures.length > 0) {
    const appId = ontology.structural.effectiveAppId ?? state.pendo?.defaultAppId
    const dsl = buildMeasuresKpiDsl(pickedMeasures, nodes, appId ?? undefined)
    if (dsl) {
      try {
        const compiled = await compileDsl(dsl)
        if (compiled.success) {
          dslTemplate = dsl
          kpiColumn = kpiColumn ?? 'events'
        }
      } catch { /* leave dslTemplate undefined */ }
    }
  }

  const nodeById = new Map(nodes.map(n => [n.id, n]))
  return {
    measures: pickedMeasures.map(id => {
      const n = nodeById.get(id)!
      return { id, name: n.name, kind: n.kind }
    }),
    kpiColumn,
    dslTemplate,
    causes,
    actions,
    llmUsed
  }
})
