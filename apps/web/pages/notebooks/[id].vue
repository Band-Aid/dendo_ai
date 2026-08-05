<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import CellList from '~/components/notebook/CellList.vue'
import ChatSidebar from '~/components/notebook/ChatSidebar.vue'
import { useOrg } from '~/composables/useOrg'
import { useNotebook } from '~/composables/useNotebook'
import { useNotebookChat } from '~/composables/useNotebookChat'
import { useAgentStream } from '~/composables/useAgentStream'
import { useApi } from '~/composables/useApi'
import { useI18n } from '~/composables/useI18n'
import { inferChartConfig } from '~/composables/useChartInference'
import type {
  NotebookCell,
  ChatAggregation,
  ChatMessage,
  ChatSummaryChart,
  QueryCellMeta,
  ResultCellMeta
} from '~/types/notebook'

const { t, locale } = useI18n()

const route = useRoute()
const router = useRouter()
const notebookId = computed(() => String(route.params.id))
const { currentOrgId } = useOrg()

const {
  current, loading, sortedCells, loadNotebook,
  addCell, updateCell, deleteCell, moveCell, updateNotebook
} = useNotebook(() => currentOrgId.value)

const {
  messages: chatMessages, loadMessages, appendMessage, clearMessages
} = useNotebookChat(() => currentOrgId.value)

const { streaming, streamingText, toolMessage, startStream, abort } = useAgentStream()
const { apiFetch } = useApi()

const editingTitle = ref(false)
const titleDraft = ref('')
// True while an IME composition is active (Japanese/Chinese/Korean input).
// Pressing Enter to commit an IME conversion must not save the title.
const titleComposing = ref(false)
const runningCellId = ref<string | null>(null)
// Chart cells currently re-running their stored DSL(s). Separate from
// `runningCellId` because multiple chart refreshes can be in flight at once
// (one per cell), but only one query-cell can run at a time.
const refreshingChartIds = ref<string[]>([])
const refreshingResultIds = ref<string[]>([])
const sessionId = ref(`nb-${Date.now()}`)
const referencedCellIds = ref<string[]>([])

// --- Collapsible chrome -----------------------------------------------------
// Both flags persist to localStorage so the view stays where the user left it
// across reloads. Chat history is always kept in `chatMessages` whether the
// sidebar is collapsed or not — collapsing is purely visual.

const STORAGE_KEY_HEADER = 'dendo.notebook.headerCollapsed'
const STORAGE_KEY_CHAT = 'dendo.notebook.chatCollapsed'
const STORAGE_KEY_CHAT_FS = 'dendo.notebook.chatFullscreen'

const headerCollapsedManual = ref<boolean | null>(
  typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY_HEADER) === 'true'
    ? true
    : typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY_HEADER) === 'false'
      ? false
      : null
)
const headerCollapsedByScroll = ref(false)
const headerCollapsed = computed(() =>
  // Manual override (if set) wins over scroll behaviour so the user can pin
  // it open even while scrolled, or pin it closed even at the top.
  headerCollapsedManual.value !== null ? headerCollapsedManual.value : headerCollapsedByScroll.value
)
function toggleHeader() {
  const next = !headerCollapsed.value
  headerCollapsedManual.value = next
  try { localStorage.setItem(STORAGE_KEY_HEADER, String(next)) } catch {}
}

const chatCollapsed = ref(
  typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY_CHAT) === 'true'
)
function toggleChat() {
  chatCollapsed.value = !chatCollapsed.value
  try { localStorage.setItem(STORAGE_KEY_CHAT, String(chatCollapsed.value)) } catch {}
  // Exiting "collapsed" while in fullscreen is fine, but entering "collapsed"
  // while in fullscreen would be visually contradictory — drop fullscreen.
  if (chatCollapsed.value && chatFullscreen.value) {
    chatFullscreen.value = false
    try { localStorage.setItem(STORAGE_KEY_CHAT_FS, 'false') } catch {}
  }
}

const chatFullscreen = ref(
  typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY_CHAT_FS) === 'true'
)
function toggleChatFullscreen() {
  chatFullscreen.value = !chatFullscreen.value
  try { localStorage.setItem(STORAGE_KEY_CHAT_FS, String(chatFullscreen.value)) } catch {}
  // Going fullscreen implies the chat is visible — uncollapse if needed.
  if (chatFullscreen.value && chatCollapsed.value) {
    chatCollapsed.value = false
    try { localStorage.setItem(STORAGE_KEY_CHAT, 'false') } catch {}
  }
}

const bodyEl = ref<HTMLElement | null>(null)
// Tracks last-emitted topbar visibility so we don't dispatch a window event
// on every scroll frame — only on the transitions.
let lastTopbarHidden: boolean | null = null

function onBodyScroll(e: Event) {
  const top = (e.target as HTMLElement).scrollTop
  // Hysteresis: collapse past 80px, expand only once back near the top.
  // Prevents a thin band of scroll positions from oscillating the header.
  if (!headerCollapsedByScroll.value && top > 80) headerCollapsedByScroll.value = true
  else if (headerCollapsedByScroll.value && top < 24) headerCollapsedByScroll.value = false

  // Use the same hysteresis to hide the app-level topbar so the notebook
  // reclaims another 44px of vertical space when the user is reading.
  let hideTopbar: boolean | null = null
  if (top > 80) hideTopbar = true
  else if (top < 24) hideTopbar = false
  if (hideTopbar !== null && hideTopbar !== lastTopbarHidden) {
    lastTopbarHidden = hideTopbar
    window.dispatchEvent(new CustomEvent('dendo:topbar-hidden', { detail: { hidden: hideTopbar } }))
  }
}

// On unmount, restore the topbar so other pages don't inherit the hidden
// state if the user navigates away while scrolled.
onBeforeUnmount(() => {
  if (lastTopbarHidden) {
    window.dispatchEvent(new CustomEvent('dendo:topbar-hidden', { detail: { hidden: false } }))
  }
})

onMounted(async () => {
  await loadNotebook(notebookId.value)
  await loadMessages(notebookId.value)
})
watch(notebookId, async (id) => {
  await loadNotebook(id)
  await loadMessages(id)
  referencedCellIds.value = []
})

const cellLookup = computed<Record<string, NotebookCell>>(() => {
  const map: Record<string, NotebookCell> = {}
  for (const c of sortedCells.value) map[c.id] = c
  return map
})

const referencedCellSummaries = computed(() =>
  referencedCellIds.value
    .map(id => cellLookup.value[id])
    .filter((c): c is NotebookCell => !!c)
    .map(c => ({ id: c.id, label: cellLabel(c) }))
)

function cellLabel(c: NotebookCell): string {
  if (c.cell_type === 'note') {
    const first = (c.content || '').split('\n')[0].slice(0, 30)
    return first ? `note: ${first}` : 'note'
  }
  if (c.cell_type === 'query') return 'query'
  if (c.cell_type === 'question') {
    const first = (c.content || '').split('\n')[0].slice(0, 30)
    return first ? `question: ${first}` : 'question'
  }
  if (c.cell_type === 'result') return `result (${(c.meta_json as any).rowCount ?? '?'} rows)`
  if (c.cell_type === 'chart') return `chart: ${(c.meta_json as any).title ?? 'untitled'}`
  return c.cell_type
}

function startEditTitle() {
  if (editingTitle.value) return
  titleDraft.value = current.value?.title ?? ''
  editingTitle.value = true
}

function cancelEditTitle() {
  editingTitle.value = false
  titleDraft.value = current.value?.title ?? ''
}

function onTitleEnter(e: KeyboardEvent) {
  if (titleComposing.value || e.isComposing) return
  saveTitle()
}

async function saveTitle() {
  if (!editingTitle.value) return
  editingTitle.value = false
  const next = titleDraft.value.trim()
  if (!current.value || !next || next === current.value.title) return
  try {
    await updateNotebook(notebookId.value, { title: next })
  } catch {}
}

// --- Default segment picker -------------------------------------------------

interface SegmentOption { id: string; name: string; description?: string }

const segmentSearch = ref('')
const segmentOptions = ref<SegmentOption[]>([])
const loadingSegments = ref(false)
const segmentPickerOpen = ref(false)

async function loadSegments(q = '') {
  loadingSegments.value = true
  try {
    const qs = q ? `?q=${encodeURIComponent(q)}` : ''
    segmentOptions.value = await apiFetch(`/api/pendo/segments${qs}`, {
      headers: { 'x-org-id': currentOrgId.value }
    })
  } catch (err: any) {
    message.error(err.message || 'Failed to load segments')
    segmentOptions.value = []
  } finally {
    loadingSegments.value = false
  }
}

function openSegmentPicker() {
  segmentPickerOpen.value = true
  if (segmentOptions.value.length === 0) loadSegments()
}

async function selectSegment(opt: SegmentOption | null) {
  segmentPickerOpen.value = false
  try {
    await updateNotebook(notebookId.value, {
      default_segment_id: opt?.id ?? null,
      default_segment_name: opt?.name ?? null
    })
    message.success(opt ? `Default segment set to "${opt.name}"` : 'Default segment cleared')
  } catch (err: any) {
    message.error(err.message || 'Failed to update segment')
  }
}

watch(segmentSearch, (q) => loadSegments(q))

async function handleAddCell(type: 'note' | 'query' | 'question', afterCellId: string | null) {
  try {
    await addCell(notebookId.value, type, '', {}, afterCellId)
  } catch (err: any) {
    message.error(err.message)
  }
}

/**
 * Run / re-run a saved question cell.
 *
 * First run (no DSLs captured yet) goes through the agent: it derives the
 * queries, runs them, and writes the answer. Every subsequent run is
 * deterministic — it replays the *exact* DSLs captured on that first run and
 * only asks the LLM to reinterpret the fresh numbers. So the data a question
 * pulls stays reproducible run-to-run; only the narrative is regenerated.
 */
async function handleRunQuestion(cellId: string) {
  if (runningCellId.value) return
  const cell = cellLookup.value[cellId]
  if (!cell || cell.cell_type !== 'question') return
  const question = (cell.content || '').trim()
  if (!question) {
    message.warning('Write a question first')
    return
  }

  const meta = (cell.meta_json as any) ?? {}
  const storedDsls = (meta.aggregations ?? [])
    .filter((a: any) => typeof a?.dsl === 'string' && a.dsl.trim())
    .map((a: any) => ({ dsl: a.dsl, explanation: a.explanation }))

  // If the question text has changed since the last run, the stored DSLs were
  // derived from a different question and must not be replayed — generate new
  // ones instead. Only replay DSLs when the question is unchanged (explicit rerun).
  const questionChanged = meta.lastRunQuestion !== undefined && meta.lastRunQuestion !== question

  runningCellId.value = cellId
  try {
    if (storedDsls.length > 0 && !questionChanged) {
      // Deterministic re-run: same DSLs, fresh data, LLM only reinterprets.
      // Failed queries are rebuilt by the agent and come back with corrected
      // DSLs, so persisting `aggregations` heals the cell for next time.
      const res = await apiFetch<{
        answer: string
        aggregations: ChatAggregation[]
        repairedCount?: number
        runAt: string
      }>(`/api/notebooks/${notebookId.value}/question/rerun`, {
        method: 'POST',
        headers: { 'x-org-id': currentOrgId.value },
        body: { question, dsls: storedDsls, originConceptId: meta.originConceptId }
      })
      await updateCell(notebookId.value, cellId, {
        meta_json: {
          ...meta,
          answer: res.answer,
          aggregations: res.aggregations ?? [],
          // Summary charts were agent-designed from pre-computed points and
          // have no DSL to replay — carry them forward untouched.
          summaryCharts: meta.summaryCharts ?? [],
          lastRunAt: res.runAt,
          lastRunQuestion: question,
          lastError: null
        }
      })
      message.success(
        res.repairedCount
          ? `Re-ran · rebuilt ${res.repairedCount} stale quer${res.repairedCount === 1 ? 'y' : 'ies'} · reinterpreted`
          : 'Re-ran saved queries · reinterpreted'
      )
    } else {
      // First run or question changed: agent derives and runs new queries.
      const res = await apiFetch<{
        answer: string
        aggregations: ChatAggregation[]
        summaryCharts: ChatSummaryChart[]
        runAt: string
      }>(`/api/notebooks/${notebookId.value}/question/run`, {
        method: 'POST',
        headers: { 'x-org-id': currentOrgId.value },
        body: { question, originConceptId: meta.originConceptId }
      })
      await updateCell(notebookId.value, cellId, {
        meta_json: {
          ...meta,
          answer: res.answer,
          aggregations: res.aggregations ?? [],
          summaryCharts: res.summaryCharts ?? [],
          lastRunAt: res.runAt,
          lastRunQuestion: question,
          lastError: null
        }
      })
      const sources = res.aggregations?.length ?? 0
      message.success(sources ? `Question run · ${sources} source${sources === 1 ? '' : 's'}` : 'Question run')
    }
  } catch (err: any) {
    await updateCell(notebookId.value, cellId, {
      meta_json: { ...meta, lastError: err.message || 'Agent error' }
    }).catch(() => {})
    message.error(err.message || 'Failed to run question')
  } finally {
    runningCellId.value = null
  }
}

async function handleSaveCell(cellId: string, content: string) {
  try {
    await updateCell(notebookId.value, cellId, { content })
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleDeleteCell(cellId: string) {
  try {
    await deleteCell(notebookId.value, cellId)
    referencedCellIds.value = referencedCellIds.value.filter(id => id !== cellId)
  } catch (err: any) {
    message.error(err.message)
  }
}

/**
 * The result cell owned by a query cell, or null if it has none yet.
 *
 * Ownership lives in `source_cell_id`. Result cells created before that link
 * was recorded have a null one, so we also adopt an *immediately following*
 * orphan result — otherwise an existing notebook would keep its stale table
 * forever and grow a second, paired one alongside it.
 *
 * Adoption needs two signals, not just adjacency: the candidate must have no
 * owner AND carry the same DSL as this query. Adjacency alone would let a
 * query cell swallow an unrelated table — "Add table" from chat appends to the
 * end of the notebook, so it lands directly after a trailing query cell and
 * would be overwritten on that cell's next run.
 */
function findPairedResultCell(queryCellId: string, dsl?: string): NotebookCell | null {
  const cells = sortedCells.value
  const owned = cells.find(c => c.cell_type === 'result' && c.source_cell_id === queryCellId)
  if (owned) return owned

  const queryIndex = cells.findIndex(c => c.id === queryCellId)
  if (queryIndex === -1) return null
  const next = cells[queryIndex + 1]
  if (next?.cell_type !== 'result' || next.source_cell_id) return null

  const candidateDsl = (next.meta_json as ResultCellMeta)?.dsl?.trim()
  return candidateDsl && candidateDsl === dsl?.trim() ? next : null
}

/**
 * Run a query cell and land the output in ITS table — one query, one result,
 * for the life of the cell. Re-running replaces the rows in place rather than
 * appending another table (which is what made every run pile up a new,
 * unattributable snapshot).
 *
 * Column order the user set by hand survives a re-run; `columnOrder` is
 * preserved and ResultCell appends any newly-arrived column, so a query that
 * grows a field doesn't hide it.
 */
async function handleRunQuery(cellId: string, dsl: string) {
  if (runningCellId.value) return
  runningCellId.value = cellId
  const queryMeta = (cellLookup.value[cellId]?.meta_json ?? {}) as QueryCellMeta
  try {
    // One endpoint, same pipeline the chat agent uses: compile (with notebook
    // default segment), run against Pendo, enrich names, then flatten to
    // `{ rows, columns }`. Keeps cell-run and chat-run results identical.
    const res = await apiFetch<{
      success: boolean
      stage?: 'compile' | 'aggregate'
      error?: string
      rows?: Record<string, unknown>[]
      columns?: string[]
      rowCount?: number
    }>(`/api/notebooks/${notebookId.value}/run-query`, {
      method: 'POST',
      headers: { 'x-org-id': currentOrgId.value },
      body: { dsl }
    })

    if (!res.success) {
      const label = res.stage === 'compile' ? 'DSL compile error' : 'Aggregation error'
      // Spread — a bare `{ lastError }` would wipe the cell's title and
      // lastRunAt every time a query failed to compile.
      await updateCell(notebookId.value, cellId, {
        meta_json: { ...queryMeta, lastError: res.error }
      })
      message.error(`${label}: ${res.error}`)
      return
    }

    const rows = res.rows ?? []
    const columns = res.columns ?? []

    // The query's name is the pair's name — the table is titled by whatever
    // the user called the query, so renaming the query renames both.
    const title = queryMeta.title?.trim() || undefined

    const paired = findPairedResultCell(cellId, dsl)
    if (paired) {
      const prevMeta = paired.meta_json as ResultCellMeta
      await updateCell(notebookId.value, paired.id, {
        meta_json: {
          ...prevMeta,
          rows,
          columns,
          rowCount: rows.length,
          dsl,
          runAt: new Date().toISOString(),
          title
        },
        // No-op when already owned; completes the adoption for an orphan.
        ...(paired.source_cell_id === cellId ? {} : { source_cell_id: cellId })
      })
    } else {
      await addCell(
        notebookId.value, 'result', '',
        { rows, columns, rowCount: rows.length, dsl, runAt: new Date().toISOString(), title },
        cellId,   // after_cell_id  — sit directly under the query
        cellId    // source_cell_id — and belong to it
      )
    }

    await updateCell(notebookId.value, cellId, {
      meta_json: { ...queryMeta, lastRunAt: new Date().toISOString(), lastError: null }
    })
    message.success(`Query returned ${rows.length} rows`)
  } catch (err: any) {
    message.error(err.message)
  } finally {
    runningCellId.value = null
  }
}

/**
 * Rename a query cell. The name is pushed straight onto the paired result so
 * the table's heading tracks the rename without waiting for the next run — an
 * unrun pair has no rows to refresh, and re-querying Pendo just to relabel a
 * table would be a needless call.
 */
async function handleSaveQueryTitle(cellId: string, title: string) {
  const cell = cellLookup.value[cellId]
  if (!cell || cell.cell_type !== 'query') return

  const trimmed = title.trim()
  const meta = { ...(cell.meta_json as QueryCellMeta) }
  if (trimmed) meta.title = trimmed
  else delete meta.title

  try {
    await updateCell(notebookId.value, cellId, { meta_json: meta })
    const paired = findPairedResultCell(cellId, cell.content)
    if (paired) {
      const prevMeta = { ...(paired.meta_json as ResultCellMeta) }
      if (trimmed) prevMeta.title = trimmed
      else delete prevMeta.title
      await updateCell(notebookId.value, paired.id, { meta_json: prevMeta })
    }
  } catch (err: any) {
    message.error(err.message)
  }
}

interface RunQueryResponse {
  success: boolean
  stage?: 'compile' | 'aggregate'
  error?: string
  rows?: Record<string, unknown>[]
  columns?: string[]
  rowCount?: number
}

/**
 * Re-execute each DSL backing a chart cell and replace the stored rows in
 * place. Multi-series charts run each series's DSL in parallel; the
 * single-series legacy path runs `meta.dsl`. Series without a DSL keep their
 * existing rows (e.g. agent-built points have none and are passed through).
 * Failures per series are reported but don't block other series — the
 * chart keeps as much fresh data as it could fetch.
 */
async function handleRefreshChart(cellId: string) {
  const cell = cellLookup.value[cellId]
  if (!cell || cell.cell_type !== 'chart') return
  if (refreshingChartIds.value.includes(cellId)) return

  const meta = cell.meta_json as any
  const singleDsl: string | undefined = typeof meta.dsl === 'string' ? meta.dsl.trim() : ''
  const seriesArr: any[] = Array.isArray(meta.series) ? meta.series : []

  const isMulti = seriesArr.length > 0
  const isSingle = !isMulti && !!singleDsl

  if (!isMulti && !isSingle) {
    message.warning('This chart has no DSL to refresh')
    return
  }

  refreshingChartIds.value = [...refreshingChartIds.value, cellId]
  try {
    if (isMulti) {
      // Parallel per-series re-runs. Track per-index outcomes so we can patch
      // each series independently while keeping the order stable.
      const results = await Promise.all(
        seriesArr.map(async (s) => {
          const dsl = typeof s?.dsl === 'string' ? s.dsl.trim() : ''
          if (!dsl) return { ok: true, series: s }
          try {
            const res = await apiFetch<RunQueryResponse>(
              `/api/notebooks/${notebookId.value}/run-query`,
              {
                method: 'POST',
                headers: { 'x-org-id': currentOrgId.value },
                body: { dsl }
              }
            )
            if (!res.success) return { ok: false, series: s, error: res.error }
            // Translate the new rows into the same {xField, yField} schema the
            // existing series uses so the renderer doesn't have to re-detect.
            const xField = s.xField ?? 'label'
            const yField = s.yField ?? 'value'
            return {
              ok: true,
              series: { ...s, rows: res.rows ?? [] },
              xField,
              yField
            }
          } catch (err: any) {
            return { ok: false, series: s, error: err.message }
          }
        })
      )

      const newSeries = results.map(r => r.series)
      const failed = results.filter(r => !r.ok)

      await updateCell(notebookId.value, cellId, {
        meta_json: { ...meta, series: newSeries }
      })

      if (failed.length === 0) {
        message.success('Chart refreshed')
      } else if (failed.length === results.length) {
        message.error(`All ${failed.length} series failed to refresh`)
      } else {
        message.warning(`Refreshed with ${failed.length} series failure(s)`)
      }
    } else {
      // Single-series legacy path.
      const res = await apiFetch<RunQueryResponse>(
        `/api/notebooks/${notebookId.value}/run-query`,
        {
          method: 'POST',
          headers: { 'x-org-id': currentOrgId.value },
          body: { dsl: singleDsl }
        }
      )
      if (!res.success) {
        const label = res.stage === 'compile' ? 'DSL compile error' : 'Aggregation error'
        message.error(`${label}: ${res.error}`)
        return
      }
      await updateCell(notebookId.value, cellId, {
        meta_json: {
          ...meta,
          rows: res.rows ?? [],
          columns: res.columns ?? (meta.columns ?? [])
        }
      })
      message.success(`Chart refreshed (${(res.rows ?? []).length} rows)`)
    }
  } catch (err: any) {
    message.error(err.message)
  } finally {
    refreshingChartIds.value = refreshingChartIds.value.filter(id => id !== cellId)
  }
}

/**
 * Re-run a result cell's stored DSL and replace its rows + columns. The DSL
 * is captured at result-creation time inside `meta_json.dsl`, so any result
 * created via the cell-run path (handleRunQuery) or the chat "Add table"
 * action carries one. Result cells without a DSL field (legacy) don't show
 * the refresh button — see `canRefresh` in ResultCell.
 */
/**
 * Persist a new column display order on a result cell. An empty `order`
 * means "clear the custom order" — `meta_json.columnOrder` is dropped so
 * the table falls back to the schema order from `meta.columns`.
 */
async function handleReorderResultColumns(cellId: string, order: string[]) {
  const cell = cellLookup.value[cellId]
  if (!cell || cell.cell_type !== 'result') return
  const meta = cell.meta_json as any
  const next: any = { ...meta }
  if (order.length === 0) delete next.columnOrder
  else next.columnOrder = order
  try {
    await updateCell(notebookId.value, cellId, { meta_json: next })
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleRefreshResult(cellId: string) {
  const cell = cellLookup.value[cellId]
  if (!cell || cell.cell_type !== 'result') return
  if (refreshingResultIds.value.includes(cellId)) return

  const meta = cell.meta_json as any
  const dsl: string = typeof meta.dsl === 'string' ? meta.dsl.trim() : ''
  if (!dsl) {
    message.warning('This result has no DSL to refresh')
    return
  }

  refreshingResultIds.value = [...refreshingResultIds.value, cellId]
  try {
    const res = await apiFetch<RunQueryResponse>(
      `/api/notebooks/${notebookId.value}/run-query`,
      {
        method: 'POST',
        headers: { 'x-org-id': currentOrgId.value },
        body: { dsl }
      }
    )
    if (!res.success) {
      const label = res.stage === 'compile' ? 'DSL compile error' : 'Aggregation error'
      message.error(`${label}: ${res.error}`)
      return
    }
    const rows = res.rows ?? []
    const columns = res.columns ?? meta.columns ?? []
    await updateCell(notebookId.value, cellId, {
      meta_json: {
        ...meta,
        rows,
        columns,
        rowCount: rows.length,
        runAt: new Date().toISOString()
      }
    })
    message.success(`Result refreshed (${rows.length} rows)`)
  } catch (err: any) {
    message.error(err.message)
  } finally {
    refreshingResultIds.value = refreshingResultIds.value.filter(id => id !== cellId)
  }
}

/**
 * Persist a manually-edited DSL for a chart cell.
 *   - `seriesIndex === null` → write to `meta.dsl` (single-series legacy path).
 *   - `seriesIndex` is a number → patch that entry in `meta.series[]`.
 * Does NOT auto-run the new DSL; the user clicks the chart's Refresh button
 * to re-fetch with the edited query. Separating save from run lets them
 * stage several series edits and refresh once.
 */
/** Persist a manually-edited DSL on a result cell. Same shape as the chart
 *  variant — Save here, Refresh re-runs. */
async function handleUpdateResultDsl(cellId: string, dsl: string) {
  const cell = cellLookup.value[cellId]
  if (!cell || cell.cell_type !== 'result') return
  const meta = cell.meta_json as any
  try {
    await updateCell(notebookId.value, cellId, {
      meta_json: { ...meta, dsl }
    })
    message.success('Saved — click refresh to re-run')
  } catch (err: any) {
    message.error(err.message)
  }
}

/** "Ask agent to tweak this result" — same flow as the chart equivalent. */
function handleAskResultTweak(cellId: string) {
  if (!referencedCellIds.value.includes(cellId)) {
    referencedCellIds.value.push(cellId)
  }
  if (chatCollapsed.value) {
    chatCollapsed.value = false
    try { localStorage.setItem(STORAGE_KEY_CHAT, 'false') } catch {}
  }
}

async function handleUpdateChartDsl(cellId: string, seriesIndex: number | null, dsl: string) {
  const cell = cellLookup.value[cellId]
  if (!cell || cell.cell_type !== 'chart') return
  const meta = cell.meta_json as any
  const next: any = { ...meta }

  if (seriesIndex == null) {
    next.dsl = dsl
  } else {
    const series = Array.isArray(meta.series) ? [...meta.series] : []
    if (seriesIndex < 0 || seriesIndex >= series.length) return
    series[seriesIndex] = { ...series[seriesIndex], dsl }
    next.series = series
  }

  try {
    await updateCell(notebookId.value, cellId, { meta_json: next })
    message.success('Saved — click refresh to re-run')
  } catch (err: any) {
    message.error(err.message)
  }
}

/**
 * "Ask agent to tweak this chart" — reference the chart cell so the agent
 * gets its content as context, uncollapse the chat, and focus there. We do
 * NOT auto-send a prompt; the user types their tweak request themselves so
 * they can be specific.
 */
function handleAskChartTweak(cellId: string) {
  if (!referencedCellIds.value.includes(cellId)) {
    referencedCellIds.value.push(cellId)
  }
  if (chatCollapsed.value) {
    chatCollapsed.value = false
    try { localStorage.setItem(STORAGE_KEY_CHAT, 'false') } catch {}
  }
}

async function handleChangeChartType(cellId: string, type: 'line' | 'bar' | 'donut') {
  const cell = cellLookup.value[cellId]
  if (!cell || cell.cell_type !== 'chart') return
  try {
    // Patch meta_json — we send the full meta_json back so the server
    // replaces it atomically (the API merges shallowly otherwise lost keys).
    await updateCell(notebookId.value, cellId, {
      meta_json: { ...(cell.meta_json as any), chartType: type }
    })
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleMoveCell(cellId: string, direction: 'up' | 'down') {
  const cells = sortedCells.value
  const idx = cells.findIndex(c => c.id === cellId)
  if (idx < 0) return
  let afterCellId: string | null = null
  if (direction === 'up' && idx > 0) {
    afterCellId = idx > 1 ? cells[idx - 2].id : null
  } else if (direction === 'down' && idx < cells.length - 1) {
    afterCellId = cells[idx + 1].id
  }
  try {
    await moveCell(notebookId.value, cellId, afterCellId)
  } catch (err: any) {
    message.error(err.message)
  }
}

// Chat / agent
async function handleSend(question: string) {
  const referenced = [...referencedCellIds.value]
  referencedCellIds.value = []

  await startStream({
    notebookId: notebookId.value,
    orgId: currentOrgId.value,
    question,
    sessionId: sessionId.value,
    referencedCellIds: referenced,
    onMessageCreated: (msg: ChatMessage) => appendMessage(msg),
    onTextDelta: () => {},
    onDone: (reason) => {
      if (reason === 'error') message.error('Agent encountered an error')
    },
    onError: (msg) => message.error(msg)
  })
}

/**
 * Query cell's Generate prompt was actually a question / analytical request.
 * Stuffing the agent's reasoning into a DSL cell makes the cell fail to
 * compile, so instead: uncollapse the chat sidebar, persist that state, and
 * forward the prompt to `handleSend` as if the user had typed it in the chat
 * input themselves.
 */
async function handleAskInChat(prompt: string) {
  if (chatCollapsed.value) {
    chatCollapsed.value = false
    try { localStorage.setItem(STORAGE_KEY_CHAT, 'false') } catch {}
  }
  await handleSend(prompt)
}

async function handleClearChat() {
  try {
    await clearMessages(notebookId.value)
    sessionId.value = `nb-${Date.now()}`
  } catch (err: any) {
    message.error(err.message)
  }
}

// Reference a cell in the next chat turn (called by "Ask about this" buttons)
function handleAskAboutCell(cellId: string) {
  if (!referencedCellIds.value.includes(cellId)) {
    referencedCellIds.value.push(cellId)
  }
}

function handleRemoveReference(cellId: string) {
  referencedCellIds.value = referencedCellIds.value.filter(id => id !== cellId)
}

// "Add to notebook" actions from chat
/**
 * Compose the note body from a chat answer + its originating question (when
 * present). The question becomes a `###` heading so the notebook captures
 * "what was asked" alongside "what the agent said", giving future readers
 * context without scrolling chat history. Multi-line prompts are collapsed
 * to one line so the heading syntax stays valid; the rest of the prompt is
 * preserved as a blockquote on the next line.
 */
function composeNoteFromChat(answer: string, question?: string): string {
  const q = question?.trim()
  if (!q) return answer
  const lines = q.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const firstLine = lines[0].slice(0, 240)
  const restLines = lines.slice(1)
  let header = `### ${firstLine}`
  if (restLines.length) {
    header += '\n' + restLines.map(l => `> ${l}`).join('\n')
  }
  return `${header}\n\n${answer}`
}

async function handleAddNoteToNotebook(answer: string, question?: string) {
  try {
    const lastCellId = sortedCells.value.length
      ? sortedCells.value[sortedCells.value.length - 1].id
      : null
    const content = composeNoteFromChat(answer, question)
    await addCell(notebookId.value, 'note', content, {}, lastCellId)
    message.success('Added note to notebook')
  } catch (err: any) {
    message.error(err.message)
  }
}

/**
 * Promote a chat Q&A turn into a re-runnable question cell. The cell starts
 * pre-populated with the answer + aggregations + summary charts the agent just
 * produced (so it's not blank), but is now a first-class widget the user can
 * re-run any time without scrolling back through chat.
 */
async function handleAddQuestionFromChat(question: string, msg: ChatMessage) {
  try {
    const lastCellId = sortedCells.value.length
      ? sortedCells.value[sortedCells.value.length - 1].id
      : null
    await addCell(
      notebookId.value, 'question', question,
      {
        answer: msg.content,
        aggregations: msg.aggregations ?? [],
        summaryCharts: msg.summary_charts ?? [],
        lastRunAt: msg.created_at,
        lastError: null
      },
      lastCellId
    )
    message.success('Saved as re-runnable question')
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleAddQueryToNotebook(dsl: string) {
  try {
    const lastCellId = sortedCells.value.length
      ? sortedCells.value[sortedCells.value.length - 1].id
      : null
    await addCell(notebookId.value, 'query', dsl, {}, lastCellId)
    message.success('Added DSL as query cell')
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleAddAggregation(agg: ChatAggregation, mode: 'table' | 'chart' | 'both') {
  try {
    let lastCellId = sortedCells.value.length
      ? sortedCells.value[sortedCells.value.length - 1].id
      : null

    let resultCellId: string | null = null
    // Reuse the agent's one-line `explanation` as the cell title for both
    // table and chart variants — it's the same line the user just clicked
    // "Add" next to in the chat, so the notebook cell carries that context.
    const title = agg.explanation?.trim() || undefined

    if (mode === 'table' || mode === 'both') {
      const resultCell = await addCell(
        notebookId.value, 'result', '',
        {
          rows: agg.rows,
          columns: agg.columns,
          rowCount: agg.rows.length,
          dsl: agg.dsl,
          runAt: new Date().toISOString(),
          title
        },
        lastCellId
      )
      resultCellId = resultCell.id
      lastCellId = resultCell.id
    }

    if (mode === 'chart' || mode === 'both') {
      const chart = inferChartConfig(agg.rows, agg.columns)
      if (chart) {
        await addCell(
          notebookId.value, 'chart', '',
          {
            chartType: chart.type,
            xField: chart.xField,
            yField: chart.yField,
            title: agg.explanation || chart.title || agg.columns[1] || 'Chart',
            sourceResultCellId: resultCellId ?? '',
            rows: agg.rows,
            columns: agg.columns,
            // Stored so the chart cell's "Refresh" button can re-run this DSL.
            dsl: agg.dsl
          },
          lastCellId
        )
      } else if (mode === 'chart') {
        message.warning('Data shape does not support a chart')
        return
      }
    }
    message.success('Added to notebook')
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleAddAgentSummaryChart(chart: ChatSummaryChart) {
  // Agent-built chart: comparison key + metric are already decided. Convert
  // the spec's `{ label, value }` points into the renderer's row shape and
  // drop into a chart cell. No inference step.
  try {
    const lastCellId = sortedCells.value.length
      ? sortedCells.value[sortedCells.value.length - 1].id
      : null
    await addCell(
      notebookId.value, 'chart', '',
      {
        chartType: chart.chartType,
        title: chart.title,
        xField: 'label',
        yField: 'value',
        series: chart.series.map(s => ({
          name: s.name,
          rows: s.points.map(p => ({ label: p.label, value: p.value })),
          xField: 'label',
          yField: 'value'
        }))
      },
      lastCellId
    )
    message.success('Chart added to notebook')
  } catch (err: any) {
    message.error(err.message)
  }
}

</script>

<template>
  <div class="notebook-view" :class="{ 'chat-fullscreen': chatFullscreen && !chatCollapsed }">
    <a-spin v-if="loading" style="display:block;text-align:center;padding:80px 0;" />

    <template v-else>
      <!--
        Notebook cells column. Hidden while the chat is in fullscreen so the
        chat can stretch across the full notebook-view width. The toggle on
        the chat header brings the cells back.
      -->
      <div
        v-show="!(chatFullscreen && !chatCollapsed)"
        class="notebook-main"
      >
        <a-tooltip v-if="headerCollapsed" title="Show header">
          <button
            class="nb-header-show-fab"
            @click="toggleHeader"
            aria-label="Show header"
          >▾</button>
        </a-tooltip>
        <header v-else class="nb-header">
          <button class="nb-back" @click="router.push('/notebooks')">
            <span class="nb-back-arrow">←</span>
            <span>{{ t('ui.notebook.back') }}</span>
          </button>
          <a-tooltip title="Hide header">
            <button class="nb-header-toggle" @click="toggleHeader" aria-label="Hide header">
              <span class="nb-header-caret">▴</span>
            </button>
          </a-tooltip>
          <div class="nb-title-block">
            <span class="eyebrow nb-eyebrow">{{ t('ui.notebook.eyebrow') }}</span>
            <div class="nb-title">
              <a-input
                v-if="editingTitle"
                v-model:value="titleDraft"
                class="nb-title-input"
                @blur="saveTitle"
                @keydown.enter="onTitleEnter"
                @keydown.esc="cancelEditTitle"
                @compositionstart="titleComposing = true"
                @compositionend="titleComposing = false"
                autofocus
              />
              <h1 v-else class="nb-title-text" @click="startEditTitle">
                {{ current?.title || '…' }}
              </h1>
            </div>
            <div class="nb-meta mono">
              <span>
                {{ sortedCells.length }} {{ sortedCells.length === 1 ? t('ui.notebook.cell_one') : t('ui.notebook.cell_other') }}
                <span class="nb-meta-dot">·</span>
                {{ t('ui.notebook.updated') }} {{ current ? new Date(current.updated_at).toLocaleDateString(locale === 'ja' ? 'ja-JP' : undefined, { month: 'short', day: 'numeric' }) : '—' }}
              </span>
              <span class="nb-meta-dot">·</span>
              <a-popover
                v-model:open="segmentPickerOpen"
                trigger="click"
                placement="bottomLeft"
                :overlay-class-name="'nb-segment-popover'"
              >
                <template #content>
                  <div class="nb-segment-picker">
                    <a-input
                      v-model:value="segmentSearch"
                      placeholder="Search segments…"
                      allow-clear
                      autofocus
                    />
                    <a-spin :spinning="loadingSegments">
                      <div class="nb-segment-list">
                        <div
                          v-if="current?.default_segment_id"
                          class="nb-segment-item nb-segment-clear"
                          @click="selectSegment(null)"
                        >Clear default — use all visitors</div>
                        <div
                          v-for="opt in segmentOptions"
                          :key="opt.id"
                          class="nb-segment-item"
                          :class="{ 'is-selected': current?.default_segment_id === opt.id }"
                          @click="selectSegment(opt)"
                        >
                          <div class="nb-segment-name">{{ opt.name }}</div>
                          <div v-if="opt.description" class="nb-segment-desc">{{ opt.description }}</div>
                        </div>
                        <div v-if="!loadingSegments && segmentOptions.length === 0" class="nb-segment-empty">No segments found.</div>
                      </div>
                    </a-spin>
                  </div>
                </template>
                <button class="nb-segment-chip" @click="openSegmentPicker">
                  <span class="nb-segment-label">Segment:</span>
                  <span class="nb-segment-value">{{ current?.default_segment_name || 'All visitors' }}</span>
                  <span class="nb-segment-caret">▾</span>
                </button>
              </a-popover>
            </div>
          </div>
        </header>

        <div ref="bodyEl" class="nb-body ms-scroll" @scroll="onBodyScroll">
          <div class="nb-paper">
            <CellList
              :cells="sortedCells"
              :running-cell-id="runningCellId"
              :refreshing-chart-ids="refreshingChartIds"
              :refreshing-result-ids="refreshingResultIds"
              :streaming="false"
              :streaming-text="''"
              :notebook-id="notebookId"
              :org-id="currentOrgId"
              @add-cell="handleAddCell"
              @save-cell="handleSaveCell"
              @save-query-title="handleSaveQueryTitle"
              @delete-cell="handleDeleteCell"
              @run-query="handleRunQuery"
              @run-question="handleRunQuestion"
              @move-cell="handleMoveCell"
              @ask-about-cell="handleAskAboutCell"
              @change-chart-type="handleChangeChartType"
              @refresh-chart="handleRefreshChart"
              @refresh-result="handleRefreshResult"
              @reorder-result-columns="handleReorderResultColumns"
              @ask-in-chat="handleAskInChat"
              @update-chart-dsl="handleUpdateChartDsl"
              @ask-chart-tweak="handleAskChartTweak"
              @update-result-dsl="handleUpdateResultDsl"
              @ask-result-tweak="handleAskResultTweak"
            />
          </div>
        </div>
      </div>

      <!-- Right: chat sidebar (collapsible — history kept in component state). -->
      <ChatSidebar
        :messages="chatMessages"
        :streaming="streaming"
        :streaming-text="streamingText"
        :tool-message="toolMessage"
        :referenced-cells="referencedCellSummaries"
        :cell-lookup="cellLookup"
        :collapsed="chatCollapsed"
        :fullscreen="chatFullscreen"
        @toggle-collapse="toggleChat"
        @toggle-fullscreen="toggleChatFullscreen"
        @send="handleSend"
        @abort="abort"
        @add-note="handleAddNoteToNotebook"
        @add-query="handleAddQueryToNotebook"
        @add-question="handleAddQuestionFromChat"
        @add-aggregation="handleAddAggregation"
        @add-agent-summary-chart="handleAddAgentSummaryChart"
        @remove-reference="handleRemoveReference"
        @clear-chat="handleClearChat"
      />
    </template>
  </div>
</template>

<style scoped>
.notebook-view {
  display: flex;
  flex-direction: row;
  height: calc(100vh - var(--topbar-h));
  overflow: hidden;
  background: var(--paper);
  margin: -36px -40px -64px;
}
/* Fullscreen chat — notebook-main is `v-show`'d off; the sidebar fills the
 * row. We unbind the chat's fixed width so flex stretches it. The app's
 * left nav + topbar stay visible so the user can still navigate out. */
.notebook-view.chat-fullscreen :deep(.chat-sidebar) {
  flex: 1;
}
.notebook-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  position: relative;
  background:
    linear-gradient(180deg, var(--paper) 0%, var(--paper) 100%);
}

/* Floating "show header" button — visible only when the header is collapsed.
 * Sits over the top-right corner of the notebook body so the user can bring
 * the header back without scrolling to the top. */
.nb-header-show-fab {
  position: absolute;
  top: 8px;
  right: 16px;
  z-index: 5;
  background: var(--paper);
  border: 1px solid var(--rule);
  border-radius: 999px;
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.nb-header-show-fab:hover {
  background: var(--subtle);
  border-color: var(--accent);
  color: var(--accent);
}

.nb-header {
  padding: 10px 48px 12px;
  border-bottom: 1px solid var(--rule);
  background: var(--paper);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
  transition: padding 0.18s ease, gap 0.18s ease;
}
.nb-header-toggle {
  position: absolute;
  top: 6px;
  right: 12px;
  background: transparent;
  border: 1px solid var(--rule);
  border-radius: 999px;
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.nb-header-toggle:hover {
  background: var(--subtle);
  border-color: var(--accent);
  color: var(--accent);
}
.nb-header-caret { line-height: 1; }

.nb-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  padding: 0;
  font-family: var(--sans);
  font-size: 13.5px;
  color: var(--muted);
  letter-spacing: 0.01em;
  cursor: pointer;
  width: fit-content;
  transition: color 0.15s;
}
.nb-back:hover { color: var(--accent); }
.nb-back-arrow { font-size: 14px; }

.nb-title-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nb-eyebrow { display: none; }
.nb-title-text {
  margin: 0;
  font-family: var(--serif);
  font-weight: 460;
  font-variation-settings: 'opsz' 36, 'SOFT' 40;
  font-size: 21px;
  letter-spacing: -0.012em;
  line-height: 1.15;
  color: var(--ink);
  cursor: text;
}
.nb-title-input :deep(input),
.nb-title-input :deep(.ant-input) {
  font-family: var(--serif) !important;
  font-weight: 460 !important;
  font-variation-settings: 'opsz' 36, 'SOFT' 40 !important;
  font-size: 21px !important;
  letter-spacing: -0.012em !important;
  background: transparent !important;
  border: none !important;
  padding: 0 !important;
  color: var(--ink) !important;
  box-shadow: none !important;
}
/* Meta + segment chip share a single row to keep the header compact. */
.nb-meta {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.nb-meta-dot { color: var(--mute-low); margin: 0 4px; }

.nb-segment-row { display: inline-flex; align-items: center; }
.nb-segment-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border: 1px solid var(--rule, #e5e7eb);
  background: var(--surface-2, #f9fafb);
  border-radius: 999px;
  font-size: 12px;
  color: var(--ink);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.nb-segment-chip:hover {
  background: var(--surface-3, #f3f4f6);
  border-color: var(--accent, #a8412b);
}
.nb-segment-label {
  color: var(--muted);
  font-family: var(--mono);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-size: 10.5px;
}
.nb-segment-value { font-weight: 500; }
.nb-segment-caret { color: var(--muted); font-size: 10px; }

.nb-segment-picker { width: 320px; display: flex; flex-direction: column; gap: 8px; }
.nb-segment-list { max-height: 280px; overflow-y: auto; margin-top: 4px; }
.nb-segment-item {
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.nb-segment-item:hover { background: var(--surface-2, #f3f4f6); }
.nb-segment-item.is-selected { background: rgba(168, 65, 43, 0.1); }
.nb-segment-clear { color: var(--muted); font-style: italic; }
.nb-segment-name { font-weight: 500; }
.nb-segment-desc { color: var(--muted); font-size: 11.5px; margin-top: 2px; }
.nb-segment-empty { padding: 12px; color: var(--muted); font-size: 12.5px; text-align: center; }

.nb-body {
  flex: 1;
  overflow-y: auto;
  /* Keep the gap above the first cell minimal — header already separates with a rule. */
  padding: 12px 0 64px;
}
.nb-paper {
  max-width: 920px;
  margin: 0 auto;
  padding: 0 32px;
}
</style>
