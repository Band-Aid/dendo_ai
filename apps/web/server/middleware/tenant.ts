import { defineEventHandler, getHeader } from 'h3'
import { getOrgById } from '~/server/utils/orgStore'

/**
 * Tenant middleware — resolves the current organization from the X-Org-Id request header.
 * Falls back to the built-in 'default' organization when no header is present,
 * when the value fails basic format validation, or when the org ID is not found
 * in the database (prevents arbitrary key inflation and cross-tenant data leakage).
 *
 * The resolved org ID is attached to event.context.orgId so every downstream
 * API handler can use it without re-reading the header.
 */

// Org IDs are UUIDs or the special value 'default'.
// Accept only alphanumeric characters plus hyphens, max 64 chars.
const ORG_ID_RE = /^[a-zA-Z0-9-]{1,64}$/

export default defineEventHandler((event) => {
  const raw = getHeader(event, 'x-org-id')?.trim()

  if (raw && ORG_ID_RE.test(raw)) {
    // Verify the org actually exists to prevent access to non-existent tenants
    // and to avoid unbounded growth of the kv_store keyspace.
    const org = getOrgById(raw)
    if (org) {
      event.context.orgId = org.id
      return
    }
  }

  event.context.orgId = 'default'
})
