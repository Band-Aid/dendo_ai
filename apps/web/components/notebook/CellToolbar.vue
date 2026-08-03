<script setup lang="ts">
import { h } from 'vue'
import { PlusOutlined, DeleteOutlined, ArrowUpOutlined, ArrowDownOutlined, FileTextOutlined, CodeOutlined, QuestionCircleOutlined } from '@ant-design/icons-vue'

defineEmits<{
  addNote: []
  addQuery: []
  addQuestion: []
  delete: []
  moveUp: []
  moveDown: []
}>()
</script>

<template>
  <div class="cell-toolbar">
    <a-tooltip title="Add note below">
      <a-button size="small" type="text" :icon="h(FileTextOutlined)" @click="$emit('addNote')" />
    </a-tooltip>
    <a-tooltip title="Add query below">
      <a-button size="small" type="text" :icon="h(CodeOutlined)" @click="$emit('addQuery')" />
    </a-tooltip>
    <a-tooltip title="Add question below">
      <a-button size="small" type="text" :icon="h(QuestionCircleOutlined)" @click="$emit('addQuestion')" />
    </a-tooltip>
    <a-divider type="vertical" />
    <a-tooltip title="Move up">
      <a-button size="small" type="text" :icon="h(ArrowUpOutlined)" @click="$emit('moveUp')" />
    </a-tooltip>
    <a-tooltip title="Move down">
      <a-button size="small" type="text" :icon="h(ArrowDownOutlined)" @click="$emit('moveDown')" />
    </a-tooltip>
    <a-divider type="vertical" />
    <a-tooltip title="Delete cell">
      <a-button size="small" type="text" danger :icon="h(DeleteOutlined)" @click="$emit('delete')" />
    </a-tooltip>
  </div>
</template>

<style scoped>
.cell-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  background: var(--paper);
  border: 1px solid var(--rule);
  border-radius: var(--r-md);
  box-shadow: 0 4px 14px rgba(40, 30, 15, 0.10);
  position: absolute;
  /* Float above the cell so it never overlaps in-cell controls like the query cell's
   * Generate / Run buttons. The toolbar is hover-only so the empty space above the
   * cell stays usable for normal reading. */
  top: -32px;
  right: 0;
  z-index: 10;
  white-space: nowrap;
}
.cell-toolbar :deep(.ant-btn) {
  color: var(--ink-2);
  width: 26px;
  height: 26px;
  padding: 0;
}
.cell-toolbar :deep(.ant-btn:hover) { color: var(--accent); }
.cell-toolbar :deep(.ant-divider-vertical) {
  border-color: var(--rule);
  margin: 0 2px;
  height: 14px;
}
</style>
