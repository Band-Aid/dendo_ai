<script setup lang="ts">
import { ref, computed, h } from 'vue'
import { marked } from 'marked'
import { MessageOutlined, EditOutlined } from '@ant-design/icons-vue'
import { useI18n } from '~/composables/useI18n'
import type { NotebookCell } from '~/types/notebook'

const { t } = useI18n()

interface Props { cell: NotebookCell }
const props = defineProps<Props>()
const emit = defineEmits<{
  save: [content: string]
  askAbout: []
}>()

const editing = ref(false)
const draft = ref(props.cell.content)

const rendered = computed(() => {
  const content = props.cell.content
  if (!content.trim()) return `<em class="note-empty">${t('ui.note.empty')}</em>`
  return marked.parse(content) as string
})

function startEdit() {
  draft.value = props.cell.content
  editing.value = true
}

function save() {
  editing.value = false
  if (draft.value !== props.cell.content) emit('save', draft.value)
}
</script>

<template>
  <div class="note-cell-wrap">
    <div class="note-cell">
      <div v-if="editing" class="note-edit">
        <a-textarea
          v-model:value="draft"
          :auto-size="{ minRows: 2, maxRows: 20 }"
          style="font-family: inherit; font-size: 14px; resize: vertical;"
          @blur="save"
          @keydown.ctrl.enter="save"
          @keydown.meta.enter="save"
        />
        <div class="note-edit-hint">Ctrl+Enter to save</div>
      </div>
      <div v-else class="note-rendered" v-html="rendered" />
    </div>
    <div v-if="!editing" class="note-actions">
      <a-tooltip :title="t('ui.note.edit')" placement="left">
        <a-button
          class="note-action-btn"
          size="small"
          type="text"
          :icon="h(EditOutlined)"
          @click.stop="startEdit"
        />
      </a-tooltip>
      <a-tooltip :title="t('ui.note.askAbout')" placement="left">
        <a-button
          class="note-action-btn"
          size="small"
          type="text"
          :icon="h(MessageOutlined)"
          @click.stop="emit('askAbout')"
        />
      </a-tooltip>
    </div>
  </div>
</template>

<style scoped>
.note-cell-wrap {
  position: relative;
  padding: 6px 0;
}
.note-cell-wrap:hover .note-actions { opacity: 1; }
.note-actions {
  position: absolute;
  top: 4px;
  right: -4px;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.note-action-btn {
  color: var(--muted);
}
.note-cell {
  min-height: 28px;
}
.note-rendered {
  line-height: 1.7;
  color: var(--ink);
  font-family: var(--sans);
  font-size: 16px;
  letter-spacing: -0.003em;
}
.note-rendered :deep(.note-empty) {
  color: var(--mute-low);
  font-family: var(--serif);
  font-variation-settings: 'opsz' 18, 'SOFT' 70;
  font-style: italic;
  font-size: 15px;
  not-italic: 1;
}
.note-rendered :deep(h1),
.note-rendered :deep(h2),
.note-rendered :deep(h3) {
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 36, 'SOFT' 30;
  letter-spacing: -0.018em;
  color: var(--ink);
  margin: 0.8em 0 0.3em;
}
.note-rendered :deep(h1) { font-size: 30px; line-height: 1.15; }
.note-rendered :deep(h2) { font-size: 24px; line-height: 1.2; }
.note-rendered :deep(h3) { font-size: 19px; line-height: 1.3; }
.note-rendered :deep(p) { margin: 0.55em 0; }
.note-rendered :deep(strong) { color: var(--ink); font-weight: 600; }
.note-rendered :deep(em) {
  font-family: var(--serif);
  font-style: italic;
  font-variation-settings: 'opsz' 18, 'SOFT' 100, 'WONK' 1;
  color: var(--ink);
}
.note-rendered :deep(code) {
  background: var(--subtle);
  color: var(--ink);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 12.5px;
  font-family: var(--mono);
  border: 1px solid var(--rule);
}
.note-rendered :deep(pre) {
  /* Light, high-contrast code block — dark cream-on-near-black washed out
   * for ASCII chart glyphs (▼ ● ★ ─). Keep monospaced glyphs cell-accurate. */
  background: var(--subtle, #F5F2EC);
  color: var(--ink, #1F1A14);
  padding: 14px 16px;
  border-radius: var(--r-md);
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.45;
  border: 1px solid var(--rule, #E5E0D5);
  white-space: pre;
  tab-size: 2;
  font-variant-ligatures: none;
  font-feature-settings: 'liga' 0, 'calt' 0;
}
.note-rendered :deep(pre code) {
  background: transparent;
  border: none;
  padding: 0;
}
.note-rendered :deep(ul),
.note-rendered :deep(ol) { padding-left: 20px; margin: 0.5em 0; }
.note-rendered :deep(blockquote) {
  border-left: 2px solid var(--accent);
  margin: 0.6em 0;
  padding: 0 0 0 16px;
  color: var(--ink-2);
  font-family: var(--serif);
  font-variation-settings: 'opsz' 18, 'SOFT' 70;
  font-style: italic;
  font-size: 15px;
}
.note-rendered :deep(a) { color: var(--accent); border-bottom: 1px solid var(--accent-soft); }
.note-rendered :deep(a:hover) { border-bottom-color: var(--accent); }
.note-rendered :deep(hr) {
  border: none;
  border-top: 1px solid var(--rule);
  margin: 1.2em 0;
}

.note-edit { padding: 0; }
.note-edit :deep(.ant-input) {
  font-family: var(--sans) !important;
  font-size: 16px !important;
  line-height: 1.65 !important;
  color: var(--ink) !important;
  background: var(--surface) !important;
  border: 1px solid var(--rule) !important;
  border-radius: var(--r-sm) !important;
  padding: 10px 12px !important;
}
.note-edit-hint {
  font-size: 11px;
  color: var(--muted);
  margin-top: 6px;
  font-family: var(--mono);
  letter-spacing: 0.02em;
}
</style>
