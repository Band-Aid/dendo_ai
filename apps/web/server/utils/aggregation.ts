import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execa, type ExecaChildProcess } from 'execa'
import { readAdminState } from '~/server/utils/adminStore'
import { getCachedCompile, setCachedCompile } from '~/server/utils/dslCache'

const SUBPROCESS_TIMEOUT_MS = 30_000

// Track running processes by session ID
const runningProcesses = new Map<string, Set<ExecaChildProcess<string>>>()

export function registerProcess(sessionId: string, process: ExecaChildProcess<string>) {
  if (!runningProcesses.has(sessionId)) {
    runningProcesses.set(sessionId, new Set())
  }
  runningProcesses.get(sessionId)!.add(process)
}

export function unregisterProcess(sessionId: string, process: ExecaChildProcess<string>) {
  runningProcesses.get(sessionId)?.delete(process)
}

export function abortSession(sessionId: string) {
  const processes = runningProcesses.get(sessionId)
  if (processes) {
    for (const proc of processes) {
      try {
        proc.kill('SIGTERM')
        // Force kill after 2 seconds if still running
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL')
          }
        }, 2000)
      } catch (err) {
        console.error('[abortSession] Failed to kill process:', err)
      }
    }
    runningProcesses.delete(sessionId)
  }
}

function repoRoot() {
  return resolve(process.cwd(), '../..')
}

export interface CompileOptions {
  /** When set and the DSL doesn't already reference a segment, splice in `| segment id="…"` so all
   * aggregations in the notebook share the default segment filter. */
  defaultSegmentId?: string | null
}

/**
 * If `defaultSegmentId` is supplied and the DSL doesn't already filter by a segment, inject a
 * `| segment id="…"` stage so every notebook aggregation respects the notebook-level default.
 *
 * "Already handles segment" means any of:
 *   - a `| segment …` pipeline stage (FROM/PIPELINE queries),
 *   - a `segment(` function call inside a filter expression,
 *   - a `"segment":` JSON key inside a stage payload (e.g. `| pes {"segment":{"id":…}}`).
 * Stray substrings in field/identifier names (e.g. a column called `segmentName`) are not matched.
 */
export function applyDefaultSegment(dsl: string, defaultSegmentId?: string | null): string {
  // Trim defensively — legacy values may have leaked in with trailing whitespace
  // (e.g. a "\n" left over from a tab-separated `lookup_segments.py` line). An
  // unquoted newline inside `id="…"` would break the DSL across two lines.
  const trimmedId = defaultSegmentId?.trim()
  if (!trimmedId) return dsl
  const alreadyHasSegment =
    /\|\s*segment\b/i.test(dsl)
    || /\bsegment\s*\(/i.test(dsl)
    || /"segment"\s*:/i.test(dsl)
  if (alreadyHasSegment) return dsl

  const lines = dsl.split(/\r?\n/)
  // Inject before the first pipeline stage so the segment filter applies to all downstream stages.
  // If the DSL has no pipeline stages (rare), append at the end.
  let insertAt = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i])) { insertAt = i; break }
  }
  const injected = `| segment id="${trimmedId}"`
  lines.splice(insertAt, 0, injected)
  return lines.join('\n')
}

/**
 * Walk the compiled aggregation JSON and strip whitespace from any
 * segment-id-bearing string. Catches three shapes:
 *   - `{ "segment": { "id": "..." } }`     (pipeline stage from `| segment …`)
 *   - `{ "segmentId": "..." }`              (some legacy payloads)
 *   - `{ "segment": "..." }`                (filter-style references)
 * Pendo returns 400 "segment id not found: …\n" when an id has a stray
 * trailing newline (e.g. an agent-generated DSL inherited a "\n" from an
 * older, unsanitized notebook default segment).
 */
function sanitizeSegmentIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSegmentIds)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'segment' && v && typeof v === 'object' && 'id' in (v as any) && typeof (v as any).id === 'string') {
        out[k] = { ...(v as any), id: ((v as any).id as string).trim() }
      } else if (k === 'segmentId' && typeof v === 'string') {
        out[k] = v.trim()
      } else if (k === 'segment' && typeof v === 'string') {
        out[k] = v.trim()
      } else {
        out[k] = sanitizeSegmentIds(v)
      }
    }
    return out
  }
  return value
}

/**
 * The aggDSL parser is LINE-oriented — `FROM … TIMESERIES … | filter …` on a
 * single line fails with "Expected: FROM event([..])". LLMs love writing
 * one-liners, so normalize: newline before each pipe stage and before
 * TIMESERIES. String-aware, because entity names legitimately contain "|"
 * (`"Agent mode | Sparkle button"`) and `||` is the logical OR operator.
 */
export function normalizeDslText(dsl: string): string {
  if (dsl.includes('\n')) return dsl // already line-structured — don't touch
  let out = ''
  let inString = false
  for (let i = 0; i < dsl.length; i++) {
    const ch = dsl[i]
    if (inString) {
      out += ch
      if (ch === '\\') { out += dsl[++i] ?? ''; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '|') {
      if (dsl[i + 1] === '|') { out += '||'; i++; continue } // logical OR
      out = out.replace(/[ \t]+$/, '')
      out += '\n| '
      while (dsl[i + 1] === ' ') i++
      continue
    }
    out += ch
  }
  return out.replace(/\)[ \t]+TIMESERIES\b/, ')\nTIMESERIES')
}

export async function compileDsl(dsl: string, sessionId?: string, opts: CompileOptions = {}) {
  const effectiveDsl = applyDefaultSegment(normalizeDslText(dsl), opts.defaultSegmentId)
  const cached = getCachedCompile(effectiveDsl)
  if (cached !== null) {
    return { success: true, data: sanitizeSegmentIds(cached), fromCache: true, effectiveDsl }
  }

  const dir = await mkdtemp(join(tmpdir(), 'dendo-aggdsl-'))
  try {
    const dslFile = join(dir, 'query.dsl')
    await writeFile(dslFile, effectiveDsl, 'utf8')
    const root = repoRoot()
    const env = {
      ...process.env,
      PYTHONPATH: join(root, 'src')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SUBPROCESS_TIMEOUT_MS)
    const proc = execa('python', ['-m', 'aggdsl', 'compile', dslFile], {
      cwd: root,
      env,
      signal: controller.signal as any
    })

    if (sessionId) registerProcess(sessionId, proc)

    let result: any
    try {
      result = await proc
    } finally {
      clearTimeout(timer)
      if (sessionId) unregisterProcess(sessionId, proc)
    }

    const compiled = sanitizeSegmentIds(JSON.parse(result.stdout))
    setCachedCompile(effectiveDsl, compiled)
    return { success: true, data: compiled, effectiveDsl }
  } catch (err: any) {
    if (err.killed || err.signal || err.name === 'AbortError') {
      return { success: false, error: 'Cancelled or timed out', cancelled: true }
    }
    return { success: false, error: err.message || String(err) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function runAggregation(source: string, isDsl: boolean, sessionId?: string, orgId = 'default') {
  const state = await readAdminState(orgId)
  if (!state.pendo?.integrationKey) {
    return {
      success: false,
      error: 'Pendo integration key not configured. Set it in Admin Settings → Pendo.'
    }
  }

  const dir = await mkdtemp(join(tmpdir(), 'dendo-agg-run-'))
  try {
    const file = join(dir, isDsl ? 'query.dsl' : 'body.json')
    await writeFile(file, source, 'utf8')
    const root = repoRoot()
    const env = {
      ...process.env,
      PYTHONPATH: join(root, 'src'),
      PENDO_INTEGRATION_KEY: state.pendo.integrationKey,
      PENDO_API_KEY: state.pendo.integrationKey
    }

    if (state.pendo.apiEndpoint) {
      env.PENDO_AGG_URL = state.pendo.apiEndpoint
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SUBPROCESS_TIMEOUT_MS)
    const proc = execa('python', ['-m', 'tools.pendo.run_agg', file], {
      cwd: root,
      env,
      signal: controller.signal as any
    })

    if (sessionId) registerProcess(sessionId, proc)

    let result: any
    try {
      result = await proc
    } finally {
      clearTimeout(timer)
      if (sessionId) unregisterProcess(sessionId, proc)
    }

    return { success: true, data: JSON.parse(result.stdout) }
  } catch (err: any) {
    if (err.killed || err.signal || err.name === 'AbortError') {
      return { success: false, error: 'Cancelled or timed out', stderr: '', cancelled: true }
    }
    return { success: false, error: err.message || String(err), stderr: err.stderr }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Pendo's aggregation endpoint (and our `enrichWithNames` post-processor) emit
 * results in several shapes depending on the query — direct array, `{results: [...]}`,
 * `{data: [...]}`, or sometimes the entire payload as a single record. This
 * mirrors `extractRowsColumns` from `toolRegistry`, lifted out so the notebook
 * cell-run endpoint and the agent's tool share one extractor.
 */
export function extractRowsColumns(data: any): { rows: Record<string, unknown>[]; columns: string[] } {
  let rows: Record<string, unknown>[] = []
  if (Array.isArray(data)) {
    rows = data
  } else if (data?.results && Array.isArray(data.results)) {
    rows = data.results
  } else if (data?.data && Array.isArray(data.data)) {
    rows = data.data
  } else if (typeof data === 'object' && data !== null) {
    rows = [data]
  }
  const columns = rows.length > 0 ? Object.keys(rows[0]) : []
  return { rows, columns }
}

export async function enrichWithNames(data: any, sessionId?: string, orgId = 'default') {
  const dir = await mkdtemp(join(tmpdir(), 'dendo-enrich-'))
  try {
    const inputFile = join(dir, 'input.json')
    await writeFile(inputFile, JSON.stringify(data), 'utf8')
    
    const state = await readAdminState(orgId)
    const root = repoRoot()
    const env = { 
      ...process.env,
      PYTHONPATH: join(root, 'src')
    }

    if (state.pendo.integrationKey) {
      env.PENDO_INTEGRATION_KEY = state.pendo.integrationKey
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SUBPROCESS_TIMEOUT_MS)
    const proc = execa('python', ['-m', 'tools.pendo.lookup_names', inputFile], {
      cwd: root,
      env,
      signal: controller.signal as any
    })

    if (sessionId) registerProcess(sessionId, proc)

    let result: any
    try {
      result = await proc
    } finally {
      clearTimeout(timer)
      if (sessionId) unregisterProcess(sessionId, proc)
    }

    return { success: true, data: JSON.parse(result.stdout) }
  } catch (err: any) {
    if (err.killed || err.signal || err.name === 'AbortError') {
      return { success: false, data, error: 'Cancelled or timed out', cancelled: true }
    }
    console.warn('[enrichWithNames] Failed to enrich:', err.message)
    return { success: false, data, error: err.message || String(err) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
