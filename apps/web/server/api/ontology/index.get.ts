import { readAdminState } from '~/server/utils/adminStore'
import { readOntology, buildGraph } from '~/server/utils/ontologyStore'
import type { OntologyGraphResponse } from '~/types/ontology'

/**
 * Full ontology graph for the workspace: structural nodes + concept nodes,
 * with `measures`/`causes` edges derived from concepts at read time.
 */
export default defineEventHandler(async (event): Promise<OntologyGraphResponse> => {
  const orgId = (event.context.orgId as string) || 'default'
  const blob = readOntology(orgId)
  const { nodes, edges, danglingMeasures } = buildGraph(blob)
  const state = await readAdminState(orgId)

  return {
    nodes: nodes as OntologyGraphResponse['nodes'],
    edges,
    concepts: blob.concepts,
    meta: {
      syncedAt: blob.structural.syncedAt,
      truncated: blob.structural.truncated,
      counts: blob.structural.counts,
      conceptCount: blob.concepts.length,
      danglingMeasures,
      pendoConfigured: Boolean(state.pendo?.integrationKey),
      appIdMismatch: blob.structural.appIdMismatch
    }
  }
})
