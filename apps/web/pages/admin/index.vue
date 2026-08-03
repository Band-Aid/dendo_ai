<script setup lang="ts">
import { ref, onMounted, computed, h, watch } from 'vue'
import { SaveOutlined, EditOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons-vue'
import { message as $message } from 'ant-design-vue'
import { useApi } from '../../composables/useApi'
import McpServerConfig from '../../components/admin/McpServerConfig.vue'
import { useOrg } from '../../composables/useOrg'
import { useI18n } from '../../composables/useI18n'

const { t } = useI18n()
const { currentOrgId } = useOrg()

const { callApi } = useApi()

// State
const loading = ref(false)
const saving = ref(false)
const activeTab = ref('1')
const fetchingModels = ref(false)
const fetchedModels = ref<Record<string, string[]>>({})

// Provider state
const providers = ref<any[]>([])

// Pendo state
const pendoForm = ref({
  integrationKey: '',
  apiEndpoint: 'https://app.pendo.io/api/v1/aggregation',
  defaultAppId: -323232
})
const pendoStatus = ref({ hasKey: false, endpoint: '', defaultAppId: 0 })

// General settings state
const settingsForm = ref({
  maxTokens: 2000
})

// Agent state
const agents = ref<any[]>([])
const agentModalVisible = ref(false)
const agentForm = ref({
  id: '',
  name: '',
  purpose: '',
  systemPrompt: '',
  provider: 'azure_openai' as 'openai' | 'anthropic' | 'azure_openai',
  model: '',
  enabled: true
})

const enabledProviders = computed(() => providers.value.filter(p => p.enabled && p.hasApiKey))

const availableModels = computed(() => {
  // Return fetched models if available, otherwise return empty array
  return fetchedModels.value[agentForm.value.provider] || []
})

// Fetch models from provider API
async function fetchModelsForProvider(provider: string, force = false) {
  // Skip only when we already have non-empty models, unless force refresh is requested.
  if (!force && Array.isArray(fetchedModels.value[provider]) && fetchedModels.value[provider].length > 0) {
    return
  }
  
  fetchingModels.value = true
  try {
    const url = `/api/admin/providers/models?provider=${provider}`
    
    const data = await callApi<{ models: string[]; cached?: boolean }>(url)
    fetchedModels.value[provider] = data.models
    
    if (data.cached) {
      console.log(`Loaded ${data.models.length} cached models for ${provider}`)
    } else {
      console.log(`Fetched ${data.models.length} models from ${provider} API`)
    }
  } catch (err: any) {
    console.error(`Failed to fetch models for ${provider}:`, err)
    $message.error(`Failed to fetch models: ${err.message}`)
    delete fetchedModels.value[provider]
  } finally {
    fetchingModels.value = false
  }
}

// Watch for provider changes and fetch models
watch(() => agentForm.value.provider, (newProvider) => {
  if (newProvider) {
    fetchModelsForProvider(newProvider, true)
  }
}, { immediate: false })

// Load all data
async function loadAll() {
  loading.value = true
  
  try {
    const [providersData, pendoData, agentsData, settingsData] = await Promise.all([
      callApi<any[]>('/api/admin/providers'),
      callApi<any>('/api/admin/pendo'),
      callApi<any[]>('/api/admin/agents'),
      callApi<any>('/api/admin/settings')
    ])
    
    providers.value = providersData
    agents.value = agentsData
    pendoStatus.value = {
      hasKey: pendoData.hasIntegrationKey || false,
      endpoint: pendoData.apiEndpoint || '',
      defaultAppId: pendoData.defaultAppId || -323232
    }
    pendoForm.value.apiEndpoint = pendoData.apiEndpoint || 'https://app.pendo.io/api/v1/aggregation'
    pendoForm.value.defaultAppId = pendoData.defaultAppId || -323232
    settingsForm.value.maxTokens = settingsData.maxTokens ?? 2000

    // Warm model cache for configured providers so modal opens with options ready.
    for (const p of providers.value) {
      if (p.enabled && p.hasApiKey) {
        void fetchModelsForProvider(p.provider, true)
      }
    }
  } catch (err: any) {
    $message.error(err.message || 'Failed to load settings')
  } finally {
    loading.value = false
  }
}

// Provider functions
async function toggleProvider(provider: any, enabled: boolean) {
  saving.value = true
  try {
    const payload: any = {
      provider: provider.provider,
      enabled
    }
    
    // Only include apiKey if it's actually provided (not masked)
    if (provider.apiKey && provider.apiKey !== '****') {
      payload.apiKey = provider.apiKey
    }
    
    // Only include Azure-specific fields if provider is azure_openai
    if (provider.provider === 'azure_openai') {
      if (provider.endpoint) payload.endpoint = provider.endpoint
      if (provider.deployment) payload.deployment = provider.deployment
      if (provider.apiVersion) payload.apiVersion = provider.apiVersion
    }
    
    await callApi('/api/admin/providers', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
    $message.success(`${provider.provider} ${enabled ? 'enabled' : 'disabled'}`)
    await loadAll()
  } catch (err: any) {
    $message.error(err.message || `Failed to update ${provider.provider}`)
  } finally {
    saving.value = false
  }
}

async function saveProvider(provider: any, values: any) {
  saving.value = true
  try {
    const payload: any = {
      provider: provider.provider,
      enabled: provider.enabled
    }
    
    // Only include apiKey if it's actually provided and not masked
    if (values.apiKey && values.apiKey !== '****') {
      payload.apiKey = values.apiKey
    }
    
    // Only include Azure-specific fields if provider is azure_openai
    if (provider.provider === 'azure_openai') {
      if (values.endpoint) payload.endpoint = values.endpoint
      if (values.deployment) payload.deployment = values.deployment
      if (values.apiVersion) payload.apiVersion = values.apiVersion
    }
    
    await callApi('/api/admin/providers', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
    $message.success(`${provider.provider} saved successfully`)
    await loadAll()
  } catch (err: any) {
    $message.error(err.message || `Failed to save ${provider.provider}`)
  } finally {
    saving.value = false
  }
}

// Pendo functions
const testingPendo = ref(false)

/** Round-trip the key against Pendo's /token/verify — tests the typed key if
 *  present, otherwise the stored one. */
async function testPendo() {
  testingPendo.value = true
  try {
    const res = await callApi<{ writeAccess: boolean }>('/api/admin/pendo/test', {
      method: 'POST',
      body: JSON.stringify({ integrationKey: pendoForm.value.integrationKey || undefined })
    })
    $message.success(`Pendo key is valid (${res.writeAccess ? 'read/write' : 'read-only'})`)
  } catch (err: any) {
    $message.error(err.message || 'Pendo key test failed')
  } finally {
    testingPendo.value = false
  }
}

async function savePendo() {
  saving.value = true
  try {
    await callApi('/api/admin/pendo', {
      method: 'POST',
      body: JSON.stringify(pendoForm.value)
    })
    $message.success('Pendo settings saved')
    pendoForm.value.integrationKey = ''
    await loadAll()
  } catch (err: any) {
    $message.error(err.message || 'Failed to save Pendo settings')
  } finally {
    saving.value = false
  }
}

// General settings functions
async function saveSettings() {
  saving.value = true
  try {
    await callApi('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify(settingsForm.value)
    })
    $message.success('Settings saved')
    await loadAll()
  } catch (err: any) {
    $message.error(err.message || 'Failed to save settings')
  } finally {
    saving.value = false
  }
}

// Agent functions
function openAgentModal(agent?: any) {
  if (agent) {
    agentForm.value = { ...agent }
  } else {
    const preferredProvider = enabledProviders.value[0]?.provider || 'anthropic'

    agentForm.value = {
      id: '',
      name: '',
      purpose: '',
      systemPrompt: '',
      provider: preferredProvider,
      model: '',
      enabled: true
    }
  }
  agentModalVisible.value = true
  
  // Fetch models for the selected provider
  fetchModelsForProvider(agentForm.value.provider, true)
}

async function saveAgent() {
  saving.value = true
  try {
    const id = agentForm.value.id || crypto.randomUUID()
    
    await callApi('/api/admin/agents', {
      method: 'POST',
      body: JSON.stringify({
        ...agentForm.value,
        id,
        enabledTools: [],
        guardrails: []
      })
    })
    
    $message.success(`Agent "${agentForm.value.name}" saved`)
    agentModalVisible.value = false
    await loadAll()
  } catch (err: any) {
    $message.error(err.message || 'Failed to save agent')
  } finally {
    saving.value = false
  }
}

async function deleteAgent(agent: any) {
  saving.value = true
  try {
    await callApi('/api/admin/agents', {
      method: 'DELETE',
      body: JSON.stringify({ id: agent.id })
    })
    $message.success(`Agent "${agent.name}" deleted`)
    await loadAll()
  } catch (err: any) {
    $message.error(err.message || 'Failed to delete agent')
  } finally {
    saving.value = false
  }
}

onMounted(loadAll)
</script>

<template>
  <div class="admin-page">
    <header class="admin-masthead">
      <div class="masthead-eyebrow">
        <span class="eyebrow">{{ t('ui.admin.masthead.vol') }}</span>
        <span class="rule" />
        <span class="masthead-stage mono">{{ t('ui.admin.masthead.stage') }}</span>
      </div>
      <div class="masthead-row">
        <h1 class="masthead-title">
          {{ t('ui.admin.masthead.titleA') }}<br/>
          <em>{{ t('ui.admin.masthead.titleB') }}</em>
        </h1>
      </div>
      <p class="masthead-lede">{{ t('ui.admin.masthead.lede') }}</p>
    </header>

    <div class="admin-body">
      <a-tabs v-model:activeKey="activeTab">
        <!-- Agents Tab -->
        <a-tab-pane key="1" tab="Agents">
          <div style="margin-bottom: 16px;">
            <a-button type="primary" :icon="h(PlusOutlined)" @click="openAgentModal()">
              Add Agent
            </a-button>
          </div>
          
          <a-table 
            :dataSource="agents" 
            :columns="[
              { title: 'Name', dataIndex: 'name', key: 'name' },
              { title: 'Model', dataIndex: 'model', key: 'model' },
              { title: 'Provider', dataIndex: 'provider', key: 'provider' },
              { title: 'Status', key: 'enabled', dataIndex: 'enabled' },
              { title: 'Actions', key: 'actions' }
            ]"
            :loading="loading"
            :rowKey="(record: any) => record.id"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'enabled'">
                <a-tag :color="record.enabled ? 'green' : 'red'">
                  {{ record.enabled ? 'Enabled' : 'Disabled' }}
                </a-tag>
              </template>
              <template v-if="column.key === 'actions'">
                <a-space>
                  <a-button size="small" :icon="h(EditOutlined)" @click="openAgentModal(record)">
                    Edit
                  </a-button>
                  <a-popconfirm
                    title="Delete this agent?"
                    @confirm="deleteAgent(record)"
                  >
                    <a-button size="small" danger :icon="h(DeleteOutlined)">
                      Delete
                    </a-button>
                  </a-popconfirm>
                </a-space>
              </template>
            </template>
          </a-table>
        </a-tab-pane>

        <!-- Providers Tab -->
        <a-tab-pane key="2" tab="Providers">
          <a-space direction="vertical" style="width: 100%;" :size="16">
            <a-card
              v-for="provider in providers"
              :key="provider.provider"
              :title="provider.provider.toUpperCase()"
            >
              <template #extra>
                <a-switch 
                  v-model:checked="provider.enabled" 
                  @change="(checked: boolean) => toggleProvider(provider, checked)"
                  :loading="saving"
                />
              </template>
              
              <a-form layout="vertical">
                <a-form-item label="API Key">
                  <a-input-password 
                    v-model:value="provider.apiKey" 
                    :placeholder="provider.hasApiKey ? 'Saved key is redacted. Enter a new key only if rotating.' : 'Enter API key'"
                  />
                  <div v-if="provider.hasApiKey" style="font-size: 12px; color: #64748b; margin-top: 4px;">
                    API key is saved.
                  </div>
                </a-form-item>
                
                <a-form-item 
                  v-if="provider.provider === 'azure_openai'" 
                  label="Endpoint"
                >
                  <a-input v-model:value="provider.endpoint" placeholder="https://xxx.openai.azure.com" />
                </a-form-item>
                
                <a-form-item 
                  v-if="provider.provider === 'azure_openai'" 
                  label="Deployment"
                >
                  <a-input v-model:value="provider.deployment" placeholder="gpt-4" />
                </a-form-item>
                
                <a-button 
                  type="primary" 
                  :icon="h(SaveOutlined)"
                  @click="saveProvider(provider, provider.provider === 'azure_openai' ? { apiKey: provider.apiKey, endpoint: provider.endpoint, deployment: provider.deployment, apiVersion: provider.apiVersion } : { apiKey: provider.apiKey })"
                  :loading="saving"
                >
                  Save
                </a-button>
              </a-form>
            </a-card>
          </a-space>
        </a-tab-pane>

        <!-- Pendo Tab -->
        <a-tab-pane key="3" tab="Pendo Integration">
          <a-card>
            <a-alert
              v-if="pendoStatus.hasKey"
              message="Pendo is configured"
              type="success"
              show-icon
              style="margin-bottom: 16px;"
            />
            
            <a-form layout="vertical">
              <a-form-item label="Integration Key">
                <a-input-password 
                  v-model:value="pendoForm.integrationKey" 
                  placeholder="Enter Pendo integration key"
                />
              </a-form-item>
              
              <a-form-item label="API Endpoint">
                <a-input 
                  v-model:value="pendoForm.apiEndpoint" 
                  placeholder="https://app.pendo.io/api/v1/aggregation"
                />
              </a-form-item>
              
              <a-form-item label="Default App ID">
                <a-input-number 
                  v-model:value="pendoForm.defaultAppId" 
                  :style="{ width: '200px' }"
                  placeholder="-323232"
                />
              </a-form-item>
              
              <a-space>
                <a-button
                  type="primary"
                  :icon="h(SaveOutlined)"
                  @click="savePendo"
                  :loading="saving"
                >
                  Save Pendo Settings
                </a-button>
                <a-button
                  @click="testPendo"
                  :loading="testingPendo"
                >
                  Test Connection
                </a-button>
              </a-space>
            </a-form>
          </a-card>
        </a-tab-pane>

        <!-- MCP Tools Tab -->
        <a-tab-pane key="mcp" tab="MCP Tools">
          <a-card>
            <McpServerConfig :org-id="currentOrgId" />
          </a-card>
        </a-tab-pane>

        <!-- Settings Tab -->
        <a-tab-pane key="settings" tab="Settings">
          <a-card>
            <a-form layout="vertical">
              <a-form-item label="Max Tokens per Response" extra="Controls the maximum number of tokens the LLM can return in a single response. Increase this if responses are getting cut off.">
                <a-input-number
                  v-model:value="settingsForm.maxTokens"
                  :min="1"
                  :style="{ width: '200px' }"
                  placeholder="2000"
                />
              </a-form-item>

              <a-button
                type="primary"
                :icon="h(SaveOutlined)"
                @click="saveSettings"
                :loading="saving"
              >
                Save Settings
              </a-button>
            </a-form>
          </a-card>
        </a-tab-pane>
      </a-tabs>
    </div>

    <!-- Agent Modal -->
    <a-modal
      v-model:open="agentModalVisible"
      :title="agentForm.id ? 'Edit Agent' : 'Add Agent'"
      @ok="saveAgent"
      :confirmLoading="saving"
      width="600px"
    >
      <a-form layout="vertical" style="margin-top: 16px;">
        <a-form-item label="Name" required>
          <a-input v-model:value="agentForm.name" placeholder="e.g., analyst" />
        </a-form-item>
        
        <a-form-item label="Purpose">
          <a-textarea v-model:value="agentForm.purpose" :rows="2" placeholder="Brief description" />
        </a-form-item>
        
        <a-form-item label="Provider" required>
          <a-select v-model:value="agentForm.provider">
            <a-select-option value="openai">OpenAI</a-select-option>
            <a-select-option value="anthropic">Anthropic</a-select-option>
            <a-select-option value="azure_openai">Azure OpenAI</a-select-option>
          </a-select>
        </a-form-item>
        
        <a-form-item label="Model" required>
          <a-auto-complete 
            v-model:value="agentForm.model" 
            placeholder="Select or type model name"
            :options="availableModels.map(m => ({ value: m }))"
            :filter-option="(input: string, option: any) => option.value.toLowerCase().includes(input.toLowerCase())"
            :loading="fetchingModels"
          />
          <div style="margin-top: 4px; font-size: 12px; color: #64748b;">
            <span v-if="fetchingModels">Fetching available models...</span>
            <span v-else-if="availableModels.length === 0">No models found. You can still enter a custom model name.</span>
            <span v-else>Select from {{ availableModels.length }} available models or enter custom name</span>
          </div>
        </a-form-item>
        
        <a-form-item label="System Prompt">
          <a-textarea v-model:value="agentForm.systemPrompt" :rows="4" placeholder="Custom system prompt (optional)" />
        </a-form-item>
        
        <a-form-item label="Status">
          <a-switch v-model:checked="agentForm.enabled">
            <template #checkedChildren>Enabled</template>
            <template #unCheckedChildren>Disabled</template>
          </a-switch>
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.admin-page {
  max-width: 1080px;
  margin: 0 auto;
}
.admin-masthead {
  padding: 16px 0 30px;
  border-bottom: 1px solid var(--rule);
  margin-bottom: 28px;
}
.masthead-eyebrow {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}
.masthead-eyebrow .rule { flex: 1; height: 1px; background: var(--rule); }
.masthead-stage { font-size: 11px; letter-spacing: 0.06em; color: var(--muted); }
.masthead-row { display: flex; justify-content: space-between; align-items: flex-end; gap: 32px; }
.masthead-title {
  font-family: var(--serif);
  font-weight: 420;
  font-variation-settings: 'opsz' 96, 'SOFT' 40;
  font-size: clamp(34px, 4.6vw, 48px);
  line-height: 1.04;
  letter-spacing: -0.025em;
  color: var(--ink);
  margin: 0;
}
.masthead-title em {
  font-style: italic;
  font-variation-settings: 'opsz' 96, 'SOFT' 100, 'WONK' 1;
  color: var(--accent);
}
.masthead-lede {
  margin: 18px 0 0;
  max-width: 580px;
  font-size: 16px;
  line-height: 1.6;
  color: var(--ink-2);
}

.admin-body {
  background: transparent;
}
.admin-body :deep(.ant-tabs) {
  font-family: var(--sans);
}
.admin-body :deep(.ant-tabs-tab) {
  font-size: 13.5px;
  letter-spacing: -0.005em;
}
.admin-body :deep(.ant-card) {
  margin-bottom: 16px;
}
.admin-body :deep(.ant-card-head-title) {
  font-family: var(--serif) !important;
  font-weight: 500 !important;
  font-variation-settings: 'opsz' 28, 'SOFT' 30 !important;
  font-size: 16px !important;
  letter-spacing: -0.01em !important;
  text-transform: capitalize;
}
</style>
