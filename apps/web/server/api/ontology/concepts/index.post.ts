import { entityNodeId, readOntology, registerEntities, upsertConcept } from '~/server/utils/ontologyStore'
import { readAdminState } from '~/server/utils/adminStore'
import { compileDsl } from '~/server/utils/aggregation'
import { syncKpiDslToMeasures } from '~/server/utils/conceptKpi'
import { conceptUpsertSchema } from '~/server/utils/schemas'

/**
 * Create or update one concept (the only concept write path besides delete).
 *
 * The template embeds concrete pendoIds, so a measures edit that doesn't touch
 * it leaves the concept querying its OLD entities — silently, since every read
 * path prefers the template. A machine-derived template is therefore rebuilt
 * from the saved measures here; a hand-written one is never rewritten, only
 * reported as drift. Either way the final template is best-effort compiled
 * offline and a non-blocking `dslWarning` returned — a broken template still
 * saves, but the user (and later the agent) should know it doesn't compile.
 */
export default defineEventHandler(async (event) => {
  const orgId = (event.context.orgId as string) || 'default'
  let input: ReturnType<typeof conceptUpsertSchema.parse>
  try {
    input = conceptUpsertSchema.parse(await readBody(event))
  } catch (err: any) {
    throw createError({ statusCode: 400, message: err.message })
  }

  // Live-searched entities the synced map doesn't hold yet: register the ones
  // this concept actually measures, so its references resolve in the graph.
  const { newEntities, ...conceptInput } = input
  const measured = new Set(conceptInput.measures)
  registerEntities(orgId, newEntities.filter(e => measured.has(entityNodeId(e.kind, e.pendoId))))

  // Read AFTER registration so measures pointing at just-registered entities
  // resolve to pendoIds when the template is rebuilt.
  const ontology = readOntology(orgId)
  const state = await readAdminState(orgId)
  const appId = ontology.structural.effectiveAppId ?? state.pendo?.defaultAppId ?? undefined

  let dslWarning: string | undefined
  let dslRegenerated = false
  const sync = syncKpiDslToMeasures(
    conceptInput.dslTemplate,
    conceptInput.measures,
    ontology.structural.nodes,
    appId
  )
  if (sync.next) {
    conceptInput.dslTemplate = sync.next
    dslRegenerated = true
  } else if (!sync.derived && (sync.staleIds.length || sync.missingIds.length)) {
    // Hand-written template — say what drifted and leave the fix to the author.
    const parts: string[] = []
    if (sync.staleIds.length) parts.push(`filters ${sync.staleIds.length} id(s) this concept no longer measures`)
    if (sync.missingIds.length) parts.push(`omits ${sync.missingIds.length} measured entity(s)`)
    dslWarning = `DSL template is out of sync with the measured objects: it ${parts.join(' and ')}. It was saved unchanged — edit it to match, or clear it to fall back to the measures.`
  }

  if (conceptInput.dslTemplate?.trim()) {
    try {
      const compiled = await compileDsl(conceptInput.dslTemplate)
      // A compile failure is the more urgent of the two — it wins the slot.
      if (!compiled.success) dslWarning = `DSL template does not compile: ${compiled.error}`
    } catch (err: any) {
      dslWarning = `DSL template check failed: ${err.message}`
    }
  }

  const concept = upsertConcept(orgId, conceptInput)
  return {
    concept,
    ...(dslWarning ? { dslWarning } : {}),
    ...(dslRegenerated ? { dslRegenerated: true } : {})
  }
})
