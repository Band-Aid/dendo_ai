<script setup lang="ts">
import { ref, h, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { PlusOutlined, DeleteOutlined, ArrowRightOutlined } from '@ant-design/icons-vue'
import { message, Modal } from 'ant-design-vue'
import { useOrg } from '~/composables/useOrg'
import { useNotebook } from '~/composables/useNotebook'
import { useI18n } from '~/composables/useI18n'

const router = useRouter()
const { t, locale } = useI18n()
const { currentOrgId } = useOrg()
const { notebooks, loading, loadNotebooks, createNotebook, deleteNotebook } =
  useNotebook(() => currentOrgId.value)

const newModalVisible = ref(false)
const creating = ref(false)
const newTitle = ref('')
const newDescription = ref('')

onMounted(loadNotebooks)

const sortedNotebooks = computed(() =>
  [...(notebooks.value ?? [])].sort((a, b) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  )
)

async function handleCreate() {
  if (!newTitle.value.trim()) return
  creating.value = true
  try {
    const nb = await createNotebook(newTitle.value.trim(), newDescription.value.trim() || undefined)
    newModalVisible.value = false
    newTitle.value = ''
    newDescription.value = ''
    router.push(`/notebooks/${nb.id}`)
  } catch (err: any) {
    message.error(err.message || t('ui.notebooks.modal.createFailed'))
  } finally {
    creating.value = false
  }
}

function confirmDelete(id: string, title: string) {
  Modal.confirm({
    title: t('ui.notebooks.modal.deleteTitle'),
    content: t('ui.notebooks.modal.deleteContent', { title }),
    okText: t('ui.notebooks.modal.deleteOk'),
    okType: 'danger',
    async onOk() {
      await deleteNotebook(id)
      message.success(t('ui.notebooks.modal.deletedSuccess'))
    }
  })
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(locale.value === 'ja' ? 'ja-JP' : undefined, {
    month: 'short', day: 'numeric', year: 'numeric'
  })
}

function relativeDate(iso: string) {
  const ms = Date.now() - new Date(iso).getTime()
  const day = 24 * 60 * 60 * 1000
  if (ms < day) return t('ui.notebooks.toc.today')
  if (ms < 2 * day) return t('ui.notebooks.toc.yesterday')
  if (ms < 7 * day) return t('ui.notebooks.toc.daysAgo', { n: Math.floor(ms / day) })
  return formatDate(iso)
}
</script>

<template>
  <div class="notebooks-page">
    <!-- Editorial header -->
    <header class="page-masthead">
      <div class="masthead-eyebrow">
        <span class="eyebrow">{{ t('ui.notebooks.masthead.vol') }}</span>
        <span class="rule" />
        <span class="masthead-count mono">{{ sortedNotebooks.length.toString().padStart(2,'0') }}</span>
      </div>
      <div class="masthead-row">
        <h1 class="masthead-title h-display">
          {{ t('ui.notebooks.masthead.titleA') }}<br />
          <em>{{ t('ui.notebooks.masthead.titleB') }}</em>
        </h1>
        <a-button type="primary" :icon="h(PlusOutlined)" @click="newModalVisible = true" size="large">
          {{ t('ui.notebooks.masthead.cta') }}
        </a-button>
      </div>
      <p class="masthead-lede">
        {{ t('ui.notebooks.masthead.lede') }}
      </p>
    </header>

    <a-spin :spinning="loading">
      <!-- Empty state — composed like a journal entry -->
      <div v-if="!loading && !sortedNotebooks.length" class="empty-state">
        <div class="empty-frame">
          <span class="eyebrow">{{ t('ui.notebooks.empty.eyebrow') }}</span>
          <h2 class="empty-title">
            <em>{{ t('ui.notebooks.empty.title') }}</em>
          </h2>
          <p class="empty-body">
            {{ t('ui.notebooks.empty.body') }}
          </p>
          <a-button type="primary" :icon="h(PlusOutlined)" @click="newModalVisible = true" size="large">
            {{ t('ui.notebooks.empty.cta') }}
          </a-button>
        </div>
      </div>

      <!-- Notebook list — table-of-contents feel -->
      <ul v-else class="notebook-toc" role="list">
        <li
          v-for="(nb, idx) in sortedNotebooks"
          :key="nb.id"
          class="toc-entry"
          @click="router.push(`/notebooks/${nb.id}`)"
        >
          <div class="toc-num mono">{{ String(idx + 1).padStart(2,'0') }}</div>
          <div class="toc-body">
            <div class="toc-title">{{ nb.title }}</div>
            <div v-if="nb.description" class="toc-desc">{{ nb.description }}</div>
            <div v-else class="toc-desc toc-desc--muted">{{ t('ui.notebooks.toc.noDescription') }}</div>
          </div>
          <div class="toc-meta">
            <span class="toc-date">{{ relativeDate(nb.updated_at) }}</span>
            <span class="toc-date-abs">{{ formatDate(nb.updated_at) }}</span>
          </div>
          <div class="toc-actions">
            <button
              class="toc-delete"
              :aria-label="t('ui.notebooks.modal.deleteAria')"
              @click.stop="confirmDelete(nb.id, nb.title)"
            >
              <component :is="h(DeleteOutlined)" />
            </button>
            <component :is="h(ArrowRightOutlined)" class="toc-arrow" />
          </div>
        </li>
      </ul>
    </a-spin>

    <!-- New notebook modal -->
    <a-modal
      v-model:open="newModalVisible"
      :title="t('ui.notebooks.modal.title')"
      :confirm-loading="creating"
      :ok-text="t('ui.notebooks.modal.okText')"
      @ok="handleCreate"
    >
      <p style="color:var(--muted);font-size:13px;margin:0 0 18px;">
        {{ t('ui.notebooks.modal.intro') }}
      </p>
      <a-form layout="vertical">
        <a-form-item :label="t('ui.notebooks.modal.titleLabel')" required>
          <a-input
            v-model:value="newTitle"
            :placeholder="t('ui.notebooks.modal.titlePlaceholder')"
            @keydown.enter="handleCreate"
          />
        </a-form-item>
        <a-form-item :label="t('ui.notebooks.modal.descLabel')">
          <a-textarea
            v-model:value="newDescription"
            :placeholder="t('ui.notebooks.modal.descPlaceholder')"
            :auto-size="{ minRows: 2, maxRows: 4 }"
          />
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.notebooks-page {
  max-width: 920px;
  margin: 0 auto;
}

/* Masthead — newspaper style */
.page-masthead {
  padding: 16px 0 34px;
  border-bottom: 1px solid var(--rule);
  margin-bottom: 36px;
}
.masthead-eyebrow {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}
.masthead-eyebrow .rule {
  flex: 1;
  height: 1px;
  background: var(--rule);
}
.masthead-count {
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.masthead-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 32px;
}
.masthead-title {
  font-family: var(--serif);
  font-weight: 420;
  font-variation-settings: 'opsz' 96, 'SOFT' 40, 'WONK' 0;
  font-size: clamp(38px, 5.6vw, 56px);
  line-height: 1.02;
  letter-spacing: -0.025em;
  color: var(--ink);
  margin: 0;
  max-width: 620px;
}
.masthead-title em {
  font-style: italic;
  font-variation-settings: 'opsz' 96, 'SOFT' 100, 'WONK' 1;
  color: var(--accent);
}
.masthead-lede {
  margin: 22px 0 0;
  max-width: 580px;
  font-size: 16px;
  line-height: 1.6;
  color: var(--ink-2);
}

/* Empty state */
.empty-state {
  display: flex;
  justify-content: center;
  padding: 32px 0;
}
.empty-frame {
  max-width: 480px;
  text-align: left;
  padding: 32px 36px;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: var(--r-lg);
  position: relative;
}
.empty-frame::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 4px;
  background: var(--accent);
  border-radius: var(--r-lg) var(--r-lg) 0 0;
}
.empty-title {
  font-family: var(--serif);
  font-weight: 480;
  font-variation-settings: 'opsz' 48, 'SOFT' 70;
  font-size: 30px;
  line-height: 1.1;
  margin: 8px 0 12px;
  color: var(--ink);
}
.empty-title em {
  font-style: italic;
  font-variation-settings: 'opsz' 48, 'SOFT' 100, 'WONK' 1;
  color: var(--accent);
}
.empty-body {
  color: var(--ink-2);
  font-size: 15px;
  line-height: 1.6;
  margin: 0 0 22px;
}

/* Table of contents */
.notebook-toc {
  list-style: none;
  margin: 0; padding: 0;
  border-top: 1px solid var(--rule);
}
.toc-entry {
  display: grid;
  grid-template-columns: 56px 1fr auto auto;
  align-items: baseline;
  gap: 22px;
  padding: 20px 8px 20px 0;
  border-bottom: 1px solid var(--rule);
  cursor: pointer;
  transition: background 0.15s;
  position: relative;
}
.toc-entry:hover { background: rgba(168, 65, 43, 0.025); }
.toc-entry:hover .toc-title { color: var(--accent); }
.toc-entry:hover .toc-arrow { color: var(--accent); transform: translateX(4px); }
.toc-entry:hover .toc-delete { opacity: 1; }

.toc-num {
  font-size: 14px;
  color: var(--mute-low);
  font-weight: 500;
  letter-spacing: 0.04em;
  padding-left: 6px;
}
.toc-body { min-width: 0; }
.toc-title {
  font-family: var(--serif);
  font-weight: 460;
  font-variation-settings: 'opsz' 28, 'SOFT' 30;
  font-size: 22px;
  letter-spacing: -0.012em;
  line-height: 1.25;
  color: var(--ink);
  transition: color 0.15s;
}
.toc-desc {
  margin-top: 5px;
  font-size: 15px;
  color: var(--ink-2);
  line-height: 1.55;
  max-width: 560px;
}
.toc-desc--muted { color: var(--mute-low); font-style: italic; }
.toc-meta {
  text-align: right;
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-end;
}
.toc-date {
  font-family: var(--sans);
  font-size: 13.5px;
  color: var(--ink-2);
  font-weight: 500;
}
.toc-date-abs {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--muted);
  letter-spacing: 0;
}
.toc-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-right: 4px;
}
.toc-delete {
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  padding: 4px 6px;
  border-radius: var(--r-sm);
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, background 0.15s;
  font-size: 14px;
}
.toc-delete:hover { background: var(--danger-bg); color: var(--danger); }
.toc-arrow {
  color: var(--mute-low);
  transition: color 0.15s, transform 0.2s;
  font-size: 14px;
}
</style>
