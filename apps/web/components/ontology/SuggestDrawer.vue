<script setup lang="ts">
import { ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useApi } from '~/composables/useApi'
import { useOrg } from '~/composables/useOrg'
import { useI18n } from '~/composables/useI18n'
import type { ConceptProposal, OntologyConcept } from '~/types/ontology'

const { t } = useI18n()
const { apiFetch } = useApi()
const { currentOrgId } = useOrg()

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; accepted: [concept: OntologyConcept] }>()

/** True while the SSE stream is open — cards keep arriving. */
const streaming = ref(false)
const proposals = ref<ConceptProposal[]>([])
const note = ref('')
const acceptingIdx = ref<number | null>(null)
/** Evidence source: what the team ASKS vs what the map + usage data SHOW. */
const source = ref<'conversations' | 'ontology'>('ontology')

let abortController: AbortController | null = null
/** Server emits per-proposal `index`es; dismiss/accept splices `proposals`,
 *  so updates route through this map to hit the right card object. */
let byIndex = new Map<number, ConceptProposal>()

watch(() => props.open, (open) => {
  if (open) fetchProposals()
  else abortController?.abort()
})

watch(source, () => {
  if (props.open) fetchProposals()
})

/**
 * Streaming fetch (SSE over POST — EventSource can't send a body; same
 * mechanics as useAgentStream). Each `proposal` event appends a card
 * immediately; `proposal_update` drops the compiled DSL into its card.
 */
async function fetchProposals() {
  abortController?.abort()
  // Keep a local handle: when the user switches source, the ABORTED stream's
  // catch/finally still run — they must not clobber the replacement stream's
  // state (that race blanked the drawer into the empty state mid-stream).
  const controller = new AbortController()
  abortController = controller
  const isCurrent = () => abortController === controller
  streaming.value = true
  proposals.value = []
  byIndex = new Map()
  note.value = ''
  try {
    const response = await fetch('/api/ontology/suggest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-org-id': currentOrgId.value },
      body: JSON.stringify({ source: source.value }),
      signal: controller.signal
    })
    if (!response.ok) {
      const err = await response.json().catch(() => null)
      throw new Error(err?.message || `Suggest failed (${response.status})`)
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done || !isCurrent()) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        let ev: any
        try { ev = JSON.parse(line.slice(6)) } catch { continue }
        if (ev.type === 'proposal') {
          proposals.value.push(ev.proposal)
          // Read back the REACTIVE proxy (push stores the raw object) so
          // later proposal_update mutations actually re-render the card.
          byIndex.set(ev.index, proposals.value[proposals.value.length - 1])
        } else if (ev.type === 'proposal_update') {
          const p = byIndex.get(ev.index)
          if (p) {
            p.dslTemplate = ev.dslTemplate
            p.kpiColumn = p.kpiColumn ?? ev.kpiColumn
          }
        } else if (ev.type === 'done') {
          note.value = ev.note ?? ''
        } else if (ev.type === 'error') {
          note.value = ev.message || 'Failed to suggest concepts'
        }
      }
    }
  } catch (err: any) {
    if (isCurrent() && err.name !== 'AbortError') {
      note.value = err.message || 'Failed to suggest concepts'
    }
  } finally {
    if (isCurrent()) streaming.value = false
  }
}

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function accept(proposal: ConceptProposal, idx: number) {
  acceptingIdx.value = idx
  try {
    const res = await apiFetch<{ concept: OntologyConcept; dslWarning?: string }>(
      '/api/ontology/concepts',
      {
        method: 'POST',
        headers: { 'x-org-id': currentOrgId.value },
        body: {
          name: proposal.name,
          definition: proposal.definition,
          dslTemplate: proposal.dslTemplate,
          kpiColumn: proposal.kpiColumn,
          measures: proposal.measures,
          causes: proposal.causes.map(c => ({ id: newId(), text: c.text, questionTemplate: c.questionTemplate })),
          actions: proposal.actions.map(a => ({ id: newId(), title: a.title, description: a.description, questionTemplate: a.questionTemplate })),
          source: 'suggested'
        }
      }
    )
    if (res.dslWarning) message.warning(res.dslWarning)
    else message.success(t('ui.ontology.conceptSaved'))
    proposals.value = proposals.value.filter((_, i) => i !== idx)
    emit('accepted', res.concept)
  } catch (err: any) {
    message.error(err.message || 'Failed to accept proposal')
  } finally {
    acceptingIdx.value = null
  }
}
</script>

<template>
  <a-drawer
    :open="open"
    :title="t('ui.ontology.suggestTitle')"
    width="560"
    @close="emit('close')"
  >
    <div class="sg-source">
      <a-segmented
        v-model:value="source"
        :options="[
          { label: t('ui.ontology.suggestFromMap'), value: 'ontology' },
          { label: t('ui.ontology.suggestFromChat'), value: 'conversations' }
        ]"
      />
      <p class="sg-source-hint">
        {{ source === 'ontology' ? t('ui.ontology.suggestFromMapHint') : t('ui.ontology.suggestFromChatHint') }}
      </p>
    </div>

    <div class="sg-list">
        <p v-if="!streaming && proposals.length === 0" class="sg-empty">
          {{ note || t('ui.ontology.suggestEmpty') }}
        </p>

        <article v-for="(p, idx) in proposals" :key="idx" class="sg-card">
          <h4 class="sg-name">{{ p.name }}</h4>
          <p class="sg-def">{{ p.definition }}</p>
          <pre v-if="p.dslTemplate" class="sg-dsl">{{ p.dslTemplate }}</pre>
          <div v-if="p.evidence.length" class="sg-evidence">
            <span class="sg-evidence-label">{{ t('ui.ontology.evidence') }}</span>
            <ul>
              <li v-for="(e, i) in p.evidence.slice(0, 4)" :key="i">{{ e }}</li>
            </ul>
          </div>
          <div class="sg-meta mono">
            {{ p.causes.length }} {{ t('ui.ontology.causes').toLowerCase() }} ·
            {{ p.actions.length }} {{ t('ui.ontology.actions').toLowerCase() }} ·
            {{ p.measures.length }} {{ t('ui.ontology.measures').toLowerCase() }}
          </div>
          <div class="sg-actions">
            <a-button size="small" @click="proposals.splice(idx, 1)">{{ t('ui.ontology.dismiss') }}</a-button>
            <a-button
              size="small"
              type="primary"
              :loading="acceptingIdx === idx"
              @click="accept(p, idx)"
            >{{ t('ui.ontology.accept') }}</a-button>
          </div>
        </article>

        <!-- Stream still open: more cards are coming. -->
        <div v-if="streaming" class="sg-thinking">
          <span class="sg-thinking-dot" /><span class="sg-thinking-dot" /><span class="sg-thinking-dot" />
          <span class="sg-thinking-label">{{ t('ui.ontology.suggestLoading') }}</span>
        </div>
    </div>
  </a-drawer>
</template>

<style scoped>
.sg-source { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.sg-source-hint { margin: 0; font-size: 12px; color: var(--muted); line-height: 1.5; }
.sg-list { display: flex; flex-direction: column; gap: 12px; min-height: 120px; }
.sg-empty { color: var(--muted); font-style: italic; font-size: 13px; }
.sg-thinking {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 12px 16px;
  border: 1px dashed var(--rule, #e5e0d5);
  border-radius: 8px;
}
.sg-thinking-label { margin-left: 6px; font-size: 12px; color: var(--muted); }
.sg-thinking-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent, #a8412b);
  opacity: 0.4;
  animation: sg-pulse 1.2s ease-in-out infinite;
}
.sg-thinking-dot:nth-child(2) { animation-delay: 0.2s; }
.sg-thinking-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes sg-pulse {
  0%, 100% { opacity: 0.25; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1.15); }
}
.sg-card {
  border: 1px solid var(--rule, #e5e0d5);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sg-name {
  margin: 0;
  font-family: var(--serif);
  font-weight: 500;
  font-size: 16px;
  color: var(--ink);
}
.sg-def { margin: 0; font-size: 13px; line-height: 1.55; color: var(--ink-2); }
.sg-dsl {
  background: var(--code-bg, #1f1a14);
  color: var(--code-fg, #f5f2ec);
  padding: 8px 10px;
  border-radius: 6px;
  font-family: var(--mono);
  font-size: 11px;
  overflow-x: auto;
  margin: 0;
  white-space: pre;
}
.sg-evidence { font-size: 12px; color: var(--muted); }
.sg-evidence-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.sg-evidence ul { margin: 4px 0 0; padding-left: 16px; }
.sg-meta { font-size: 10.5px; color: var(--muted); }
.sg-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
