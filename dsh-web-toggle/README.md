# dsh-web-toggle

给 DSH 对话输入框工具栏加一个**按会话独立**的断网开关。装上之后，输入框左边多一个小地球：

- 亮着：本会话工具齐全（`web_search` / `web_fetch`、shell、浏览器、MCP 都在）。
- 点灭：本会话**只剩不能出网的工具**——网页搜索、浏览器、MCP、生图/视频、子代理、插件管理、定时任务全部从工具列表里消失，`ops_bash` 保留但加命令过滤。下一次请求生效。
- 再点一次恢复。**只影响这一个会话**，别的会话和本地功能照旧。

底层用的是 DSH 内核自带的 `agent.ctx.tools.restrict()`：作用域绑定在 agent 上，返回精确的 disposer，所以隔离是天然的、按会话的、可逆的。用的是**白名单**而不是只 deny 两个名字：只 deny `web_search` / `web_fetch` 挡不住 shell、浏览器、MCP 这些通用通道；白名单才能默认关门——将来别的插件新加的工具也一样被挡在外面，直到有人把它加进白名单。

## 安装

需要 DSH `>= 0.2.2-rc.1 < 0.3.0`。

源码目录直接装（推荐，改代码后要同步）：

```
plugin_manager install_bundle target="file:E:/workspace/dsh-web-toggle-prompt-20261116/dsh-web-toggle"
```

装完 **刷新页面**（新的客户端模块要重新下发）。Host 半侧随 DSH 启动加载；插件管理器里禁用再启用即可热重载。

pnpm 对 `file:` 依赖做的是**拷贝**，不是软链：改完源码要 `node scripts/sync-to-profile.mjs` 把文件同步进 `C:\Users\Aluminium\.dsh\profiles\desktop\node_modules\dsh-web-toggle\`，再热重载。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/webtoggle` | 切换 |
| `/webtoggle on` / `off` | 显式开关（幂等） |
| `/webtoggle status` | 只读状态 |

轮次正在执行时切换会被**拒绝**（不排队）：同一轮里前后两个请求的工具声明不一致会让模型困惑。

## 它挡什么

**隐藏**：`web_search`、`web_fetch`、浏览器（`bsk_*`）、`computer_*`（能驱动浏览器看网页）、全部 `mcp__*` 与 MCP 资源读取、`video_*`、`workbuddy_*`、`subagent` / `subagent_fork` / `workflow` / `send_message`（子代理是新的 Agent，遮罩跟不过去）、`plugin_manager`（装包=下载）、`schedule_create` / `schedule_edit`（会安排另一个会话去联网）。

**留下、但加命令过滤**：`ops_bash`。本地活照跑；命令里出现联网迹象就在执行前拦下。

**留下（纯本地，不设防）**：文件读写与检索、上下文/记忆、计划与目标、技能、`job_*` 查看与终止、`schedule_list` / `schedule_view`、`present`、`ask_user_question` 等。

被拦下的调用会收到一条**写成指令的拒绝理由**，而不是只说"被拦了"：

> 规则：本会话暂时不允许使用一切形式的联网工具。不要换别的工具、不要写脚本或编码后执行、不要起子进程去找替代通道——开关打开之前这里的任何联网尝试都会被拦下。真的需要联网时，停下来向用户说明「需要联网」，请用户暂时打开开关；如果怀疑是误判，也照此处理。

## 命令过滤的三层

1. **字面匹配**：命令行客户端（`curl` / `wget` / `ssh` / `nc` / `ping` …）、联网式仓库与包管理操作（`git clone`、`npm view|pack|install`、`pip install`、`gh release` …）、URL 与 UNC、解释器的网络模块（`import socket` / `require('net')` / `ssl` / `urllib` …）、PowerShell/.NET 的下载器与 `-EncodedCommand`、`base64 -d | sh`。
2. **去伪装再匹配**：先去掉 `'` `"` 反引号 `^` `\` `+` 和 `${IFS}`，把 `so''cket`、`"cur""l"`、`__import__('so'+'cket')` 还原成真名后再匹配一遍。
3. **看它要执行的文件**：命令带解释器（`python` / `node` / `bash` / `pwsh` / `source` …）和脚本路径时，按 `workdir` → 会话目录 → 进程目录解析，**真的把文件读出来**（≤256 KB，一层递归）用同一套规则看内容；`npm run x` / `pnpm x` 会读 `package.json` 的 `scripts.x`，再查它引用的脚本。

读不到文件**一律放行**：读不到的东西也跑不起来，而对读不到的东西 fail-closed 会让正常工程挂掉。

## 挡不住什么（如实写）

这一层是**提示性护栏，不是网络层的墙**。DSH 内核没有"按会话断网"的能力（`dsh-sandbox-local` 只约束文件系统，没有网络规则），所以：

1. **运行时拼出来的名字**：`chr(115)+chr(111)+...`、`getattr(mod, name)` 之类，文本里没有任何关键词，只有解释器知道会拼出什么。
2. **脚本放在三个候选目录之外**（读不到 → 放行），或者改名到没有扩展名。
3. **编译器产物**：`gcc` / `rustc` 编译出联网二进制，文本层只看到"编译"。
4. **已经在跑的东西**：关之前起的后台任务、计划任务、服务不会自动断；用 `job_list` + `job_kill` 收尾。
5. **`run_code` 是内核保留名**，`tools.restrict()` 不接受它，所以 PTC 模式下仍可见；它自身没有网络 API，但它起的子代理是否受限取决于内核。
6. 真要"一个字节都不许出"，只能在无网 VM/容器里跑 DSH——那不是插件能做的事。

## 性能

几乎为零。Host 半侧只在切换时读一次工具目录（约 100 个名字的过滤），平日只有两个事件监听器；每次 admitted step 只做一次 `Set.has`。断网期间每次 `ops_bash` 多一次正则（以及必要时读一个脚本文件，≤256 KB，不做目录遍历）。客户端是一小组件，只在状态变化时渲染——没有轮询、没有常驻定时器。

## 开发与测试

```bash
node tests/host.test.mjs      # 12 组：开关、幂等、隔离、序列重建、白名单、命令过滤
node tests/client.test.mjs    # 8 组：按钮两态、探针、失败分支、切走切回
node scripts/sync-to-profile.mjs
```

`tests/host.test.mjs` 里的命令过滤用例包含三轮红队实测：直白写法、引号/加号拆分、写盘再执行、`npm run` 脚本体，以及一组本地命令的回归基线（`pnpm run build`、`git status`、`python -c "print(1+1)"`、`node scripts/x.mjs` …）。

更多设计细节见 [docs/DETAIL.md](docs/DETAIL.md)，红队记录见 [docs/REDTEAM.md](docs/REDTEAM.md)，真机验证见 [docs/VERIFY.md](docs/VERIFY.md)。

## 目录

```
index.js            Host 半侧：命令、restrict、guard、请求序列重建
client.js           Browser 半侧：输入框按钮、状态、locale
cordis.patch.yml    把插件插进 profile 的 bundle 补丁
locale/{en,zh}.json 插件管理器里的标题/描述/详情路径
icon.svg            插件图标
docs/               DETAIL / REDTEAM / VERIFY
tests/              host 与 client 的离线测试
scripts/            同步进 profile 的脚本
```

## 许可

MIT
