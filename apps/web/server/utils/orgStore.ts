import { randomUUID } from 'node:crypto'
import { getDb } from '../db/client'

export interface Organization {
  id: string
  name: string
  slug: string
  createdAt: string
}

function toOrg(row: any): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at
  }
}

export function listOrgs(): Organization[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM organizations ORDER BY name ASC').all() as any[]
  return rows.map(toOrg)
}

export function getOrgById(id: string): Organization | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) as any
  return row ? toOrg(row) : null
}

export function getOrgBySlug(slug: string): Organization | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM organizations WHERE slug = ?').get(slug) as any
  return row ? toOrg(row) : null
}

export function createOrg(input: { name: string; slug: string }): Organization {
  const db = getDb()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO organizations (id, name, slug, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(id, input.name, input.slug)
  return getOrgById(id)!
}
