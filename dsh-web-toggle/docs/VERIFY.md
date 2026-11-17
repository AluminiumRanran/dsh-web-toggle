# 验证记录

分三层：离线逻辑测试、安装结果、还需要人工确认的部分。

## 1. 离线逻辑测试（已通过）

```bash
node tests/host.test.mjs     # Host 半侧状态机，用假的 ctx/agent
node tests/client.test.mjs   # Browser 半侧组件，用极简 React 打桩 + 假 remote
```

`tests/host.test.mjs` 覆盖：

1. 初始状态 = 开（`status` 回 `[web:on]`，不加限制）
2. `off` 生效：调用一次 `agent.ctx.tools.restrict({ deny: ['web_search','web_fetch'] })`，结果带 `[web:off]`
3. 重复 `off` / 无参来回不叠加限制（restrict 只调用一次）
4. `on` 精确调用一次 disposer，重复 `on` 不再 dispose
5. 无参切换 on ⇄ off
6. 轮次进行中（`agent.status === 'running'`）直接拒绝且不加限制
7. 会话隔离：A 关掉不影响 B 的 `status`，B 的 restrict 调用数为 0
8. 非法参数回 error
9. `agent/disposed` 触发时撤销限制并清记录；同一 sessionId 的新 agent 回到"开"
10. `agent/pre-step`：变化后下一步返回 `startsRequestSeries: true`，只消费一次；`signal.aborted` 的步骤不消费标记

`tests/client.test.mjs` 覆盖：

1. 默认亮态渲染（`data-off="false"`、`aria-pressed="true"`、标题 = `title.on`），无提示
2. 槽位定义（`conversation.input.left` / id `web-toggle` / `locale web-toggle` / order 11）与样式表 effect 注册
3. 点击 → `commands.execute(sessionId, '/webtoggle off', [])`（三个 wire 参数）→ 灭态 + 提示 + localStorage 记 `1`
4. 记住 off 后重新挂载：先显示灭态，挂载探针 `status` 只发一次，宿主确认关闭时保持；再点恢复发 `/webtoggle on` 并清记忆
5. 轮次进行中：按钮 `disabled`，标题换成 `title.running`
6. 失败分支：没有 remote、命令未注册（`value === undefined`）、Remote 报错、Host 明确拒绝（原文展示、状态不变）
7. 挂载探针纠偏：记住 off 但宿主已重置 → 探针把显示改成亮态并提示 `note.syncedOn`

## 2. 安装结果

- 包：`dsh-web-toggle@0.1.0`（`file:E:/workspace/dsh-web-toggle-prompt-20261116/dsh-web-toggle`）
- 走的是 `plugin_manager install_bundle`，结果 `application: "applied"`、`enabled: true`
- profile 里新增：`dependencies.dsh-web-toggle`、`dsh.profile.bundles` 里的 `dsh-web-toggle`
- 备份：`tmp/profile-backup-20261117-115656/`（package.json / pnpm-lock.yaml / cordis.patch.yml）
- ⚠ 顺带发生的非本插件改动：`pnpm install` 把 `billion-context` 从 lockfile 里的 0.1.214 更新到 0.1.215（package.json 里本来就写的 `0.1.215`，属于补齐声明与实际不一致），lockfile 因此有对应改动。其余依赖未变。
- ⚠ pnpm 的 `file:` 依赖在这里落成了**拷贝**：`profiles/desktop/node_modules/dsh-web-toggle/` 不是软链。改完源码要跑 `node scripts/sync-to-profile.mjs` 或重新安装，否则跑的是旧副本。

## 3. 需要人工确认（重启/刷新之后）

离线测试证明不了"真实内核里工具真的消失"，这几条要在真机上点一遍：

- [ ] 刷新页面（必要时重启 DSH）后，输入框工具栏出现「联网」按钮，没有斜线
- [ ] 点一下：按钮变灭态，命令回执里带 `[web:off]`
- [ ] 同会话下一轮：模型工具列表里 `web_search` / `web_fetch` 消失（问模型"你现在有哪些工具"，或让它联网试试）
- [ ] 另一个会话的按钮仍是亮态，可以正常联网
- [ ] 再点一下恢复，下一轮又能联网
- [ ] 宿主控制台没有 `tools.restrict() requires a scoped context` / `names unknown global tool` 这类报错
- [ ] 重启 DSH 后按钮不报错；若重启前是灭态，刷新后按钮会先向宿主探一次并如实纠正显示
