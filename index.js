/**
 * dsh-plugin-workspace-mover — Host 面。
 *
 * 职责：
 *  1) 注册 `/workspace-move <sessionId> <workspaceId>` 隐藏命令，把“把某个会话
 *     挪到另一个工作区”写成一条队列任务（重启后生效）。
 *  2) 在 `webServer` 上注册 exact 路由，供本插件自己的 Client 面（右键菜单）使用：
 *       POST /dsh-workspace-mover/list  -> 工作区列表（id / title / sessionIds）
 *       POST /dsh-workspace-mover/move  -> 入队
 *       POST /dsh-workspace-mover/ping  -> 客户端存活探针（写日志）
 *     第三方插件的 Host→Client 通道只有 webServer 路由（dshmarket / session-delete 同款）。
 *  3) DSH 启动早期消费队列：改会话日志头的 cwd、换会话目录编码、更新投影缓存与
 *     workspace.json 归属；随后在 workspace 服务就绪时用官方 API 对账内存态。
 *
 * 设计前提：会话日志头 cwd 属于不可变历史，没有任何在线 API 能改；而且会话一被
 * 打开，日志文件就被 Host 进程持有写租约。所以搬迁必须发生在“没有会话被 attach”
 * 的启动瞬间——这也是本插件坚持“排队 + 重启”的原因。若启动时文件仍被占用
 * （另一份 DSH 进程还开着同一会话），任务会保留在队列里，下次启动再试，不丢。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HttpError, isJsonContentType, isSameOrigin, readJsonBody, sendJson } from './lib/http.js'
import {
  doneDir, enqueue, findWorkspaceByPath, listQueue, migrateSession, queueDir, readRegistry,
} from './lib/mover.js'

const NAME = 'workspace-mover'
const ROUTE_LIST = '/dsh-workspace-mover/list'
const ROUTE_MOVE = '/dsh-workspace-mover/move'
const ROUTE_PING = '/dsh-workspace-mover/ping'
const MAX_BODY = 4096
const SESSION_ID_RE = /^session-[0-9a-f-]+$/i
const WORKSPACE_ID_RE = /^[0-9a-f-]{36}$/i

function resolveHome(config) {
  return path.resolve(config?.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
}

function makeLogger(home) {
  const dir = path.join(home, 'storages', NAME)
  const file = path.join(dir, 'mover.log')
  const write = (level, msg) => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${level} ${msg}\n`)
    } catch { /* 日志失败不影响主流程 */ }
  }
  return {
    file,
    info: m => write('INFO', m),
    warn: m => write('WARN', m),
    error: m => write('ERROR', m),
  }
}

function archive(home, file, job, result) {
  try {
    const dir = doneDir(home)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, path.basename(file)), JSON.stringify({ job, result, at: new Date().toISOString() }, null, 2) + '\n')
    fs.unlinkSync(file)
  } catch { /* 归档失败时保留队列文件，下次重试 */ }
}

function targetPathOf(home, workspaceId) {
  const { data } = readRegistry(home)
  const table = data?.tables?.workspaces ?? {}
  const rec = table[workspaceId]
  if (!rec) throw new Error(`工作区不存在或已删除：${workspaceId}`)
  return rec.path
}

/** 工作区列表（菜单用）：id / title / sessionIds。 */
function listWorkspaces(home) {
  const { data } = readRegistry(home)
  const table = data?.tables?.workspaces ?? {}
  return Object.entries(table).map(([id, rec]) => ({
    id,
    title: rec.title || path.basename(rec.path || ''),
    path: rec.path,
    sessionIds: Array.isArray(rec.sessionIds) ? rec.sessionIds : [],
  }))
}

/** 文件被别的进程占用 / 写租约冲突：这类失败要留档重试，不能当成永久失败。 */
function isBusy(error) {
  const code = String(error?.code || '')
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') return true
  return /EBUSY|EPERM|EACCES|resource busy|being used by another process/i.test(String(error?.message || ''))
}

async function readActionBody(request) {
  if (request.method !== 'POST') throw new HttpError(405, 'method-not-allowed', '只接受 POST')
  if (!isSameOrigin(request.headers)) throw new HttpError(403, 'cross-origin', '拒绝跨站请求')
  if (!isJsonContentType(request.headers)) throw new HttpError(415, 'content-type', '需要 application/json')
  return await readJsonBody(request, MAX_BODY)
}

/** 把处理器包成「永不抛出」的响应函数：HttpError → 状态码，其余 → 500。 */
function serving(log, label, handler) {
  return (request, response) => {
    void (async () => {
      try {
        await handler(request, response)
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(response, error.status, { ok: false, code: error.code, message: error.message })
          return
        }
        log.error(label + ' failed: ' + (error?.message || String(error)))
        sendJson(response, 500, { ok: false, code: 'internal', message: '操作失败：' + (error?.message || String(error)) })
      }
    })()
  }
}

export function apply(ctx, config = {}) {
  const home = resolveHome(config)
  const log = makeLogger(home)
  const dryRun = config?.dryRun === true
  log.info(`plugin started (home=${home}, dryRun=${dryRun})`)

  /** 队列消费（启动早期，任何会话 attach 之前） */
  const drained = (async () => {
    const results = []
    let jobs = []
    try { jobs = listQueue(home) } catch (e) { log.error('list queue failed: ' + e.message); return results }
    for (const { file, job } of jobs) {
      if (!job) { log.warn('skip unreadable job: ' + file); continue }
      try {
        const targetPath = targetPathOf(home, job.workspaceId)
        const report = migrateSession({ home, sessionId: job.sessionId, targetPath, dryRun })
        log.info(`job ${job.sessionId} -> ${targetPath}: ${report.status}`)
        results.push(report)
        if (!dryRun) archive(home, file, job, report)
      } catch (e) {
        if (isBusy(e) && !dryRun) {
          // 会话日志还被别的进程占用（比如另一份 DSH 还开着这个会话）：
          // 保留队列文件，下次启动再试；绝不能因为一次占用就丢掉用户的搬迁请求。
          log.warn(`job ${job.sessionId} postponed (busy): ${e.message}`)
          results.push({ sessionId: job.sessionId, status: 'postponed', error: e.message })
          continue
        }
        log.error(`job ${job.sessionId} failed: ${e.message}`)
        results.push({ sessionId: job.sessionId, status: 'failed', error: e.message })
        if (!dryRun) archive(home, file, job, { status: 'failed', error: e.message })
      }
    }
    return results
  })()

  /** 命令：写队列（右键菜单不可用时的兜底） */
  ctx.inject(['commands'], (c) => {
    c.commands.register({
      name: 'workspace-move',
      description: '把当前会话排队迁移到另一个工作区（重启 DeepSeek Harness 后生效）',
      input: { hint: '<sessionId> <workspaceId>' },
      handler: ({ rawInput }) => {
        const parts = String(rawInput || '').trim().split(/\s+/).filter(Boolean)
        if (parts.length !== 2) return { kind: 'error', text: '用法：/workspace-move <sessionId> <workspaceId>' }
        const [sessionId, workspaceId] = parts
        if (!SESSION_ID_RE.test(sessionId)) return { kind: 'error', text: `会话 id 不合法：${sessionId}` }
        if (!WORKSPACE_ID_RE.test(workspaceId)) return { kind: 'error', text: `工作区 id 不合法：${workspaceId}` }
        try {
          const targetPath = targetPathOf(home, workspaceId)
          const file = enqueue(home, { sessionId, workspaceId, targetPath })
          log.info(`enqueued ${sessionId} -> ${workspaceId} (${file})`)
          return { kind: 'success', text: `已排队：重启 DeepSeek Harness 后，该会话会出现在「${path.basename(targetPath)}」。` }
        } catch (e) {
          log.error('enqueue failed: ' + e.message)
          return { kind: 'error', text: '排队失败：' + e.message }
        }
      },
    })
  })

  /** 对账：等工作区服务就绪后，用官方 API 让内存态与磁盘一致 */
  const reconcile = async (c, results) => {
    const moved = results.filter(r => r.status === 'moved' || r.status === 'noop')
    if (moved.length === 0) return
    let workspaces
    try { workspaces = c.workspaceRegistry.list() } catch (e) { log.warn('reconcile skipped: ' + e.message); return }
    for (const r of moved) {
      try {
        const oldWs = workspaces.find(w => w.path === r.oldCwd)
        if (oldWs) await oldWs.detachSession(r.sessionId)
      } catch (e) { log.warn(`detach ${r.sessionId} failed: ${e.message}`) }
      try {
        const target = c.workspaceRegistry.list().find(w => w.path === r.newCwd)
        if (target) await target.attachSession(r.sessionId)
      } catch (e) { log.warn(`attach ${r.sessionId} failed: ${e.message}`) }
    }
    // 最终核对：磁盘上目标工作区必须真的包含该会话
    try {
      const { data } = readRegistry(home)
      for (const r of moved) {
        const hit = findWorkspaceByPath(data, r.newCwd)
        const ok = hit && (hit.record.sessionIds || []).includes(r.sessionId)
        log.info(`verify ${r.sessionId}: ${ok ? 'ok' : 'MISMATCH'}`)
      }
    } catch (e) { log.warn('final verify failed: ' + e.message) }
  }

  ctx.inject(['workspaceRegistry'], (c) => {
    void drained.then(results => reconcile(c, results)).catch(e => log.error('reconcile crashed: ' + e.message))
  })

  void drained.catch(e => log.error('drain crashed: ' + e.message))

  /** HTTP 路由：Client 面（右键菜单）用 */
  ctx.inject(['webServer'], (host) => {
    const routes = [
      {
        label: 'list',
        path: ROUTE_LIST,
        handler: (_request, response) => {
          sendJson(response, 200, { ok: true, workspaces: listWorkspaces(home) })
        },
      },
      {
        label: 'move',
        path: ROUTE_MOVE,
        handler: async (request, response) => {
          const body = await readActionBody(request)
          const sessionId = String(body?.sessionId || '')
          const workspaceId = String(body?.workspaceId || '')
          if (!SESSION_ID_RE.test(sessionId)) throw new HttpError(400, 'bad-session-id', '会话 id 不合法')
          if (!WORKSPACE_ID_RE.test(workspaceId)) throw new HttpError(400, 'bad-workspace-id', '工作区 id 不合法')
          const targetPath = targetPathOf(home, workspaceId)
          const title = listWorkspaces(home).find(w => w.id === workspaceId)?.title || path.basename(targetPath)
          const file = enqueue(home, { sessionId, workspaceId, targetPath })
          log.info(`enqueued ${sessionId} -> ${workspaceId} (${file})`)
          sendJson(response, 200, { ok: true, text: `已排队：重启 DSH 后会出现在「${title}」` })
        },
      },
      {
        label: 'ping',
        path: ROUTE_PING,
        handler: async (request, response) => {
          const body = await readActionBody(request)
          log.info(`client applied (ping at ${body?.at || 'n/a'})`)
          sendJson(response, 200, { ok: true })
        },
      },
    ]
    for (const route of routes) {
      host.effect(() => host.webServer.register({
        kind: 'exact',
        path: route.path,
        handler: serving(log, route.label, (request, response) => route.handler(request, response)),
      }), 'workspace-mover: ' + route.label + ' route')
    }
  })
}

export const inject = []
export const name = NAME
