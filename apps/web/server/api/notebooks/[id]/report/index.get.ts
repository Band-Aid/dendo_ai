import { getReportState } from '~/server/utils/reportStore'
export default defineEventHandler(event => getReportState(getRouterParam(event, 'id')!, event.context.orgId))
