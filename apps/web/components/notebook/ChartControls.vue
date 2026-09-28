<script setup lang="ts">
import { ref } from 'vue'
import ChartSettings from './ChartSettings.vue'
import { chartTypes } from '~/utils/chartEngine'
import { chartPresentation } from '~/utils/notebookCharts'
import type { ChartCellMeta, ChartType, EmbeddedChartConfig } from '~/types/notebook'

const props = defineProps<{ config: ChartCellMeta; disabled?: boolean }>()
const emit = defineEmits<{ update: [config: EmbeddedChartConfig] }>()
const open = ref(false)
const draft = ref<Partial<ChartCellMeta>>({})
function customize() {
  draft.value = JSON.parse(JSON.stringify(props.config))
  open.value = true
}
function apply() {
  if (props.disabled) return
  emit('update', chartPresentation(draft.value))
  open.value = false
}
</script>

<template>
  <div class="chart-controls">
    <select aria-label="Chart type" :value="config.chartType" :disabled="disabled" @change="emit('update', { chartType: ($event.target as HTMLSelectElement).value as ChartType })">
      <option v-for="type in chartTypes" :key="type.value" :value="type.value">{{ type.label }}</option>
    </select>
    <a-button size="small" :disabled="disabled" @click="customize">Customize</a-button>
    <a-modal v-model:open="open" title="Customize chart" ok-text="Apply changes" :width="600" :ok-button-props="{ disabled }" @ok="apply">
      <ChartSettings v-model="draft" />
    </a-modal>
  </div>
</template>

<style scoped>
.chart-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
select { max-width: 160px; padding: 3px 6px; border: 1px solid var(--rule-strong); border-radius: 4px; background: var(--surface); color: var(--ink); font: inherit; font-size: 12px; }
</style>
