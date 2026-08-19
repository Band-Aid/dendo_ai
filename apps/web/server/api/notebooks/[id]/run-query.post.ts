import { z } from 'zod'
import { getNotebook } from '~/server/utils/notebookStore'
import {
  compileDsl,
  runAggregation,
  enrichWithNames,
  extractRowsColumns
} from '~/server/utils/aggregation'

/**
 * Run a notebook query cell end-to-end: compile aggDSL (with the notebook's
 * default segment), execute against Pendo, enrich result IDs with friendly
 * names, then flatten to `{ rows, columns }`. Mirrors what the agent's
 * `run_pendo_aggregation` tool does so cell-run and chat-run produce
 * identical result shapes.
 */
const schema = z.object({
  dsl: z.string().min(1)
})

export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const notebookId = getRouterParam(event, 'id')!
  const body = await readBody(event)

  let input: z.infer<typeof schema>
  try {
    input = schema.parse(body)
  } catch (err: any) {
    throw createError({ statusCode: 400, message: err.message })
  }

  let notebook
  try {
    notebook = getNotebook(notebookId, orgId)
  } catch {
    throw createError({ statusCode: 404, message: 'Notebook not found' })
  }

  // 1. Compile with notebook default segment.
  const compiled = await compileDsl(input.dsl, undefined, {
    defaultSegmentId: notebook.default_segment_id ?? null,
    defaultAccountId: notebook.default_account_id ?? null
  })
  if (!compiled.success) {
    return { success: false, stage: 'compile', error: compiled.error }
  }

  // 2. Send compiled body to Pendo.
  const agg = await runAggregation(JSON.stringify(compiled.data), false, undefined, orgId)
  if (!agg.success) {
    return { success: false, stage: 'aggregate', error: agg.error }
  }

  // 3. Enrich rows with friendly names (best-effort — fall back to raw on failure).
  const enriched = await enrichWithNames(agg.data, undefined, orgId)
  const dataForExtraction = enriched.success ? enriched.data : agg.data

  // 4. Flatten Pendo's response variants to a uniform `{ rows, columns }`.
  const { rows, columns } = extractRowsColumns(dataForExtraction)

  return {
    success: true,
    rows,
    columns,
    rowCount: rows.length,
    effectiveDsl: compiled.effectiveDsl
  }
})
