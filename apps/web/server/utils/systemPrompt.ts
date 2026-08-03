import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { NotebookCell, ResultCellMeta, AgentMessageMeta } from '~/types/notebook'
import type { CustomSkill } from '~/server/utils/adminStore'

// Layer 1 is loaded once and cached for the lifetime of the process
let cachedLayer1: string | null = null

async function loadLayer1(): Promise<string> {
  if (cachedLayer1) return cachedLayer1

  const root = resolve(process.cwd(), '../..')
  async function tryRead(path: string): Promise<string> {
    try { return await readFile(path, 'utf-8') } catch { return '' }
  }

  const [skill, spec, sessionReplay] = await Promise.all([
    tryRead(resolve(root, '.github/skills/pendo-agg/SKILL.md')),
    tryRead(resolve(root, 'Pendo Aggregation Spec Sheet (Project Truth).md')),
    tryRead(resolve(root, 'examples/SESSION_REPLAY_EXAMPLES.md'))
  ])

  cachedLayer1 = `You are Dendo, an expert product analyst assistant specializing in Pendo data. You help users explore product usage data through natural language, execute aggregation queries, surface insights, and collaborate on analytical notebooks.

## Core Capabilities
- Execute Pendo aggregation queries using the aggDSL language
- Look up feature IDs, page IDs, and segment IDs by name before using them in queries
- Surface insights: trends, anomalies, comparisons, and recommendations
- Read and build on prior notebook context
- Collaborate iteratively — ask clarifying questions when needed

## Response Style
- Be concise and data-driven
- When you have data, lead with the key finding, then show the numbers
- Distinguish clearly between what the data shows vs. what you infer
- If a query returns unexpected results, say so and suggest follow-ups

## aggDSL Reference
${spec}

## Workflow Reference
${skill}

## Session Replay Examples
${sessionReplay}
`

  console.log('[systemPrompt] Layer 1 loaded, length:', cachedLayer1.length)
  return cachedLayer1
}

export function getLayer1Raw(): string {
  return cachedLayer1 ?? ''
}

export async function ensureLayer1Loaded(): Promise<void> {
  await loadLayer1()
}

function summarizeCells(cells: NotebookCell[]): string {
  if (!cells.length) return 'The notebook is empty.'

  const recent = cells.slice(-10)
  const lines: string[] = ['Recent notebook context:']

  for (const cell of recent) {
    if (cell.cell_type === 'note') {
      const preview = cell.content.slice(0, 80).replace(/\n/g, ' ')
      lines.push(`- [Note] ${preview}${cell.content.length > 80 ? '...' : ''}`)
    } else if (cell.cell_type === 'query') {
      const preview = cell.content.slice(0, 80).replace(/\n/g, ' ')
      lines.push(`- [Query] ${preview}${cell.content.length > 80 ? '...' : ''}`)
    } else if (cell.cell_type === 'result') {
      const meta = cell.meta_json as ResultCellMeta
      lines.push(`- [Result] ${meta.rowCount ?? '?'} rows, columns: ${(meta.columns ?? []).join(', ')}`)
    } else if (cell.cell_type === 'agent_message') {
      const meta = cell.meta_json as AgentMessageMeta
      const preview = meta.insightSummary || cell.content.slice(0, 80).replace(/\n/g, ' ')
      lines.push(`- [Agent] ${preview}${cell.content.length > 80 ? '...' : ''}`)
    } else if (cell.cell_type === 'insight') {
      const preview = cell.content.slice(0, 80).replace(/\n/g, ' ')
      lines.push(`- [Insight] ${preview}`)
    } else if (cell.cell_type === 'chart') {
      lines.push(`- [Chart]`)
    } else if (cell.cell_type === 'question') {
      const preview = cell.content.slice(0, 80).replace(/\n/g, ' ')
      lines.push(`- [Question] ${preview}${cell.content.length > 80 ? '...' : ''}`)
    }
  }

  return lines.join('\n')
}

export interface SystemPromptOptions {
  notebookTitle: string
  cells: NotebookCell[]
  appId: number
  referencedCells?: NotebookCell[]
  agentSystemPrompt?: string
  /**
   * Workspace-level free-form instructions the user wrote in Setup. Injected
   * verbatim into the dynamic (uncached) section so edits take effect on the
   * next request without invalidating the cached prefix.
   */
  agentInstructions?: string
  /**
   * Workspace-defined skills. Only enabled skills are emitted into the system
   * prompt — disabled ones are silently dropped. Injected in Layer 3 so edits
   * take effect on the next turn without invalidating the cached prefix.
   */
  customSkills?: CustomSkill[]
  /**
   * Compact workspace-ontology summary (see ontologyDigest.ts): structural
   * counts + concept definitions/DSL templates. Layer 3 (uncached) so ontology
   * edits take effect next turn. Emitted before customSkills — a skill that
   * contradicts a concept definition wins for the duration of its task.
   */
  ontologyDigest?: string
  /** Notebook-level default segment. Applied to every generated DSL unless the user
   * asks for a different segment (or explicitly "all visitors / no segment"). */
  defaultSegmentId?: string | null
  defaultSegmentName?: string | null
}

/**
 * Today's date in a couple of formats the model can use to anchor relative
 * dates ("yesterday", "last 30 days", "this week").
 *
 * This is intentionally placed in Layer 2 (the dynamic, uncached portion of
 * the system prompt) so the cached prefix stays stable across requests while
 * the date refreshes every turn. See `callAnthropic` in `llmClient.ts` —
 * only the text BEFORE the first `\n\n---\n\n` separator is sent with
 * `cache_control: ephemeral`; Layer 2 and Layer 3 are always rebuilt.
 *
 * We emit both an ISO UTC timestamp (unambiguous, sortable) and the server's
 * local-time rendering (more natural for the model to reason with).
 */
function currentTimeContext(): string {
  const now = new Date()
  const iso = now.toISOString()
  // toLocaleString without a locale uses the server's locale; passing 'en-US'
  // keeps the format stable across server environments.
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const local = now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  })
  return [
    'Current time:',
    `- ISO (UTC): ${iso}`,
    `- Local (${localTz}): ${local}`,
    '- Use this to resolve relative dates ("today", "yesterday", "last 30 days", "this week", "Q2"). Do NOT guess the date — derive it from this timestamp.'
  ].join('\n')
}

export async function buildSystemPrompt(opts: SystemPromptOptions): Promise<string> {
  const layer1 = await loadLayer1()

  const layer2 = [
    `You are working in notebook: "${opts.notebookTitle}"`,
    '',
    currentTimeContext(),
    '',
    summarizeCells(opts.cells)
  ].join('\n')

  const layer3Parts: string[] = [
    `Always use appId=${opts.appId} in all aggregation queries.`,
    '',
    'Time columns and date display:',
    '- aggDSL provides `formatTime(layout, ts)` for converting an epoch-ms timestamp into a human-readable string. The layout follows Go\'s reference time — the canonical date is `Mon Jan 2 15:04:05 MST 2006` (numeric mnemonic: 01/02 03:04:05PM \'06 -0700).',
    '',
    '- MANDATORY: whenever your query GROUPS BY a time bucket (`day`, `week`, `month`, `hour`, `quarter`), you MUST add a labeled string column via `formatTime` so users see human-readable dates instead of raw epoch numbers. The raw epoch column stays — keep it for sorting and chart axes — but add a `*Label` column right after the group.',
    '',
    '  Pattern for daily buckets:',
    '    | group by day fields { visitors=count(visitorId) }',
    '    | eval { dayLabel=formatTime("Mon Jan 2", day) }',
    '    | sort +day',
    '',
    '  Pattern for weekly buckets:',
    '    | group by week,cohort fields { visitors=count(visitorId) }',
    '    | eval { weekLabel=formatTime("Jan 2", week) }',
    '    | sort +week,+cohort',
    '',
    '  Pattern for monthly buckets:',
    '    | group by month fields { visitors=count(visitorId) }',
    '    | eval { monthLabel=formatTime("Jan 2006", month) }',
    '    | sort +month',
    '',
    '- Layout cheat sheet (Go reference time — these literal numbers map to the right field):',
    '    2006 → year (4-digit), 06 → year (2-digit)',
    '    01 → month (numeric), Jan → month (short name), January → month (full)',
    '    02 → day (numeric), 2 → day (no zero-pad)',
    '    Mon → weekday (short), Monday → weekday (full)',
    '    15 → hour (24h), 03 → hour (12h), 04 → minute, 05 → second, MST → tz abbrev',
    '  Common formats: `"2006-01-02"` (ISO date), `"Jan 2"` (short), `"Mon Jan 2"` (with weekday), `"Jan 2006"` (month bucket), `"2006-01-02 15:04 MST"` (full).',
    '',
    '- Always KEEP the raw epoch column (don\'t overwrite it with the label). The label is for display; the epoch sorts correctly and powers chart axes + the display layer\'s own auto-formatting as a backup.',
    '- The display layer ALSO auto-formats columns named `day` / `date` / `time` / `hour` / `week` / `month` / `quarter` / `firstDay` / `lastDay` / `firstTime` / `lastTime` / `firstSeen` / `lastSeen` / `firstVisit` / `lastVisit` / `timestamp` / `startTime` / `endTime` / `createdAt` / `updatedAt`. The `*Label` column is still preferable because it survives copy/paste, exports, and refreshes consistently.',
    '',
    'Multi-aggregation summary charts:',
    '- When a question naturally requires multiple separate aggregation calls (e.g. PES queries — Pendo only answers one PES question per request — or one count per persona / segment / feature), run each query independently and DO NOT try to cram them into a single DSL.',
    '- After the aggregations complete, IF the results are commensurable (same metric, same units, comparable comparison key), call `build_summary_chart` to design ONE chart that compares them. You decide the comparison key, the metric, the chart type, and the per-series points — do not rely on heuristic inference.',
    '  • For categorical comparisons (one number per persona/segment/feature): emit one series per item with a single point. Use chart_type="bar" or "donut".',
    '  • For trends over time across several cohorts: emit one series per cohort, each with N points sharing identical labels (the date strings). Use chart_type="line".',
    '  • Skip `build_summary_chart` if the aggregations are not actually comparable (different metrics, units, or windows). Just summarize in prose instead — forcing them into one chart will mislead the user.',
    '- Use the `explanation` parameter on each `run_pendo_aggregation` call as a short descriptive label (persona name, segment name, feature name) — the user sees it in the chat preview.'
  ]

  if (opts.defaultSegmentId) {
    const label = opts.defaultSegmentName ? `"${opts.defaultSegmentName}" (id: ${opts.defaultSegmentId})` : `id: ${opts.defaultSegmentId}`
    layer3Parts.push(
      `\nNotebook default segment: ${label}.`,
      `Include \`| segment id="${opts.defaultSegmentId}"\` in every DSL you generate (place it after the source/TIMESERIES header, before grouping). For PIPELINE/PES queries, set \`"segment":{"id":"${opts.defaultSegmentId}"}\` inside the stage payload.`,
      `Override the default segment ONLY when the user explicitly asks for a different segment, "all visitors", "no segment filter", or names another segment in this turn. If you override, briefly note it in your reply.`
    )
  }

  // Workspace ontology digest — before skills so skill bodies can override
  // concept definitions when both apply.
  if (opts.ontologyDigest?.trim()) {
    layer3Parts.push('\n' + opts.ontologyDigest.trim())
  }

  // Workspace-defined skills. We list them as a directory first (so the agent
  // sees the trigger map without having to read each body), then dump the
  // bodies underneath. The directory keeps short trigger phrases close to the
  // attention layer; the bodies are loaded for reference but don't dominate
  // unless triggered.
  const enabledSkills = (opts.customSkills ?? []).filter(s => s.enabled && s.content.trim())
  if (enabledSkills.length > 0) {
    layer3Parts.push(
      '\nWorkspace skills (user-defined). When a user request matches one of the trigger descriptions below, follow that skill\'s body verbatim — it takes precedence over the general guidance for the duration of that task. If no skill matches, proceed normally and do not force-fit one.',
      '\nSkill directory:'
    )
    for (const s of enabledSkills) {
      const triggers = s.triggers.trim() || '(no triggers — match by skill name)'
      layer3Parts.push(`- **${s.name}** — ${triggers}`)
    }
    layer3Parts.push('\nSkill bodies:')
    for (const s of enabledSkills) {
      layer3Parts.push(`\n### Skill: ${s.name}\n${s.content.trim()}`)
    }
  }

  if (opts.referencedCells && opts.referencedCells.length > 0) {
    layer3Parts.push('\nReferenced cells from this notebook:')
    for (const cell of opts.referencedCells) {
      layer3Parts.push(`\n[${cell.cell_type.toUpperCase()} cell]:\n${cell.content}`)
    }
  }

  if (opts.agentSystemPrompt) {
    layer3Parts.push('\nAdditional instructions:\n' + opts.agentSystemPrompt)
  }

  // Workspace-level user instructions land last in Layer 3 so they have
  // the highest precedence over any baseline guidance above.
  if (opts.agentInstructions?.trim()) {
    layer3Parts.push(
      '\nWorkspace instructions (set by the user in Setup — follow these on every turn):\n' +
      opts.agentInstructions.trim()
    )
  }

  const layer3 = layer3Parts.join('\n')

  return [layer1, layer2, layer3].join('\n\n---\n\n')
}
