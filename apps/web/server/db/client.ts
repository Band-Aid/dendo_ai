import { mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: any }

let db: any | null = null

function dbPath() {
  return resolve(process.cwd(), '.data', 'dendo.sqlite')
}

function ensureDbDir() {
  mkdirSync(dirname(dbPath()), { recursive: true })
}

function runMigrations(database: any) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL,
      decision_question TEXT NOT NULL,
      goal_type TEXT NOT NULL CHECK(goal_type IN ('revenue','roi')),
      primary_metric TEXT,
      workspace_state TEXT NOT NULL DEFAULT 'framing' CHECK(workspace_state IN ('framing','learning','deciding')),
      status TEXT NOT NULL DEFAULT 'exploring' CHECK(status IN ('exploring','validating','ready_to_act')),
      confidence TEXT NOT NULL DEFAULT 'low' CHECK(confidence IN ('low','med','high')),
      context_json TEXT,
      summary_json TEXT,
      recommendation_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_timeline (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      step_type TEXT NOT NULL,
      title TEXT NOT NULL,
      content_json TEXT,
      superseded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workspace_cards (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      question TEXT NOT NULL,
      claim TEXT NOT NULL,
      evidence_json TEXT,
      data_source_json TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','discarded')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_timeline_workspace ON workspace_timeline(workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_cards_workspace ON workspace_cards(workspace_id, created_at);
  `)

  // Seed the default organization (idempotent)
  database.exec(`
    INSERT OR IGNORE INTO organizations (id, name, slug, created_at)
    VALUES ('default', 'Default', 'default', datetime('now'))
  `)

  // Migration: add workspace_state column if missing (existing DBs)
  try {
    database.exec(`ALTER TABLE workspaces ADD COLUMN workspace_state TEXT NOT NULL DEFAULT 'framing' CHECK(workspace_state IN ('framing','learning','deciding'))`)
  } catch {
    // Column already exists — ignore
  }

  // Migration: add framing_notes_json column if missing
  try {
    database.exec(`ALTER TABLE workspaces ADD COLUMN framing_notes_json TEXT`)
  } catch {
    // Column already exists — ignore
  }

  // Migration: add notebook_cells_json column if missing
  try {
    database.exec(`ALTER TABLE workspaces ADD COLUMN notebook_cells_json TEXT`)
  } catch {
    // Column already exists — ignore
  }

  // Migration: add org_id column to workspaces if missing
  try {
    database.exec(`ALTER TABLE workspaces ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default'`)
  } catch {
    // Column already exists — ignore
  }

  // Index on org_id — created after the column migration so it is safe on both
  // new and existing databases.
  try {
    database.exec(`CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(org_id)`)
  } catch {
    // Index already exists — ignore
  }

  // Migration: add description column to workspaces
  try {
    database.exec(`ALTER TABLE workspaces ADD COLUMN description TEXT`)
  } catch {
    // Column already exists — ignore
  }

  // Migration: notebook-level default segment (applied to all aggregations that don't
  // explicitly override it, both in query cells and in agent-generated chat DSL).
  try {
    database.exec(`ALTER TABLE workspaces ADD COLUMN default_segment_id TEXT`)
  } catch {
    // Column already exists — ignore
  }
  try {
    database.exec(`ALTER TABLE workspaces ADD COLUMN default_segment_name TEXT`)
  } catch {
    // Column already exists — ignore
  }

  // Migration: create notebook_cells table (replaces notebook_cells_json blob)
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS notebook_cells (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        cell_type    TEXT NOT NULL CHECK(cell_type IN ('note','query','result','chart','agent_message','insight','question')),
        position     REAL NOT NULL,
        content      TEXT NOT NULL DEFAULT '',
        meta_json    TEXT,
        source_cell_id TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_notebook_cells_workspace ON notebook_cells(workspace_id, position);
    `)
  } catch {
    // Table already exists — ignore
  }

  // Migration: the original `notebook_cells.cell_type` CHECK constraint shipped
  // without the v2 'question' cell type, so inserting a question cell fails with
  // a constraint violation — which surfaces as a 500 when you click "Add
  // question below". SQLite can't ALTER a CHECK constraint, so rebuild the table
  // when the stored schema predates 'question'. Idempotent: the guard skips DBs
  // whose constraint already allows it (including freshly created ones).
  try {
    const existing = database
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='notebook_cells'`)
      .get() as { sql?: string } | undefined
    if (existing?.sql && !existing.sql.includes("'question'")) {
      // Nothing FK-references notebook_cells, so a copy/drop/rename rebuild is
      // safe. foreign_keys is toggled per the canonical SQLite procedure.
      database.exec(`PRAGMA foreign_keys=OFF`)
      database.exec(`
        BEGIN;
        CREATE TABLE notebook_cells_new (
          id           TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          cell_type    TEXT NOT NULL CHECK(cell_type IN ('note','query','result','chart','agent_message','insight','question')),
          position     REAL NOT NULL,
          content      TEXT NOT NULL DEFAULT '',
          meta_json    TEXT,
          source_cell_id TEXT,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
        INSERT INTO notebook_cells_new (id, workspace_id, cell_type, position, content, meta_json, source_cell_id, created_at, updated_at)
          SELECT id, workspace_id, cell_type, position, content, meta_json, source_cell_id, created_at, updated_at FROM notebook_cells;
        DROP TABLE notebook_cells;
        ALTER TABLE notebook_cells_new RENAME TO notebook_cells;
        CREATE INDEX IF NOT EXISTS idx_notebook_cells_workspace ON notebook_cells(workspace_id, position);
        COMMIT;
      `)
      database.exec(`PRAGMA foreign_keys=ON`)
    }
  } catch (err) {
    try { database.exec(`ROLLBACK; PRAGMA foreign_keys=ON`) } catch { /* no active tx */ }
    console.error('[db] notebook_cells cell_type migration (add question) failed:', err)
  }

  // Migration: notebook chat messages (sidebar chat persisted per notebook)
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS notebook_chat_messages (
        id                  TEXT PRIMARY KEY,
        notebook_id         TEXT NOT NULL,
        role                TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content             TEXT NOT NULL DEFAULT '',
        dsl                 TEXT,
        aggregations_json   TEXT,
        referenced_cell_ids TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (notebook_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_notebook_chat_messages_notebook
        ON notebook_chat_messages(notebook_id, created_at);
    `)
  } catch {
    // Table already exists — ignore
  }

  // Migration: agent-built summary charts attached to chat messages. Added
  // separately from `aggregations_json` because they're a different shape —
  // designed chart specs, not raw query output. Nullable so legacy rows
  // continue to deserialize to `summary_charts: []`.
  try {
    database.exec(`ALTER TABLE notebook_chat_messages ADD COLUMN summary_charts_json TEXT`)
  } catch {
    // Column already exists — ignore
  }

  // Migration: migrate existing notebook_cells_json blobs into notebook_cells rows
  try {
    const { randomUUID } = require('node:crypto')
    const rows = database.prepare(
      `SELECT id, notebook_cells_json FROM workspaces WHERE notebook_cells_json IS NOT NULL AND notebook_cells_json != ''`
    ).all() as Array<{ id: string; notebook_cells_json: string }>

    const typeMap: Record<string, string> = {
      text: 'note',
      output: 'result',
      agent_suggestion: 'agent_message',
      query: 'query',
      chart: 'chart'
    }

    for (const ws of rows) {
      const count = (database.prepare(
        `SELECT COUNT(*) as c FROM notebook_cells WHERE workspace_id = ?`
      ).get(ws.id) as { c: number }).c
      if (count > 0) continue // already migrated

      let cells: any[] = []
      try { cells = JSON.parse(ws.notebook_cells_json) } catch { continue }

      const insert = database.prepare(
        `INSERT OR IGNORE INTO notebook_cells (id, workspace_id, cell_type, position, content, meta_json, source_cell_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i]
        const newType = typeMap[c.type] ?? 'note'
        insert.run(
          c.id ?? randomUUID(),
          ws.id,
          newType,
          i + 1.0,
          c.content ?? '',
          JSON.stringify(c.metadata ?? {}),
          c.sourceCellId ?? null,
          c.createdAt ?? new Date().toISOString(),
          c.updatedAt ?? new Date().toISOString()
        )
      }
    }
  } catch (err) {
    console.error('[db] notebook_cells migration failed:', err)
  }
}

export function getDb() {
  if (!db) {
    ensureDbDir()
    db = new DatabaseSync(dbPath())
    runMigrations(db)
  }
  return db
}

export function dbGetJson<T>(key: string, fallback: T): T {
  const row = getDb().prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as { value: string } | undefined
  if (!row?.value) return fallback

  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export function dbSetJson<T>(key: string, value: T): void {
  const text = JSON.stringify(value)
  getDb()
    .prepare(`
      INSERT INTO kv_store (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `)
    .run(key, text)
}
