<script setup lang="ts">
import { ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useApi } from '~/composables/useApi'
import { useOrg } from '~/composables/useOrg'
import { useI18n } from '~/composables/useI18n'

const { t } = useI18n()
const { apiFetch } = useApi()
const { currentOrgId } = useOrg()

interface NotebookLite { id: string; title: string }

const props = defineProps<{
  open: boolean
  /** Question text, placeholders already filled by the caller. */
  question: string
  /** When the question was already asked (map Ask panel), the cell lands
   *  PRE-RUN: answer + data included, so Re-run replays deterministically. */
  result?: {
    answer: string
    aggregations: unknown[]
    summaryCharts: unknown[]
  } | null
  /** Concept this question was asked from (a cause/action/KPI button), if any —
   *  carried onto the saved cell so future runs keep using that concept's context. */
  originConceptId?: string | null
}>()
const emit = defineEmits<{ close: []; saved: [notebookId: string] }>()

const notebooks = ref<NotebookLite[]>([])
const loading = ref(false)
const saving = ref(false)
const selectedNotebookId = ref<string | null>(null)
const draft = ref('')

watch(() => props.open, async (open) => {
  if (!open) return
  draft.value = props.question
  selectedNotebookId.value = null
  loading.value = true
  try {
    notebooks.value = await apiFetch<NotebookLite[]>('/api/notebooks', {
      headers: { 'x-org-id': currentOrgId.value }
    })
    if (notebooks.value.length === 1) selectedNotebookId.value = notebooks.value[0].id
  } catch (err: any) {
    message.error(err.message || 'Failed to load notebooks')
  } finally {
    loading.value = false
  }
})

async function save() {
  if (!selectedNotebookId.value || !draft.value.trim()) return
  saving.value = true
  try {
    // With a result attached the cell arrives already-run (mirrors what a
    // notebook first-run would have stored, incl. lastRunQuestion so an
    // unedited Re-run replays the same DSLs deterministically). Without one it
    // lands blank, exactly like the notebook's own "Add question".
    const content = draft.value.trim()
    const meta = props.result
      ? {
          answer: props.result.answer,
          aggregations: props.result.aggregations,
          summaryCharts: props.result.summaryCharts,
          lastRunAt: new Date().toISOString(),
          lastError: null,
          // The ORIGINAL asked question — if the user edited the text in this
          // modal, content ≠ lastRunQuestion and the notebook's next run
          // correctly re-derives queries instead of replaying these.
          lastRunQuestion: props.question,
          ...(props.originConceptId ? { originConceptId: props.originConceptId } : {})
        }
      : (props.originConceptId ? { originConceptId: props.originConceptId } : {})
    await apiFetch(`/api/notebooks/${selectedNotebookId.value}/cells`, {
      method: 'POST',
      headers: { 'x-org-id': currentOrgId.value },
      body: { cell_type: 'question', content, meta_json: meta }
    })
    message.success(t('ui.ontology.questionSaved'))
    emit('saved', selectedNotebookId.value)
    emit('close')
  } catch (err: any) {
    message.error(err.message || 'Failed to save question')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <a-modal
    :open="open"
    :title="t('ui.ontology.saveAsQuestion')"
    :confirm-loading="saving"
    :ok-text="t('ui.ontology.saveQuestionOk')"
    :ok-button-props="{ disabled: !selectedNotebookId || !draft.trim() }"
    @ok="save"
    @cancel="emit('close')"
  >
    <div class="sq-body">
      <label class="sq-label">{{ t('ui.ontology.questionLabel') }}</label>
      <a-textarea v-model:value="draft" :auto-size="{ minRows: 2, maxRows: 6 }" />

      <label class="sq-label">{{ t('ui.ontology.pickNotebook') }}</label>
      <a-spin :spinning="loading">
        <a-select
          v-model:value="selectedNotebookId"
          style="width: 100%"
          :placeholder="t('ui.ontology.pickNotebookPh')"
          :options="notebooks.map(n => ({ value: n.id, label: n.title }))"
          show-search
          option-filter-prop="label"
        />
      </a-spin>
      <p class="sq-hint">{{ t('ui.ontology.saveQuestionHint') }}</p>
    </div>
  </a-modal>
</template>

<style scoped>
.sq-body { display: flex; flex-direction: column; gap: 8px; }
.sq-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin-top: 6px;
}
.sq-hint {
  font-size: 12px;
  color: var(--muted);
  font-style: italic;
  margin: 6px 0 0;
}
</style>
