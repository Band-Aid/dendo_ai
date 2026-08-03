<script setup lang="ts">
import { ref, computed, h } from 'vue'
import { marked } from 'marked'
import { DatabaseOutlined, DownOutlined, UpOutlined } from '@ant-design/icons-vue'
import ResultCell from './ResultCell.vue'
import type { AgentMessageCell, ResultCell as ResultCellType } from '~/types/notebook'

interface Props { cell: AgentMessageCell }
const props = defineProps<Props>()

const expanded = ref<Record<number, boolean>>({})
const meta = computed(() => props.cell.meta_json)
const attachments = computed(() => meta.value?.dataAttachments ?? [])
const rendered = computed(() => marked.parse(props.cell.content || '') as string)

function toggleAttachment(idx: number) {
  expanded.value = { ...expanded.value, [idx]: !expanded.value[idx] }
}

function attachmentToResultCell(att: any, idx: number): ResultCellType {
  return {
    id: `att-${props.cell.id}-${idx}`,
    cell_type: 'result',
    position: 0,
    content: '',
    meta_json: {
      rows: att.rows ?? [],
      columns: att.columns ?? [],
      rowCount: att.rows?.length ?? 0,
      dsl: att.dsl ?? '',
      runAt: ''
    },
    source_cell_id: null,
    created_at: '',
    updated_at: ''
  }
}
</script>

<template>
  <div class="agent-cell">
    <div class="agent-header">
      <div class="agent-avatar">D</div>
      <span class="agent-label">Dendo</span>
    </div>
    <div class="agent-content" v-html="rendered" />
    <div v-if="attachments.length" class="agent-attachments">
      <div
        v-for="(att, idx) in attachments"
        :key="idx"
        class="attachment"
      >
        <button class="attachment-toggle" @click="toggleAttachment(idx)">
          <component :is="h(DatabaseOutlined)" style="margin-right:6px" />
          {{ att.explanation || `Query result (${att.rows?.length ?? 0} rows)` }}
          <component :is="expanded[idx] ? h(UpOutlined) : h(DownOutlined)" style="margin-left:6px" />
        </button>
        <div v-if="expanded[idx]" class="attachment-content">
          <ResultCell :cell="attachmentToResultCell(att, idx)" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-cell { background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 16px; }
.agent-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.agent-avatar {
  width: 28px; height: 28px; border-radius: 50%;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white; font-weight: 700; font-size: 13px;
  display: flex; align-items: center; justify-content: center;
}
.agent-label { font-size: 13px; font-weight: 600; color: #0369a1; }
.agent-content { line-height: 1.65; color: #1f2937; }
.agent-content :deep(p) { margin: 0.4em 0; }
.agent-content :deep(code) { background: #dbeafe; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.agent-content :deep(pre) {
  /* Light code block — dark on dark was too low-contrast for ASCII charts. */
  background: var(--subtle, #F5F2EC);
  color: var(--ink, #1F1A14);
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
  font-family: var(--mono);
  white-space: pre;
  tab-size: 2;
  font-variant-ligatures: none;
  font-feature-settings: 'liga' 0, 'calt' 0;
  line-height: 1.45;
  border: 1px solid var(--rule, #E5E0D5);
}
.agent-content :deep(ul), .agent-content :deep(ol) { margin: 0.4em 0; padding-left: 1.4em; }
.agent-attachments { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.attachment { border: 1px solid #bae6fd; border-radius: 6px; overflow: hidden; }
.attachment-toggle {
  width: 100%; display: flex; align-items: center; padding: 8px 12px;
  background: #e0f2fe; border: none; cursor: pointer; font-size: 13px; color: #0369a1;
  text-align: left;
}
.attachment-toggle:hover { background: #bae6fd; }
.attachment-content { padding: 0; }
</style>
