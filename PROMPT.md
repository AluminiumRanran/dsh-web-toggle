# 任务：给 DSH 写一个「联网开关」插件

在 DSH 对话输入框工具栏加一个开关，控制**当前会话**是否允许 `web_search` / `web_fetch`。
点一下关掉，这个会话的模型就看不到这两个工具；再点一下恢复。按会话独立，互不影响。

---

## 环境

- DSH 桌面版，内核 **0.2.2-rc.3**
- profile：`C:\Users\Aluminium\.dsh\profiles\desktop`
- 插件以 **bundle** 形式安装（进 `dsh.profile.bundles`），不是单文件 mjs
- 工作目录 `E:\workspace`，产物放 `E:\workspace\<项目名>\`

## 已确认的技术事实（已实读源码验证，直接用）

### 1. 客户端槽位
`conversation.input.left` —— 输入框工具栏左侧。现成的 `dsh-task-mode-switch` 就注册在这里。

### 2. 客户端模块格式
```js
window.__ModuleLoader__.load({
  id: '<plugin-id>',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    // ...
    return {
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register({ name: 'conversation.input.left', /* component */ })
        )
      }
    }
  }
})
```

### 3. package.json 的 dsh 段
```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": [
      "@deepseek-ai/dsh-api-remotes",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-conversation"
    ]
  }
}
```
`cordis.patch.yml` 只插一条：
```yaml
- insert:
    - id: <plugin-id>
      name: '<包名>'
```

### 4. 服务端
`export const inject = ['commands', 'agents']` + `export function apply(ctx) {}`
注册命令：
```js
ctx.commands.register({
  name: 'webtoggle',
  description: '...',
  input: { hint: 'on|off' },
  handler: ({ agent, rawInput }) => { /* ... */ }
})
```

### 5. ★ 核心：`ctx.tools.restrict()` 是 agent 作用域的

源码 `@deepseek-ai/dsh-tools/lib/index.js`：
```js
restrict(filter) {
  const scope = scopeOf(this.ctx)
  if (scope === void 0) throw new Error(
    "tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead"
  )
  // ... returns the exact disposer that lifts this restriction
}
```
- **必须在 `agent.ctx` 上调用**，在 host 级 ctx 上会直接抛错
- `filter` 支持 `allow` / `deny`
- **返回 disposer**，调用即撤销
- 这就是 per-session 粒度的正解

### 6. 工具名
`@deepseek-ai/dsh-tool-web` 注册 `web_search` 和 `web_fetch`（配置项 `search` / `fetch`，默认 true）。

### 7. 改工具集后必须重建请求序列
否则新工具声明会被当成"延迟追加"发给上游。参考实现里的做法：
```js
ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()
  // 只在决定 enter、未取消、messages 非空时消费标记
  if (!pendingSeries.has(payload.agent.session.id)) return decision
  pendingSeries.delete(payload.agent.session.id)
  return { ...decision, startsRequestSeries: true }
})
```

---

## 参考实现（先读它，别从零想）

`dsh-task-mode-switch@1.0.2`（npm，MIT，XIONG研究员），演示了完全相同的模式：工具栏按钮 + 服务端命令 + 实时改 agent 组合 + 请求序列重建。

已解包在：**`E:\workspace\dsh-web-toggle-prompt-20261116\tmp\package\`**
- `client.js`（826 行）：工具栏组件、locale、`ctx.slots.inject`、Remotes 调用
- `index.js`：命令注册、`agent/pre-step` 拦截、per-session 串行化、错误处理
- `cordis.patch.yml`、`package.json`

**照着它的骨架改，不要另起一套。**

---

## 要做的

1. **服务端**
   - 维护 `Map<sessionId, boolean>` 记录每个会话的联网开关状态
   - 提供命令 `webtoggle [on|off]`（无参数时切换并回报当前状态）
   - handler 里拿 `agent.ctx`，关时 `const dispose = agent.ctx.tools.restrict({ deny: ['web_search','web_fetch'] })` 并存起来；开时调对应 disposer
   - 状态变化后 arm 请求序列重建（同参考实现的 `pendingSeries`）
   - 监听 `agent/disposed` 清理 Map 和 disposer
   - **同一个会话重复关闭时不要重复 restrict**（幂等）

2. **客户端**
   - `conversation.input.left` 注册一个小按钮（图标用 primitives 里现成的，或纯文字「联网」）
   - 状态：亮/灭两态，点击调 `webtoggle`
   - 状态来源：调命令拿返回值，或自己按 session id 记 localStorage（v1 够用，但要能正确显示）
   - 文案走 `ctx.locale.register(NS, dict)`，中英各一份

3. **边界**
   - 会话正在跑（turn 打开）时改工具：要么排队到下一轮，要么直接拒绝并提示 —— 选一个，写清楚
   - 不要碰 `search`/`fetch` 之外的工具
   - 会话结束/销毁要还原，别把限制泄漏给别的 session

---

## 验收标准

1. 新会话里按钮可点，点了之后这一轮 `web_search` / `web_fetch` **在模型的工具列表里消失**（让它自己调一次验证，应该报 unknown tool 或不在列表）
2. 另一个会话加的限制**不影响**当前会话
3. 再点一次恢复，工具回来
4. DSH 重启后不报错（v1 状态重置可接受，但要在按钮上如实显示）
5. 日志里没有 `restrict() requires a scoped context` 这类错误

---

## 约束

- 不要动 profile 里现有的其他插件条目和依赖
- 安装前备份 `package.json` / `pnpm-lock.yaml`
- 装好后先热加载验证，**不要急着重启**（除非确实需要）
- 中文注释，代码风格跟参考实现对齐（JSDoc、单引号、无分号可由你定）
- 如果 `restrict` 在 `agent.ctx` 上的行为跟上面描述不符（版本差异），**先停下来报告实测结果**，不要硬写

## 交付

- 完整插件目录（可 `pnpm add file:` 或 `dsh plugin add`）
- 一句话说明装法、验证结果、还有什么没做到
