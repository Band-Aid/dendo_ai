/**
 * The agent selected to handle chat/question turns.
 *
 * Admin lets you configure several agents, but nothing surfaced a way to pick
 * which one actually runs — every endpoint silently used whichever sorted
 * first. The selection here is per-browser (localStorage, same pattern as
 * `useOrg`'s org id) rather than per-notebook: an agent is a personal choice
 * of "who answers my questions", not a property of the notebook's content.
 *
 * `null` means "no explicit choice" — every call site treats that as
 * "use the first enabled agent", which is the pre-existing behavior, so a
 * workspace with one agent configured (the common case) never sees a picker
 * or needs to think about this.
 */
import { ref, computed } from 'vue'
import { useApi } from '~/composables/useApi'

export interface AgentProfile {
  id: string
  name: string
  purpose: string
  enabled: boolean
  provider: 'anthropic' | 'openai' | 'azure_openai'
  model: string
}

const STORAGE_KEY = 'dendo_active_agent_id'

function readStoredAgentId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

const activeAgentId = ref<string | null>(null)
const agents = ref<AgentProfile[]>([])
const loadingAgents = ref(false)

let initialized = false
let agentsLoaded = false

function ensureInit() {
  if (initialized) return
  initialized = true
  activeAgentId.value = readStoredAgentId()
}

export function useActiveAgent() {
  ensureInit()
  const { callApi } = useApi()

  const enabledAgents = computed(() => agents.value.filter(a => a.enabled))

  const activeAgent = computed(() =>
    enabledAgents.value.find(a => a.id === activeAgentId.value) ?? enabledAgents.value[0] ?? null
  )

  function setActiveAgentId(id: string | null) {
    activeAgentId.value = id
    if (typeof window === 'undefined') return
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id)
      else localStorage.removeItem(STORAGE_KEY)
    } catch {}
  }

  async function loadAgents(force = false) {
    if (agentsLoaded && !force) return
    agentsLoaded = true
    loadingAgents.value = true
    try {
      agents.value = await callApi<AgentProfile[]>('/api/admin/agents')
      // A stored id that no longer matches an enabled agent (deleted,
      // disabled, or never existed) is dropped rather than kept around as a
      // silently-ignored value — callers should see the same "no explicit
      // choice" state a fresh browser would.
      const stored = activeAgentId.value
      if (stored && !enabledAgents.value.some(a => a.id === stored)) {
        setActiveAgentId(null)
      }
    } catch (err) {
      console.warn('[useActiveAgent] Could not load agents:', err)
    } finally {
      loadingAgents.value = false
    }
  }

  return {
    agents,
    enabledAgents,
    activeAgentId,
    activeAgent,
    loadingAgents,
    setActiveAgentId,
    loadAgents
  }
}
