import { listOrgs } from '~/server/utils/orgStore'

export default defineEventHandler(async () => {
  return { organizations: listOrgs() }
})
