import { z } from 'zod'

export const providerSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'azure_openai']),
  enabled: z.boolean().default(true),
  apiKey: z.string().optional(),
  endpoint: z.string().optional(),
  apiVersion: z.string().optional(),
  deployment: z.string().optional()
})

export const agentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  purpose: z.string().default('General purpose agent'),
  systemPrompt: z.string().default('You are a helpful AI assistant.'),
  enabledTools: z.array(z.string()).default([]),
  guardrails: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  provider: z.enum(['anthropic', 'openai', 'azure_openai']),
  model: z.string().min(1)
})

export const compileSchema = z.object({
  dsl: z.string().min(1),
  notebookId: z.string().optional()
})

export const runSchema = z.object({
  source: z.string().min(1),
  isDsl: z.boolean().default(true)
})

export const pendoSettingsSchema = z.object({
  integrationKey: z.string().optional(),
  apiEndpoint: z.string().url().optional(),
  defaultAppId: z.number().int().optional()
})

/**
 * Pendo Agent Analytics destination. Empty strings are meaningful here — they
 * are how the form clears a field — so blanks are preserved rather than treated
 * as "unset", unlike the integration key above.
 */
export const pendoAgentSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string().max(200).default(''),
  agentId: z.string().max(200).default(''),
  endpoint: z.union([z.string().url(), z.literal('')]).default(''),
  redact: z.boolean().default(false),
  defaultVisitorId: z.string().max(200).default(''),
  defaultAccountId: z.string().max(200).default('')
}).refine(v => !v.enabled || (v.apiKey.trim() && v.agentId.trim()), {
  message: 'Public App ID and Agent ID are both required to enable tracing'
})

/**
 * A user-defined skill. The agent loads enabled skills into its system prompt
 * (uncached layer) and follows the matching one when the user's request hits
 * its trigger phrases. Skills are workspace-scoped — different teams can keep
 * their own onboarding maturity matrix, QBR template, etc.
 */
export const customSkillSchema = z.object({
  id: z.string().min(1),
  // Short identifier shown to the agent (e.g. "onboarding-maturity"). Keep
  // it slug-shaped so the model can refer to it cleanly in its reasoning.
  name: z.string().min(1).max(60),
  // Natural-language description of WHEN to use the skill. The agent matches
  // user requests against this — "オンボーディング成熟度", "QBR template", etc.
  triggers: z.string().max(500).default(''),
  // The skill body. Markdown / system-prompt text. Capped to keep the
  // per-request system prompt under ~100KB even with several skills enabled.
  content: z.string().max(30000).default(''),
  enabled: z.boolean().default(true)
})

export const generalSettingsSchema = z.object({
  maxTokens: z.number().int().min(1).optional(),
  // Capped at 8k chars so a runaway paste can't blow the system prompt budget;
  // realistic instructions fit in a few hundred chars.
  agentInstructions: z.string().max(8000).optional(),
  // Hard-capped at 10 to bound the system-prompt budget. The cap is enforced
  // here so a busted client can't sneak past it.
  customSkills: z.array(customSkillSchema).max(10).optional()
})

// --- Ontology -----------------------------------------------------------------

export const conceptCauseSchema = z.object({
  id: z.string().min(1),
  conceptId: z.string().optional(),
  text: z.string().max(500).optional(),
  questionTemplate: z.string().max(500).optional()
})

export const conceptActionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  questionTemplate: z.string().max(500).optional()
})

/** A live-searched Pendo entity the concept editor picked but the synced map
 *  doesn't hold yet — registered as a structural node on save. */
export const conceptNewEntitySchema = z.object({
  kind: z.enum(['productArea', 'feature', 'page', 'trackEvent', 'segment']),
  pendoId: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  appId: z.number().int().optional(),
  url: z.string().max(2000).optional(),
  description: z.string().max(2000).optional(),
  groupId: z.string().max(200).optional(),
  groupName: z.string().max(300).optional()
})

/**
 * Concept upsert. `id` absent → server generates one. Caps keep the ontology
 * blob (and the agent's prompt digest) bounded.
 */
export const conceptUpsertSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(120),
  definition: z.string().min(1).max(4000),
  dslTemplate: z.string().max(4000).optional(),
  kpiColumn: z.string().max(120).optional(),
  measures: z.array(z.string()).max(20).default([]),
  causes: z.array(conceptCauseSchema).max(10).default([]),
  actions: z.array(conceptActionSchema).max(10).default([]),
  source: z.enum(['manual', 'suggested']).default('manual'),
  newEntities: z.array(conceptNewEntitySchema).max(20).default([])
})

/** `YYYY-MM-DD`, and a real date — `2026-02-31` parses as a Date but isn't one. */
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').refine(s => {
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}, 'not a real calendar date')

export const ontologyOverlaySchema = z.object({
  force: z.boolean().default(false),
  /** Inclusive usage window. Both or neither; omitted means the default 30 days. */
  from: calendarDay.optional(),
  to: calendarDay.optional()
}).refine(v => (v.from == null) === (v.to == null), {
  message: 'from and to must be provided together'
}).refine(v => !v.from || !v.to || v.from <= v.to, {
  message: 'from must not be after to'
})

export const conceptMetricsSchema = z.object({
  force: z.boolean().default(false)
})

export const ontologySuggestSchema = z.object({
  maxSuggestions: z.number().int().min(1).max(10).default(5),
  /** What to mine: past conversations, or the product map itself (structure +
   *  usage overlay + concept coverage gaps). */
  source: z.enum(['conversations', 'ontology']).default('conversations')
})
