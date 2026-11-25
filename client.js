/**
 * dsh-plugin-workspace-mover — Client 面。
 *
 * 在会话右键菜单（菜单服务 target = 'session'）里加一条「移动到工作区…」，
 * 展开后是各目标工作区。点击只做一件事：POST 给 Host 写队列；真正的搬迁在下次
 * 启动时完成——会话日志头 cwd 属于不可变历史，不能在线重写。
 *
 * 走 `contextMenus` 菜单服务而不是旧 `sidebar.workspaces.session.menu.item` 槽位：
 * 后者只是“外部 React 条目”的兼容位置，且依赖 slots 注入时机；菜单服务是内置
 * 会话菜单本身使用的那套（ui-workspace 的 SessionMenu 会把 target 传进来）。
 *
 * Client 面不假设任何 Host 服务已就绪：工作区列表与排队都走同一个 Host HTTP 路由，
 * 因此 apply() 只要跑起来就一定有效果；apply() 会 POST 一个 ping 进日志，便于确认
 * “客户端模块到底加载没有”。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-workspace-mover',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const zh = String(navigator.language || '').toLowerCase().startsWith('zh')
    const STR = zh
      ? {
          open: '移动到工作区…',
          moveTo: t => `→ ${t}`,
          queued: t => `已排队：重启 DSH 后会出现在「${t}」`,
          failed: m => `排队失败：${m}`,
          unreachable: '插件服务没有响应（先重启一次 DSH 再试）',
          empty: '没有其它工作区',
        }
      : {
          open: 'Move to workspace…',
          moveTo: t => `→ ${t}`,
          queued: t => `Queued: restart DSH to move it to “${t}”`,
          failed: m => `Queue failed: ${m}`,
          unreachable: 'The plugin service did not respond. Restart DSH and retry.',
          empty: 'No other workspace',
        }

    const ROUTE_LIST = '/dsh-workspace-mover/list'
    const ROUTE_MOVE = '/dsh-workspace-mover/move'
    const ROUTE_PING = '/dsh-workspace-mover/ping'

    /** POST 一个 JSON，返回解析后的对象；非 2xx / ok:false 一律抛错。 */
    async function post(route, body) {
      const response = await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body || {}),
      })
      let data = {}
      try { data = await response.json() } catch { /* 空响应 */ }
      if (!response.ok || data.ok === false) {
        throw new Error(data.message || ('HTTP ' + response.status))
      }
      return data
    }

    /** 轻量提示条：不依赖内部 UI 服务，2.6 秒后自清。 */
    function flash(text) {
      try {
        const el = document.createElement('div')
        el.textContent = text
        el.setAttribute('role', 'status')
        el.style.cssText = [
          'position:fixed', 'left:50%', 'bottom:32px', 'transform:translateX(-50%)',
          'z-index:2147483000', 'padding:8px 14px', 'border-radius:8px',
          'background:rgba(28,28,30,.92)', 'color:#fff', 'font-size:13px',
          'font-family:system-ui,sans-serif', 'box-shadow:0 6px 24px rgba(0,0,0,.28)',
          'pointer-events:none', 'opacity:0', 'transition:opacity .18s ease',
        ].join(';')
        document.body.appendChild(el)
        requestAnimationFrame(() => { el.style.opacity = '1' })
        setTimeout(() => {
          el.style.opacity = '0'
          setTimeout(() => el.remove(), 220)
        }, 2600)
      } catch { /* 提示失败不影响排队 */ }
    }

    async function queueMove(sessionId, workspace) {
      try {
        const result = await post(ROUTE_MOVE, { sessionId, workspaceId: workspace.id })
        flash(result.text || STR.queued(workspace.title))
      } catch (error) {
        flash(STR.failed(error && error.message ? error.message : String(error)))
      }
    }

    /** 拉一次工作区列表；失败时返回 undefined，用于把菜单项标成不可用。 */
    async function fetchWorkspaces() {
      try {
        const data = await post(ROUTE_LIST, {})
        return Array.isArray(data.workspaces) ? data.workspaces : []
      } catch {
        return undefined
      }
    }

    return {
      inject: ['contextMenus'],
      apply(ctx) {
        // 探针：证明客户端模块真的加载并 apply 了（Host 写进 mover.log）
        post(ROUTE_PING, { at: new Date().toISOString() }).catch(() => {})

        ctx.effect(() => ctx.contextMenus.register({
          id: 'workspace.move',
          target: 'session',
          order: 600,
          resolve: async (target) => {
            const list = await fetchWorkspaces()
            if (list === undefined) {
              return [{
                id: 'move',
                label: STR.unreachable,
                disabled: true,
                separatorBefore: true,
              }]
            }
            const from = list.find(w => Array.isArray(w.sessionIds) && w.sessionIds.includes(target.sessionId))
            const targets = list.filter(w => !from || w.id !== from.id)
            if (!targets.length) {
              return [{ id: 'move', label: STR.empty, disabled: true, separatorBefore: true }]
            }
            return [{
              id: 'move',
              label: STR.open,
              separatorBefore: true,
              children: targets.map(w => ({
                id: 'move:' + w.id,
                label: STR.moveTo(w.title),
                run: () => queueMove(target.sessionId, w),
              })),
            }]
          },
        }), 'workspace-mover: session menu')
      },
    }
  },
})
