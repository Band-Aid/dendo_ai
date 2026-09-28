<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { useRoute } from 'vue-router'
import ReportCanvas from '~/components/report/ReportCanvas.vue'
import { downloadReportHtml } from '~/utils/reportExport'
import type { ReportDocument } from '~/types/report'
const route = useRoute()
const report = ref<ReportDocument | null>(null)
const loading = ref(true)
const error = ref('')
const canvas = ref<HTMLElement | null>(null)
useHead({ title: computed(() => report.value ? `${report.value.title} · Dendo` : 'Shared report · Dendo'), meta: [{ name: 'robots', content: 'noindex, nofollow' }, { name: 'referrer', content: 'no-referrer' }] })
watch(() => route.params.token, async token => {
  loading.value = true; error.value = ''; report.value = null
  try {
    const response = await fetch(`/api/reports/${encodeURIComponent(String(token))}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(response.status === 404 ? 'This report is unavailable. Its sharing link may have been revoked.' : 'The report could not be loaded. Please try again.')
    report.value = await response.json()
  } catch (err: any) { error.value = err.message }
  finally { loading.value = false }
}, { immediate: true })
async function exportHtml() {
  await nextTick()
  const element = canvas.value?.querySelector<HTMLElement>('.report-document')
  if (element && report.value) downloadReportHtml(element, report.value.title)
}
function printReport() { window.print() }
</script>

<template>
  <div class="report-reader">
    <nav v-if="report" class="report-controls" aria-label="Report actions"><span>Dendo <strong>Shared report</strong></span><div><button @click="exportHtml">Download HTML</button><button @click="printReport">Print / Save PDF</button></div></nav>
    <div v-if="loading" class="reader-state"><a-spin /> Loading report…</div>
    <div v-else-if="error" class="reader-state" role="alert"><h1>Report unavailable</h1><p>{{ error }}</p></div>
    <div v-else-if="report" ref="canvas"><ReportCanvas :report="report" /></div>
  </div>
</template>

<style scoped>
.report-reader { min-height: 100vh; padding: 24px 32px 60px; background: #F3EFE7; }
.report-controls { max-width: 1120px; margin: 0 auto 22px; display: flex; align-items: center; justify-content: space-between; gap: 20px; font-size: 12px; color: #79766E; }
.report-controls strong { font-weight: 400; padding-left: 12px; border-left: 1px solid #D0C8B8; margin-left: 12px; }
.report-controls div { display: flex; gap: 10px; }
.report-controls button { border: 1px solid #D0C8B8; padding: 8px 14px; background: #fff; color: #3C3A35; border-radius: 5px; font: inherit; cursor: pointer; }
.reader-state { text-align: center; padding: 100px 20px; }
@media(max-width: 700px) { .report-reader { padding: 16px 10px; } .report-controls { flex-wrap: wrap; } }
</style>
