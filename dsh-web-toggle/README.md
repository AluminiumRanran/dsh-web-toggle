# dsh-web-toggle

给 DSH 对话输入框工具栏加一个**按会话独立**的断网开关。装上之后，输入框左边多一个小地球：

- 亮着：本会话工具齐全（`web_search` / `web_fetch`、shell、浏览器、MCP 都在）。
- 点灭：本会话里**被标成「隐藏」的工具从工具列表里消失**（出厂默认：网页搜索、浏览器、MCP、生图/视频、子代理、插件管理、定时任务），`ops_bash` 保留但每次调用前过一遍命令内容检查；**没写进名单的工具默认「检查」**——还在列表里，但每次调用的参数都会被看一眼。下一次请求生效。
- 再点一次恢复。**只影响这一个会话**，别的会话和本地功能照旧。
- 旁边的**小箭头**打开本会话面板：开关、本会话每个工具的模式都在里面；设置页与插件详情页还有一份全局面板（除详情页外都能在配置里关掉）。

每个工具一个模式，一共四种：

| 模式 | 断网时 |
| --- | --- |
| `keep` 保留 | 照常出现在工具列表里，不做任何检查 |
| `hide` 隐藏 | 从工具列表里消失，模型看不见也调不到 |
| `inspect` 检查 | 保留，但每次调用前把参数拿去做联网内容检查，命中就拒绝 |
| `refuse` 调用时拒绝 | 保留可见，但每次调用直接拒绝，连参数都不看——缓存友好，适合「这个工具一律不许用」 |

这套设计是给公开发布用的：插件不知道你装了哪些工具，所以**不维护白名单，只维护例外**——出厂只把「一看就是联网」的名字标成 `hide`，把通用执行器标成 `inspect`，**没提到的名字默认也是 `inspect`**（可见，但调用时看参数）。将来别的插件新加了工具，不用改配置就有一条保守的防线；反过来，确认安全的工具切成 `keep`，确认危险的切成 `hide` 或 `refuse`。

四个模式里只有 `hide` 会改动工具列表（因此会打断提示词缓存）；`keep` / `inspect` / `refuse` 都不动列表，只是断网期间在调用前多一道判断。

底层用的是 DSH 内核自带的 `agent.ctx.tools.restrict()`：作用域绑定在 agent 上，返回精确的 disposer，所以隔离是天然的、按会话的、可逆的。内容检查用同一作用域的 `tools.guard()`。

## 安装

需要 DSH `>= 0.2.2-rc.1 < 0.3.0`。

从 npm 装（最省事）：

```
plugin_manager install_bundle target="dsh-web-toggle"
```

或指定版本 `target="dsh-web-toggle@0.4.0"`。也可以下 GitHub Release 里的 tgz，用 `target="file:/绝对路径/dsh-web-toggle-0.4.0.tgz"` 装，效果一样。

开发时源码目录直接装（改代码后要同步）：

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
| `/webtoggle status` | 只读状态（含面板配置与按模式的统计） |
| `/webtoggle tools` | 列出内核当前全部工具，以及每个工具的模式 |
| `/webtoggle config` | 看配置：三个入口的显示状态、隐藏/检查/放行的数量 |
| `/webtoggle surface <settings\|composer> on\|off` | 开关某处面板（详情页固定显示） |
| `/webtoggle mode <tool> keep\|hide\|inspect\|refuse [--global]` | 给某个工具定模式（默认本会话） |
| `/webtoggle mode reset [--global]` | 本会话（或全局）的模式表交还给上一层 |
| `/webtoggle mode list [--global]` | 只列这一层写过的模式 |
| `/webtoggle keep <tool> on\|off [--global]` | `mode` 的旧写法（`on` → `keep`、`off` → `hide`） |
| `/webtoggle allow add\|remove <tool> [--global]` | 上一条的更早写法，仍可用 |

轮次正在执行时切换会被**拒绝**（不排队）：同一轮里前后两个请求的工具声明不一致会让模型困惑。改模式同理——只写配置，不立刻下发，回执里会写「跳过 N（正在执行）」，下一轮自动生效。

## 三处面板

刷新后能见到三个入口。关掉一个入口是**真的把它从界面卸载**（导航项、图标、按钮一起消失），不是只清空内容：

| 位置 | 管什么 | 能否关闭 |
| --- | --- | --- |
| 输入框小地球右边的小箭头 | 本会话开关 + 每个工具的模式（**本会话**层） | 能 |
| 设置 → 侧边栏「联网开关」 | 两个入口的显示开关 + 每个工具的模式（**全局**层） | 能 |
| 插件管理 → 本插件详情页 | 与设置页同内容，省得从插件页跳走 | **不能**：它是把另外两个入口重新打开的保底 |

三个面板里的「工具」区都列出内核当前**全部**工具（`/webtoggle tools` 的同一份目录），每行一个按钮，点一下在 `放行 → 拒绝 → 检查 → 调用时拒绝 → 放行` 之间循环，按钮上写的就是当前模式。出厂标过模式的工具带一个小徽标。顶部有筛选框，输入名字的一部分就能缩小列表（只在本地过滤，不发命令）。

配置就写在 profile 的 `cordis.yml` 里本插件那一行，界面改动**即时生效**（字段是 volatile 的，不会重启插件）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `pluginPage` | `true` | 保留字段：详情页始终显示 |
| `settingsSection` | `true` | 设置页侧边栏里的面板 |
| `composerPanel` | `true` | 输入框开关旁的小箭头 |
| `debug` | `false` | 命令回执附机器可读的 `[web-state]` / `[web-tools]` JSON，排障用 |
| `toolModes` | `{}` | **全局层**：工具名 → `keep` / `hide` / `inspect` / `refuse` |
| `sessionModes` | `{}` | **按会话层**：会话 id → 上表 |

模式是**分层**的：先看本会话写过的，没写过看全局层，再没写过用出厂默认（下表）。所以「改回默认」不是写个 `keep`，而是把这一层的这条删掉——`mode reset` 就是把整层交还给上一层。切换模式后立刻换一份新的 deny 名单，不用先开再关。

小箭头面板写的是 `sessionModes[当前会话]`：只影响这一个任务；设置页与详情页写的是 `toolModes`：影响所有没单独设置过的会话。

顺带说明：这些面板拿不到「当前会话」（设置页的 owner props 只有 `close`），所以它们执行命令时用**最后一个在页面上画过的会话**，其次用 localStorage 记下的会话 id，再其次取客户端已知的第一个会话。开过一次任务之后就不会缺会话。

## 出厂默认

**`hide`（断网时消失）** —— 名字前缀：`web_`、`bsk_`、`computer_`、`mcp__`、`video_`、`workbuddy_`、`snowluma_`；另外点名：`plugin_manager`（装包=下载）、`schedule_create` / `schedule_edit`（会安排另一个会话去联网）、`subagent` / `subagent_fork` / `workflow` / `send_message` / `wait_agent`（子代理是新的 Agent，遮罩跟不过去）、`list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`。

**`inspect`（保留，但每次查内容）** —— `ops_bash`，以及**所有没被上面点名的工具**。

`refuse`（调用时拒绝）出厂不给任何工具——它是给你自己用的：某个工具不想让它跑，又不想让工具列表变化时切过去。确认安全的本地工具（文件读写、上下文、计划、`job_*` 等）建议显式写成 `keep`，省掉每次调用的参数检查。

被内容检查拦下的调用会收到一条**写成指令的拒绝理由**，而不是只说"被拦了"：

> 规则：本会话暂时不允许使用一切形式的联网工具。不要换别的工具、不要写脚本或编码后执行、不要起子进程去找替代通道——开关打开之前这里的任何联网尝试都会被拦下。真的需要联网时，停下来向用户说明「需要联网」，请用户暂时打开开关；如果怀疑是误判，也照此处理。

## 命令过滤的三层

只作用于 `inspect` 模式的工具（默认就是 `ops_bash`）：

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

几乎为零。Host 半侧只在切换模式时读一次工具目录（约 100 个名字的过滤），平日只有两个事件监听器；每次 admitted step 只做一次 `Set.has`。断网期间每次 `inspect` 工具的调用多一次正则（以及必要时读一个脚本文件，≤256 KB，不做目录遍历）；`refuse` 不读参数，只有一次模式查表。客户端是一小组件，只在状态变化时渲染——没有轮询、没有常驻定时器。

## 从 0.3.x 升级

`0.4.0` 是**破坏性变更**：`globalTools` / `sessionTools`（完整保留名单）换成了 `toolModes` / `sessionModes`（工具 → 模式），默认语义也从「名单外一律隐藏」变成「名单外一律放行」。`0.5.0` 又加了第四态 `refuse`，并把**名单外的默认从 `keep` 收紧成 `inspect`**：升级后如果某个本地工具开始被拦，把它显式设成 `keep` 即可。

- 旧的 `globalTools` / `sessionTools` **不再读取**，请照旧配置里的名字重写一遍：
  想保留的 → `mode <tool> keep --global`；想隐藏的 → `mode <tool> hide --global`。
- 只写了几个名字的旧配置不能直接迁移成模式表：旧名单是「完整名单」，新表是「例外表」，语义相反，自动转换会把意图弄反，所以宁可不转。
- 出厂默认已经覆盖了绝大多数联网工具；升级后想恢复以前的「只剩本地工具」，把不认识的工具逐个切 `hide` 即可（面板里一次点一下）。

## 开发与测试

```bash
node tests/host.test.mjs      # 16 组：开关、幂等、隔离、序列重建、三态分类、命令过滤、配置面
node tests/client.test.mjs    # 14 组：按钮两态、三处面板、三态循环、探针、失败分支、切走切回
node scripts/sync-to-profile.mjs
```

`tests/host.test.mjs` 里的命令过滤用例包含三轮红队实测：直白写法、引号/加号拆分、写盘再执行、`npm run` 脚本体，以及一组本地命令的回归基线（`pnpm run build`、`git status`、`python -c "print(1+1)"`、`node scripts/x.mjs` …）。

更多设计细节见 [docs/DETAIL.md](docs/DETAIL.md)，红队记录见 [docs/REDTEAM.md](docs/REDTEAM.md)，真机验证见 [docs/VERIFY.md](docs/VERIFY.md)。

## 目录

```
index.js            Host 半侧：命令、restrict、guard、请求序列重建
client.js           Browser 半侧：输入框按钮、三处面板、locale
cordis.patch.yml    把插件插进 profile 的 bundle 补丁
locale/{en,zh}.json 插件管理器里的标题/描述/详情路径
icon.svg            插件图标
docs/               DETAIL / REDTEAM / VERIFY
tests/              host 与 client 的离线测试
scripts/            同步进 profile、链接依赖的脚本
```

## 许可

MIT

## 声明

本插件使用 AI 辅助完成（设计、实现、测试与文档均由人和 AI 协作产出，并经真机红队测试）。发布前请自行复核它是否满足你的安全要求——它的定位是**提示性护栏**，不是网络隔离。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
