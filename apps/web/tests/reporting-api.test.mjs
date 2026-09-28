import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { once } from 'node:events'

let server, dir, base
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dendo-report-test-'))
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  const entry = fileURLToPath(new URL('../.output/server/index.mjs', import.meta.url))
  server = spawn(process.execPath, [entry], { cwd: dir, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Preview did not start. Run npm run build first.\n${logs}`)), 20000)
    server.stdout.on('data', data => { logs += data; if (logs.includes('Listening on')) { clearTimeout(timer); resolve() } })
    server.stderr.on('data', data => { logs += data })
    server.once('error', error => { clearTimeout(timer); reject(error) })
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited (${code}). Run npm run build first.\n${logs}`)) })
  })
  base = `http://127.0.0.1:${port}`
})
after(async () => {
  if (server && server.exitCode === null) { const stopped = once(server, 'exit'); server.kill(); await stopped }
  if (dir) await rm(dir, { recursive: true, force: true })
})
async function api(path, method = 'GET', body, org = 'default', status = 200) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-org-id': org }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  assert.equal(response.status, status, `${method} ${path}: ${text}`)
  return text ? JSON.parse(text) : null
}

test('report lifecycle preserves drafts, scopes writes, sanitizes snapshots, detects conflicts and revokes links', async () => {
  const notebook = await api('/api/notebooks', 'POST', { title: 'Report test' })
  const prefix = `/api/notebooks/${notebook.id}`
  const chart = await api(`${prefix}/cells`, 'POST', { cell_type: 'chart', meta_json: { chartType: 'bar', title: 'Active teams', xField: 'plan', yField: 'teams', rows: [{ plan: 'Enterprise', teams: 4, private: 'PRIVATE_DATA' }], dsl: 'PRIVATE_DSL' } })
  await api(`${prefix}/cells`, 'POST', { cell_type: 'query', content: 'PRIVATE_QUERY' })
  const config = { version: 1, title: 'Review', subtitle: '', author: '', audience: '', period: '', summary: '', nextSteps: '', template: 'brief', blocks: [{ id: 'a', kind: 'chart', sourceKey: chart.id, title: 'Active teams', width: 'full' }] }
  assert.equal((await api(`${prefix}/report`)).config, null)
  const saved = await api(`${prefix}/report`, 'PUT', { config, expectedUpdatedAt: null })
  assert.deepEqual((await api(`${prefix}/report`)).config, config)
  await api(`${prefix}/report`, 'PUT', { config, expectedUpdatedAt: null }, 'default', 409)
  await api(`${prefix}/report`, 'PUT', { config: { ...config, title: '' }, expectedUpdatedAt: saved.updatedAt }, 'default', 400)
  const other = (await api('/api/organizations', 'POST', { name: 'Other', slug: 'other' })).organization
  await api(`${prefix}/report`, 'GET', undefined, other.id, 404)
  await api(`${prefix}/report`, 'PUT', { config, expectedUpdatedAt: saved.updatedAt }, other.id, 404)
  await api(`${prefix}/report/publish`, 'POST', { expectedUpdatedAt: saved.updatedAt }, other.id, 404)
  await api(`${prefix}/report/share`, 'DELETE', undefined, other.id, 404)
  const published = await api(`${prefix}/report/publish`, 'POST', { expectedUpdatedAt: saved.updatedAt })
  assert.equal(published.shareToken.length, 32)
  const reportUrl = `/api/reports/${published.shareToken}`
  const snapshot = await api(reportUrl)
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_'))
  assert.ok(!JSON.stringify(snapshot).includes('dsl'))
  assert.ok(!JSON.stringify(snapshot).includes('sourceKey'))
  const response = await fetch(base + reportUrl)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  await api(`${prefix}/cells/${chart.id}`, 'PATCH', { meta_json: { ...chart.meta_json, rows: [{ plan: 'Enterprise', teams: 9 }] } })
  assert.deepEqual(await api(reportUrl), snapshot)
  await api(`${prefix}/report/publish`, 'POST', { expectedUpdatedAt: saved.updatedAt })
  assert.equal((await api(reportUrl)).blocks[0].chart.rows[0].teams, 9)
  await api(`${prefix}/report/share`, 'DELETE')
  await api(reportUrl, 'GET', undefined, 'default', 404)
  const again = await api(`${prefix}/report/publish`, 'POST', { expectedUpdatedAt: saved.updatedAt })
  assert.notEqual(again.shareToken, published.shareToken)
  await api(`${prefix}/cells/${chart.id}`, 'DELETE')
  await api(`${prefix}/report/publish`, 'POST', { expectedUpdatedAt: saved.updatedAt }, 'default', 400)
  await api(prefix, 'DELETE')
  await api(`/api/reports/${again.shareToken}`, 'GET', undefined, 'default', 404)
})

test('publishing rejects missing fields and invalid charts while allowing legacy chart payloads', async () => {
  const notebook = await api('/api/notebooks', 'POST', { title: 'Validation test' })
  const prefix = `/api/notebooks/${notebook.id}`
  const cell = await api(`${prefix}/cells`, 'POST', { cell_type: 'result', meta_json: { rows: [{ name: 'A', value: -5 }], columns: ['name', 'value'], rowCount: 1, dsl: 'PRIVATE_DSL' } })
  const config = { version: 1, title: 'Review', subtitle: '', author: '', audience: '', period: '', summary: '', nextSteps: '', template: 'dashboard', blocks: [{ id: 'a', kind: 'chart', sourceKey: cell.id, title: 'Signed value', width: 'full', chart: { chartType: 'donut' } }] }
  let state = await api(`${prefix}/report`, 'PUT', { config, expectedUpdatedAt: null })
  await api(`${prefix}/report/publish`, 'POST', { expectedUpdatedAt: state.updatedAt }, 'default', 400)
  config.blocks[0].chart = { chartType: 'bar', xField: 'removed' }
  state = await api(`${prefix}/report`, 'PUT', { config, expectedUpdatedAt: state.updatedAt })
  await api(`${prefix}/report/publish`, 'POST', { expectedUpdatedAt: state.updatedAt }, 'default', 400)
  config.blocks[0] = { id: 'a', kind: 'table', sourceKey: cell.id, title: 'Table', width: 'full', columns: ['removed'] }
  state = await api(`${prefix}/report`, 'PUT', { config, expectedUpdatedAt: state.updatedAt })
  await api(`${prefix}/report/publish`, 'POST', { expectedUpdatedAt: state.updatedAt }, 'default', 400)
  config.blocks[0] = { id: 'a', kind: 'chart', sourceKey: cell.id, title: 'Signed value', width: 'full', chart: { chartType: 'bar' } }
  state = await api(`${prefix}/report`, 'PUT', { config, expectedUpdatedAt: state.updatedAt })
  const published = await api(`${prefix}/report/publish`, 'POST', { expectedUpdatedAt: state.updatedAt })
  assert.equal((await api(`/api/reports/${published.shareToken}`)).blocks[0].chart.rows[0].value, -5)
})

test('only one concurrent save can commit against the same draft revision', async () => {
  const notebook = await api('/api/notebooks', 'POST', { title: 'Concurrent drafts' })
  const path = `/api/notebooks/${notebook.id}/report`
  const config = { version: 1, title: 'Initial', subtitle: '', author: '', audience: '', period: '', summary: '', nextSteps: '', template: 'brief', blocks: [] }
  const initial = await api(path, 'PUT', { config, expectedUpdatedAt: null })
  const responses = await Promise.all(['First', 'Second'].map(title => fetch(base + path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { ...config, title }, expectedUpdatedAt: initial.updatedAt }) })))
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409])
  const winner = await responses.find(r => r.status === 200).json()
  assert.equal((await api(path)).config.title, winner.config.title)
})
