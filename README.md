# 会话跨工作区移动（dsh-plugin-workspace-mover）

在会话右键菜单里把某个会话「移动」到另一个工作区。因为 DSH 的会话日志头 `cwd` 属于
不可变历史（`Committed events are never rewritten`），移动不能在运行时完成：插件只负责
**排队**，真正的搬迁发生在下一次 DeepSeek Harness 启动、任何会话被 attach 之前。

## 安装

插件目录：`<工作区>\plugins\dsh-plugin-workspace-mover`

1. 打开 DeepSeek Harness → 设置 → 插件（Plugins）→ 添加插件 → 选择本地目录；
2. 选中上面的目录，确认安装；
3. 完全退出并重开 DeepSeek Harness（不是刷新页面）。

装好后右键任意会话，菜单里会出现一条「移动到工作区…」，点开就是其它工作区的列表。

## 用法

1. 右键会话 → 「移动到工作区…」→ 选目标工作区；
2. 底部提示「已排队：重启 DSH 后会出现在「…」」；
3. 完全退出 DSH 再启动；
4. 目标工作区下会出现该会话，历史完整、工作目录已切到目标路径。

等价的手工命令（在任意会话里输入）：

```
/workspace-move <sessionId> <workspaceId>
```

## 它到底做了什么

队列文件：`%USERPROFILE%\.dsh\storages\workspace-mover\queue\*.json`
启动时逐个消费，每个会话执行：

1. 备份会话目录、`workspace.json`、投影缓存到 `storages\workspace-mover\backups\<时间戳>-<会话id>\`；
2. 重写会话日志首帧 header 的 `cwd`（其余 zstd 帧逐字节保留，帧数/事件数校验不变才落盘）；
3. 把会话目录从 `sessions\--<旧编码>--\<id>` 改名到 `sessions\--<新编码>--\<id>`；
4. 更新投影缓存 `record.identity.cwd` 与 `record.rows.workingDirectory.val`；
5. 在 `workspace.json` 里把会话 id 从所有工作区摘掉，再插到目标工作区最前；
6. 自校验：header、注册表、旧工作区残留；
7. 等工作区服务就绪后，用官方 API `detachSession` / `attachSession` 让内存态与磁盘一致。

日志：`%USERPROFILE%\.dsh\storages\workspace-mover\mover.log`（记录了每个任务的结论与对账结果）。

## 已知限制

- **只支持右键菜单，不支持拖拽**：DSH 的侧栏没有 drop target 扩展点，拖拽判定在核心
  `WorkspaceBrowser` 内部，插件无法挂接。要拖拽得等上游加槽位。
- **必须重启生效**：运行中改 `workspace.json` / 会话日志会被 DSH 内存态回写（实测过）。
- 会话行右键菜单里只多一条入口，工作区列表在展开后出现，不会随工作区数量把菜单撑长。
- 会话若正被别的窗口使用，重启前它会正常落盘；重启后迁移读取的是落盘后的日志。
- 目标工作区必须已注册且目录存在；否则命令直接报错、不排队。

## 失败与回滚

- 任务失败时日志会写 `ERROR`，备份目录保留；
- 回滚：把 `backups\<时间戳>-<id>\session` 覆盖回 `sessions\<新编码>\<id>`，
  `workspace.json` 用备份覆盖，`projcache.json` 覆盖回 `storages\session_projcache\sessions\<id>.json`；
  或直接运行 `tools/relocate-workspace.js` 的反向参数（整工作区级）。
- 建议先用 `config.dryRun: true` 跑一轮（只写日志，不改文件）。

## 配置

```yaml
- id: workspace-mover
  name: 'dsh-plugin-workspace-mover'
  config:
    home: 'C:\Users\<you>\.dsh'   # 可选，默认 DSH_HOME 或 ~/.dsh
    dryRun: false                  # 可选，只演练不落地
```

## 自测

```
<node> plugins\dsh-plugin-workspace-mover\test\run-test.mjs
```

测试在 `test/home` 下造一套假数据（3 帧日志、workspace.json、投影缓存），覆盖
dry-run、正常迁移、幂等、目标未注册、目录编码回归。
