import { entityNodeId, registerEntities, upsertConcept } from '~/server/utils/ontologyStore'
import { compileDsl } from '~/server/utils/aggregation'
import { conceptUpsertSchema } from '~/server/utils/schemas'

/**
 * Create or update one concept (the only concept write path besides delete).
 * If a DSL template is provided we best-effort compile it offline and return
 * a non-blocking `dslWarning` — a broken template still saves, but the user
 * (and later the agent) should know it doesn't compile.
 */
export default defineEventHandler(async (event) => {
  const orgId = (event.context.orgId as string) || 'default'
  let input: ReturnType<typeof conceptUpsertSchema.parse>
  try {
    input = conceptUpsertSchema.parse(await readBody(event))
  } catch (err: any) {
    throw createError({ statusCode: 400, message: err.message })
  }

  let dslWarning: string | undefined
  if (input.dslTemplate?.trim()) {
    try {
      const compiled = await compileDsl(input.dslTemplate)
      if (!compiled.success) dslWarning = `DSL template does not compile: ${compiled.error}`
    } catch (err: any) {
      dslWarning = `DSL template check failed: ${err.message}`
    }
  }

  // Live-searched entities the synced map doesn't hold yet: register the ones
  // this concept actually measures, so its references resolve in the graph.
  const { newEntities, ...conceptInput } = input
  const measured = new Set(conceptInput.measures)
  registerEntities(orgId, newEntities.filter(e => measured.has(entityNodeId(e.kind, e.pendoId))))

  const concept = upsertConcept(orgId, conceptInput)
  return { concept, ...(dslWarning ? { dslWarning } : {}) }
})
