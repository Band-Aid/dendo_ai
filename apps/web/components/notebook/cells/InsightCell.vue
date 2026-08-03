<script setup lang="ts">
import { computed, h } from 'vue'
import { BulbOutlined, WarningOutlined, ExclamationCircleOutlined } from '@ant-design/icons-vue'
import type { InsightCell } from '~/types/notebook'

interface Props { cell: InsightCell }
const props = defineProps<Props>()
const meta = computed(() => props.cell.meta_json)
const severity = computed(() => meta.value?.severity ?? 'info')
const icon = computed(() => {
  if (severity.value === 'anomaly') return h(ExclamationCircleOutlined)
  if (severity.value === 'warning') return h(WarningOutlined)
  return h(BulbOutlined)
})
const colors = {
  info: { border: '#3b82f6', bg: '#eff6ff', icon: '#2563eb', text: '#1e3a8a' },
  warning: { border: '#f59e0b', bg: '#fffbeb', icon: '#d97706', text: '#92400e' },
  anomaly: { border: '#ef4444', bg: '#fef2f2', icon: '#dc2626', text: '#7f1d1d' }
}
const color = computed(() => colors[severity.value] ?? colors.info)
</script>

<template>
  <div class="insight-cell" :style="{ borderLeftColor: color.border, background: color.bg }">
    <div class="insight-icon" :style="{ color: color.icon }">
      <component :is="icon" />
    </div>
    <div class="insight-body">
      <div v-if="meta.metric" class="insight-metric" :style="{ color: color.text }">{{ meta.metric }}</div>
      <div class="insight-content" :style="{ color: color.text }">{{ cell.content }}</div>
      <div v-if="meta.comparisons?.length" class="insight-comparisons">
        <span v-for="(c, i) in meta.comparisons" :key="i" class="comparison-chip">{{ c }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.insight-cell { display: flex; gap: 12px; border-left: 4px solid; border-radius: 0 8px 8px 0; padding: 12px 16px; }
.insight-icon { font-size: 16px; padding-top: 2px; }
.insight-body { flex: 1; }
.insight-metric { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
.insight-content { font-size: 14px; line-height: 1.5; }
.insight-comparisons { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.comparison-chip { font-size: 11px; background: rgba(0,0,0,0.06); padding: 2px 8px; border-radius: 99px; }
</style>
