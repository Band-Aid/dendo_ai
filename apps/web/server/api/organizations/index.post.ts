import { z } from 'zod'
import { createOrg, getOrgBySlug } from '~/server/utils/orgStore'

const bodySchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
})

export default defineEventHandler(async (event) => {
  const body = bodySchema.parse(await readBody(event))

  const existing = getOrgBySlug(body.slug)
  if (existing) {
    throw createError({ statusCode: 409, statusMessage: `Organization with slug "${body.slug}" already exists` })
  }

  const org = createOrg({ name: body.name, slug: body.slug })
  return { organization: org }
})
