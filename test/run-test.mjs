import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import assert from 'node:assert'
import { fileURLToPath } from 'node:url'
import { encodeCwd, migrateSession, readSessionHeader } from '../lib/mover.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const home = path.join(here, 'home')
fs.rmSync(home, { recursive: true, force: true })

const OLD = 'D:\\old-ws'
const NEW = 'D:\\new-ws'
const SID = 'session-11111111-2222-3333-4444-555555555555'

function frame(obj) { return zlib.zstdCompressSync(Buffer.from(JSON.stringify(obj) + '\n', 'utf8')) }
function makeLog(dir, cwd) {
  fs.mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: 4, id: SID, cwd, agentPreset: 'standard' }
  const ev1 = { type: 'message', role: 'user', seq: 1 }
  const ev2 = { type: 'message', role: 'assistant', seq: 2 }
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame(header), frame(ev1), frame(ev2)]))
}

// 1) 造数据
const oldDir = path.join(home, 'sessions', encodeCwd(OLD), SID)
makeLog(oldDir, OLD)
fs.mkdirSync(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
fs.writeFileSync(path.join(home, 'storages', 'session_projcache', 'sessions', SID + '.json'), JSON.stringify({
  version: 7,
  record: { identity: { cwd: OLD }, rows: { workingDirectory: { val: OLD, seq: 3 } } },
}))
const wsFile = path.join(home, 'storages', 'workspace.json')
fs.mkdirSync(path.dirname(wsFile), { recursive: true })
const now = new Date().toISOString()
fs.writeFileSync(wsFile, JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, defaultWorkspaceId: 'ws-a', workspaceIds: ['ws-a', 'ws-b'], archivedSessionIds: [], pinnedSessionIds: [] },
  tables: {
    workspaces: {
      'ws-a': { path: OLD, title: 'old', sessionIds: [SID], createdAt: now, updatedAt: now },
      'ws-b': { path: NEW, title: 'new', sessionIds: [], createdAt: now, updatedAt: now },
    },
  },
}, null, 2))

// 2) dry-run 不改文件
const before = fs.readFileSync(path.join(oldDir, 'session.v4.jsonl.zstd'))
const dry = migrateSession({ home, sessionId: SID, targetPath: NEW, dryRun: true })
assert.equal(dry.status, 'dry-run')
assert.deepEqual(fs.readFileSync(path.join(oldDir, 'session.v4.jsonl.zstd')), before)
assert.ok(fs.existsSync(oldDir), 'dry-run must not move dir')

// 3) 真跑
const r = migrateSession({ home, sessionId: SID, targetPath: NEW })
assert.equal(r.status, 'moved')
assert.equal(r.oldCwd, OLD)
assert.equal(r.events, 2, 'event count preserved')
assert.equal(r.frames, 3, 'frame count preserved')

const after = readSessionHeader(home, SID)
assert.equal(after.header.cwd, NEW)
assert.equal(after.found.encoded, encodeCwd(NEW))
assert.ok(!fs.existsSync(oldDir), 'old session dir moved away')
assert.ok(fs.existsSync(path.join(home, 'sessions', encodeCwd(NEW), SID, 'session.v4.jsonl.zstd')))

const reg = JSON.parse(fs.readFileSync(wsFile, 'utf8'))
assert.ok(!reg.tables.workspaces['ws-a'].sessionIds.includes(SID), 'removed from old workspace')
assert.deepEqual(reg.tables.workspaces['ws-b'].sessionIds, [SID], 'prepended to target')

const proj = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'session_projcache', 'sessions', SID + '.json'), 'utf8'))
assert.equal(proj.record.identity.cwd, NEW)
assert.equal(proj.record.rows.workingDirectory.val, NEW)

assert.ok(fs.existsSync(r.backup), 'backup exists')
assert.ok(fs.existsSync(path.join(r.backup, 'session', 'session.v4.jsonl.zstd')))

// 4) 幂等
const again = migrateSession({ home, sessionId: SID, targetPath: NEW })
assert.equal(again.status, 'noop')

// 5) 目标未注册时拒绝
assert.throws(() => migrateSession({ home, sessionId: SID, targetPath: 'D:\\nope' }), /目标工作区未注册/)

// 6) 编码函数回归
assert.equal(encodeCwd('D:\\AI\\harness program\\AI金融分析'), '--D-AI-harness~0020program-AI~91D1~878D~5206~6790--')

console.log('ALL TESTS PASSED')
