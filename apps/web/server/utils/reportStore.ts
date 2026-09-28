import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { getDb } from '../db/client'
import { getNotebook } from './notebookStore'
import { reportSources, renderReport } from '../../utils/report'
import { chartIssue } from '../../utils/chartEngine'
import type { ReportConfig, ReportDocument, ReportState } from '../../types/report'

export function getReportState(id: string, orgId: string): ReportState {
  getNotebook(id, orgId)
  const row = getDb().prepare('SELECT * FROM notebook_reports WHERE notebook_id = ?').get(id) as any
  return { config: row ? JSON.parse(row.config_json) : null, updatedAt: row?.updated_at ?? null, publishedAt: row?.published_at ?? null, shareToken: row?.share_token ?? null }
}

export function saveReport(id: string, orgId: string, config: ReportConfig, expectedUpdatedAt: string | null): ReportState {
  const existing = getReportState(id, orgId)
  if (existing.updatedAt !== expectedUpdatedAt) throw createError({ statusCode: 409, message: 'This report changed in another tab. Reload before saving.' })
  // Monotonic even for two saves in the same millisecond.
  const updatedAt = new Date(Math.max(Date.now(), existing.updatedAt ? Date.parse(existing.updatedAt) + 1 : 0)).toISOString()
  const result = existing.updatedAt === null
    ? getDb().prepare('INSERT OR IGNORE INTO notebook_reports (notebook_id, config_json, updated_at) VALUES (?, ?, ?)').run(id, JSON.stringify(config), updatedAt)
    : getDb().prepare('UPDATE notebook_reports SET config_json = ?, updated_at = ? WHERE notebook_id = ? AND updated_at = ?').run(JSON.stringify(config), updatedAt, id, expectedUpdatedAt)
  if (!result.changes) throw createError({ statusCode: 409, message: 'This report changed in another tab. Reload before saving.' })
  return getReportState(id, orgId)
}

export function publishReport(id: string, orgId: string, expectedUpdatedAt: string): ReportState {
  const state = getReportState(id, orgId)
  if (!state.config || !state.config.blocks.length) throw createError({ statusCode: 400, message: 'Add at least one report block before publishing.' })
  if (state.updatedAt !== expectedUpdatedAt) throw createError({ statusCode: 409, message: 'The report changed. Reload before publishing.' })
  const snapshot = renderReport(state.config, reportSources(getNotebook(id, orgId)))
  if (snapshot.blocks.some(b => b.missing)) throw createError({ statusCode: 400, message: 'A selected notebook source was deleted. Remove or replace that block before publishing.' })
  for (const block of snapshot.blocks) {
    if (block.issue) throw createError({ statusCode: 400, message: `${block.title || 'Table'}: ${block.issue}` })
    if (block.kind === 'chart' && block.chart) {
      const issue = chartIssue({ ...block.chart, chartType: block.chart.chartType || 'bar' })
      if (issue) throw createError({ statusCode: 400, message: `${block.title || 'Chart'}: ${issue}` })
    }
  }
  snapshot.publishedAt = new Date().toISOString()
  const json = JSON.stringify(snapshot)
  if (Buffer.byteLength(json) > 15_000_000) throw createError({ statusCode: 413, message: 'This report is too large to publish. Reduce the number of data blocks or source rows.' })
  const result = getDb().prepare('UPDATE notebook_reports SET share_token = ?, snapshot_json = ?, published_at = ? WHERE notebook_id = ? AND updated_at = ? AND share_token IS ?')
    .run(state.shareToken || randomBytes(24).toString('base64url'), json, snapshot.publishedAt, id, expectedUpdatedAt, state.shareToken)
  if (!result.changes) throw createError({ statusCode: 409, message: 'The report or share link changed. Reload before publishing.' })
  return getReportState(id, orgId)
}

export function revokeReport(id: string, orgId: string): ReportState {
  getReportState(id, orgId)
  getDb().prepare('UPDATE notebook_reports SET share_token = NULL, snapshot_json = NULL, published_at = NULL WHERE notebook_id = ?').run(id)
  return getReportState(id, orgId)
}

export function getPublishedReport(token: string): ReportDocument {
  if (!/^[\w-]{32}$/.test(token)) throw createError({ statusCode: 404, message: 'Report unavailable' })
  const row = getDb().prepare('SELECT snapshot_json FROM notebook_reports WHERE share_token = ?').get(token) as any
  if (!row?.snapshot_json) throw createError({ statusCode: 404, message: 'Report unavailable' })
  return JSON.parse(row.snapshot_json)
}
