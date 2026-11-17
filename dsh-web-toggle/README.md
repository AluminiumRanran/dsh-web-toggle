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

挡住（关掉时隐藏）：`web_search`、`web_fetch`、`ops_bash`、浏览器工具（`bsk_*`）、`computer_*`、全部 `mcp__*` 与 `read_mcp_resource` / `list_mcp_resources`、`video_*`、`workbuddy_*`、`subagent` / `subagent_fork` / `workflow` / `send_message`、`plugin_manager`、`schedule_create` / `schedule_edit`。

留下（都是纯本地）：文件读写与检索、上下文/记忆、计划与目标、技能、`job_*` 查看与终止、`schedule_list` / `schedule_view`、`present`、`ask_user_question` 等。

挡住不了的三件事，如实写在这里：

1. **关之前已经跑起来的后台任务不会自动断**。比如你先前用 `ops_bash` 起的 `curl` 还在跑，它继续用网。关掉开关后可以用 `job_list` + `job_kill` 收尾。
2. **`run_code` 是内核保留名字**，`tools.restrict()` 不接受它，所以 PTC 模式下它仍可见；它自身不能直接联网（脚本里没有网络 API），但它能起的子代理是否受限取决于内核。
3. **它不是网络层的墙**。DSH 没有"按会话断网"的内核能力（`dsh-sandbox-local` 只做文件系统约束，没有网络规则）。真要在系统层面断绝，只能在无网 VM/容器里跑 DSH——那不是插件能做的事。

## 性能

几乎为零：Host 半侧只在切换时读一次工具目录（约 100 个名字的过滤），平日只有两个事件监听器；每次 admitted step 只做一次 `Set.has`。客户端是一个小组件，只在状态变化时渲染；没有轮询、没有定时器（唯一的 0ms 定时器只在"浏览器记着关"时问一次宿主）。

## 已知边界

- 任务正在执行时切换会被拒绝，等这一轮结束再点。
- DSH 重启后 Host 侧状态重置；浏览器记着的状态会在挂载时向 Host 探一次并纠正显示。**同一个页面内**探过就不再探——切到别的会话再切回来既不重发命令，也不再弹提示。

细节见 [docs/DETAIL.md](docs/DETAIL.md)。
