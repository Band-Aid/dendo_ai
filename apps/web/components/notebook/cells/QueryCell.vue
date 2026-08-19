<script setup lang="ts">
import { ref, computed, h, watch } from 'vue'
import {
  PlayCircleOutlined,
  ThunderboltOutlined,
  CloseOutlined,
  DownOutlined,
  RightOutlined
} from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { useApi } from '~/composables/useApi'
import { useI18n } from '~/composables/useI18n'
import { useActiveAgent } from '~/composables/useActiveAgent'
import type { QueryCell } from '~/types/notebook'

const { t } = useI18n()
const { activeAgentId } = useActiveAgent()

interface Props {
  cell: QueryCell
  running?: boolean
  notebookId: string
  orgId: string
}
const props = defineProps<Props>()
const emit = defineEmits<{
  save: [content: string]
  run: [dsl: string]
  saveTitle: [title: string]
  /** Hand off to the chat sidebar — the prompt is a question the agent has
   *  to reason through, not a one-shot DSL translation. */
  askInChat: [prompt: string]
}>()

const { apiFetch } = useApi()

const draft = ref(props.cell.content)
const titleDraft = ref(props.cell.meta_json?.title ?? '')

// A rename that lands from elsewhere (another tab, or the run that copies the
// name onto the pair) shouldn't be clobbered by this input's stale value.
watch(() => props.cell.meta_json?.title, (next) => {
  if ((next ?? '') !== titleDraft.value) titleDraft.value = next ?? ''
})

function commitTitle() {
  const next = titleDraft.value.trim()
  if (next === (props.cell.meta_json?.title ?? '')) return
  emit('saveTitle', next)
}
const generating = ref(false)
const showPrompt = ref(false)
const prompt = ref('')

// Collapsed by default for non-empty DSL — once the user has data in the
// cell, the table/chart below it is usually the focus. Empty cells start
// expanded so there's something to type into. Local state only; per-cell
// persistence would clutter the meta_json for a purely visual preference.
const collapsed = ref<boolean>(!!props.cell.content?.trim())

function toggleCollapsed() { collapsed.value = !collapsed.value }

/** One-line preview of the DSL for the collapsed-header summary — collapses
 *  pipeline stages onto a single line so the user can still scan it. */
const dslPreview = computed(() => {
  const text = (draft.value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > 110 ? text.slice(0, 110) + '…' : text
})

function handleRun() {
  if (draft.value !== props.cell.content) emit('save', draft.value)
  emit('run', draft.value)
}

/**
 * Heuristic: is this prompt better answered by the chat agent than by the
 * one-shot DSL generator? The generator pipes the model's response straight
 * into the cell, so any prose / reasoning / multi-step plan corrupts the
 * cell into something that won't compile. Questions and multi-sentence
 * intents are the common offenders — route them to chat where the agent can
 * think out loud, call tools, and explain.
 */
function isLikelyChatPrompt(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  // Direct: anything with a question mark is a question.
  if (t.includes('?')) return true
  // Long prompts almost always include intent that won't translate to one
  // clean DSL block.
  if (t.length > 220) return true
  // Multi-sentence: a sentence terminator followed by more words.
  if (/[.!]\s+\S/.test(t)) return true
  // Starts with an interrogative or analytical verb.
  if (/^(how|what|why|which|when|where|who|is|are|do|does|did|can|could|should|will|would|compare|analyze|investigate|explain|tell)\b/i.test(t)) return true
  return false
}

/**
 * Detect output that's clearly NOT clean aggDSL. The compiler expects the
 * first non-blank, non-comment line to start with FROM / PIPELINE / REQUEST.
 * Anything else (markdown prose, code fences, "I'll do X" sentences) will
 * fail to compile and shouldn't be written into the cell.
 */
function looksLikeCleanDsl(text: string): boolean {
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('//') || t.startsWith('#')) continue  // comments
    return /^(FROM\s|PIPELINE\b|REQUEST\s)/i.test(t)
  }
  return false
}

async function handleGenerate() {
  const text = prompt.value.trim()
  if (!text || generating.value) return

  // Short-circuit before hitting the generator — questions/analytical prompts
  // go to chat directly so we don't pay the round-trip just to discard the
  // response. The chat sidebar gets focus + opens automatically via the
  // parent handler.
  if (isLikelyChatPrompt(text)) {
    emit('askInChat', text)
    showPrompt.value = false
    prompt.value = ''
    return
  }

  generating.value = true
  try {
    const res = await apiFetch<{ dsl: string }>(
      `/api/notebooks/${props.notebookId}/agent/generate-dsl`,
      {
        method: 'POST',
        headers: { 'x-org-id': props.orgId },
        body: {
          prompt: text,
          existingDsl: draft.value,
          ...(activeAgentId.value ? { agentId: activeAgentId.value } : {})
        }
      }
    )
    if (res?.dsl && looksLikeCleanDsl(res.dsl)) {
      draft.value = res.dsl
      emit('save', res.dsl)
      message.success(t('ui.query.dslGenerated'))
      showPrompt.value = false
      prompt.value = ''
    } else if (res?.dsl) {
      // Server-side safety net: the model returned something but it isn't a
      // clean DSL block (e.g. it wrapped reasoning around the query). Don't
      // overwrite the cell — push the original prompt into chat so the user
      // can iterate there.
      emit('askInChat', text)
      showPrompt.value = false
      prompt.value = ''
      message.info(t('ui.query.handoffToChat'))
    } else {
      message.error(t('ui.query.noDsl'))
    }
  } catch (err: any) {
    message.error(err.message || t('ui.query.generateFailed'))
  } finally {
    generating.value = false
  }
}

function togglePrompt() {
  showPrompt.value = !showPrompt.value
  if (!showPrompt.value) prompt.value = ''
}
</script>

<template>
  <div class="query-cell" :class="{ 'query-cell--collapsed': collapsed }">
    <!--
      Header is clickable when there's DSL content so the user can collapse /
      expand by tapping anywhere on it. The chevron + label still convey the
      affordance for users who haven't discovered the click target.
    -->
    <div class="query-header" :class="{ 'query-header--clickable': dslPreview }" @click="dslPreview && toggleCollapsed()">
      <div class="query-label-group">
        <button
          v-if="dslPreview"
          class="collapse-btn"
          :aria-label="collapsed ? t('ui.query.expand') : t('ui.query.collapse')"
          @click.stop="toggleCollapsed"
        >
          <component :is="h(collapsed ? RightOutlined : DownOutlined)" />
        </button>
        <span class="query-sigil mono">λ</span>
        <!--
          Collapsed: the name is the cell's identity, so show it plainly (and
          fall back to the generic label when unnamed) with the DSL trailing
          behind it. Expanded: the name becomes editable in place.
        -->
        <template v-if="collapsed">
          <span v-if="cell.meta_json?.title" class="query-title-static">{{ cell.meta_json.title }}</span>
          <span v-else class="query-label">{{ t('ui.query.label') }}</span>
          <span v-if="dslPreview" class="query-preview mono">{{ dslPreview }}</span>
        </template>
        <template v-else>
          <span class="query-label">{{ t('ui.query.label') }}</span>
          <input
            v-model="titleDraft"
            class="query-title-input"
            :placeholder="t('ui.query.titlePlaceholder')"
            :aria-label="t('ui.query.titleLabel')"
            maxlength="120"
            @click.stop
            @blur="commitTitle"
            @keydown.enter.prevent="commitTitle"
          />
        </template>
      </div>
      <div class="query-header-actions" @click.stop>
        <a-button
          v-if="!collapsed"
          size="small"
          :icon="h(ThunderboltOutlined)"
          :type="showPrompt ? 'primary' : 'default'"
          @click="togglePrompt"
        >{{ t('ui.query.generate') }}</a-button>
        <a-button
          size="small"
          type="primary"
          :icon="h(PlayCircleOutlined)"
          :loading="props.running"
          @click="handleRun"
        >{{ t('ui.query.run') }}</a-button>
      </div>
    </div>

    <div v-if="!collapsed && showPrompt" class="generate-prompt">
      <a-textarea
        v-model:value="prompt"
        :auto-size="{ minRows: 2, maxRows: 6 }"
        :placeholder="t('ui.query.generatePlaceholder')"
        @keydown.ctrl.enter="handleGenerate"
        @keydown.meta.enter="handleGenerate"
      />
      <div class="generate-actions">
        <span class="generate-hint">{{ t('ui.query.generateHint') }}</span>
        <a-space>
          <a-button size="small" :icon="h(CloseOutlined)" @click="togglePrompt">{{ t('ui.query.cancel') }}</a-button>
          <a-button
            size="small"
            type="primary"
            :loading="generating"
            :disabled="!prompt.trim()"
            @click="handleGenerate"
          >{{ t('ui.query.generateBtn') }}</a-button>
        </a-space>
      </div>
    </div>

    <a-textarea
      v-if="!collapsed"
      v-model:value="draft"
      :auto-size="{ minRows: 3, maxRows: 20 }"
      class="query-textarea"
      placeholder="FROM event([source=events, appId=-323232])&#10;TIMESERIES period=dayRange first=now() count=-30&#10;| group by day fields { visitors=count(visitorId) }"
      @blur="draft !== cell.content && emit('save', draft)"
    />
    <div v-if="!collapsed && cell.meta_json?.lastError" class="query-error">
      {{ t('ui.query.errorPrefix') }} {{ cell.meta_json.lastError }}
    </div>
  </div>
</template>

<style scoped>
.query-cell {
  background: var(--code-bg);
  border-radius: var(--r-md);
  overflow: hidden;
  border: 1px solid var(--code-rule);
}
.query-cell--collapsed .query-header {
  border-bottom: none;
}
.query-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--code-bg-2);
  border-bottom: 1px solid var(--code-rule);
  gap: 12px;
}
.query-header--clickable { cursor: pointer; }
.query-header--clickable:hover { background: rgba(168, 65, 43, 0.08); }
.query-label-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.collapse-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  background: transparent;
  border: none;
  color: var(--code-muted);
  cursor: pointer;
  font-size: 10px;
  padding: 0;
}
.collapse-btn:hover { color: var(--code-fg); }
.query-title-static {
  font-family: var(--sans);
  font-size: 13px;
  font-weight: 600;
  color: var(--code-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 45%;
}
.query-title-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  border-bottom: 1px dashed transparent;
  color: var(--code-fg);
  font-family: var(--sans);
  font-size: 13px;
  font-weight: 600;
  padding: 1px 2px;
  outline: none;
}
.query-title-input::placeholder {
  color: var(--code-muted);
  font-weight: 400;
  font-style: italic;
}
.query-title-input:hover { border-bottom-color: var(--code-rule); }
.query-title-input:focus { border-bottom-color: var(--accent); }
.query-preview {
  font-size: 12px;
  color: var(--code-fg);
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  margin-left: 4px;
}
.query-sigil {
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}
.query-label {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--code-muted);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.query-header-actions { display: flex; gap: 6px; }
.query-header-actions :deep(.ant-btn) {
  background: transparent;
  border: 1px solid var(--code-rule);
  color: var(--code-fg);
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
}
.query-header-actions :deep(.ant-btn:hover) {
  background: rgba(168, 65, 43, 0.18) !important;
  border-color: var(--accent) !important;
  color: var(--code-fg) !important;
}
.query-header-actions :deep(.ant-btn-primary) {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.query-header-actions :deep(.ant-btn-primary:hover) {
  background: var(--accent-deep) !important;
  border-color: var(--accent-deep) !important;
}

.generate-prompt {
  background: var(--code-bg-2);
  padding: 12px 14px;
  border-bottom: 1px solid var(--code-rule);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.generate-prompt :deep(.ant-input) {
  background: rgba(250, 247, 242, 0.04) !important;
  color: var(--code-fg) !important;
  border: 1px solid var(--code-rule) !important;
  border-radius: var(--r-sm) !important;
  font-family: var(--sans) !important;
  font-size: 14px !important;
}
.generate-prompt :deep(.ant-input::placeholder) {
  color: var(--code-muted) !important;
  font-style: italic;
}
.generate-prompt :deep(.ant-input:focus) {
  border-color: var(--accent) !important;
  box-shadow: 0 0 0 3px rgba(168, 65, 43, 0.18) !important;
}
.generate-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.generate-hint {
  color: var(--code-muted);
  font-size: 12px;
  font-family: var(--sans);
  font-style: italic;
}

.query-textarea {
  font-family: var(--mono) !important;
  font-size: 14px !important;
  color: var(--code-fg) !important;
  background: var(--code-bg) !important;
  border: none !important;
  border-radius: 0 !important;
  padding: 14px 16px !important;
  resize: vertical;
  line-height: 1.6 !important;
}
.query-textarea:focus { box-shadow: none !important; border: none !important; }
.query-textarea::placeholder {
  color: var(--code-muted) !important;
  font-style: italic;
}
.query-error {
  padding: 10px 14px;
  background: rgba(139, 47, 47, 0.18);
  color: #F4B0A2;
  font-size: 12px;
  font-family: var(--mono);
  border-top: 1px solid rgba(139, 47, 47, 0.4);
}
</style>
