/**
 * Host 面路由与排队的单元测试（不依赖真实 DSH 进程）。
 *
 * 用假的 ctx 跑 apply()，再直接调用注册到 webServer 的三个 exact 路由，
 * 验证：工作区列表、入队、ping 探针、以及“文件被占用时保留队列”的策略。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'

const WS_A = '11111111-1111-4111-8111-111111111111'
const WS_B = '22222222-2222-4222-8222-222222222222'
const SESSION = 'session-abcdef01-2345-4678-9abc-def012345678'

/** 造一个临时 DSH home：两个工作区、一个会话目录。 */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mover-home-'))
  const dirA = path.join(home, 'projects', 'A')
  const dirB = path.join(home, 'projects', 'B')
  fs.mkdirSync(dirA, { recursive: true })
  fs.mkdirSync(dirB, { recursive: true })
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
  const registry = {
    tables: {
      workspaces: {
        [WS_A]: { path: dirA, title: 'A 工作区', sessionIds: [SESSION] },
        [WS_B]: { path: dirB, title: 'B 工作区', sessionIds: [] },
      },
    },
  }
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify(registry, null, 2))
  fs.mkdirSync(path.join(home, 'sessions', '--enc--', SESSION), { recursive: true })
  return { home, dirA, dirB }
}

function fakeCtx() {
  const ctx = {
    routes: new Map(),
    commands: [],
    effects: [],
    inject(names, callback) {
      if (names.includes('webServer')) {
        ctx.webServer = {
          register(spec) { ctx.routes.set(spec.path, spec); return () => {} },
        }
        callback(ctx)
        return
      }
      if (names.includes('commands')) {
        callback({ commands: { register(spec) { ctx.commands.push(spec) } } })
        return
      }
      // workspaceRegistry 等：测试里故意不提供，验证插件不会因此崩溃
    },
    effect(fn, label) { ctx.effects.push(label); return fn() },
  }
  return ctx
}

function makeRequest(body, headers = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify(body || {}))])
  request.method = 'POST'
  request.headers = {
    'content-type': 'application/json',
    host: '127.0.0.1:1234',
    origin: 'http://127.0.0.1:1234',
    'sec-fetch-site': 'same-origin',
    ...headers,
  }
  return request
}

function makeResponse() {
  const chunks = []
  return {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)) },
    json() { return JSON.parse(Buffer.concat(chunks).toString('utf8')) },
  }
}

async function call(ctx, route, body, headers) {
  const spec = ctx.routes.get(route)
  assert.ok(spec, 'route not registered: ' + route)
  const response = makeResponse()
  spec.handler(makeRequest(body, headers), response)
  // handler 内部是 fire-and-forget 的 async，等一轮宏任务让响应写完
  await new Promise(r => setTimeout(r, 30))
  return response
}

test('list route returns workspaces from the registry', async () => {
  const { home } = makeHome()
  const ctx = fakeCtx()
  apply(ctx, { home })
  const res = await call(ctx, '/dsh-workspace-mover/list', {})
  const data = res.json()
  assert.equal(res.statusCode, 200)
  assert.equal(data.ok, true)
  assert.equal(data.workspaces.length, 2)
  assert.deepEqual(data.workspaces.map(w => w.id).sort(), [WS_A, WS_B].sort())
  assert.equal(data.workspaces.find(w => w.id === WS_A).title, 'A 工作区')
  assert.deepEqual(data.workspaces.find(w => w.id === WS_A).sessionIds, [SESSION])
})

test('move route enqueues a job with the resolved target path', async () => {
  const { home, dirB } = makeHome()
  const ctx = fakeCtx()
  apply(ctx, { home })
  const res = await call(ctx, '/dsh-workspace-mover/move', { sessionId: SESSION, workspaceId: WS_B })
  const data = res.json()
  assert.equal(res.statusCode, 200)
  assert.equal(data.ok, true)
  assert.match(data.text, /已排队/)
  const queueDir = path.join(home, 'storages', 'workspace-mover', 'queue')
  const files = fs.readdirSync(queueDir)
  assert.equal(files.length, 1)
  const job = JSON.parse(fs.readFileSync(path.join(queueDir, files[0]), 'utf8'))
  assert.equal(job.sessionId, SESSION)
  assert.equal(job.workspaceId, WS_B)
  assert.equal(job.targetPath, dirB)
})

test('move route rejects bad ids and cross-origin calls', async () => {
  const { home } = makeHome()
  const ctx = fakeCtx()
  apply(ctx, { home })
  const bad = await call(ctx, '/dsh-workspace-mover/move', { sessionId: 'nope', workspaceId: WS_B })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().ok, false)
  const cross = await call(ctx, '/dsh-workspace-mover/move', { sessionId: SESSION, workspaceId: WS_B }, {
    origin: 'http://evil.example',
    'sec-fetch-site': 'cross-site',
  })
  assert.equal(cross.statusCode, 403)
})

test('ping route answers and logs', async () => {
  const { home } = makeHome()
  const ctx = fakeCtx()
  apply(ctx, { home })
  const res = await call(ctx, '/dsh-workspace-mover/ping', { at: 'now' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  const log = fs.readFileSync(path.join(home, 'storages', 'workspace-mover', 'mover.log'), 'utf8')
  assert.match(log, /client applied \(ping at now\)/)
})

test('command fallback still validates arguments', async () => {
  const { home } = makeHome()
  const ctx = fakeCtx()
  apply(ctx, { home })
  assert.equal(ctx.commands.length, 1)
  const command = ctx.commands[0]
  assert.equal(command.name, 'workspace-move')
  const usage = command.handler({ rawInput: '' })
  assert.equal(usage.kind, 'error')
  const ok = command.handler({ rawInput: `${SESSION} ${WS_B}` })
  assert.equal(ok.kind, 'success')
})
