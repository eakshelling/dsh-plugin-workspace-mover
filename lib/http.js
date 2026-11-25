/**
 * dsh-plugin-workspace-mover — 路由用的最小 HTTP 工具。
 *
 * 本插件的路由是 `webServer` 上的 exact 路由，会先于 DSH 自己的 `/api` 前缀围栏
 * 命中，因此同源 / 内容类型 / 体积这些校验必须自己做，不能指望核心代劳。
 */

/** 带状态码与稳定 code 的错误；上层据此回 JSON。 */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/** 写一个不缓存的 JSON 响应；响应已断开时静默放弃。 */
export function sendJson(response, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    body = '{"ok":false,"code":"internal","message":"响应序列化失败"}'
    status = 500
  }
  try {
    response.statusCode = status
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('content-length', Buffer.byteLength(body))
    response.end(body)
  } catch { /* 客户端已断开 */ }
}

/**
 * 同源判定：
 *  - 有 Origin 时必须与 Host 完全一致（浏览器跨站 POST 一定带 Origin）；
 *  - 有 Sec-Fetch-Site 时只接受 same-origin / none；
 *  - 两者都没有（本机 curl / 脚本）放行——它们本来就能直接读写 ~/.dsh。
 */
export function isSameOrigin(headers) {
  const site = headers?.['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  const origin = headers?.origin
  if (origin === undefined) return true
  const host = headers?.host
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Content-Type 必须是 JSON（表单编码的跨站提交因此被挡下）。 */
export function isJsonContentType(headers) {
  const value = headers?.['content-type']
  return typeof value === 'string' && /^application\/json\b/i.test(value.trim())
}

/** 读取一个带体积上限的 JSON 对象请求体；非法/过大时抛 HttpError。 */
export function readJsonBody(request, limit = 4096) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers?.['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, 'body-too-large', '请求体过大'))
      request.resume?.()
      return
    }
    let size = 0
    let settled = false
    const chunks = []
    const fail = (error) => {
      if (settled) return
      settled = true
      request.resume?.()
      reject(error)
    }
    request.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(new HttpError(413, 'body-too-large', '请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        resolve({})
        return
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        reject(new HttpError(400, 'invalid-json', '请求体不是合法 JSON'))
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(new HttpError(400, 'invalid-json', '请求体必须是 JSON 对象'))
        return
      }
      resolve(parsed)
    })
    request.on('error', (error) => {
      fail(new HttpError(400, 'request-error', '读取请求失败：' + (error?.message ?? String(error))))
    })
    request.on('aborted', () => {
      fail(new HttpError(400, 'request-aborted', '请求已中断'))
    })
  })
}
