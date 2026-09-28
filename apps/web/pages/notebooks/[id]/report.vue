<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, onBeforeRouteLeave } from 'vue-router'
import { message, Modal } from 'ant-design-vue'
import { useApi } from '~/composables/useApi'
import { useOrg } from '~/composables/useOrg'
import ReportCanvas from '~/components/report/ReportCanvas.vue'
import ChartSettings from '~/components/notebook/ChartSettings.vue'
import { emptyReport, reportSources, renderReport, sourceBlock } from '~/utils/report'
import { chartColumns } from '~/utils/chartEngine'
import { downloadReportHtml } from '~/utils/reportExport'
import type { NotebookWithCells, ChartCellMeta } from '~/types/notebook'
import type { ReportConfig, ReportState, ReportSource } from '~/types/report'

useHead({ title: 'Report studio · Dendo' })
const route = useRoute()
const { apiFetch } = useApi()
const { currentOrgId } = useOrg()
const id = computed(() => String(route.params.id))
const notebook = ref<NotebookWithCells | null>(null)
const config = ref<ReportConfig>(emptyReport(''))
const state = ref<ReportState>({ config: null, updatedAt: null, publishedAt: null, shareToken: null })
const saved = ref('')
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const preview = ref(false)
const tab = ref<'details' | 'content' | 'block'>('details')
const selectedId = ref('')
const search = ref('')
const shareOpen = ref(false)
const canvas = ref<HTMLElement | null>(null)
const sources = computed(() => notebook.value ? reportSources(notebook.value) : [])
const filteredSources = computed(() => sources.value.filter(s => s.title.toLowerCase().includes(search.value.toLowerCase())))
const document = computed(() => renderReport(config.value, sources.value))
const selected = computed(() => config.value.blocks.find(b => b.id === selectedId.value))
const selectedSource = computed(() => sources.value.find(s => s.key === selected.value?.sourceKey))
const dirty = computed(() => saved.value !== JSON.stringify(config.value))
const shareUrl = computed(() => state.value.shareToken && typeof window !== 'undefined' ? `${window.location.origin}/reports/${state.value.shareToken}` : '')
const sourceChart = computed(() => ({ ...selectedSource.value?.chart, ...selected.value?.chart }))
const availableColumns = computed(() => selectedSource.value?.columns || chartColumns(selectedSource.value?.chart || {}))
const publishedChanged = computed(() => !!state.value.publishedAt && (dirty.value || (state.value.updatedAt || '') > state.value.publishedAt! || document.value.blocks.some(b => (b.sourceUpdatedAt || '') > state.value.publishedAt!)))

let requestVersion = 0
async function load() {
  const version = ++requestVersion
  loading.value = true; error.value = ''
  try {
    const [nb, report] = await Promise.all([
      apiFetch<NotebookWithCells>(`/api/notebooks/${id.value}`),
      apiFetch<ReportState>(`/api/notebooks/${id.value}/report`)
    ])
    if (version !== requestVersion) return
    notebook.value = nb; state.value = report
    config.value = report.config || emptyReport(nb.title)
    saved.value = JSON.stringify(config.value)
  } catch (err: any) { if (version === requestVersion) error.value = err.message }
  finally { if (version === requestVersion) loading.value = false }
}
watch([id, currentOrgId], load, { immediate: true })

function select(blockId: string) { selectedId.value = blockId; tab.value = 'block' }
function addSource(source: ReportSource) {
  const block = sourceBlock(source, crypto.randomUUID())
  if (config.value.template === 'readout') block.width = 'full'
  config.value.blocks.push(block); select(block.id)
}
function addText(kind: 'heading' | 'text') {
  const block = { id: crypto.randomUUID(), kind, title: kind === 'heading' ? 'Section title' : 'Key finding', content: '', width: 'full' as const }
  config.value.blocks.push(block); select(block.id)
}
function applyLayout(template: ReportConfig['template']) {
  config.value.template = template
  for (const block of config.value.blocks) block.width = block.kind === 'chart' ? (template === 'readout' ? 'full' : 'half') : 'full'
}
async function refreshSources() {
  busy.value = true
  try { notebook.value = await apiFetch<NotebookWithCells>(`/api/notebooks/${id.value}`); message.success('Notebook sources refreshed') }
  catch (err: any) { message.error(err.message) }
  finally { busy.value = false }
}
function useNotebookFindings() {
  const existing = new Set(config.value.blocks.map(b => b.sourceKey))
  for (const source of sources.value) if (!existing.has(source.key)) config.value.blocks.push({ ...sourceBlock(source, crypto.randomUUID()), width: config.value.template === 'readout' || source.kind !== 'chart' ? 'full' : 'half' })
}
function move(direction: number) {
  const i = config.value.blocks.findIndex(b => b.id === selectedId.value)
  if (i < 0 || i + direction < 0 || i + direction >= config.value.blocks.length) return
  const [block] = config.value.blocks.splice(i, 1); config.value.blocks.splice(i + direction, 0, block)
}
function remove() { config.value.blocks = config.value.blocks.filter(b => b.id !== selectedId.value); selectedId.value = ''; tab.value = 'content' }
function duplicate() {
  if (!selected.value) return
  const copy = { ...JSON.parse(JSON.stringify(selected.value)), id: crypto.randomUUID() }
  const i = config.value.blocks.findIndex(b => b.id === selectedId.value)
  config.value.blocks.splice(i + 1, 0, copy); select(copy.id)
}
function setChart(value: Partial<ChartCellMeta>) {
  if (!selected.value) return
  const { rows, series, columns, dsl, sourceResultCellId, title, ...settings } = value
  selected.value.chart = settings
}
function toggleColumn(column: string, checked: boolean) {
  if (!selected.value) return
  const cols = selected.value.columns || [...availableColumns.value]
  const next = checked ? [...cols, column] : cols.filter(c => c !== column)
  if (!next.length) { message.info('Keep at least one visible column.'); return }
  selected.value.columns = [...new Set(next)]
}
async function persist(): Promise<boolean> {
  if (!config.value.title.trim()) { message.error('Give this report a title.'); return false }
  try {
    const submitted = JSON.stringify(config.value)
    const result = await apiFetch<ReportState>(`/api/notebooks/${id.value}/report`, { method: 'PUT', body: { config: config.value, expectedUpdatedAt: state.value.updatedAt } })
    state.value = result
    // Inputs are disabled while saving; keep server-normalized settings locally.
    if (JSON.stringify(config.value) === submitted) config.value = result.config!
    saved.value = JSON.stringify(result.config)
    return true
  } catch (err: any) { message.error(err.message); return false }
}
async function save() { busy.value = true; try { if (await persist()) message.success('Report saved') } finally { busy.value = false } }
async function publish() {
  busy.value = true
  try {
    if (!(await persist())) return
    state.value = await apiFetch<ReportState>(`/api/notebooks/${id.value}/report/publish`, { method: 'POST', body: { expectedUpdatedAt: state.value.updatedAt } })
    message.success('Published snapshot is ready to share')
  } catch (err: any) { message.error(err.message) }
  finally { busy.value = false }
}
async function revoke() {
  busy.value = true
  try { state.value = await apiFetch<ReportState>(`/api/notebooks/${id.value}/report/share`, { method: 'DELETE' }); message.success('Share link revoked') }
  catch (err: any) { message.error(err.message) }
  finally { busy.value = false }
}
async function copyLink() {
  try { await navigator.clipboard.writeText(shareUrl.value); message.success('Report link copied') }
  catch { message.info('Select and copy the link below.') }
}
async function exportHtml() {
  await nextTick()
  const element = canvas.value?.querySelector<HTMLElement>('.report-document')
  if (element) downloadReportHtml(element, config.value.title)
}
async function printReport() { await nextTick(); window.print() }
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
onBeforeRouteLeave(() => {
  if (!dirty.value) return true
  return new Promise<boolean>(resolve => Modal.confirm({ title: 'Leave with unsaved report changes?', content: 'Save the report to keep your latest edits.', okText: 'Leave without saving', cancelText: 'Keep editing', onOk: () => resolve(true), onCancel: () => resolve(false) }))
})
</script>

<template>
  <div class="report-builder">
    <header class="report-builder-toolbar">
      <div class="builder-heading"><NuxtLink :to="`/notebooks/${id}`">← Notebook</NuxtLink><span class="builder-divider" /><strong>Report studio</strong><span v-if="!loading" class="save-status">{{ dirty ? 'Unsaved changes' : state.updatedAt ? 'All changes saved' : 'Draft' }}</span></div>
      <div class="builder-actions"><button :class="{ active: preview }" @click="preview = !preview">{{ preview ? '← Edit report' : 'Preview' }}</button><button :disabled="busy || loading || !!error" @click="save">{{ busy ? 'Saving…' : 'Save' }}</button><button class="primary" :disabled="busy || loading || !!error" @click="shareOpen = true">Share & export ↗</button></div>
    </header>
    <div v-if="loading" class="builder-state"><a-spin /> Loading your notebook…</div>
    <div v-else-if="error" class="builder-state" role="alert"><p>{{ error }}</p><button @click="load">Try again</button></div>
    <div v-else class="report-workspace" :class="{ 'is-preview': preview }">
      <aside v-if="!preview" class="report-inspector">
        <nav class="inspector-tabs" aria-label="Report editor"><button :class="{ active: tab === 'details' }" @click="tab = 'details'">Report</button><button :class="{ active: tab === 'content' }" @click="tab = 'content'">Content <small>{{ config.blocks.length }}</small></button><button :class="{ active: tab === 'block' }" :disabled="!selected" @click="tab = 'block'">Block</button></nav>
        <fieldset :disabled="busy" class="inspector-fields">
          <template v-if="tab === 'details'">
            <div class="inspector-intro"><h2>Shape the story</h2><p>Choose a format, set the context, and bring forward what matters.</p></div>
            <div class="layout-presets" role="group" aria-label="Report format"><button v-for="preset in ([{ id: 'brief', name: 'Executive brief', detail: 'Summary → evidence → decisions' }, { id: 'readout', name: 'Team readout', detail: 'Findings and supporting detail' }, { id: 'dashboard', name: 'Dashboard', detail: 'A visual overview of performance' }] as const)" :key="preset.id" :class="{ chosen: config.template === preset.id }" :aria-pressed="config.template === preset.id" @click="applyLayout(preset.id)"><strong>{{ preset.name }}</strong><span>{{ preset.detail }}</span></button></div>
            <label>Report title<input v-model="config.title" maxlength="200" placeholder="e.g. Product adoption · September"></label>
            <label>Subtitle<textarea v-model="config.subtitle" rows="2" placeholder="The question this report answers" /></label>
            <div class="field-pair"><label>Prepared by<input v-model="config.author" placeholder="Name or team"></label><label>Audience<input v-model="config.audience" placeholder="Leadership team"></label></div>
            <label>Reporting period<input v-model="config.period" placeholder="September 2026"></label>
            <label>Executive summary<textarea v-model="config.summary" rows="5" placeholder="What changed? Why does it matter? What should the reader know first?" /><small>Markdown supported</small></label>
            <label>Decisions & next steps<textarea v-model="config.nextSteps" rows="5" placeholder="The recommendation, owner, and next milestone." /></label>
            <button class="primary full-width" @click="tab = 'content'">Add notebook findings →</button>
          </template>
          <template v-else-if="tab === 'content'">
            <div class="inspector-intro"><h2>Your report outline</h2><p>Arrange the evidence in the order your reader needs it.</p></div>
            <div class="add-writing"><button @click="addText('heading')">+ Section</button><button @click="addText('text')">+ Written finding</button></div>
            <ol class="report-outline"><li v-for="(block, i) in config.blocks" :key="block.id"><button @click="select(block.id)"><span>{{ String(i + 1).padStart(2, '0') }}</span><strong>{{ block.title || block.kind }}</strong><small>{{ block.kind }}</small></button></li></ol>
            <p v-if="!config.blocks.length" class="inspector-empty">Your report is empty. Add a finding below or write a section.</p>
            <div class="library-heading"><h3>From this notebook</h3><button :disabled="!sources.length" @click="useNotebookFindings">Add all</button></div>
            <button :disabled="busy" @click="refreshSources">↻ Refresh notebook data</button>
            <input v-model="search" aria-label="Search notebook findings" placeholder="Search findings…">
            <p v-if="!sources.length" class="inspector-empty">Add notes or run questions in the notebook first. Your findings will appear here.</p>
            <div class="source-library"><button v-for="source in filteredSources" :key="source.key" @click="addSource(source)"><small>{{ source.kind === 'text' ? 'Finding' : source.kind }}</small><strong>{{ source.title }}</strong><span>+ Add to report</span></button></div>
          </template>
          <template v-else-if="selected">
            <div class="inspector-intro"><h2>Edit this block</h2><p>Changes here apply to the report. Your notebook stays available for exploration.</p></div>
            <div class="block-actions"><button :disabled="config.blocks[0]?.id === selectedId" aria-label="Move block up" @click="move(-1)">↑</button><button :disabled="config.blocks.at(-1)?.id === selectedId" aria-label="Move block down" @click="move(1)">↓</button><button @click="duplicate">Duplicate</button><button class="danger" @click="remove">Remove</button></div>
            <label>Heading<input v-model="selected.title" maxlength="1000"></label>
            <label>Width<select aria-label="Width" v-model="selected.width"><option value="full">Full width</option><option value="half">Half width</option><option value="third">One third</option></select></label>
            <label v-if="selected.kind === 'chart' || selected.kind === 'table'">Display as<select aria-label="Display as" v-model="selected.kind"><option value="chart">Visualization</option><option value="table">Data table</option></select></label>
            <template v-if="selected.kind === 'text'"><label>Finding<textarea :value="selected.content ?? selectedSource?.content ?? ''" rows="12" @input="selected.content = ($event.target as HTMLTextAreaElement).value" /><small>Markdown supported</small></label><button v-if="selected.sourceKey && selected.content !== undefined" @click="delete selected.content">Use notebook text</button></template>
            <ChartSettings v-if="selected.kind === 'chart'" :model-value="sourceChart" @update:model-value="setChart" />
            <div v-if="selected.kind === 'table'" class="column-picker"><span>Visible columns</span><button v-if="selected.columns" @click="delete selected.columns">Reset to current source columns</button><label v-for="column in availableColumns" :key="column"><input type="checkbox" :checked="!selected.columns || selected.columns.includes(column)" @change="toggleColumn(column, ($event.target as HTMLInputElement).checked)">{{ column }}</label></div>
            <label v-if="selected.kind !== 'heading'">Caption / takeaway<textarea v-model="selected.caption" rows="3" placeholder="Explain what the reader should notice." /></label>
            <p v-if="selectedSource" class="source-note">Linked to: {{ selectedSource.title }}. Draft previews use the latest saved notebook data; sharing captures a snapshot.</p>
          </template>
        </fieldset>
      </aside>
      <main ref="canvas" class="report-preview"><div v-if="preview" class="preview-label" data-export-remove>Reader preview · {{ state.publishedAt ? 'Draft changes appear after publishing again' : 'Not published yet' }}</div><ReportCanvas :report="document" :editing="!preview && !busy" :selected-id="selectedId" @select="select" /></main>
    </div>
    <a-modal v-model:open="shareOpen" title="Share your report" :footer="null" :width="540">
      <div class="share-panel">
        <p>Publish a read-only snapshot of the selected report content. Anyone with the link can view it without opening the notebook.</p>
        <p v-if="publishedChanged" class="share-status">Your draft or source data has changed. Publish again to update the shared report.</p>
        <p v-else-if="state.publishedAt" class="share-status">Published {{ new Date(state.publishedAt).toLocaleString() }}. Later notebook edits do not change this snapshot.</p>
        <a-button type="primary" :loading="busy" :disabled="!config.blocks.length" @click="publish">{{ state.shareToken ? 'Update published snapshot' : 'Publish & create link' }}</a-button>
        <p v-if="!config.blocks.length" class="source-note">Add at least one block before publishing.</p>
        <div v-if="shareUrl" class="share-link"><label>Share link<a-input :value="shareUrl" readonly @focus="($event.target as HTMLInputElement).select()" /></label><a-space><a-button @click="copyLink">Copy link</a-button><a :href="shareUrl" target="_blank" rel="noopener noreferrer">Open report ↗</a><a-popconfirm title="Revoke this link? Anyone using it will lose access." @confirm="revoke"><a-button type="text" danger :disabled="busy">Revoke</a-button></a-popconfirm></a-space></div>
        <div class="export-options"><h3>Export this draft</h3><p>Download a standalone report or save as PDF from your browser’s print dialog.</p><a-space><a-button @click="exportHtml">Download HTML</a-button><a-button @click="shareOpen = false; printReport()">Print / Save PDF</a-button></a-space></div>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.report-builder { height: 100vh; display: flex; flex-direction: column; background: #F3EFE7; }
.report-builder button { font: inherit; cursor: pointer; border: 1px solid var(--rule-strong); background: #fff; color: var(--ink-2); padding: 7px 12px; border-radius: 5px; font-size: 12px; }
.report-builder button:hover { border-color: var(--accent); color: var(--accent); }
.report-builder button:disabled { opacity: .45; cursor: not-allowed; }
.report-builder .primary { color: white; background: var(--accent); border-color: var(--accent); }
.report-builder-toolbar { display: flex; justify-content: space-between; gap: 20px; align-items: center; padding: 14px 24px; background: var(--paper); border-bottom: 1px solid var(--rule-strong); flex-shrink: 0; }
.builder-heading, .builder-actions { display: flex; gap: 12px; align-items: center; }
.builder-heading a { font-size: 12px; color: var(--muted); }
.builder-heading strong { font-family: var(--serif); font-size: 21px; font-weight: 500; }
.builder-divider { width: 1px; height: 22px; background: var(--rule-strong); }
.save-status { font-size: 10px; color: var(--muted); }
.report-workspace { display: grid; grid-template-columns: 320px minmax(0, 1fr); min-height: 0; flex: 1; }
.report-workspace.is-preview { grid-template-columns: 1fr; }
.report-inspector { overflow-y: auto; background: var(--paper); border-right: 1px solid var(--rule-strong); }
.inspector-tabs { display: flex; position: sticky; top: 0; z-index: 3; background: var(--paper); padding: 12px 16px 0; border-bottom: 1px solid var(--rule); }
.inspector-tabs button { flex: 1; border: 0; border-radius: 0; background: none; padding: 10px 4px; border-bottom: 2px solid transparent; }
.inspector-tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
.inspector-tabs small { color: var(--muted); margin-left: 4px; }
.inspector-fields { min-width: 0; display: flex; flex-direction: column; gap: 18px; border: 0; margin: 0; padding: 22px 20px 40px; }
.inspector-intro h2 { font: 500 24px/1.2 var(--serif); margin: 0 0 8px; letter-spacing: -.02em; }
.inspector-intro p, .inspector-empty { color: var(--muted); font-size: 12px; line-height: 1.6; margin: 0; }
.inspector-fields label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--ink-2); }
.inspector-fields input:not([type=checkbox]), .inspector-fields textarea, .inspector-fields select { width: 100%; min-width: 0; padding: 8px 10px; border: 1px solid var(--rule-strong); border-radius: 5px; background: white; color: var(--ink); font: inherit; font-size: 12px; }
.inspector-fields textarea { resize: vertical; line-height: 1.65; }
.inspector-fields small { color: var(--muted); font-size: 10px; }
.field-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.layout-presets { display: grid; gap: 7px; }
.layout-presets button { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 11px 12px; }
.layout-presets button.chosen { border-color: var(--accent); background: #FAF0EB; }
.layout-presets span { font-size: 10px; color: var(--muted); }
.report-preview { overflow-y: auto; padding: 32px; min-width: 0; }
.preview-label { text-align: center; font-size: 11px; color: var(--muted); margin: 0 0 20px; }
.add-writing, .block-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.block-actions .danger { color: #8B2F2F; }
.report-outline { padding: 0; list-style: none; display: grid; gap: 6px; margin: 0; }
.report-outline button { width: 100%; display: flex; align-items: center; gap: 8px; text-align: left; }
.report-outline strong { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.report-outline span { color: var(--muted); font-size: 10px; }
.library-heading { border-top: 1px solid var(--rule); padding-top: 22px; display: flex; align-items: center; justify-content: space-between; }
.library-heading h3 { margin: 0; font-size: 13px; font-weight: 500; }
.library-heading button { padding: 4px 8px; font-size: 11px; }
.source-library { display: grid; gap: 8px; }
.source-library button { display: flex; flex-direction: column; text-align: left; gap: 5px; padding: 12px; }
.source-library small { text-transform: uppercase; font-size: 9px; letter-spacing: .08em; }
.source-library strong { font-size: 12px; font-weight: 500; line-height: 1.5; overflow-wrap: anywhere; }
.source-library span { font-size: 10px; color: var(--accent); }
.source-note { color: var(--muted); font-size: 11px; line-height: 1.65; }
.column-picker { display: grid; gap: 8px; font-size: 12px; }
.column-picker label { flex-direction: row; align-items: center; }
.builder-state { text-align: center; padding: 80px; }
.share-panel { display: flex; flex-direction: column; gap: 14px; padding-top: 10px; }
.share-panel p { margin: 0; font-size: 13px; color: var(--ink-2); }
.share-panel .share-status { padding: 12px; background: var(--subtle); font-size: 12px; }
.share-link { display: grid; gap: 12px; }
.share-link label { display: grid; gap: 6px; font-size: 12px; }
.share-link a { color: var(--accent); font-size: 12px; }
.export-options { padding-top: 20px; border-top: 1px solid var(--rule); display: grid; gap: 10px; }
.export-options h3 { margin: 0; font-size: 15px; }
.export-options p { color: var(--muted); font-size: 12px; }
@media(max-width: 1000px) { .report-workspace { grid-template-columns: 280px minmax(0, 1fr); } .report-preview { padding: 20px; } .save-status { display: none; } }
@media(max-width: 700px) { .report-builder { height: auto; min-height: 100vh; } .report-builder-toolbar { flex-wrap: wrap; gap: 12px; padding: 12px 16px; } .builder-actions { width: 100%; } .report-workspace { display: flex; flex-direction: column; } .report-inspector { max-height: 55vh; border-bottom: 1px solid var(--rule-strong); } .report-preview { padding: 12px; overflow: visible; } }
</style>
