# dsh-web-toggle

给 DSH 对话输入框工具栏加一个**按会话独立**的联网开关。

- 亮着：本会话的模型可以调用 `web_search` / `web_fetch`。
- 划掉：这两个工具从本会话的工具列表里消失（下一次请求生效）。
- 再点一次恢复。其他会话不受影响。

实现手段是 DSH 内核自带的 `agent.ctx.tools.restrict({ deny: [...] })` —— 这个调用是 **agent 作用域**的，返回精确的 disposer，因此限制天然按会话隔离。

## 装法

```bash
# 在 profile 目录（C:\Users\Aluminium\.dsh\profiles\desktop）
# 方式一：交给 DSH 插件管理器
#   plugin_manager install_bundle target="file:E:/workspace/dsh-web-toggle-prompt-20261116/dsh-web-toggle"
# 方式二：手动挂 file: 依赖并 pnpm install，然后把包名加进 dsh.profile.bundles
```

装完需要 DSH 重启一次（新的客户端模块要重新下发）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/webtoggle` | 切换 |
| `/webtoggle on` \| `off` | 显式开关（幂等） |
| `/webtoggle status` | 只读状态 |

## 别把它当断网

这个开关关的是**联网工具**，不是网络。关掉之后模型看不到 `web_search` / `web_fetch`，但下面这些通道照样能拿到外网信息：

- `ops_bash` 里的 `curl` / `wget` / `node -e fetch(...)`；
- 浏览器类工具（`bsk_page` 等）与任何能打开页面的 MCP 工具；
- 子代理、`run_code` 里的网络调用。

按 PROMPT 的范围要求，插件只碰 `web_search` / `web_fetch` 两个名字。如果哪天真要"整台机器不许出网"，那属于权限/网络层的事（关掉对应工具、断 DNS 或用防火墙），不是这个按钮。

## 已知边界

- 任务正在执行时切换会被拒绝，等这一轮结束再点。
- 只影响 `web_search` / `web_fetch`，不碰别的工具。
- DSH 重启后 Host 侧状态重置；浏览器记着的状态会在挂载时向 Host 探一次并纠正显示。**同一个页面内**探过就不再探——切到别的会话再切回来既不重发命令，也不再弹提示；只有"浏览器记着关、宿主其实已重置"这种真偏差才会提示一次。

细节见 [docs/DETAIL.md](docs/DETAIL.md)。
