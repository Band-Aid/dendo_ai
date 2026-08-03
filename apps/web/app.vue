<script setup lang="ts">
import { ref, h, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  BookOutlined,
  PartitionOutlined,
  ToolOutlined,
  SettingOutlined,
  TeamOutlined,
  PlusOutlined,
  ApiOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined
} from '@ant-design/icons-vue'
import { useI18n } from './composables/useI18n'
import { useOrg } from './composables/useOrg'
import { message } from 'ant-design-vue'

const route = useRoute()
const router = useRouter()
const { t, locale, init: initI18n } = useI18n()
const {
  currentOrgId, organizations, loadingOrgs,
  setOrgId, loadOrganizations, createOrganization
} = useOrg()

const hideAppChrome = ref(false)
const sidebarCollapsed = ref(false)
// Pages that scroll their own body (notebook detail) dispatch
// `dendo:topbar-hidden` events with `{ hidden: true | false }`. The topbar
// slides out of view via transform when hidden, but stays in the DOM so the
// layout doesn't reflow. Pages without their own scroll container leave the
// topbar visible.
const topbarHiddenByScroll = ref(false)

const orgModalVisible = ref(false)
const newOrgName = ref('')
const newOrgSlug = ref('')
const creatingOrg = ref(false)

function handleToggleHeader(event: Event) {
  const customEvent = event as CustomEvent<{ hidden: boolean }>
  hideAppChrome.value = !!customEvent.detail?.hidden
}

function handleTopbarHidden(event: Event) {
  const customEvent = event as CustomEvent<{ hidden: boolean }>
  topbarHiddenByScroll.value = !!customEvent.detail?.hidden
}

onMounted(async () => {
  await initI18n()
  await loadOrganizations()
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('dendo_sidebar_collapsed')
    if (stored === '1') sidebarCollapsed.value = true
  }
  window.addEventListener('dendo:toggle-header', handleToggleHeader as EventListener)
  window.addEventListener('dendo:topbar-hidden', handleTopbarHidden as EventListener)
})

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  if (typeof window !== 'undefined') {
    localStorage.setItem('dendo_sidebar_collapsed', sidebarCollapsed.value ? '1' : '0')
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('dendo:toggle-header', handleToggleHeader as EventListener)
  window.removeEventListener('dendo:topbar-hidden', handleTopbarHidden as EventListener)
})

watch(newOrgName, (val) => {
  newOrgSlug.value = val.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
})

/**
 * Switch to a different workspace.
 *
 * Without the redirect, the current route would keep showing data fetched
 * under the previous org (the org ID only takes effect on the *next*
 * navigation, since most pages load data in `onMounted`/`watch(notebookId)`
 * and don't re-fetch when `currentOrgId` changes). For routes like
 * `/notebooks/:id`, that notebook may not even exist in the new org, which
 * would surface as a 404 on the next interaction.
 *
 * Always send the user to the notebooks index so they land on a list that's
 * unambiguously scoped to the new org. `router.push` is a no-op if they're
 * already on that path.
 */
function handleSwitchOrg(id: string) {
  if (id === currentOrgId.value) return
  setOrgId(id)
  router.push('/notebooks')
}

async function handleCreateOrg() {
  if (!newOrgName.value.trim() || !newOrgSlug.value.trim()) {
    message.warning(t('ui.workspace.modal.validateWarning'))
    return
  }
  creatingOrg.value = true
  try {
    const org = await createOrganization(newOrgName.value.trim(), newOrgSlug.value.trim())
    handleSwitchOrg(org.id)
    orgModalVisible.value = false
    newOrgName.value = ''
    newOrgSlug.value = ''
    message.success(t('ui.workspace.modal.createdSuccess', { name: org.name }))
  } catch (err: any) {
    message.error(err.message || 'Failed to create organization')
  } finally {
    creatingOrg.value = false
  }
}

interface NavItem { path: string; key: string; icon: any; eyebrow?: string }
const navItems = computed<NavItem[]>(() => [
  { path: '/notebooks', key: 'ui.nav.notebooks', icon: BookOutlined, eyebrow: 'I' },
  { path: '/ontology',  key: 'ui.nav.ontology', icon: PartitionOutlined, eyebrow: 'II' },
  { path: '/setup',     key: 'ui.nav.setup', icon: ToolOutlined, eyebrow: 'III' },
  { path: '/admin',     key: 'ui.nav.admin', icon: SettingOutlined, eyebrow: 'IV' }
])

function isActive(itemPath: string) {
  if (itemPath === '/notebooks') {
    return route.path === '/' || route.path.startsWith('/notebooks')
  }
  return route.path.startsWith(itemPath)
}

const currentOrgName = computed(() => {
  return organizations.value?.find?.((o: any) => o.id === currentOrgId.value)?.name ?? '—'
})

const dateLocale = computed(() => (locale.value === 'ja' ? 'ja-JP' : undefined))
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell--bare': hideAppChrome, 'app-shell--collapsed': sidebarCollapsed }">

    <!-- Sidebar — "spine" of the journal -->
    <aside
      v-if="!hideAppChrome"
      class="ms-sidebar"
      :class="{ 'ms-sidebar--collapsed': sidebarCollapsed }"
      :aria-expanded="!sidebarCollapsed"
    >
      <div class="ms-brand">
        <div class="ms-monogram" aria-hidden="true">
          <span class="ms-monogram-d">D</span>
          <span v-if="!sidebarCollapsed" class="ms-monogram-rule" />
        </div>
        <div v-if="!sidebarCollapsed" class="ms-brand-text">
          <div class="ms-brand-name">{{ t('ui.brand.name') }}</div>
          <div class="ms-brand-tag">{{ t('ui.brand.tag') }}</div>
        </div>
      </div>

      <nav class="ms-nav" aria-label="Primary">
        <a-tooltip
          v-for="item in navItems"
          :key="item.path"
          :title="sidebarCollapsed ? t(item.key) : ''"
          placement="right"
          :mouse-enter-delay="0.3"
        >
          <a
            :href="item.path"
            class="ms-nav-item"
            :class="{ 'ms-nav-item--active': isActive(item.path) }"
            @click.prevent="router.push(item.path)"
          >
            <span v-if="!sidebarCollapsed" class="ms-nav-eyebrow">{{ item.eyebrow }}</span>
            <span class="ms-nav-icon">
              <component :is="h(item.icon)" />
            </span>
            <span v-if="!sidebarCollapsed" class="ms-nav-label">{{ t(item.key) }}</span>
          </a>
        </a-tooltip>
      </nav>

      <div class="ms-sidebar-bottom">
        <div class="ms-org">
          <template v-if="!sidebarCollapsed">
            <div class="ms-org-head">
              <component :is="h(TeamOutlined)" class="ms-org-icon" />
              <span class="eyebrow ms-org-eyebrow">{{ t('ui.workspace.label') }}</span>
            </div>
            <div class="ms-org-row">
              <a-select
                :value="currentOrgId"
                :loading="loadingOrgs"
                size="small"
                class="ms-org-select"
                :bordered="false"
                @change="(val: string) => handleSwitchOrg(val)"
              >
                <a-select-option
                  v-for="org in organizations"
                  :key="org.id"
                  :value="org.id"
                >
                  {{ org.name }}
                </a-select-option>
              </a-select>
              <a-tooltip :title="t('ui.workspace.newTooltip')">
                <button class="ms-icon-btn" @click="orgModalVisible = true" :aria-label="t('ui.workspace.newTooltip')">
                  <component :is="h(PlusOutlined)" />
                </button>
              </a-tooltip>
            </div>
          </template>
          <a-tooltip v-else :title="currentOrgName" placement="right">
            <button class="ms-org-collapsed" @click="toggleSidebar" :aria-label="t('ui.workspace.label')">
              <component :is="h(TeamOutlined)" />
            </button>
          </a-tooltip>
        </div>

        <div v-if="!sidebarCollapsed" class="ms-footnote">
          <component :is="h(ApiOutlined)" />
          <span>{{ t('ui.topbar.connected') }}</span>
        </div>
      </div>
    </aside>

    <!-- Content area -->
    <main class="ms-main">
      <div
        v-if="!hideAppChrome"
        class="ms-topbar"
        :class="{ 'ms-topbar--hidden': topbarHiddenByScroll }"
      >
        <div class="ms-topbar-left">
          <a-tooltip :title="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'" placement="right">
            <button class="ms-topbar-toggle" @click="toggleSidebar" :aria-label="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'">
              <component :is="h(sidebarCollapsed ? MenuUnfoldOutlined : MenuFoldOutlined)" />
            </button>
          </a-tooltip>
          <span class="ms-topbar-org">{{ currentOrgName }}</span>
          <span class="ms-topbar-dot">·</span>
          <span class="ms-topbar-date">{{ new Date().toLocaleDateString(dateLocale, { weekday:'long', month:'long', day:'numeric' }) }}</span>
        </div>
        <div class="ms-topbar-right">
          <LanguageSwitcher />
        </div>
      </div>

      <div class="ms-content ms-scroll" :class="{ 'ms-content--bare': hideAppChrome }">
        <NuxtPage />
      </div>
    </main>

    <!-- New organization modal -->
    <a-modal
      v-model:open="orgModalVisible"
      :title="t('ui.workspace.modal.title')"
      :confirm-loading="creatingOrg"
      :ok-text="t('ui.workspace.modal.okText')"
      @ok="handleCreateOrg"
      @cancel="orgModalVisible = false"
    >
      <p style="color:var(--muted);font-size:13px;margin:0 0 16px;">
        {{ t('ui.workspace.modal.intro') }}
      </p>
      <a-form layout="vertical">
        <a-form-item :label="t('ui.workspace.modal.nameLabel')" required>
          <a-input v-model:value="newOrgName" :placeholder="t('ui.workspace.modal.namePlaceholder')" />
        </a-form-item>
        <a-form-item :label="t('ui.workspace.modal.slugLabel')" required>
          <a-input v-model:value="newOrgSlug" :placeholder="t('ui.workspace.modal.slugPlaceholder')" />
          <div style="font-size: 12px; color: var(--muted); margin-top: 4px;">
            {{ t('ui.workspace.modal.slugHint') }}
          </div>
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style>
/* App shell layout */
.app-shell {
  display: grid;
  grid-template-columns: 232px 1fr;
  min-height: 100vh;
  background: var(--paper);
  position: relative;
  transition: grid-template-columns 0.22s ease;
}
.app-shell::before {
  /* subtle paper grain texture */
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  background-image: radial-gradient(rgba(20,21,19,0.025) 1px, transparent 1px);
  background-size: 22px 22px;
  background-position: -1px -1px;
  z-index: 0;
}
.app-shell--bare { grid-template-columns: 1fr; }
.app-shell--collapsed { grid-template-columns: 52px 1fr; }

/* ============================================================
   Sidebar — paper-toned, vertical journal spine
   ============================================================ */
.ms-sidebar {
  grid-column: 1;
  border-right: 1px solid var(--rule);
  background: linear-gradient(180deg, var(--paper) 0%, var(--paper-deep) 100%);
  padding: 28px 18px 18px;
  display: flex;
  flex-direction: column;
  gap: 26px;
  position: sticky;
  top: 0;
  height: 100vh;
  z-index: 5;
  overflow: hidden;
  transition: padding 0.22s ease;
}
.ms-sidebar--collapsed {
  padding: 22px 4px 14px;
}

.ms-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 6px;
  min-height: 38px;
}
.ms-sidebar--collapsed .ms-brand {
  justify-content: center;
  padding: 0;
}
.ms-monogram {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ms-monogram-d {
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 144, 'SOFT' 100, 'WONK' 1;
  font-size: 34px;
  line-height: 1;
  color: var(--accent);
  display: inline-block;
}
.ms-monogram-rule {
  display: inline-block;
  width: 18px;
  height: 2px;
  background: var(--ink);
}
.ms-brand-text { display: flex; flex-direction: column; }
.ms-brand-name {
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 48, 'SOFT' 30;
  font-size: 20px;
  letter-spacing: -0.015em;
  color: var(--ink);
  line-height: 1;
}
.ms-brand-tag {
  font-family: var(--sans);
  font-size: 11.5px;
  letter-spacing: 0.01em;
  color: var(--muted);
  margin-top: 5px;
}

/* Nav */
.ms-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 2px;
  flex: 1;
}
.ms-nav-item {
  display: grid;
  grid-template-columns: 20px 22px 1fr;
  align-items: center;
  gap: 10px;
  padding: 10px 10px;
  border-radius: var(--r-sm);
  color: var(--ink-2);
  font-family: var(--sans);
  font-weight: 500;
  font-size: 15px;
  letter-spacing: -0.005em;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  position: relative;
}
.ms-sidebar--collapsed .ms-nav-item {
  grid-template-columns: 1fr;
  justify-items: center;
  padding: 10px 0;
}
.ms-nav-item:hover { background: rgba(20,21,19,0.04); color: var(--ink); }
.ms-nav-eyebrow {
  font-family: var(--serif);
  font-weight: 400;
  font-variation-settings: 'opsz' 14, 'SOFT' 100, 'WONK' 1;
  font-style: italic;
  font-size: 12px;
  color: var(--mute-low);
  text-align: center;
}
.ms-nav-icon {
  font-size: 17px;
  color: var(--muted);
  display: flex;
  align-items: center;
  justify-content: center;
}
.ms-nav-label { white-space: nowrap; }

.ms-nav-item--active {
  background: var(--ink);
  color: var(--paper);
}
.ms-nav-item--active::before {
  content: '';
  position: absolute;
  left: -18px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 22px;
  background: var(--accent);
  border-radius: 2px;
}
.ms-sidebar--collapsed .ms-nav-item--active::before {
  left: -10px;
  height: 18px;
}
.ms-nav-item--active .ms-nav-icon,
.ms-nav-item--active .ms-nav-eyebrow { color: var(--paper); opacity: 0.78; }
.ms-nav-item--active:hover { background: var(--ink); }

/* Sidebar bottom — workspace switcher + footnote */
.ms-sidebar-bottom {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 8px 6px;
  border-top: 1px solid var(--rule);
}
.ms-sidebar--collapsed .ms-sidebar-bottom {
  padding: 14px 0 6px;
  align-items: center;
}
.ms-org-collapsed {
  width: 36px; height: 36px;
  border-radius: var(--r-sm);
  background: var(--surface);
  border: 1px solid var(--rule);
  color: var(--ink-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.ms-org-collapsed:hover {
  background: var(--subtle);
  border-color: var(--ink-2);
  color: var(--ink);
}
.ms-org-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.ms-org-icon { color: var(--muted); font-size: 12px; }
.ms-org-eyebrow { font-size: 9.5px; }
.ms-org-row {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
  padding: 2px 4px 2px 6px;
}
.ms-org-row:hover { border-color: var(--ink-2); }
.ms-org-select { flex: 1; min-width: 0; }
.ms-org-select :deep(.ant-select-selector) {
  background: transparent !important;
  border: none !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
  font-weight: 500;
  font-size: 13px !important;
  box-shadow: none !important;
}
.ms-org-select :deep(.ant-select-selection-item) { color: var(--ink); }
.ms-icon-btn {
  width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  border-radius: var(--r-sm);
  font-size: 11px;
}
.ms-icon-btn:hover { background: var(--subtle); color: var(--ink); }

.ms-footnote {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  font-family: var(--mono);
  letter-spacing: 0.01em;
  padding: 0 4px;
}
.ms-footnote :deep(svg) { color: var(--positive); }

/* ============================================================
   Main column
   ============================================================ */
.ms-main {
  grid-column: 2;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  position: relative;
  z-index: 1;
}
.app-shell--bare .ms-main { grid-column: 1; }

.ms-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 28px;
  height: var(--topbar-h);
  border-bottom: 1px solid var(--rule);
  background: rgba(250, 247, 242, 0.85);
  backdrop-filter: saturate(120%) blur(6px);
  position: sticky;
  top: 0;
  z-index: 4;
  transition: transform 0.22s ease, opacity 0.18s ease;
  transform-origin: top center;
}
/* Slide off-screen when the active page reports it has scrolled past the
 * threshold (see notebooks/[id].vue's `onBodyScroll`). Stays in the DOM so
 * the layout grid doesn't reflow; the content underneath continues at its
 * normal height. */
.ms-topbar--hidden {
  transform: translateY(-100%);
  opacity: 0;
  pointer-events: none;
}
.ms-topbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--muted);
}
.ms-topbar-toggle {
  width: 28px; height: 28px;
  background: transparent;
  border: 1px solid var(--rule);
  border-radius: var(--r-sm);
  color: var(--ink-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.ms-topbar-toggle:hover {
  background: var(--subtle);
  border-color: var(--ink-2);
  color: var(--accent);
}
.ms-topbar-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--muted);
}
.ms-topbar-org {
  font-family: var(--serif);
  font-weight: 500;
  font-variation-settings: 'opsz' 20, 'SOFT' 50;
  font-style: italic;
  color: var(--ink);
  font-size: 15.5px;
  letter-spacing: -0.005em;
}
.ms-topbar-dot { color: var(--mute-low); }
.ms-topbar-date { font-family: var(--mono); font-size: 12.5px; letter-spacing: 0; }

.ms-topbar-right { display: flex; align-items: center; gap: 12px; }
.ms-topbar-right :deep(.ant-btn) {
  font-size: 12.5px;
  height: 30px;
  padding: 0 10px;
}

.ms-content {
  padding: 36px 40px 64px;
  flex: 1;
  overflow-y: auto;
}
.ms-content--bare {
  padding: 0;
  height: 100vh;
  overflow: hidden;
}

/* Make Language switcher look paper-native */
.ms-topbar :deep(.ant-btn) {
  background: transparent;
  border-color: var(--rule);
  color: var(--ink-2);
}
</style>
