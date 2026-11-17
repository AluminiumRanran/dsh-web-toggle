# dsh-web-toggle

给 DSH 对话输入框工具栏加一个**按会话独立**的断网开关。

- 亮着：本会话工具齐全（含 `web_search` / `web_fetch`、shell、浏览器、MCP）。
- 划掉：本会话**只剩本地工具**——凡是有能力出网的工具（网页搜索、`ops_bash`、浏览器、MCP、视频/生图、子代理、插件管理）全部从工具列表里消失，下一次请求生效。
- 再点一次恢复。其他会话、其他本地功能不受影响。

实现手段是 DSH 内核自带的 `agent.ctx.tools.restrict({ allow: [...] })` —— 这个调用是 **agent 作用域**的，返回精确的 disposer，因此限制天然按会话隔离。用的是白名单而不是只 deny 两个名字：deny 少数几个工具挡不住 shell / 浏览器 / MCP 这些通用通道，白名单才能**默认关门**——将来别的插件新加的工具也一样被挡在外面，直到有人把它加进白名单。

## 装法

```bash
# 在 profile 目录（C:\\Users\\Aluminium\\.dsh\\profiles\\desktop）
# 方式一：交给 DSH 插件管理器
#   plugin_manager install_bundle target="file:E:/workspace/dsh-web-toggle-prompt-20261116/dsh-web-toggle"
# 方式二：手动挂 file: 依赖并 pnpm install，然后把包名加进 dsh.profile.bundles
```

装完需要刷新页面（新客户端模块要重新下发）；插件的 Host 半侧随 DSH 重启加载。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/webtoggle` | 切换 |
| `/webtoggle on` \\| `off` | 显式开关（幂等） |
| `/webtoggle status` | 只读状态 |

## 它挡什么、不挡什么

被拦下的调用会收到一条**写成指令的拒绝理由**（而不是只说"被拦了"）：本会话暂时不允许使用一切形式的联网工具 / 不要换工具、写脚本、编码或起子进程找替代通道 / 真需要就停下请用户打开开关 / 怀疑误判照此处理。

**留下、但加命令过滤**：`ops_bash`。跑本地命令（构建、测试、搬文件）照常；命令里出现 `curl` / `wget` / `ssh` / `git clone` / `npm view|pack|install` / `pip install` / `python` 的 `socket`·`ssl`·`urllib` 导入 / PowerShell 的 `Net.WebClient`·`-EncodedCommand` / `base64 -d | sh` / `http(s)://` / UNC 共享之类，执行前就被 `tools.guard()` 拦下并说明原因。本地命令为：`pnpm run build`、`npm test`、`git status|log|commit`、`python -c "print(1+1)"`、`node scripts/x.mjs` 等。**红队已证明：把脚本先写到文件再执行、或用二进制发包，仍能绕**——这层是提示，不是墙。

**隐藏**：`web_search`、`web_fetch`、浏览器工具（`bsk_*`）、`computer_*`（能驱动浏览器看网页）、全部 `mcp__*` 与 `read_mcp_resource` / `list_mcp_resources`、`video_*`、`workbuddy_*`、`subagent` / `subagent_fork` / `workflow` / `send_message`（子代理是新的 Agent，遮罩不跟过去）、`plugin_manager`（装包=下载）、`schedule_create` / `schedule_edit`（会安排另一个会话去联网）。

**留下（纯本地，不设防）**：文件读写与检索、上下文/记忆、计划与目标、技能、`job_*` 查看与终止、`schedule_list` / `schedule_view`、`present`、`ask_user_question` 等。

挡住不了的四件事，如实写在这里：

1. **shell 过滤是按字面匹配的**。它挡的是明显的联网命令，挡住不了精心伪装的（base64、把脚本先写到本地再执行、自定义二进制）。要"一个字节都不许出"，关掉 shell 更干脆——但那也意味着这一轮跑不了测试和构建。
2. **关之前已经跑起来的后台任务不会自动断**。比如先前起的 `curl` 还在跑，它继续用网。用 `job_list` + `job_kill` 收尾。
3. **`run_code` 是内核保留名字**，`tools.restrict()` 不接受它，所以 PTC 模式下它仍可见；它自身没有网络 API，但能起的子代理是否受限取决于内核。
4. **它不是网络层的墙**。DSH 没有"按会话断网"的内核能力（`dsh-sandbox-local` 只约束文件系统，没有网络规则）。真要在系统层面断绝，只能在无网 VM/容器里跑 DSH——那不是插件能做的事。

## 性能

几乎为零：Host 半侧只在切换时读一次工具目录（约 100 个名字的过滤），平日只有两个事件监听器；每次 admitted step 只做一次 `Set.has`；断网期间每次工具调用多一次正则判断（只针对 `ops_bash` 的 command 字符串）。客户端是一个小组件，只在状态变化时渲染；没有轮询、没有定时器（唯一的 0ms 定时器只在"浏览器记着关"时问一次宿主）。

## 已知边界

- 任务正在执行时切换会被拒绝，等这一轮结束再点。
- DSH 重启后 Host 侧状态重置；浏览器记着的状态会在挂载时向 Host 探一次并纠正显示。**同一个页面内**探过就不再探——切到别的会话再切回来既不重发命令，也不再弹提示。

细节见 [docs/DETAIL.md](docs/DETAIL.md)。
