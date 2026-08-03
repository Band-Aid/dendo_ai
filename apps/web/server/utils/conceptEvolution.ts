import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { callLlm } from '~/server/utils/llmClient'
import { readOntology, upsertConcept } from '~/server/utils/ontologyStore'
import { extractJson } from '~/server/utils/conceptMapping'
import type { ProviderConfig } from '~/server/utils/adminStore'
import type { OntologyConcept } from '~/types/ontology'

/**
 * Concept self-maintenance: after an agent answers a question with live Pendo
 * data, enrich the EXISTING concepts that question touched — additive only
 * (new measures / causes / actions), never touching names, definitions,
 * templates, or anything already on the concept. NEW concepts stay a human
 * decision (the Suggest drawer); this module only keeps approved ones current.
 *
 * Selective by design — the ontology's value is precision, so:
 *  - no LLM call at all unless a concept deterministically matches the
 *    exchange (name/measure mention, or the ask's origin node);
 *  - the model is told that adding NOTHING is the usual right answer;
 *  - additions are deduped, clamped, and validated against real node ids.
 */

export interface ExchangeAggregation {
  dsl: string
  explanation?: string
  columns: string[]
  rows: Record<string, unknown>[]
}

export interface ConceptEvolutionUpdate {
  conceptId: string
  name: string
  addedMeasures: number
  addedCauses: number
  addedActions: number
}

const MAX_CANDIDATE_CONCEPTS = 3
const MAX_MEASURE_CANDIDATES = 30

const evolutionSchema = z.object({
  updates: z.array(z.object({
    conceptId: z.string(),
    addMeasures: z.array(z.string()).default([]).transform(a => a.slice(0, 5)),
    addCauses: z.array(z.object({
      text: z.string().min(1).max(500),
      questionTemplate: z.string().max(500).optional()
    })).default([]).transform(a => a.slice(0, 2)),
    addActions: z.array(z.object({
      title: z.string().min(1).max(200),
      description: z.string().max(1000).optional(),
      questionTemplate: z.string().max(500).optional()
    })).default([]).transform(a => a.slice(0, 2))
  })).default([]).transform(a => a.slice(0, MAX_CANDIDATE_CONCEPTS))
})

const norm = (s: string) => s.trim().toLowerCase()

/** Paraphrase-tolerant duplicate test: exact or substring either way. */
function isDuplicate(candidate: string, existing: string[]): boolean {
  const c = norm(candidate)
  return existing.some(e => {
    const x = norm(e)
    return x === c || x.includes(c) || c.includes(x)
  })
}

export async function evolveConcepts(opts: {
  orgId: string
  provider: ProviderConfig
  model: string
  question: string
  answer: string
  aggregations?: ExchangeAggregation[]
  /** Map node the question was launched from (ask panel). */
  originNodeId?: string
}): Promise<ConceptEvolutionUpdate[]> {
  const blob = readOntology(opts.orgId)
  if (blob.concepts.length === 0) return []

  const text = `${opts.question}\n${opts.answer}`.toLowerCase()
  const nodeById = new Map(blob.structural.nodes.map(n => [n.id, n]))

  // Deterministic candidate gate — origin-linked concepts first, then name
  // mentions, then measured-entity mentions. No match → no LLM call.
  const candidates: OntologyConcept[] = []
  const pick = (c: OntologyConcept) => {
    if (!candidates.includes(c) && candidates.length < MAX_CANDIDATE_CONCEPTS) candidates.push(c)
  }
  if (opts.originNodeId) {
    for (const c of blob.concepts) {
      if (c.id === opts.originNodeId || c.measures.includes(opts.originNodeId)) pick(c)
    }
  }
  for (const c of blob.concepts) {
    if (c.name.length >= 3 && text.includes(c.name.toLowerCase())) pick(c)
  }
  for (const c of blob.concepts) {
    if (c.measures.some(id => {
      const n = nodeById.get(id)
      return n && n.name.length >= 4 && text.includes(n.name.toLowerCase())
    })) pick(c)
  }
  if (candidates.length === 0) return []

  // Entities the model may link as new measures: only ones this exchange
  // actually names, so a hallucinated link is impossible. Single-word names
  // ("Guides", "Features") match the prose of almost any answer — those only
  // qualify when the USER's question names them; multi-word names appearing
  // anywhere in the exchange are near-always genuine.
  const questionText = opts.question.toLowerCase()
  const measureCandidates = blob.structural.nodes
    .filter(n => {
      if (n.kind === 'productArea' || n.name.length < 4) return false
      const name = n.name.toLowerCase()
      if (!text.includes(name)) return false
      return name.trim().includes(' ') || questionText.includes(name)
    })
    .slice(0, MAX_MEASURE_CANDIDATES)

  const aggLines = (opts.aggregations ?? []).slice(0, 4).map((a, i) => {
    const sample = JSON.stringify(a.rows.slice(0, 3)).slice(0, 400)
    return `${i + 1}. ${a.explanation || 'query'} — columns [${a.columns.join(', ')}], sample rows: ${sample}`
  })

  const conceptBlock = JSON.stringify(candidates.map(c => ({
    conceptId: c.id,
    name: c.name,
    definition: c.definition.slice(0, 500),
    measures: c.measures.map(id => nodeById.get(id)?.name ?? id),
    causes: c.causes.map(x => x.text).filter(Boolean),
    actions: c.actions.map(x => x.title)
  })), null, 1)

  const prompt = `You maintain the EXISTING concepts of a product-analytics ontology over Pendo data. A question was just asked and answered with live data. Decide whether any candidate concept below should be enriched.

## The exchange
Question: ${opts.question.slice(0, 1000)}
Answer: ${opts.answer.slice(0, 3000)}
${aggLines.length ? `Data pulled:\n${aggLines.join('\n')}` : ''}

## Candidate concepts (their FULL current state — never re-add or paraphrase anything already listed)
${conceptBlock}

## Entities you may add as new measures (EXACT ids; only these)
${measureCandidates.map(n => `${n.id} — ${n.name} (${n.kind})`).join('\n') || '(none — addMeasures must stay empty)'}

## Rules
- ADDITIVE ONLY. Never modify names, definitions, or existing items.
- Every addition must be grounded in THIS exchange: a cause hypothesis the answer's data supports (state the concrete numbers in the text), an action the findings motivate, or an entity the exchange shows the concept is measured by.
- Adding NOTHING is the correct answer for most exchanges — an ordinary lookup teaches the ontology nothing. Only add durable knowledge the workspace will reuse.
- If an existing cause or action already covers the same theme or recommendation — even with different wording or newer numbers — do NOT add another. Few strong items beat many overlapping ones.
- questionTemplate is the follow-up question to ask next time ({conceptName}, {entityName} placeholders allowed).

Respond with EXACTLY this JSON, nothing else:
{"updates":[{"conceptId":"...","addMeasures":[],"addCauses":[{"text":"...","questionTemplate":"..."}],"addActions":[{"title":"...","description":"...","questionTemplate":"..."}]}]}
If nothing should change: {"updates":[]}`

  const res = await callLlm({
    provider: opts.provider,
    model: opts.model,
    systemPrompt: 'You maintain an analytics ontology. You respond with valid JSON only — no markdown, no commentary.',
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    maxTokens: 1500,
    onTextDelta: () => {}
  })

  const parsed = evolutionSchema.safeParse(extractJson(res.textContent))
  if (!parsed.success) {
    console.error('[conceptEvolution] response rejected:', parsed.error.message.slice(0, 200))
    return []
  }

  const results: ConceptEvolutionUpdate[] = []
  const validNodeIds = new Set(blob.structural.nodes.map(n => n.id))
  const newId = () => randomUUID()

  for (const u of parsed.data.updates) {
    // Re-read per apply: upsertConcept writes the whole blob, so each update
    // must merge into the freshest concept state.
    const fresh = readOntology(opts.orgId)
    const concept = fresh.concepts.find(c => c.id === u.conceptId)
    if (!concept) continue

    const measures = u.addMeasures.filter(id =>
      validNodeIds.has(id) &&
      measureCandidates.some(n => n.id === id) &&
      !concept.measures.includes(id)
    ).slice(0, Math.max(0, 20 - concept.measures.length))

    const causes = u.addCauses
      .filter(c => !isDuplicate(c.text, concept.causes.map(x => x.text ?? '')))
      .slice(0, Math.max(0, 10 - concept.causes.length))
    const actions = u.addActions
      .filter(a => !isDuplicate(a.title, concept.actions.map(x => x.title)))
      .slice(0, Math.max(0, 10 - concept.actions.length))

    if (measures.length + causes.length + actions.length === 0) continue

    upsertConcept(opts.orgId, {
      id: concept.id,
      name: concept.name,
      definition: concept.definition,
      dslTemplate: concept.dslTemplate,
      kpiColumn: concept.kpiColumn,
      measures: [...concept.measures, ...measures],
      causes: [
        ...concept.causes,
        ...causes.map(c => ({ id: newId(), text: c.text, questionTemplate: c.questionTemplate ?? '' }))
      ],
      actions: [
        ...concept.actions,
        ...actions.map(a => ({ id: newId(), title: a.title, description: a.description ?? '', questionTemplate: a.questionTemplate ?? '' }))
      ],
      source: concept.source
    })

    results.push({
      conceptId: concept.id,
      name: concept.name,
      addedMeasures: measures.length,
      addedCauses: causes.length,
      addedActions: actions.length
    })
  }

  if (results.length) {
    console.log('[conceptEvolution]', results.map(r =>
      `"${r.name}" +${r.addedMeasures}m/+${r.addedCauses}c/+${r.addedActions}a`
    ).join(', '))
  }
  return results
}
