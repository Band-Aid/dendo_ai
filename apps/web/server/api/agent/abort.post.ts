import { z } from 'zod'
import { abortSession } from '~/server/utils/aggregation'

const requestSchema = z.object({
  sessionId: z.string().min(1)
})

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const input = requestSchema.parse(body)
  
  // Kill all running processes for this session
  abortSession(input.sessionId)
  
  return { success: true, message: 'Session aborted' }
})
