<script setup lang="ts">
import { ref, h, onMounted, onBeforeUnmount } from 'vue'
import { PlusOutlined, DeleteOutlined, CheckCircleOutlined, CloseCircleOutlined, KeyOutlined, LockOutlined, DisconnectOutlined, ReloadOutlined, WarningOutlined, EditOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import type { McpServerConfig } from '~/types/mcp'
import { useApi } from '~/composables/useApi'

interface Props {
  orgId: string
}

const props = defineProps<Props>()
const { apiFetch } = useApi()

const servers = ref<McpServerConfig[]>([])
const loading = ref(false)
const saving = ref(false)
const testResults = ref<Record<string, { success: boolean; toolCount?: number; error?: string } | null>>({})

const modalVisible = ref(false)
const editingServer = ref<Partial<McpServerConfig> & { isNew?: boolean }>({})

async function load() {
  loading.value = true
  try {
    servers.value = await apiFetch('/api/admin/mcp', {
      headers: { 'x-org-id': props.orgId }
    })
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  try {
    servers.value = await apiFetch('/api/admin/mcp', {
      method: 'POST',
      headers: { 'x-org-id': props.orgId },
      body: { servers: servers.value }
    })
    message.success('MCP servers saved')
  } catch (err: any) {
    message.error(err.message || 'Save failed')
  } finally {
    saving.value = false
  }
}

function openAdd() {
  editingServer.value = { id: crypto.randomUUID(), transport: 'http_sse', enabled: true, isNew: true }
  modalVisible.value = true
}

function openEdit(s: McpServerConfig) {
  editingServer.value = { ...s }
  modalVisible.value = true
}

function confirmEdit() {
  const s = editingServer.value as McpServerConfig
  if (!s.name?.trim() || !s.url?.trim()) {
    message.warning('Name and URL are required')
    return
  }
  if (editingServer.value.isNew) {
    servers.value.push({ ...s })
  } else {
    const idx = servers.value.findIndex(x => x.id === s.id)
    if (idx > -1) servers.value[idx] = { ...s }
  }
  modalVisible.value = false
}

function removeServer(id: string) {
  servers.value = servers.value.filter(s => s.id !== id)
}

async function testServer(s: McpServerConfig) {
  testResults.value[s.id] = null
  try {
    const result = await apiFetch('/api/admin/mcp/test', {
      method: 'POST',
      headers: { 'x-org-id': props.orgId },
      // serverId lets the test use the SAVED config, incl. stored OAuth
      // tokens — url/name remain as fallback for a not-yet-saved server.
      body: { serverId: s.id, url: s.url, name: s.name }
    })
    testResults.value = { ...testResults.value, [s.id]: result }
  } catch (err: any) {
    testResults.value = { ...testResults.value, [s.id]: { success: false, error: err.message } }
  }
}

async function authenticate(s: McpServerConfig) {
  // /oauth/start resolves the server from the SAVED config, but "Add Server"
  // only edits the local list — so persist before starting auth or a freshly
  // added server 404s. The popup must open synchronously inside the click
  // handler (popup blockers), so open it blank and navigate it after the save.
  const w = window.open('', 'dendo-mcp-oauth', 'width=600,height=720,popup=yes')
  if (!w) {
    message.error('Popup was blocked. Allow popups and try again.')
    return
  }
  try {
    servers.value = await apiFetch('/api/admin/mcp', {
      method: 'POST',
      headers: { 'x-org-id': props.orgId },
      body: { servers: servers.value }
    })
  } catch (err: any) {
    w.close()
    message.error(err.message || 'Save failed')
    return
  }
  // orgId travels as a query param — a popup navigation can't carry the
  // x-org-id header the rest of the admin API uses.
  w.location.href = `/api/admin/mcp/oauth/start?serverId=${encodeURIComponent(s.id)}&orgId=${encodeURIComponent(props.orgId)}`
}

/**
 * Auth status for the badge and for which buttons to offer.
 *
 * `ok` and `stale` both have tokens — the difference is whether something has
 * since failed. A dead refresh grant leaves a perfectly good-looking access
 * token in place, so keying the badge purely off `hasOAuthTokens` showed a green
 * "Authenticated" next to a 401 and gave no way back.
 */
type AuthState = 'ok' | 'stale' | 'needs-auth' | 'none'
function authState(s: McpServerConfig): AuthState {
  if (s.hasOAuthTokens) return s.oauth?.lastError || s.oauth?.needsAuth ? 'stale' : 'ok'
  if (s.oauth?.needsAuth || s.oauth?.client || s.oauth?.metadata) return 'needs-auth'
  return 'none'
}

async function disconnect(s: McpServerConfig) {
  try {
    await apiFetch('/api/admin/mcp/oauth/disconnect', {
      method: 'POST',
      headers: { 'x-org-id': props.orgId },
      body: { serverId: s.id }
    })
    message.success('Disconnected')
    await load()
  } catch (err: any) {
    message.error(err.message || 'Disconnect failed')
  }
}

function onAuthMessage(ev: MessageEvent) {
  if (ev.data?.source !== 'dendo-mcp-oauth') return
  if (ev.data.ok) {
    message.success('MCP authentication complete')
  } else {
    message.error('MCP authentication failed')
  }
  load()
}

onMounted(() => {
  window.addEventListener('message', onAuthMessage)
})
onBeforeUnmount(() => {
  window.removeEventListener('message', onAuthMessage)
})

load()
</script>

<template>
  <div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <p style="margin:0;color:#6b7280;font-size:14px;">
        Connect external MCP (Model Context Protocol) servers to give the agent additional tools.
      </p>
      <a-button :icon="h(PlusOutlined)" @click="openAdd">Add Server</a-button>
    </div>

    <a-spin :spinning="loading">
      <a-empty v-if="!servers.length" description="No MCP servers configured" style="margin:32px 0;" />

      <div v-for="s in servers" :key="s.id" class="server-card">
        <div class="server-main">
          <div class="server-info">
            <div style="font-weight:600;font-size:14px;">{{ s.name }}</div>
            <div class="server-url">{{ s.url }}</div>
            <div class="server-tags">
              <a-tag v-if="authState(s) === 'ok'" color="success">
                <template #icon><component :is="h(CheckCircleOutlined)" /></template>
                Authenticated
              </a-tag>
              <a-tag v-else-if="authState(s) === 'stale'" color="warning">
                <template #icon><component :is="h(WarningOutlined)" /></template>
                Re-authentication required
              </a-tag>
              <a-tag v-else-if="authState(s) === 'needs-auth'" color="warning">
                <template #icon><component :is="h(LockOutlined)" /></template>
                Auth required
              </a-tag>
              <a-tag v-if="testResults[s.id]?.success" color="success">
                <template #icon><component :is="h(CheckCircleOutlined)" /></template>
                {{ testResults[s.id]?.toolCount }} tools loaded
              </a-tag>
              <a-tag v-else-if="testResults[s.id] && testResults[s.id]?.success === false" color="error">
                <template #icon><component :is="h(CloseCircleOutlined)" /></template>
                Test failed
              </a-tag>
            </div>
          </div>

          <!--
            flex-shrink:0 + the wrapping error block below: a long server error
            used to sit in a nowrap <a-tag> here, which set the left column's
            min-content width and pushed every one of these buttons hundreds of
            pixels off the right edge of the page — with no horizontal scroll to
            reach them, so re-auth and edit became impossible.
          -->
          <div class="server-actions">
            <a-switch v-model:checked="s.enabled" size="small" />
            <a-button size="small" @click="testServer(s)">Test</a-button>
            <a-button
              v-if="authState(s) === 'ok' || authState(s) === 'stale'"
              size="small"
              :type="authState(s) === 'stale' ? 'primary' : 'default'"
              :icon="h(ReloadOutlined)"
              @click="authenticate(s)"
            >Re-authenticate</a-button>
            <a-button
              v-else
              size="small"
              type="primary"
              :icon="h(KeyOutlined)"
              @click="authenticate(s)"
            >Authenticate</a-button>
            <a-button
              v-if="s.hasOAuthTokens"
              size="small"
              :icon="h(DisconnectOutlined)"
              @click="disconnect(s)"
            >Disconnect</a-button>
            <a-button size="small" :icon="h(EditOutlined)" @click="openEdit(s)">Edit</a-button>
            <a-button size="small" danger :icon="h(DeleteOutlined)" @click="removeServer(s.id)" />
          </div>
        </div>

        <!-- Full-width so it can wrap freely instead of widening the row. -->
        <div v-if="s.oauth?.lastError" class="server-error">
          <component :is="h(CloseCircleOutlined)" class="server-error-icon" />
          <div>
            <div class="server-error-title">Last authentication error</div>
            <div class="server-error-body">{{ s.oauth.lastError }}</div>
            <div v-if="authState(s) === 'stale'" class="server-error-hint">
              The stored refresh token is no longer accepted. Click <strong>Re-authenticate</strong> to sign in again — this clears the error and replaces the tokens.
            </div>
          </div>
        </div>
        <div v-if="testResults[s.id] && testResults[s.id]?.success === false" class="server-error">
          <component :is="h(CloseCircleOutlined)" class="server-error-icon" />
          <div>
            <div class="server-error-title">Test failed</div>
            <div class="server-error-body">{{ testResults[s.id]?.error }}</div>
          </div>
        </div>
      </div>
    </a-spin>

    <div v-if="servers.length" style="margin-top:16px;">
      <a-button type="primary" :loading="saving" @click="save">Save Changes</a-button>
    </div>

    <!-- Add/Edit modal -->
    <a-modal
      v-model:open="modalVisible"
      :title="editingServer.isNew ? 'Add MCP Server' : 'Edit MCP Server'"
      @ok="confirmEdit"
    >
      <a-form layout="vertical" style="margin-top:16px;">
        <a-form-item label="Name" required>
          <a-input v-model:value="editingServer.name" placeholder="My Analytics Server" />
        </a-form-item>
        <a-form-item label="URL" required>
          <a-input v-model:value="editingServer.url" placeholder="http://localhost:8080" />
          <div style="font-size:12px;color:#6b7280;margin-top:4px;">
            HTTP endpoint for the MCP server. The agent will POST JSON-RPC requests here.
          </div>
        </a-form-item>
        <a-form-item label="Enabled">
          <a-switch v-model:checked="editingServer.enabled" />
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.server-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 10px;
  background: #fafafa;
}
.server-main { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
/* min-width:0 lets this column shrink below its content; without it a long
   unbreakable string here dictates the row width. */
.server-info { min-width: 0; flex: 1; }
.server-url {
  font-size: 12px;
  color: #6b7280;
  margin-top: 2px;
  overflow-wrap: anywhere;
}
.server-tags { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }
.server-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
}
.server-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid #fecaca;
  border-radius: 6px;
  background: #fef2f2;
}
.server-error-icon { color: #dc2626; margin-top: 2px; flex-shrink: 0; }
.server-error-title { font-size: 12px; font-weight: 600; color: #b91c1c; }
.server-error-body {
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.5;
  color: #7f1d1d;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  /* The payload is often one long JSON blob with no spaces to break on. */
  overflow-wrap: anywhere;
  max-height: 120px;
  overflow-y: auto;
}
.server-error-hint { margin-top: 6px; font-size: 12px; color: #7f1d1d; line-height: 1.5; }
</style>
