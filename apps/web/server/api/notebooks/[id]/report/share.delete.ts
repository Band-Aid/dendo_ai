import { revokeReport } from '~/server/utils/reportStore'
export default defineEventHandler(event => revokeReport(getRouterParam(event, 'id')!, event.context.orgId))
