import { getNotebook } from '~/server/utils/notebookStore'
import { listChatMessages } from '~/server/utils/chatMessageStore'

export default defineEventHandler((event) => {
  const orgId = getHeader(event, 'x-org-id') || 'default'
  const notebookId = getRouterParam(event, 'id')!

  try {
    getNotebook(notebookId, orgId)
  } catch {
    throw createError({ statusCode: 404, message: 'Notebook not found' })
  }

  return listChatMessages(notebookId)
})
