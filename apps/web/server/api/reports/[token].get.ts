import { getPublishedReport } from '~/server/utils/reportStore'
export default defineEventHandler(event => {
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'X-Robots-Tag', 'noindex, nofollow')
  return getPublishedReport(getRouterParam(event, 'token')!)
})
