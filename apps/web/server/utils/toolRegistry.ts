import { compileDsl, runAggregation, enrichWithNames, extractRowsColumns } from '~/server/utils/aggregation'
import { fetchPendoFeatures, fetchPendoPages } from '~/server/utils/pendoEntities'
import { lookupOntology, type OntologyLookupKind } from '~/server/utils/ontologyLookup'
import { readAdminState, writeAdminState } from '~/server/utils/adminStore'
import { loadMcpTools, callMcpTool } from '~/server/utils/mcpClient'
import type { UnifiedTool } from '~/server/utils/llmClient'
import type { McpServerConfig } from '~/types/mcp'

export function buildBuiltInTools(appId: number): UnifiedTool[] {
  return [
    {
      name: 'lookup_ontology',
      description: 'Search the workspace ontology (product map) by name — instant, no network. Returns pendoIds usable directly in aggDSL, product-area membership (a productArea match expands into its member feature ids), and workspace concepts (business definition, canonical DSL template, measured entities with pendoIds, likely causes, playbook actions, current KPI). PREFER this over the lookup_pendo_* tools — use those only when this returns no match (the ontology sync is capped and point-in-time).',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Full or partial name of a feature, page, segment, product area, or concept (case-insensitive). Example: "Agent Mode"'
          },
          kind: {
            type: 'string',
            enum: ['feature', 'page', 'segment', 'productArea', 'concept'],
            description: 'Optional — restrict matches to one kind.'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'lookup_pendo_segments',
      description: 'Look up Pendo segment IDs by name (live Pendo API). CRITICAL: Use this before using a segment name in a query — Pendo requires the segment ID, not the name. Prefer lookup_ontology first; use this as the fallback when it has no match.',
      parameters: {
        type: 'object',
        properties: {
          search_term: {
            type: 'string',
            description: 'Full or partial segment name to search (case-insensitive). Example: "Enterprise users"'
          }
        },
        required: ['search_term']
      }
    },
    {
      name: 'lookup_pendo_features',
      description: 'Look up Pendo feature IDs by feature name (live Pendo API). Fallback for when lookup_ontology has no match — the ontology sync is capped and point-in-time.',
      parameters: {
        type: 'object',
        properties: {
          search_term: {
            type: 'string',
            description: 'Feature name or partial name. Example: "Segment dropdown"'
          }
        },
        required: ['search_term']
      }
    },
    {
      name: 'lookup_pendo_pages',
      description: 'Look up Pendo page IDs by page name (live Pendo API). Fallback for when lookup_ontology has no match.',
      parameters: {
        type: 'object',
        properties: {
          search_term: {
            type: 'string',
            description: 'Page name or partial name.'
          }
        },
        required: ['search_term']
      }
    },
    {
      name: 'run_pendo_aggregation',
      description: `Execute a Pendo aggregation query to retrieve product usage data. Use this whenever you need real data to answer a question. Always use appId=${appId}.`,
      parameters: {
        type: 'object',
        properties: {
          dsl: {
            type: 'string',
            description: `The aggDSL query. Example: FROM event([source=events, appId=${appId}])\\nTIMESERIES period=dayRange first=now() count=-30\\n| group by day fields { visitors=count(visitorId) }`
          },
          explanation: {
            type: 'string',
            description: 'Brief description of what this query answers'
          }
        },
        required: ['dsl', 'explanation']
      }
    },
    {
      name: 'build_summary_chart',
      description: [
        'Build a designed summary chart that combines results from MULTIPLE prior aggregation queries into one visualization.',
        'Use this when a single question required several `run_pendo_aggregation` calls (e.g. one query per persona, segment, or feature — typical for PES which can only answer one question per request).',
        'YOU pick the comparison key and the metric. Read the aggregation results you got back, decide which numbers are commensurable, and emit one series per comparison item.',
        '',
        'Two shapes are supported:',
        '  • Categorical (each series has ONE point): one bar/slice per series. Use for "compare a single number across N personas/features/segments".',
        '  • Time-series (each series has MANY points sharing point labels across series): one line per series. Use for "compare a trend over time across N cohorts".',
        '',
        'Do NOT use this for a single aggregation — use `run_pendo_aggregation` and let the user add it via the chart action. This tool is specifically for combining several into one.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short, specific title for the chart. Example: "30-day MAU by persona"'
          },
          chart_type: {
            type: 'string',
            enum: ['bar', 'line', 'donut'],
            description: 'Preferred chart type. Use "bar" or "donut" for categorical comparisons (one point per series), "line" for time-series.'
          },
          x_axis_label: {
            type: 'string',
            description: 'Label for the categorical or time axis. Example: "Persona", "Date".'
          },
          y_axis_label: {
            type: 'string',
            description: 'Label for the metric axis with units. Example: "Visitors", "Events", "Conversion rate (%)".'
          },
          series: {
            type: 'array',
            description: 'One entry per comparison item (persona, segment, feature, …). All series must use the SAME units. For categorical charts each series has one point; for time-series each series has many points with consistent labels.',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Series label shown in the legend. Example: "Free tier", "Enterprise", "Login button".'
                },
                points: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'X-axis label for this point. For categorical: typically same as series name. For time-series: a date string.' },
                      value: { type: 'number', description: 'Numeric value at this point.' }
                    },
                    required: ['label', 'value']
                  }
                }
              },
              required: ['name', 'points']
            }
          },
          explanation: {
            type: 'string',
            description: 'One-sentence description of what the chart shows, surfaced in the chat preview.'
          }
        },
        required: ['title', 'chart_type', 'series']
      }
    }
  ]
}

export async function buildAllTools(orgId: string): Promise<{
  builtIn: UnifiedTool[]
  mcp: UnifiedTool[]
  mcpConfigs: McpServerConfig[]
}> {
  const state = await readAdminState(orgId)
  const appId = state.pendo?.defaultAppId ?? -323232
  const builtIn = buildBuiltInTools(appId)

  const mcpConfigs = (state.mcpServers ?? []).filter(s => s.enabled)
  let mcpTools: UnifiedTool[] = []
  if (mcpConfigs.length > 0) {
    const loaded = await loadMcpTools(mcpConfigs)
    // loadMcpTools mutates the configs in-place (refreshed OAuth tokens,
    // cachedTools, needsAuth/lastError). Persist so a rotated refresh token
    // isn't lost with the request — losing it would strand auth entirely.
    await writeAdminState(state, orgId)
    mcpTools = loaded.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }))
  }

  return { builtIn, mcp: mcpTools, mcpConfigs }
}

export interface ExecuteToolOptions {
  /** Notebook-level default segment to splice into DSL when the agent's tool call doesn't override it. */
  defaultSegmentId?: string | null
}

// Execute a built-in tool
export async function executeBuiltInTool(
  name: string,
  args: Record<string, unknown>,
  orgId: string,
  sessionId: string,
  opts: ExecuteToolOptions = {}
): Promise<{ result: unknown; error?: string }> {
  if (name === 'lookup_ontology') {
    try {
      const kind = args.kind as OntologyLookupKind | undefined
      return { result: lookupOntology(orgId, String(args.query ?? ''), kind) }
    } catch (err: any) {
      return { result: null, error: err.message }
    }
  }

  if (name === 'lookup_pendo_segments') {
    try {
      const segments = await lookupSegments(String(args.search_term ?? ''), orgId)
      return { result: segments }
    } catch (err: any) {
      return { result: null, error: err.message }
    }
  }

  if (name === 'lookup_pendo_features') {
    try {
      const features = await lookupFeatures(String(args.search_term ?? ''), orgId)
      return { result: features }
    } catch (err: any) {
      return { result: null, error: err.message }
    }
  }

  if (name === 'lookup_pendo_pages') {
    try {
      const pages = await lookupPages(String(args.search_term ?? ''), orgId)
      return { result: pages }
    } catch (err: any) {
      return { result: null, error: err.message }
    }
  }

  if (name === 'run_pendo_aggregation') {
    const dsl = String(args.dsl ?? '')
    try {
      // Compile — apply notebook default segment unless the DSL already specifies one.
      const compiled = await compileDsl(dsl, sessionId, { defaultSegmentId: opts.defaultSegmentId ?? null })
      if (!compiled.success) return { result: null, error: `DSL compile error: ${compiled.error}` }

      // Run aggregation
      const agg = await runAggregation(JSON.stringify(compiled.data), false, sessionId, orgId)
      if (!agg.success) return { result: null, error: `Aggregation error: ${agg.error}` }

      // Enrich with names
      const enriched = await enrichWithNames(agg.data, sessionId, orgId)
      const data = enriched.success ? enriched.data : agg.data

      // Extract rows/columns for structured result
      const structured = extractRowsColumns(data)
      return {
        result: {
          rows: structured.rows,
          columns: structured.columns,
          rowCount: structured.rows.length,
          raw: data,
          dsl
        }
      }
    } catch (err: any) {
      return { result: null, error: err.message }
    }
  }

  if (name === 'build_summary_chart') {
    // Pure data-shape tool — the agent has done the design work and we just
    // validate and echo back a normalized spec. The agent loop picks this up
    // as a "summary chart" result alongside aggregations.
    const validation = validateSummaryChartArgs(args)
    if (!validation.ok) return { result: null, error: validation.error }
    return { result: { summaryChart: validation.spec, message: 'Summary chart spec accepted. The user can add it to their notebook from the chat.' } }
  }

  return { result: null, error: `Unknown tool: ${name}` }
}

interface SummaryChartSpec {
  title: string
  chartType: 'bar' | 'line' | 'donut'
  xAxisLabel?: string
  yAxisLabel?: string
  series: Array<{ name: string; points: Array<{ label: string; value: number }> }>
  explanation?: string
}

function validateSummaryChartArgs(args: Record<string, unknown>):
  | { ok: true; spec: SummaryChartSpec }
  | { ok: false; error: string }
{
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (!title) return { ok: false, error: 'title is required' }

  const chartType = args.chart_type
  if (chartType !== 'bar' && chartType !== 'line' && chartType !== 'donut') {
    return { ok: false, error: 'chart_type must be one of: bar, line, donut' }
  }

  if (!Array.isArray(args.series) || args.series.length === 0) {
    return { ok: false, error: 'series must be a non-empty array' }
  }

  const series: SummaryChartSpec['series'] = []
  for (const [i, raw] of (args.series as any[]).entries()) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: `series[${i}] must be an object` }
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) return { ok: false, error: `series[${i}].name is required` }
    if (!Array.isArray(raw.points) || raw.points.length === 0) {
      return { ok: false, error: `series[${i}].points must be a non-empty array` }
    }
    const points: SummaryChartSpec['series'][number]['points'] = []
    for (const [j, p] of (raw.points as any[]).entries()) {
      const label = typeof p?.label === 'string' ? p.label.trim() : String(p?.label ?? '').trim()
      const value = typeof p?.value === 'number' ? p.value : Number(p?.value)
      if (!label) return { ok: false, error: `series[${i}].points[${j}].label is required` }
      if (!Number.isFinite(value)) return { ok: false, error: `series[${i}].points[${j}].value must be a finite number` }
      points.push({ label, value })
    }
    series.push({ name, points })
  }

  return {
    ok: true,
    spec: {
      title,
      chartType,
      xAxisLabel: typeof args.x_axis_label === 'string' ? args.x_axis_label : undefined,
      yAxisLabel: typeof args.y_axis_label === 'string' ? args.y_axis_label : undefined,
      series,
      explanation: typeof args.explanation === 'string' ? args.explanation : undefined
    }
  }
}

async function lookupSegments(searchTerm: string, orgId: string) {
  const state = await readAdminState(orgId)
  if (!state.pendo?.integrationKey) throw new Error('Pendo integration key not configured. Set it in Admin Settings → Pendo.')

  const { execa } = await import('execa')
  const projectRoot = process.cwd().replace('/apps/web', '')

  const result = await execa('python', ['-m', 'tools.pendo.lookup_segments', searchTerm], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PENDO_API_KEY: state.pendo.integrationKey,
      PENDO_INTEGRATION_KEY: state.pendo.integrationKey
    }
  })

  if (result.exitCode !== 0) throw new Error(`Segment lookup failed: ${result.stderr}`)
  const lines = result.stdout.trim().split(/\r?\n/).filter(l => l && !l.startsWith('  →'))
  return lines.map(line => {
    const [id, ...nameParts] = line.split('\t')
    return { id: id.trim(), name: nameParts.join('\t').trim() }
  })
}

async function lookupFeatures(searchTerm: string, orgId: string) {
  const state = await readAdminState(orgId)
  if (!state.pendo?.integrationKey) throw new Error('Pendo integration key not configured. Set it in Admin Settings → Pendo.')

  // Scoped to the configured app — in multi-app subscriptions the bare
  // /feature endpoint only returns the DEFAULT app's entities, which made this
  // tool blind to the app the agent is actually asked about. The normalized
  // shape is also far smaller in the tool result than raw Pendo objects.
  const features = await fetchPendoFeatures(state.pendo.integrationKey, state.pendo.defaultAppId)
  const query = searchTerm.toLowerCase()
  return features.filter(f => f.name.toLowerCase().includes(query))
}

async function lookupPages(searchTerm: string, orgId: string) {
  const state = await readAdminState(orgId)
  if (!state.pendo?.integrationKey) throw new Error('Pendo integration key not configured. Set it in Admin Settings → Pendo.')

  const pages = await fetchPendoPages(state.pendo.integrationKey, state.pendo.defaultAppId)
  const query = searchTerm.toLowerCase()
  return pages.filter(p => p.name.toLowerCase().includes(query))
}

const BUILT_IN_NAMES = new Set([
  'lookup_ontology',
  'lookup_pendo_segments',
  'lookup_pendo_features',
  'lookup_pendo_pages',
  'run_pendo_aggregation',
  'build_summary_chart'
])

export function isBuiltInTool(name: string): boolean {
  return BUILT_IN_NAMES.has(name)
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  orgId: string,
  sessionId: string,
  mcpConfigs: McpServerConfig[],
  opts: ExecuteToolOptions = {}
): Promise<{ result: unknown; error?: string }> {
  if (isBuiltInTool(name)) {
    return executeBuiltInTool(name, args, orgId, sessionId, opts)
  }

  // MCP tool
  const config = mcpConfigs.find(c => c.cachedTools?.some(t => t.name === name) || c.enabled)
  if (!config) return { result: null, error: `No MCP server found for tool: ${name}` }

  try {
    const result = await callMcpTool(config, name, args)
    return { result }
  } catch (err: any) {
    return { result: null, error: err.message }
  }
}
