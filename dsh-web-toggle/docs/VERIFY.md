# 验证记录

分三层：离线逻辑测试、安装结果、还需要人工确认的部分。

## 1. 离线逻辑测试（已通过）

```bash
node tests/host.test.mjs     # Host 半侧状态机，用假的 ctx/agent
node tests/client.test.mjs   # Browser 半侧组件，用极简 React 打桩 + 假 remote
```

`tests/host.test.mjs` 覆盖（16 组）：

1. 初始状态 = 开（`status` 回 `[web:on]`，不加限制）
2. `off` 生效：调用一次 `agent.ctx.tools.restrict({ deny: [...隐藏名单] })`（只给 deny，不给 allow），结果带 `[web:off]`
3. 重复 `off` / 无参来回不叠加限制（restrict 只调用一次）
4. `on` 精确调用一次 disposer，重复 `on` 不再 dispose
5. 无参切换 on ⇄ off
6. 轮次进行中（`agent.status === 'running'`）直接拒绝且不加限制
7. 会话隔离：A 关掉不影响 B 的 `status`，B 的 restrict 调用数为 0
8. 非法参数回 error
9. `agent/disposed` 触发时撤销限制并清记录；同一 sessionId 的新 agent 回到"开"
10. `agent/pre-step`：变化后下一步返回 `startsRequestSeries: true`，只消费一次；`signal.aborted` 的步骤不消费标记
11. 出厂四态分类：`web_*` / `bsk_*` / `computer_*` / `mcp__*` / `video_*` / `workbuddy_*` / `snowluma_*` 前缀与显式联网名 → `hide`；`ops_bash` 与**所有没点名的工具** → `inspect`；`refuse` 出厂不指派；目录里没注册的名字被过滤而不是抛错
12. shell 命令过滤：三层规则各拦一批（红队复现命令），同时放行日常本地命令
13. 配置面：默认两个入口开、详情页恒开；`surface settings off` 落到配置且只写一次；`surface plugin off` 只回一句「始终显示」且不改配置；未知入口与缺值给用法错误；`mode` 与继承值相同则不落盘、`--global` 写全局层、`mode reset` 交还整层、`keep on|off` 与 `allow add|remove` 别名等价、`config` 输出含 `pluginPage=`；没有 configEditor 时如实回报 `没有配置文件可写` 与 `writable:false`
14. 模式改动即时生效：断网状态下 `mode ops_bash keep` 之后 guard 仍要重装（其他工具还是 `inspect`），新 guard 不再拦 shell 命令；`mode ops_bash refuse` 后连 `echo hi` 也直接拒；`read_image` 的参数里带 `https://` 被拦、本地路径放行；轮次正在执行时只存配置不下发并回执 `跳过 1`；恢复再断网时带上新模式
15. 工具目录与 `mode`：`tools` 回 `[web-tools]`（按名字排序、每行含 `mode`/`builtIn`）；没配置过的工具也报 `inspect`；`mode web_search keep` / `mode write refuse` 后目录立刻变；`mode reset` 删键回默认；`--global` 写全局层；不存在的名字也进目录并有提醒
16. 回执降噪：默认配置下 `status`/`off`/`mode`/`tools` 的回执都不带 JSON（`tools` 只回数量）；`tools --json` 才带 `[web-tools]`+`[web-state]`；错误信息完整且不带 JSON；`debug: true` 时成功回执才带机器标记

`tests/client.test.mjs` 覆盖（14 组）：

1. 默认亮态渲染（`data-off="false"`、`aria-pressed="true"`、标题 = `title.on`），无提示
2. 槽位定义（`conversation.input.left` / id `web-toggle` / `locale web-toggle` / order 11）、`settings.section` 及其 `settings.section.icon`、样式表 effect 注册
3. 点击 → `commands.execute(sessionId, '/webtoggle off', [])`（三个 wire 参数）→ 灭态 + 提示 + localStorage 记 `1`
4. 记住 off 后重新挂载：先显示灭态，挂载探针 `status` 只发一次，**宿主确认关闭时不弹提示**；再点恢复发 `/webtoggle on` 并清记忆
5. 切到别的会话再切回来（同一页面内重新挂载）：不重发 `status`、不弹提示，状态仍是灭态
6. 轮次进行中：按钮 `disabled`，标题换成 `title.running`
7. 失败分支：没有 remote、命令未注册（`value === undefined`）、Remote 报错、Host 明确拒绝（原文展示、状态不变）
8. 挂载探针纠偏：记住 off 但宿主已重置 → 探针把显示改成亮态并提示 `note.syncedOn`
9. 小箭头面板：首次点开只发 `tools --json`（不发 `status`），缓存命中时一条命令都不发；「断网」发 `/webtoggle off`；工具行按钮在 `hide → inspect → refuse → keep → hide` 循环（`data-mode` 与命令文本都跟着变，按钮文字是当前模式）；筛选框只在本地过滤、不发命令
10. 配置关掉小箭头后不再画箭头，开关本身照常
11. 设置页面板：内联渲染、工具行的 `data-mode` 反映全局模式表、不画本会话开关；点「隐藏」发 `surface settings off`；关掉后页面自己 `return null`；从别处取回状态后画回来；工具模式命令带 `--global`
12. 插件详情页只对本包渲染，别的包 `null`
13. 配置页在没有 Remote 时如实报错
14. 入口真卸载：宿主回报 `composer:false` 后 `conversation.input.left` 的槽位被注销（不是内容变空）；`plugins.detail.section` 仍在；从设置页打开后槽位重新注册

## 2. 安装结果

- 包：`dsh-web-toggle`，从 `0.1.0` 一路升到 `0.4.0`（`file:E:/workspace/dsh-web-toggle-prompt-20261116/dsh-web-toggle`）
- 走的是 `plugin_manager install_bundle`，结果 `application: "applied"`、`enabled: true`
- profile 里新增：`dependencies.dsh-web-toggle`、`dsh.profile.bundles` 里的 `dsh-web-toggle`
- 备份：`tmp/profile-backup-20261117-115656/`（package.json / pnpm-lock.yaml / cordis.patch.yml）
- ⚠ 顺带发生的非本插件改动：`pnpm install` 把 `billion-context` 从 lockfile 里的 0.1.214 更新到 0.1.215（package.json 里本来就写的 `0.1.215`，属于补齐声明与实际不一致），lockfile 因此有对应改动。其余依赖未变。
- ⚠ pnpm 的 `file:` 依赖在这里落成了**拷贝**：`profiles/desktop/node_modules/dsh-web-toggle/` 不是软链。改完源码要跑 `node scripts/sync-to-profile.mjs` 或重新安装，否则跑的是旧副本。

## 3. 需要人工确认（重启/刷新之后）

离线测试证明不了"真实内核里工具真的消失"，这几条要在真机上点一遍：

- [ ] 刷新页面（必要时重启 DSH）后，输入框工具栏出现「联网」按钮，没有斜线
- [ ] 点一下：按钮变灭态，命令回执只有一句人话（不再刷 JSON）
- [ ] 同会话下一轮：`hide` 的工具（`web_*`、`bsk_*`、`mcp__*` 等）从工具列表消失；`keep` 的本地工具照常可用；`ops_bash` 仍在但联网命令被拦
- [ ] 另一个会话的按钮仍是亮态，可以正常联网
- [ ] 再点一下恢复，下一轮工具回来
- [ ] 设置页侧边栏出现「联网开关」（地球图标，不是齿轮），插件详情页出现同样的面板；两处改模式后输入框那一侧立即跟着变
- [ ] 小箭头浮层贴在输入框卡片的正上方、左边缘与卡片对齐，不压在输入框文字上
- [ ] 深色与浅色主题下，浮层的底色、描边、文字都跟着界面走（不是固定的白底）
- [ ] 小箭头里把某个 `keep` 的工具切成 `hide`，下一轮它真的消失；再切回 `keep` 又回来
- [ ] 把一个 `hide` 的工具切成 `inspect`，下一轮它可见、且调用时被内容检查（回执带拒绝理由）
- [ ] 关掉某个入口后刷新页面，该入口不再出现（不是只变空白），其余照常
- [ ] 宿主控制台没有 `tools.restrict() requires a scoped context` / `names unknown global tool` 这类报错
- [ ] 重启 DSH 后按钮不报错；若重启前是灭态，刷新后按钮会先向宿主探一次并如实纠正显示

## 4. 真机证据（2026-11-17，本机 DSH 0.2.2-rc.3）

来源：本会话日志 `C:\Users\Aluminium\.dsh\sessions\--E-workspace--\session-4d5c4520-1cdc-44b5-be11-86a5e3f39958\session.v4.jsonl.zstd`（zstd，`zlib.zstdDecompressSync` 解）。

- `request/header`：11:48 首请求 **105** 个工具（含 `web_search` / `web_fetch`）；11:57 两次 `reason:"change"` 仍是 105；**12:05:06 本轮 103 个、无 `web_*` 且 `startsSeries: true`** —— 遮罩生效，请求序列确实被重建。
- `command/done`：12:04:00 / 12:04:01 / 12:04:51 / 12:04:54 连点，回执尾部依次 `[web:off]` → `[web:on]` → `[web:off]` → `[web:on]` → `[web:off]`，最终停在关闭。
- 全程没有 `tools.restrict() requires a scoped context`、没有 `names unknown global tool`。

因此第 3 节里「点一下 → 回执」「下一轮工具消失」「无 restrict 报错」三条已由日志确认；其余仍然需要人眼在界面上看一眼。

## 声明

本插件使用 AI 辅助完成（设计、实现、测试与文档均由人和 AI 协作产出，并经真机红队测试）。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

## 0.5.2 追加

- [x] `node tests/host.test.mjs`：18 组通过（第 17 组：配置说关 → pre-step 自动装限制并重建请求序列、配置改回开 → 自动撤销、目录写进 `knownTools`；第 18 组：会话开始后 `hide` 进 `refuse`、开关被锁、`lock off` 后解锁、`reconcile` 在锁定时把配置写回真值）。
- [x] `node tests/client.test.mjs`：15 组通过（按钮全部改走 `settings.describe/mutate`，断言"命令线一次都没被调用"；第 15 组：会话已开始时开关禁用、设置页出现锁行、点击写 `lockAfterStart: false`）。
- [ ] 真机：刷新客户端后点开关 / 切模式 / 点「刷新」，聊天里**都不应**出现新的 `> webtoggle` 回执；只有手敲 `/webtoggle …` 才有。
- [ ] 真机：宿主重启后，配置里关着的会话在第一轮请求前就被断网（不需要先点一次开关）。
- [ ] 真机：会话发过言之后，面板里的开关变灰、提示「本会话已经开始」；新开会话则正常。
- [ ] 真机：会话开始后点灭（先 `/webtoggle off` 前若未锁），工具表**不应**变化（`hide` 已按 `refuse` 执行，日志里工具数不变）。
