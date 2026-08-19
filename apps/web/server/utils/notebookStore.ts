import { randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { getDb } from '../db/client'
import type { Notebook, NotebookCell, NotebookWithCells } from '~/types/notebook'

function nowIso() {
  return new Date().toISOString()
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function rowToCell(row: any): NotebookCell {
  return {
    id: row.id,
    cell_type: row.cell_type,
    position: row.position,
    content: row.content ?? '',
    meta_json: parseJson(row.meta_json, {}),
    source_cell_id: row.source_cell_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  } as NotebookCell
}

// Strip whitespace from string values that flow into command-line args, DSL
// injection, or JSON sent to upstream APIs. Trailing "\n" on segment ids leaked
// in via the agent's `lookup_segments.py` path in older flows and caused Pendo
// to 400 with "segment id not found: <id>\n".
function trimOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s.length ? s : null
}

function rowToNotebook(r: any): Notebook {
  return {
    id: r.id,
    org_id: r.org_id,
    title: r.title,
    description: r.description ?? null,
    default_segment_id: trimOrNull(r.default_segment_id),
    default_segment_name: trimOrNull(r.default_segment_name),
    default_account_id: trimOrNull(r.default_account_id),
    created_at: r.created_at,
    updated_at: r.updated_at
  }
}

const NOTEBOOK_COLUMNS = 'id, org_id, title, description, default_segment_id, default_segment_name, default_account_id, created_at, updated_at'

export function listNotebooks(orgId: string): Notebook[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT ${NOTEBOOK_COLUMNS}
     FROM workspaces WHERE org_id = ? ORDER BY updated_at DESC`
  ).all(orgId) as any[]
  return rows.map(rowToNotebook)
}

export function createNotebook(orgId: string, title: string, description?: string): Notebook {
  const db = getDb()
  const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(orgId) as any
  if (!org) throw createError({ statusCode: 400, message: `Organization '${orgId}' not found` })

  const id = randomUUID()
  const now = nowIso()
  db.prepare(
    `INSERT INTO workspaces (id, org_id, title, decision_question, goal_type, description, created_at, updated_at)
     VALUES (?, ?, ?, '', 'revenue', ?, ?, ?)`
  ).run(id, orgId, title, description ?? null, now, now)

  return { id, org_id: orgId, title, description: description ?? null, default_segment_id: null, default_segment_name: null, default_account_id: null, created_at: now, updated_at: now }
}

export function getNotebook(id: string, orgId: string): NotebookWithCells {
  const db = getDb()
  const row = db.prepare(
    `SELECT ${NOTEBOOK_COLUMNS} FROM workspaces WHERE id = ? AND org_id = ?`
  ).get(id, orgId) as any
  if (!row) throw createError({ statusCode: 404, message: 'Notebook not found' })

  const cellRows = db.prepare(
    `SELECT * FROM notebook_cells WHERE workspace_id = ? ORDER BY position ASC`
  ).all(id) as any[]

  return { ...rowToNotebook(row), cells: cellRows.map(rowToCell) }
}

export function updateNotebook(
  id: string,
  orgId: string,
  patch: {
    title?: string
    description?: string
    default_segment_id?: string | null
    default_segment_name?: string | null
    default_account_id?: string | null
  }
): Notebook {
  const db = getDb()
  const existing = db.prepare('SELECT id FROM workspaces WHERE id = ? AND org_id = ?').get(id, orgId) as any
  if (!existing) throw createError({ statusCode: 404, message: 'Notebook not found' })

  const sets: string[] = ['updated_at = ?']
  const params: any[] = [nowIso()]
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title) }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
  if (patch.default_segment_id !== undefined) { sets.push('default_segment_id = ?'); params.push(patch.default_segment_id) }
  if (patch.default_segment_name !== undefined) { sets.push('default_segment_name = ?'); params.push(patch.default_segment_name) }
  if (patch.default_account_id !== undefined) { sets.push('default_account_id = ?'); params.push(patch.default_account_id) }
  params.push(id, orgId)

  db.prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`).run(...params)
  return getNotebook(id, orgId)
}

export function deleteNotebook(id: string, orgId: string): void {
  const db = getDb()
  const existing = db.prepare('SELECT id FROM workspaces WHERE id = ? AND org_id = ?').get(id, orgId) as any
  if (!existing) throw createError({ statusCode: 404, message: 'Notebook not found' })
  db.prepare('DELETE FROM workspaces WHERE id = ? AND org_id = ?').run(id, orgId)
}

function maxPosition(workspaceId: string): number {
  const db = getDb()
  const row = db.prepare('SELECT MAX(position) as m FROM notebook_cells WHERE workspace_id = ?').get(workspaceId) as any
  return row?.m ?? 0
}

function positionAfterCell(workspaceId: string, afterCellId: string): number {
  const db = getDb()
  const after = db.prepare('SELECT position FROM notebook_cells WHERE id = ? AND workspace_id = ?').get(afterCellId, workspaceId) as any
  if (!after) return maxPosition(workspaceId) + 1.0

  const next = db.prepare(
    'SELECT position FROM notebook_cells WHERE workspace_id = ? AND position > ? ORDER BY position ASC LIMIT 1'
  ).get(workspaceId, after.position) as any

  if (!next) return after.position + 1.0
  return (after.position + next.position) / 2
}

export function addCell(
  workspaceId: string,
  orgId: string,
  cellType: string,
  content: string,
  metaJson: Record<string, unknown>,
  sourceCellId?: string | null,
  afterCellId?: string | null
): NotebookCell {
  const db = getDb()
  const ws = db.prepare('SELECT id FROM workspaces WHERE id = ? AND org_id = ?').get(workspaceId, orgId) as any
  if (!ws) throw createError({ statusCode: 404, message: 'Notebook not found' })

  const id = randomUUID()
  const now = nowIso()
  const position = afterCellId
    ? positionAfterCell(workspaceId, afterCellId)
    : maxPosition(workspaceId) + 1.0

  db.prepare(
    `INSERT INTO notebook_cells (id, workspace_id, cell_type, position, content, meta_json, source_cell_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, workspaceId, cellType, position, content, JSON.stringify(metaJson), sourceCellId ?? null, now, now)

  db.prepare('UPDATE workspaces SET updated_at = ? WHERE id = ?').run(now, workspaceId)

  const row = db.prepare('SELECT * FROM notebook_cells WHERE id = ?').get(id) as any
  return rowToCell(row)
}

export function updateCell(
  cellId: string,
  workspaceId: string,
  orgId: string,
  patch: {
    content?: string
    meta_json?: Record<string, unknown>
    cell_type?: string
    /** Re-parent a cell. Used to adopt orphaned result cells created before
     *  query→result pairing was recorded (see handleRunQuery). */
    source_cell_id?: string | null
  }
): NotebookCell {
  const db = getDb()
  const ws = db.prepare('SELECT id FROM workspaces WHERE id = ? AND org_id = ?').get(workspaceId, orgId) as any
  if (!ws) throw createError({ statusCode: 404, message: 'Notebook not found' })

  const existing = db.prepare('SELECT * FROM notebook_cells WHERE id = ? AND workspace_id = ?').get(cellId, workspaceId) as any
  if (!existing) throw createError({ statusCode: 404, message: 'Cell not found' })

  const sets: string[] = ['updated_at = ?']
  const params: any[] = [nowIso()]
  if (patch.content !== undefined) { sets.push('content = ?'); params.push(patch.content) }
  if (patch.meta_json !== undefined) { sets.push('meta_json = ?'); params.push(JSON.stringify(patch.meta_json)) }
  if (patch.cell_type !== undefined) { sets.push('cell_type = ?'); params.push(patch.cell_type) }
  if (patch.source_cell_id !== undefined) { sets.push('source_cell_id = ?'); params.push(patch.source_cell_id) }
  params.push(cellId, workspaceId)

  db.prepare(`UPDATE notebook_cells SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...params)

  const row = db.prepare('SELECT * FROM notebook_cells WHERE id = ?').get(cellId) as any
  return rowToCell(row)
}

export function deleteCell(cellId: string, workspaceId: string, orgId: string): void {
  const db = getDb()
  const ws = db.prepare('SELECT id FROM workspaces WHERE id = ? AND org_id = ?').get(workspaceId, orgId) as any
  if (!ws) throw createError({ statusCode: 404, message: 'Notebook not found' })
  db.prepare('DELETE FROM notebook_cells WHERE id = ? AND workspace_id = ?').run(cellId, workspaceId)
}

export function moveCell(
  cellId: string,
  workspaceId: string,
  orgId: string,
  afterCellId: string | null
): NotebookCell {
  const db = getDb()
  const ws = db.prepare('SELECT id FROM workspaces WHERE id = ? AND org_id = ?').get(workspaceId, orgId) as any
  if (!ws) throw createError({ statusCode: 404, message: 'Notebook not found' })

  const existing = db.prepare('SELECT * FROM notebook_cells WHERE id = ? AND workspace_id = ?').get(cellId, workspaceId) as any
  if (!existing) throw createError({ statusCode: 404, message: 'Cell not found' })

  const newPosition = afterCellId
    ? positionAfterCell(workspaceId, afterCellId)
    : 0.5

  db.prepare('UPDATE notebook_cells SET position = ?, updated_at = ? WHERE id = ?')
    .run(newPosition, nowIso(), cellId)

  const row = db.prepare('SELECT * FROM notebook_cells WHERE id = ?').get(cellId) as any
  return rowToCell(row)
}

export function getCells(workspaceId: string, orgId: string): NotebookCell[] {
  const db = getDb()
  const ws = db.prepare('SELECT id FROM workspaces WHERE id = ? AND org_id = ?').get(workspaceId, orgId) as any
  if (!ws) throw createError({ statusCode: 404, message: 'Notebook not found' })
  const rows = db.prepare(
    'SELECT * FROM notebook_cells WHERE workspace_id = ? ORDER BY position ASC'
  ).all(workspaceId) as any[]
  return rows.map(rowToCell)
}
