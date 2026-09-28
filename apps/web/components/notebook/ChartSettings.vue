<script setup lang="ts">
import { computed } from 'vue'
import { chartTypes, chartColumns } from '~/utils/chartEngine'
import type { ChartCellMeta } from '~/types/notebook'
const props = defineProps<{ modelValue: Partial<ChartCellMeta> }>()
const emit = defineEmits<{ 'update:modelValue': [value: Partial<ChartCellMeta>] }>()
const columns = computed(() => chartColumns(props.modelValue))
function patch(key: string, value: unknown) { emit('update:modelValue', { ...props.modelValue, [key]: value }) }
</script>

<template>
  <div class="chart-settings">
    <label>Visualization<select aria-label="Visualization" :value="modelValue.chartType || 'bar'" @change="patch('chartType', ($event.target as HTMLSelectElement).value)"><option v-for="type in chartTypes" :key="type.value" :value="type.value">{{ type.label }}</option></select></label>
    <template v-if="!modelValue.series?.length">
      <label>Category / X axis<select aria-label="Category / X axis" :value="modelValue.xField" @change="patch('xField', ($event.target as HTMLSelectElement).value)"><option value="">Select field</option><option v-for="col in columns" :key="col">{{ col }}</option></select></label>
      <label>Value / Y axis<select aria-label="Value / Y axis" :value="modelValue.yField" @change="emit('update:modelValue', { ...modelValue, yField: ($event.target as HTMLSelectElement).value, yFields: [] })"><option value="">Select field</option><option v-for="col in columns" :key="col">{{ col }}</option></select></label>
      <label>Split by<select aria-label="Split by" :value="modelValue.groupField || ''" @change="patch('groupField', ($event.target as HTMLSelectElement).value)"><option value="">No grouping</option><option v-for="col in columns" :key="col">{{ col }}</option></select></label>
      <label class="settings-wide">Compare value fields<select multiple :value="modelValue.yFields || []" @change="patch('yFields', Array.from(($event.target as HTMLSelectElement).selectedOptions).map(o => o.value))"><option v-for="col in columns" :key="col">{{ col }}</option></select><small>Optional: choose all metrics to plot together.</small></label>
    </template>
    <label>Combine observations<select aria-label="Combine observations" :value="modelValue.aggregation || 'sum'" @change="patch('aggregation', ($event.target as HTMLSelectElement).value)"><option value="sum">Sum</option><option value="average">Average</option><option value="min">Minimum</option><option value="max">Maximum</option><option value="last">Last non-empty value</option></select></label>
    <label>Number format<select aria-label="Number format" :value="modelValue.numberFormat || 'number'" @change="patch('numberFormat', ($event.target as HTMLSelectElement).value)"><option value="number">Number</option><option value="compact">Compact (1.2K)</option><option value="percent">Percent (0.25 → 25%)</option><option value="currency">Currency</option></select></label>
    <label v-if="modelValue.numberFormat === 'currency'">Currency<select aria-label="Currency" :value="modelValue.currency || 'USD'" @change="patch('currency', ($event.target as HTMLSelectElement).value)"><option>USD</option><option>JPY</option><option>EUR</option><option>GBP</option></select></label>
    <label>Decimal places<input type="number" min="0" max="6" :value="modelValue.decimals ?? 1" @change="patch('decimals', Math.min(6, Math.max(0, Number(($event.target as HTMLInputElement).value))))"></label>
    <label>Order<select aria-label="Order" :value="modelValue.sort || 'source'" @change="patch('sort', ($event.target as HTMLSelectElement).value)"><option value="source">Source order</option><option value="descending">Highest first</option><option value="ascending">Lowest first</option></select></label>
    <label>Colors<select aria-label="Colors" :value="modelValue.palette || 'editorial'" @change="patch('palette', ($event.target as HTMLSelectElement).value)"><option value="editorial">Editorial</option><option value="ocean">Ocean</option><option value="forest">Forest</option></select></label>
    <label>X axis label<input :value="modelValue.xAxisLabel" @input="patch('xAxisLabel', ($event.target as HTMLInputElement).value)"></label>
    <label>Y axis / unit label<input :value="modelValue.yAxisLabel" @input="patch('yAxisLabel', ($event.target as HTMLInputElement).value)"></label>
    <label v-if="modelValue.chartType === 'metric'">Target (optional)<input type="number" :value="modelValue.target" @input="patch('target', ($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value))"></label>
    <label class="check"><input type="checkbox" :checked="modelValue.showLegend !== false" @change="patch('showLegend', ($event.target as HTMLInputElement).checked)"> Show legend</label>
    <label class="check"><input type="checkbox" :checked="modelValue.showLabels === true" @change="patch('showLabels', ($event.target as HTMLInputElement).checked)"> Show values</label>
  </div>
</template>

<style scoped>
.chart-settings { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--ink-2); }
select, input:not([type=checkbox]) { width: 100%; min-width: 0; padding: 7px 8px; border: 1px solid var(--rule-strong); border-radius: 5px; background: white; color: var(--ink); font: inherit; }
select[multiple] { height: 75px; }
.check { flex-direction: row; align-items: center; }
.settings-wide { grid-column: 1 / -1; }
small { color: var(--muted); }
</style>
