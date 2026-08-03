/**
 * Composable for managing the active organization in a multi-tenant context.
 *
 * The selected org ID is persisted in localStorage under the key `dendo_org_id`.
 * It is sent with every API call via the `X-Org-Id` request header (see useApi).
 * Falls back to the built-in 'default' organization when nothing is stored.
 */
import { ref, computed } from 'vue'

export interface Organization {
  id: string
  name: string
  slug: string
  createdAt: string
}

const STORAGE_KEY = 'dendo_org_id'

function readStoredOrgId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || 'default'
  } catch {
    return 'default'
  }
}

const currentOrgId = ref<string>('default')

const organizations = ref<Organization[]>([])
const loadingOrgs = ref(false)

let initialized = false
let orgsLoaded = false

function ensureInit() {
  if (initialized) return
  initialized = true
  currentOrgId.value = readStoredOrgId()
}

export function useOrg() {
  ensureInit()

  const currentOrg = computed(() =>
    organizations.value.find((o) => o.id === currentOrgId.value) ?? null
  )

  function setOrgId(id: string) {
    currentOrgId.value = id
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, id)
    }
  }

  async function loadOrganizations() {
    if (orgsLoaded) return
    orgsLoaded = true
    loadingOrgs.value = true
    try {
      const res = await fetch('/api/organizations', {
        headers: { 'Content-Type': 'application/json' }
      })
      if (!res.ok) throw new Error('Failed to load organizations')
      const data = await res.json()
      organizations.value = data.organizations ?? []

      // Ensure the stored org still exists; fall back to 'default' if not.
      const stored = currentOrgId.value
      if (!organizations.value.find((o) => o.id === stored)) {
        setOrgId('default')
      }
    } catch (err) {
      console.warn('[useOrg] Could not load organizations:', err)
    } finally {
      loadingOrgs.value = false
    }
  }

  async function createOrganization(name: string, slug: string): Promise<Organization> {
    const res = await fetch('/api/organizations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, slug })
    })
    if (!res.ok) {
      const text = await res.text().catch(() => 'Unknown error')
      throw new Error(`Failed to create organization: ${text}`)
    }
    const data = await res.json()
    const org: Organization = data.organization
    organizations.value = [...organizations.value, org]
    return org
  }

  return {
    currentOrgId,
    currentOrg,
    organizations,
    loadingOrgs,
    setOrgId,
    loadOrganizations,
    createOrganization
  }
}
