import { randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { getDb } from '../db/client'

export type WorkspaceGoalType = 'revenue' | 'roi'
export type WorkspaceStatus = 'exploring' | 'validating' | 'ready_to_act'
export type WorkspaceState = 'framing' | 'learning' | 'deciding'
export type ConfidenceLevel = 'low' | 'med' | 'high'

/** Valid transitions: framing→learning, learning→deciding, deciding→learning (re-open evidence) */
const VALID_STATE_TRANSITIONS: Record<WorkspaceState, WorkspaceState[]> = {
  framing: ['learning'],
  learning: ['deciding'],
  deciding: ['learning']
}

interface WorkspaceContext {
  decisionTitle: string
  goalType: WorkspaceGoalType
  primarySuccessMetric: string
  status: WorkspaceStatus
  confidence: ConfidenceLevel
}

interface DecisionSummary {
  stance: string
  rationale: string
  changeTriggers: string[]
}

interface EvidenceTimelineStep {
  id: string
  stepType: 'hypothesis' | 'data_pull' | 'finding' | 'refinement' | 'analysis_plan'
  title: string
  content: string
  createdAt: string
  superseded?: boolean
}

interface EvidenceCard {
  id: string
  question: string
  claim: string
  evidence: string[]
  dataSource: string[]
  status: 'active' | 'superseded' | 'discarded'
}

interface Recommendation {
  proposedAction: string
  supportingEvidence: string[]
  risks: string[]
  confidence: ConfidenceLevel
  nextExperiment: string
}

interface FramingNote {
  role: 'user' | 'agent'
  content: string
  timestamp: string
}

export type NotebookCellType = 'text' | 'query' | 'output' | 'chart' | 'agent_suggestion'

export interface NotebookCell {
  id: string
  type: NotebookCellType
  content: string
  name?: string
  metadata?: Record<string, any>
  sourceCellId?: string
  createdAt: string
  updatedAt: string
}

export interface DecisionWorkspace {
  id: string
  title: string
  decisionQuestion: string
  workspaceState: WorkspaceState
  context: WorkspaceContext
  summary: DecisionSummary
  timeline: EvidenceTimelineStep[]
  cards: EvidenceCard[]
  recommendation: Recommendation
  framingNotes: FramingNote[]
  notebookCells: NotebookCell[]
  createdAt: string
  updatedAt: string
}

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

function defaultSummary(): DecisionSummary {
  return {
    stance: 'No stance yet. Start by pressure-testing your core assumption.',
    rationale: 'Insufficient evidence has been collected.',
    changeTriggers: ['Evidence that contradicts current assumption', 'Higher-confidence leading indicators']
  }
}

function defaultRecommendation(): Recommendation {
  return {
    proposedAction: 'No committed action yet.',
    supportingEvidence: [],
    risks: ['Insufficient evidence'],
    confidence: 'low',
    nextExperiment: 'Run first evidence pull tied to your primary decision question.'
  }
}

function defaultNotebookCells(question: string): NotebookCell[] {
  const now = nowIso()
  return [
    {
      id: randomUUID(),
      type: 'text',
      content: `# Exploration\n\n${question || 'Start by writing a question or adding a DSL query cell.'}`,
      createdAt: now,
      updatedAt: now,
      metadata: {}
    }
  ]
}

function toWorkspace(row: any, timeline: EvidenceTimelineStep[], cards: EvidenceCard[]): DecisionWorkspace {
  const context = parseJson<WorkspaceContext>(row.context_json, {
    decisionTitle: row.title,
    goalType: row.goal_type,
    primarySuccessMetric: row.primary_metric || '',
    status: row.status,
    confidence: row.confidence
  })

  return {
    id: row.id,
    title: row.title,
    decisionQuestion: row.decision_question,
    workspaceState: (row.workspace_state || 'framing') as WorkspaceState,
    context,
    summary: parseJson<DecisionSummary>(row.summary_json, defaultSummary()),
    timeline,
    cards,
    recommendation: parseJson<Recommendation>(row.recommendation_json, defaultRecommendation()),
    framingNotes: parseJson<FramingNote[]>(row.framing_notes_json, []),
    notebookCells: parseJson<NotebookCell[]>(row.notebook_cells_json, defaultNotebookCells(row.decision_question)),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listWorkspaces(orgId = 'default') {
  const db = getDb()
  const rows = db.prepare(`
    SELECT id, title, decision_question, goal_type, workspace_state, status, confidence, created_at, updated_at
    FROM workspaces
    WHERE org_id = ?
    ORDER BY datetime(updated_at) DESC
  `).all(orgId) as any[]

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    decisionQuestion: r.decision_question,
    goalType: r.goal_type,
    workspaceState: (r.workspace_state || 'framing') as WorkspaceState,
    status: r.status,
    confidence: r.confidence,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

/** Shared loader — fetches a workspace row and its related data. */
function loadWorkspaceRow(row: any, id: string): DecisionWorkspace | null {
  const db = getDb()

  const timelineRows = db.prepare(`
    SELECT id, step_type, title, content_json, superseded, created_at
    FROM workspace_timeline
    WHERE workspace_id = ?
    ORDER BY datetime(created_at) ASC
  `).all(id) as any[]

  const cardRows = db.prepare(`
    SELECT id, question, claim, evidence_json, data_source_json, status
    FROM workspace_cards
    WHERE workspace_id = ?
    ORDER BY datetime(updated_at) DESC
  `).all(id) as any[]

  const timeline: EvidenceTimelineStep[] = timelineRows.map((r) => ({
    id: r.id,
    stepType: r.step_type,
    title: r.title,
    content: parseJson<{ content?: string }>(r.content_json, {}).content || '',
    createdAt: r.created_at,
    superseded: !!r.superseded
  }))

  const cards: EvidenceCard[] = cardRows.map((r) => ({
    id: r.id,
    question: r.question,
    claim: r.claim,
    evidence: parseJson<string[]>(r.evidence_json, []),
    dataSource: parseJson<string[]>(r.data_source_json, []),
    status: r.status
  }))

  return toWorkspace(row, timeline, cards)
}

/** Internal helper — fetches by ID without org scoping. Used within the store. */
function getWorkspaceByIdInternal(id: string): DecisionWorkspace | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as any
  if (!row) return null
  return loadWorkspaceRow(row, id)
}

export function getWorkspaceById(id: string, orgId = 'default'): DecisionWorkspace | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ? AND org_id = ?').get(id, orgId) as any
  if (!row) return null
  return loadWorkspaceRow(row, id)
}

export function createWorkspace(input: {
  title: string
  decisionQuestion: string
  goalType: WorkspaceGoalType
  primarySuccessMetric?: string
  orgId?: string
}): DecisionWorkspace {
  const db = getDb()
  const orgId = input.orgId || 'default'

  // Validate that the organization exists before inserting to surface a controlled
  // error rather than relying on the FK constraint producing a 500.
  const orgExists = db.prepare('SELECT id FROM organizations WHERE id = ?').get(orgId)
  if (!orgExists) {
    throw createError({ statusCode: 404, statusMessage: `Organization "${orgId}" not found` })
  }

  const id = randomUUID()
  const createdAt = nowIso()
  const context: WorkspaceContext = {
    decisionTitle: input.title,
    goalType: input.goalType,
    primarySuccessMetric: input.primarySuccessMetric || '',
    status: 'exploring',
    confidence: 'low'
  }
  const notebookCells = defaultNotebookCells(input.decisionQuestion)

  db.prepare(`
    INSERT INTO workspaces (
      id, org_id, title, decision_question, goal_type, primary_metric, workspace_state, status, confidence,
      context_json, summary_json, recommendation_json, notebook_cells_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    orgId,
    input.title,
    input.decisionQuestion,
    input.goalType,
    input.primarySuccessMetric || '',
    'framing',
    'exploring',
    'low',
    JSON.stringify(context),
    null,
    null,
    JSON.stringify(notebookCells),
    createdAt,
    createdAt
  )

  return getWorkspaceByIdInternal(id)!
}

export function updateWorkspaceContext(id: string, patch: Partial<WorkspaceContext>, orgId = 'default') {
  const db = getDb()
  const existing = getWorkspaceById(id, orgId)
  if (!existing) return null

  const context: WorkspaceContext = {
    ...existing.context,
    ...patch
  }

  db.prepare(`
    UPDATE workspaces
    SET title = ?,
        goal_type = ?,
        primary_metric = ?,
        status = ?,
        confidence = ?,
        context_json = ?,
        updated_at = ?
    WHERE id = ? AND org_id = ?
  `).run(
    context.decisionTitle,
    context.goalType,
    context.primarySuccessMetric,
    context.status,
    context.confidence,
    JSON.stringify(context),
    nowIso(),
    id,
    orgId
  )

  return getWorkspaceById(id, orgId)
}

export function appendTimelineStep(id: string, step: {
  stepType: EvidenceTimelineStep['stepType']
  title: string
  content: string
}, orgId = 'default') {
  const db = getDb()
  const existing = getWorkspaceById(id, orgId)
  if (!existing) return null

  db.prepare(`
    INSERT INTO workspace_timeline (id, workspace_id, step_type, title, content_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    id,
    step.stepType,
    step.title,
    JSON.stringify({ content: step.content }),
    nowIso()
  )

  db.prepare('UPDATE workspaces SET updated_at = ? WHERE id = ? AND org_id = ?').run(nowIso(), id, orgId)
  return getWorkspaceById(id, orgId)
}

export function upsertRecommendation(id: string, recommendation: Recommendation, orgId = 'default') {
  const db = getDb()
  const existing = getWorkspaceById(id, orgId)
  if (!existing) return null

  db.prepare(`
    UPDATE workspaces
    SET recommendation_json = ?, confidence = ?, updated_at = ?
    WHERE id = ? AND org_id = ?
  `).run(JSON.stringify(recommendation), recommendation.confidence, nowIso(), id, orgId)

  return getWorkspaceById(id, orgId)
}

export function createEvidenceCard(id: string, card: {
  question: string
  claim: string
  evidence?: string[]
  dataSource?: string[]
}, orgId = 'default') {
  const db = getDb()
  const existing = getWorkspaceById(id, orgId)
  if (!existing) return null

  // Cards are only allowed in learning or deciding state
  if (existing.workspaceState === 'framing') {
    throw new Error('Cannot create evidence cards in framing state')
  }

  db.prepare(`
    INSERT INTO workspace_cards (id, workspace_id, question, claim, evidence_json, data_source_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(
    randomUUID(),
    id,
    card.question,
    card.claim,
    JSON.stringify(card.evidence || []),
    JSON.stringify(card.dataSource || []),
    nowIso(),
    nowIso()
  )

  db.prepare('UPDATE workspaces SET updated_at = ? WHERE id = ? AND org_id = ?').run(nowIso(), id, orgId)
  return getWorkspaceById(id, orgId)
}

/**
 * Transition workspace state with strict validation.
 * Valid transitions: framing→learning, learning→deciding, deciding→learning
 */
export function transitionWorkspaceState(id: string, newState: WorkspaceState, orgId = 'default'): DecisionWorkspace | null {
  const db = getDb()
  const existing = getWorkspaceById(id, orgId)
  if (!existing) return null

  const currentState = existing.workspaceState
  const allowed = VALID_STATE_TRANSITIONS[currentState]
  if (!allowed || !allowed.includes(newState)) {
    throw new Error(`Invalid state transition: ${currentState} → ${newState}. Allowed: ${allowed?.join(', ') || 'none'}`)
  }

  db.prepare(`
    UPDATE workspaces SET workspace_state = ?, updated_at = ? WHERE id = ? AND org_id = ?
  `).run(newState, nowIso(), id, orgId)

  return getWorkspaceById(id, orgId)
}

/**
 * Get the current workspace state for gating agent behavior.
 */
export function getWorkspaceState(id: string, orgId = 'default'): WorkspaceState | null {
  const db = getDb()
  const row = db.prepare('SELECT workspace_state FROM workspaces WHERE id = ? AND org_id = ?').get(id, orgId) as any
  if (!row) return null
  return (row.workspace_state || 'framing') as WorkspaceState
}

/**
 * Delete a workspace and all its related data (timeline, cards).
 * Returns true if deleted, false if not found.
 */
export function deleteWorkspace(id: string, orgId = 'default'): boolean {
  const db = getDb()
  const existing = db.prepare('SELECT id FROM workspaces WHERE id = ? AND org_id = ?').get(id, orgId)
  if (!existing) return false

  // Delete related records first
  db.prepare('DELETE FROM workspace_cards WHERE workspace_id = ?').run(id)
  db.prepare('DELETE FROM workspace_timeline WHERE workspace_id = ?').run(id)
  db.prepare('DELETE FROM workspaces WHERE id = ? AND org_id = ?').run(id, orgId)

  return true
}

/**
 * Update framing notes and context for refinement in framing state.
 * Can update title, question, lens, metric, and framing notes.
 */
export function updateFramingRefinement(id: string, updates: {
  framingNotes?: FramingNote[]
  title?: string
  decisionQuestion?: string
  goalType?: WorkspaceGoalType
  primarySuccessMetric?: string
}, orgId = 'default'): DecisionWorkspace | null {
  const db = getDb()
  const existing = getWorkspaceById(id, orgId)
  if (!existing) return null

  if (existing.workspaceState !== 'framing') {
    throw new Error('Can only refine framing when workspace is in framing state')
  }

  const context: WorkspaceContext = { ...existing.context }
  const updateFields: any = {
    updated_at: nowIso()
  }

  if (updates.framingNotes) {
    updateFields.framing_notes_json = JSON.stringify(updates.framingNotes)
  }

  if (updates.title) {
    context.decisionTitle = updates.title
    updateFields.title = updates.title
  }

  if (updates.decisionQuestion) {
    updateFields.decision_question = updates.decisionQuestion
  }

  if (updates.goalType) {
    context.goalType = updates.goalType
  }

  if (updates.primarySuccessMetric !== undefined) {
    context.primarySuccessMetric = updates.primarySuccessMetric
  }

  // Always update context JSON
  updateFields.context_json = JSON.stringify(context)
  updateFields.goal_type = context.goalType
  updateFields.primary_metric = context.primarySuccessMetric

  // Build dynamic update statement
  const setClauses = Object.keys(updateFields).map(k => `${k} = ?`).join(', ')
  const values = Object.values(updateFields)
  
  db.prepare(`UPDATE workspaces SET ${setClauses} WHERE id = ? AND org_id = ?`).run(...values, id, orgId)

  return getWorkspaceById(id, orgId)
}

export function addNotebookCell(
  id: string,
  cell: {
    type: NotebookCellType
    content: string
    metadata?: Record<string, any>
    sourceCellId?: string
    afterCellId?: string
  },
  orgId = 'default'
): DecisionWorkspace | null {
  const db = getDb()
  const existing = getWorkspaceById(id, orgId)
  if (!existing) return null

  const now = nowIso()
  const nextCell: NotebookCell = {
    id: randomUUID(),
    type: cell.type,
    content: cell.content,
    metadata: cell.metadata || {},
    sourceCellId: cell.sourceCellId,
    createdAt: now,
    updatedAt: now
  }

  const cells = [...(existing.notebookCells || [])]
  if (cell.afterCellId) {
    const index = cells.findIndex((c) => c.id === cell.afterCellId)
    if (index >= 0) {
      cells.splice(index + 1, 0, nextCell)
    } else {
      cells.push(nextCell)
    }
  } else {
    cells.push(nextCell)
  }

  db.prepare('UPDATE workspaces SET notebook_cells_json = ?, updated_at = ? WHERE id = ? AND org_id = ?')
    .run(JSON.stringify(cells), nowIso(), id, orgId)

  return getWorkspaceById(id, orgId)
}

export function updateNotebookCell(
  id: string,
  cellId: string,
  patch: Partial<Pick<NotebookCell, 'content' | 'metadata' | 'type' | 'name'>>,
  orgId = 'default'
): DecisionWorkspace | null {
  const db = getDb()
  const existing = getWorkspaceById(id, orgId)
  if (!existing) return null

  const cells = [...(existing.notebookCells || [])]
  const index = cells.findIndex((c) => c.id === cellId)
  if (index < 0) return null

  cells[index] = {
    ...cells[index],
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
    ...(patch.type !== undefined ? { type: patch.type } : {}),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    updatedAt: nowIso()
  }

  db.prepare('UPDATE workspaces SET notebook_cells_json = ?, updated_at = ? WHERE id = ? AND org_id = ?')
    .run(JSON.stringify(cells), nowIso(), id, orgId)

  return getWorkspaceById(id, orgId)
}

export function deleteNotebookCell(id: string, cellId: string, orgId = 'default'): DecisionWorkspace | null {
  const db = getDb()
  const existing = getWorkspaceById(id, orgId)
  if (!existing) return null

  const cells = (existing.notebookCells || []).filter((c) => c.id !== cellId)

  db.prepare('UPDATE workspaces SET notebook_cells_json = ?, updated_at = ? WHERE id = ? AND org_id = ?')
    .run(JSON.stringify(cells), nowIso(), id, orgId)

  return getWorkspaceById(id, orgId)
}

export function moveNotebookCell(
  id: string,
  sourceCellId: string,
  targetCellId: string,
  orgId = 'default'
): DecisionWorkspace | null {
  const db = getDb()
  const existing = getWorkspaceById(id, orgId)
  if (!existing) return null

  const cells = [...(existing.notebookCells || [])]
  const sourceIndex = cells.findIndex((c) => c.id === sourceCellId)
  const targetIndex = cells.findIndex((c) => c.id === targetCellId)

  if (sourceIndex < 0 || targetIndex < 0) return null

  // Remove source cell
  const [movedCell] = cells.splice(sourceIndex, 1)

  // Recalculate target index after removal
  const newTargetIndex = cells.findIndex((c) => c.id === targetCellId)
  
  // Insert before target
  cells.splice(newTargetIndex, 0, movedCell)

  db.prepare('UPDATE workspaces SET notebook_cells_json = ?, updated_at = ? WHERE id = ? AND org_id = ?')
    .run(JSON.stringify(cells), nowIso(), id, orgId)

  return getWorkspaceById(id, orgId)
}
