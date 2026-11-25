/**
 * 单个会话的跨工作区搬迁内核。
 *
 * 与 tools/relocate-workspace.js（整工作区搬迁）的区别：这里只处理“一个会话从
 * 工作区 A 搬到工作区 B”，不改目录 path，只改会话日志头里的 cwd、会话目录编码、
 * 投影缓存，以及 workspace.json 里的 sessionIds 归属。
 *
 * 所有步骤自校验；任何一步失败都会抛错，调用方负责按备份回滚。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const LOG_RE = /^session\.v(\d+)\.jsonl\.zstd$/

/** DSH 会话目录名编码：D:\a b\金 -> --D-a~0020b-~91D1-- */
export function encodeCwd(p) {
  let s = String(p).replace(/[\\/]+$/, '')
  s = s.replace(/^([A-Za-z]):[\\/]/, '$1-')
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0)
    if (code > 126) out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    else if (ch === '\\' || ch === '/' || ch === ':') out += '-'
    else if (ch === ' ') out += '~0020'
    else out += ch
  }
  return '--' + out + '--'
}

function frameRanges(buf) {
  const starts = []
  let i = 0
  for (;;) {
    const at = buf.indexOf(ZSTD_MAGIC, i)
    if (at < 0) break
    starts.push(at)
    i = at + 4
  }
  if (starts.length === 0 || starts[0] !== 0) throw new Error('not a zstd frame stream')
  const ranges = []
  for (let k = 0; k < starts.length; k++) ranges.push([starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length])
  return ranges
}

function countEvents(buf, ranges) {
  let events = 0
  ranges.forEach((r, k) => {
    const lines = zlib.zstdDecompressSync(buf.subarray(r[0], r[1])).toString('utf8').split('\n').filter(Boolean)
    events += k === 0 ? lines.length - 1 : lines.length
  })
  return events
}

function readLog(file) {
  const buf = fs.readFileSync(file)
  const ranges = frameRanges(buf)
  const header = JSON.parse(zlib.zstdDecompressSync(buf.subarray(ranges[0][0], ranges[0][1])).toString('utf8'))
  return { buf, ranges, header }
}

function writeAtomic(file, data) {
  const tmp = file + '.mover-tmp'
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d)
    else if (e.isFile()) fs.copyFileSync(s, d)
  }
}

function exists(p) { try { fs.statSync(p); return true } catch { return false } }
function must(cond, msg) { if (!cond) throw new Error(msg) }

/** 找到会话所在目录（不依赖任何缓存，直接扫 sessions/*） */
export function findSessionDir(home, sessionId) {
  const root = path.join(home, 'sessions')
  if (!exists(root)) return undefined
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const dir = path.join(root, e.name, sessionId)
    if (exists(dir)) return { dir, encoded: e.name, root }
  }
  return undefined
}

/** 读取一个会话日志的 header（含 cwd） */
export function readSessionHeader(home, sessionId) {
  const found = findSessionDir(home, sessionId)
  if (!found) return undefined
  const logFile = fs.readdirSync(found.dir).find(n => LOG_RE.test(n))
  if (!logFile) return { found, header: undefined, logFile: undefined }
  const { header } = readLog(path.join(found.dir, logFile))
  return { found, header, logFile }
}

export function readRegistry(home) {
  const file = path.join(home, 'storages', 'workspace.json')
  must(exists(file), 'workspace.json missing: ' + file)
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) }
}

function registryTable(data) {
  const table = data?.tables?.workspaces
  must(table, 'unexpected workspace.json shape (no tables.workspaces)')
  return table
}

/** 在工作区表里按 path 找目标记录 */
export function findWorkspaceByPath(data, absPath) {
  const table = registryTable(data)
  for (const [id, rec] of Object.entries(table)) {
    if (rec.path === absPath) return { id, record: rec }
  }
  return undefined
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')

/**
 * 把一个会话从它当前所在工作区搬到 targetPath 对应的工作区。
 * @returns 报告对象（含 backup 目录、事件数等）
 */
export function migrateSession({ home, sessionId, targetPath, dryRun = false }) {
  const absTarget = path.resolve(targetPath)
  const { file: wsFile, data: ws } = readRegistry(home)
  const target = findWorkspaceByPath(ws, absTarget)
  must(target, `目标工作区未注册：${absTarget}`)

  const current = readSessionHeader(home, sessionId)
  must(current, `找不到会话目录：${sessionId}`)
  must(current.header, `会话缺少 session.v*.jsonl.zstd：${sessionId}`)

  const oldCwd = current.header.cwd
  const report = {
    sessionId,
    oldCwd,
    newCwd: absTarget,
    targetWorkspaceId: target.id,
    fromEncoded: current.found.encoded,
    toEncoded: encodeCwd(absTarget),
    frames: current.found && undefined,
  }

  if (path.resolve(oldCwd) === absTarget) {
    return { ...report, status: 'noop', reason: '会话已在该工作区' }
  }

  const logFile = path.join(current.found.dir, current.logFile)
  const before = readLog(logFile)
  const beforeEvents = countEvents(before.buf, before.ranges)
  report.frames = before.ranges.length
  report.events = beforeEvents

  if (dryRun) {
    return { ...report, status: 'dry-run' }
  }

  // 1) 备份：会话目录 + workspace.json + projcache
  const backupRoot = path.join(home, 'storages', 'workspace-mover', 'backups', stamp() + '-' + sessionId)
  fs.mkdirSync(backupRoot, { recursive: true })
  copyDir(current.found.dir, path.join(backupRoot, 'session'))
  fs.copyFileSync(wsFile, path.join(backupRoot, 'workspace.json'))
  const projFile = path.join(home, 'storages', 'session_projcache', 'sessions', sessionId + '.json')
  if (exists(projFile)) fs.copyFileSync(projFile, path.join(backupRoot, 'projcache.json'))
  report.backup = backupRoot

  // 2) 重写日志首帧 header 的 cwd
  const header = { ...before.header, cwd: absTarget }
  const frame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'))
  const rebuilt = Buffer.concat([frame, before.buf.subarray(before.ranges[0][1])])
  const afterRanges = frameRanges(rebuilt)
  must(afterRanges.length === before.ranges.length, '帧数变化，拒绝写入')
  must(countEvents(rebuilt, afterRanges) === beforeEvents, '事件数变化，拒绝写入')
  writeAtomic(logFile, rebuilt)
  report.size = rebuilt.length

  // 3) 会话目录换到新编码目录
  const newRoot = path.join(home, 'sessions', report.toEncoded)
  const dstDir = path.join(newRoot, sessionId)
  if (exists(dstDir)) throw new Error('目标会话目录已存在，拒绝覆盖：' + dstDir)
  fs.mkdirSync(newRoot, { recursive: true })
  fs.renameSync(current.found.dir, dstDir)

  // 4) 投影缓存
  if (exists(projFile)) {
    const proj = JSON.parse(fs.readFileSync(projFile, 'utf8'))
    const rec = proj.record || {}
    let changed = false
    if (rec.identity && rec.identity.cwd === oldCwd) { rec.identity.cwd = absTarget; changed = true }
    if (rec.rows && rec.rows.workingDirectory && rec.rows.workingDirectory.val === oldCwd) {
      rec.rows.workingDirectory.val = absTarget
      changed = true
    }
    if (changed) writeAtomic(projFile, JSON.stringify(proj))
    report.projcache = changed
  }

  // 5) 注册表归属：从所有工作区摘掉，再插到目标工作区最前
  const table = registryTable(ws)
  for (const rec of Object.values(table)) {
    if (Array.isArray(rec.sessionIds)) rec.sessionIds = rec.sessionIds.filter(id => id !== sessionId)
  }
  target.record.sessionIds = [sessionId, ...(target.record.sessionIds || [])]
  target.record.updatedAt = new Date().toISOString()
  writeAtomic(wsFile, JSON.stringify(ws, null, 2) + '\n')

  // 6) 自校验
  const check = readSessionHeader(home, sessionId)
  must(check && check.header && path.resolve(check.header.cwd) === absTarget, '校验失败：header cwd 未更新')
  const checkTable = registryTable(readRegistry(home).data)
  const targetRec = checkTable[target.id]
  must(targetRec && targetRec.sessionIds.includes(sessionId), '校验失败：注册表未包含该会话')
  for (const [id, rec] of Object.entries(checkTable)) {
    if (id !== target.id && (rec.sessionIds || []).includes(sessionId)) throw new Error('校验失败：会话仍挂在 ' + id)
  }

  // 7) 旧编码目录空了就删掉
  try {
    const oldRoot = path.join(home, 'sessions', report.fromEncoded)
    if (exists(oldRoot) && fs.readdirSync(oldRoot).length === 0) fs.rmdirSync(oldRoot)
  } catch { /* 目录被占用时忽略 */ }

  return { ...report, status: 'moved' }
}

/** 队列目录 */
export function queueDir(home) { return path.join(home, 'storages', 'workspace-mover', 'queue') }
export function doneDir(home) { return path.join(home, 'storages', 'workspace-mover', 'done') }

export function enqueue(home, job) {
  const dir = queueDir(home)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${job.sessionId}-${Date.now()}.json`)
  writeAtomic(file, JSON.stringify({ v: 1, ...job }, null, 2) + '\n')
  return file
}

export function listQueue(home) {
  const dir = queueDir(home)
  if (!exists(dir)) return []
  return fs.readdirSync(dir)
    .filter(n => n.endsWith('.json'))
    .map(n => {
      const file = path.join(dir, n)
      try { return { file, job: JSON.parse(fs.readFileSync(file, 'utf8')) } }
      catch { return { file, job: undefined } }
    })
}
