<script setup lang="ts">
import { ref, h } from 'vue'
import { SendOutlined, StopOutlined, LoadingOutlined } from '@ant-design/icons-vue'
import { useI18n } from '~/composables/useI18n'

const { t } = useI18n()

interface Props {
  streaming: boolean
  toolMessage?: string | null
}

const props = defineProps<Props>()
const emit = defineEmits<{
  send: [question: string]
  abort: []
}>()

const question = ref('')

/** True while an IME conversion is open (Japanese/Chinese/Korean input). */
const composing = ref(false)

function handleSend() {
  const q = question.value.trim()
  if (!q || props.streaming) return
  emit('send', q)
  question.value = ''
}

function handleKeydown(e: KeyboardEvent) {
  if (!((e.ctrlKey || e.metaKey) && e.key === 'Enter')) return

  // While an IME conversion is open this keystroke belongs to the IME, not to
  // us. Sending anyway left text behind in the box: `v-model` defers its
  // updates until `compositionend`, so `question` still held the *previous*
  // value at this point — we would send that (or nothing), clear the ref, and
  // then `compositionend` would write the just-converted text straight back
  // into the empty input. Letting the IME keep the keystroke means the user
  // confirms their conversion first, and the following Ctrl+Enter sends and
  // clears exactly what they see.
  //
  // `composing` is the reliable signal; `isComposing` and the legacy 229
  // keycode are checked too because IME behaviour varies by browser and
  // platform. Same guard as `onTitleEnter` in the notebook page.
  if (composing.value || e.isComposing || e.keyCode === 229) return

  e.preventDefault()
  handleSend()
}
</script>

<template>
  <div class="agent-input-bar">
    <div v-if="streaming && toolMessage" class="streaming-status">
      <component :is="h(LoadingOutlined)" spin style="margin-right:8px;" />
      {{ toolMessage }}
    </div>
    <div class="input-row">
      <a-textarea
        v-model:value="question"
        :placeholder="t('ui.agentInput.placeholder')"
        :auto-size="{ minRows: 1, maxRows: 6 }"
        :disabled="streaming"
        class="question-input"
        @keydown="handleKeydown"
        @compositionstart="composing = true"
        @compositionend="composing = false"
      />
      <a-button
        v-if="!streaming"
        type="primary"
        :icon="h(SendOutlined)"
        :disabled="!question.trim()"
        @click="handleSend"
        class="send-btn"
      />
      <a-button
        v-else
        type="primary"
        danger
        :icon="h(StopOutlined)"
        @click="$emit('abort')"
        class="send-btn send-btn--abort"
      />
    </div>
    <div class="input-hint">
      <span class="mono">⌘↵</span>{{ t('ui.agentInput.hintSuffix') }}
    </div>
  </div>
</template>

<style scoped>
.agent-input-bar {
  padding: 14px 18px 18px;
  background: var(--paper);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.streaming-status {
  display: flex;
  align-items: center;
  font-size: 14px;
  color: var(--ink-2);
  padding: 4px 2px 6px;
  font-family: var(--serif);
  font-variation-settings: 'opsz' 18, 'SOFT' 70;
  font-style: italic;
}
.streaming-status :deep(svg) { color: var(--accent); }
.input-row { display: flex; gap: 8px; align-items: flex-end; }
.question-input { flex: 1; }
.question-input :deep(.ant-input) {
  font-family: var(--sans) !important;
  font-size: 15px !important;
  background: var(--surface) !important;
  border: 1px solid var(--rule) !important;
  border-radius: var(--r-md) !important;
  padding: 10px 12px !important;
  line-height: 1.6 !important;
  resize: none;
}
.question-input :deep(.ant-input:focus) {
  border-color: var(--accent) !important;
  box-shadow: 0 0 0 3px var(--accent-glow) !important;
}
.question-input :deep(.ant-input::placeholder) {
  color: var(--mute-low);
  font-style: italic;
}
.send-btn {
  height: 40px !important;
  min-width: 40px !important;
  border-radius: var(--r-md) !important;
}
.send-btn--abort {
  background: var(--danger) !important;
  border-color: var(--danger) !important;
}
.input-hint {
  font-size: 12px;
  color: var(--muted);
  font-family: var(--sans);
  letter-spacing: 0.01em;
}
.input-hint .mono {
  background: var(--subtle);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11.5px;
  color: var(--ink-2);
  border: 1px solid var(--rule);
  margin-right: 2px;
}
</style>
