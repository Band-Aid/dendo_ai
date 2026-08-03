import { z } from 'zod'
import { readAdminState } from '~/server/utils/adminStore'
import { emptyOntology, writeOntology, writeOverlay, writeConceptMetrics } from '~/server/utils/ontologyStore'
import { syncStructural } from '~/server/utils/ontologyBuilder'

const schema = z.object({
  /** Rebuild the structural layer right after clearing (default). */
  resync: z.boolean().default(true)
})

/**
 * Wipe the ontology completely — structural layer, ALL concepts, and the
 * cached usage overlay — and optionally rebuild fresh from Pendo. This is the
 * escape hatch for a map polluted by an earlier bad sync (wrong app, stale
 * demo entities, concepts linked against ids that no longer exist). The UI
 * gates it behind an explicit confirmation because concepts are not
 * recoverable.
 */
export default defineEventHandler(async (event) => {
  const orgId = (event.context.orgId as string) || 'default'
  const body = await readBody(event).catch(() => ({}))
  const { resync } = schema.parse(body ?? {})

  writeOntology(orgId, emptyOntology())
  // Expired sentinel — the overlay TTL check treats epoch 0 as stale, so the
  // next overlay request re-runs the usage queries instead of serving paint
  // from the pre-reset map.
  writeOverlay(orgId, { fetchedAt: new Date(0).toISOString(), metrics: {} })
  writeConceptMetrics(orgId, { fetchedAt: new Date(0).toISOString(), metrics: {} })

  const state = await readAdminState(orgId)
  if (resync && state.pendo?.integrationKey) {
    const structural = await syncStructural(orgId)
    return {
      ok: true,
      resynced: true,
      counts: structural.counts,
      truncated: structural.truncated,
      appIdMismatch: structural.appIdMismatch
    }
  }

  return { ok: true, resynced: false }
})
