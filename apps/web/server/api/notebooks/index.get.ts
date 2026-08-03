import { listNotebooks } from '~/server/utils/notebookStore'

export default defineEventHandler(async (event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  return listNotebooks(orgId)
})
