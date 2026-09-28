<script setup lang="ts">
import ChartRenderer from '~/components/notebook/ChartRenderer.vue'
import { safeMarkdown } from '~/utils/safeMarkdown'
import type { ReportDocument } from '~/types/report'
defineProps<{ report: ReportDocument; editing?: boolean; selectedId?: string }>()
defineEmits<{ select: [id: string] }>()
function display(value: unknown) { return value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value) }
function date(value: string) { return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
</script>

<template>
  <article class="report-document" :class="[`report-${report.template}`, { 'report-editing': editing }]">
    <header class="report-cover">
      <div class="report-kicker"><span>DENDO / {{ report.template === 'brief' ? 'Executive brief' : report.template === 'readout' ? 'Team readout' : 'Dashboard' }}</span><span>{{ report.period }}</span></div>
      <h1>{{ report.title || 'Untitled report' }}</h1>
      <p v-if="report.subtitle" class="report-subtitle">{{ report.subtitle }}</p>
      <div v-if="report.author || report.audience || report.publishedAt" class="report-byline"><span v-if="report.author">{{ report.author }}</span><span v-if="report.audience">Prepared for {{ report.audience }}</span><span v-if="report.publishedAt">Published {{ date(report.publishedAt) }}</span></div>
    </header>
    <section v-if="report.summary" class="report-summary"><span class="report-eyebrow">At a glance</span><div class="report-prose" v-html="safeMarkdown(report.summary)" /></section>
    <div v-if="!report.blocks.length" class="report-empty"><span>From exploration to a clear story.</span><p>Add findings from your notebook, then arrange them for your audience.</p></div>
    <div class="report-grid">
      <section v-for="block in report.blocks" :key="block.id" :class="['report-block', `report-span-${block.width}`, `report-block-${block.kind}`, { 'report-block-selected': editing && selectedId === block.id }]" :tabindex="editing ? 0 : undefined" :aria-label="editing ? `Edit ${block.title || block.kind}` : undefined" @click="editing && $emit('select', block.id)" @keydown.enter.self="editing && $emit('select', block.id)">
        <span v-if="editing" class="report-edit-hint" data-export-remove>Edit {{ block.kind }}</span>
        <h2 v-if="block.title">{{ block.title }}</h2>
        <p v-if="block.missing" class="report-missing">Source no longer available. Replace or remove this block before sharing.</p>
        <p v-else-if="block.issue" class="report-missing">{{ block.issue }}</p>
        <template v-else>
          <div v-if="block.kind === 'text'" class="report-prose" v-html="safeMarkdown(block.content || '')" />
          <ChartRenderer v-else-if="block.kind === 'chart' && block.chart" :type="block.chart.chartType || 'bar'" :x-field="block.chart.xField" :y-field="block.chart.yField" :rows="block.chart.rows" :series="block.chart.series" :options="block.chart" :height="block.width === 'third' ? 250 : 320" />
          <div v-else-if="block.kind === 'table'" class="report-table-scroll" tabindex="0" :aria-label="`${block.title} data table`">
            <table class="report-table"><thead><tr><th v-for="column in block.columns" :key="column" scope="col">{{ column }}</th></tr></thead><tbody><tr v-for="(row, i) in block.rows" :key="i"><td v-for="column in block.columns" :key="column">{{ display(row[column]) }}</td></tr></tbody></table>
            <p v-if="!block.rows?.length" class="report-no-data">No rows in this source.</p>
          </div>
        </template>
        <p v-if="block.caption" class="report-caption">{{ block.caption }}</p>
        <p v-if="block.sourceUpdatedAt" class="report-source">Source updated {{ date(block.sourceUpdatedAt) }}<span v-if="block.kind === 'table'"> · {{ block.rows?.length || 0 }} rows</span></p>
      </section>
    </div>
    <section v-if="report.nextSteps" class="report-next"><span class="report-eyebrow">Decisions & next steps</span><div class="report-prose" v-html="safeMarkdown(report.nextSteps)" /></section>
    <footer class="report-footer"><span>{{ report.title }}</span><span>Prepared with Dendo{{ report.publishedAt ? ' · Published snapshot' : '' }}</span></footer>
  </article>
</template>
