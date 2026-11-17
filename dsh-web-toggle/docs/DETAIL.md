# 联网开关

输入框工具栏上的一个小开关，只干一件事：控制**当前会话**的模型能不能看到 `web_search` / `web_fetch`。

## 用法

- 工具栏左侧的「联网」按钮：亮着 = 开，图标被斜线划掉 = 关。
- 点一下切换。也可以在输入框里敲命令：

| 命令 | 作用 |
| --- | --- |
| `/webtoggle` | 切换本会话的联网开关 |
| `/webtoggle off` | 关（幂等：重复关不会叠加限制） |
| `/webtoggle on` | 开 |
| `/webtoggle status` | 只看当前状态，不改 |
| `/webtoggle config` | 看面板配置与两份保留名单 |
| `/webtoggle tools` | 列出内核当前全部工具 + 哪些在断网时保留 |
| `/webtoggle surface <settings\|composer> on\|off` | 开关某处面板（`plugin` 固定显示，见下） |
| `/webtoggle keep <tool> on\|off [--global]` | 让某个工具断网时保留 / 隐藏（默认本会话） |
| `/webtoggle keep reset [--global]` | 这一层名单交还上一层 |
| `/webtoggle allow add\|remove <tool> [--global]` | `keep` 的旧写法 |

命令结果末尾带机器可读标记：`[web:on]` / `[web:off]` 供按钮同步真实状态，`[web-state]{...}` 供面板画配置（开关、三个入口、两份名单、能否写配置）。`tools` 与 `keep`/`surface` 的回执里还多一段 `[web-tools]{...}`（工具目录，含每项的 `kept`/`builtIn`），面板据此一次往返就把开关画对，不必再问一遍。

## 行为

- 关闭后，本会话的 Agent 上下文被 `tools.restrict({ allow: [...本地工具 + ops_bash] })` 加上遮罩：下一次请求的工具声明里只剩白名单里的名字，其余（网页搜索、浏览器、MCP、视频/生图、子代理、插件管理、定时任务）一律消失；模型硬调用只会得到 unknown tool。
- `ops_bash` 属于双用途工具，因此不隐藏而是加一道 `tools.guard()`：命令文本命中联网特征（`curl`/`wget`/`ssh`/`git clone`/`pnpm add`/`pip install`/`http(s)://`/UNC 共享/导入 `http`,`net`,`tls` 模块等）就在执行前被拒绝，本地命令照常跑。guard 是与 restrict 同作用域的，恢复时一并撤销。
- 用**白名单**而不是 deny 两三个名字是有意的：`ops_bash` 可以 `curl`、浏览器工具能开页面、MCP 能转发请求，deny 少数几个永远漏。白名单默认关门，将来新插件加的工具也进不来，除非显式加名字。
- 名单里的名字只留内核肯接受的（见下「工具目录怎么来的」），插件没装时不会因为 `restrict()` 报 unknown tool 而整体失败。
- 恢复时调用当时存下的那个 disposer，遮罩被精确撤销，工具列表原样回来。
- 状态按**会话**记录，互不影响：关掉 A 会话不会影响 B 会话，也不影响其他会话的本地工作。
- 工具列表变了会重建请求序列（`agent/pre-step` → `startsRequestSeries`），避免新声明被上游当成「延迟追加」。

## 三处面板与按会话白名单

三个入口都注册在客户端槽位上，都读同一个状态、走同一条命令线：

| 槽位 | id | 作用 |
| --- | --- | --- |
| `conversation.input.left` | `web-toggle` | 输入框的开关；旁边小箭头是本会话面板 |
| `settings.section` | `web-toggle` | 设置页侧边栏的全局面板 |
| `plugins.detail.section` | `web-toggle` | 插件详情页的全局面板（只认本包） |

- 入口开关是**真卸载**：关掉时把 `ctx.slots.register` 的 disposer 连同它的 `ctx.effect` 一起撤销，导航项与图标一起消失；重新打开时再注册回来。详情页那一处**永不卸载**——它是把另外两个入口重新打开的保底，命令层面 `surface plugin off` 只回一句说明。
- 三个面板里都有「工具」区：列出全部工具、每行一个开关，点一下发 `keep <name> on|off[ --global]`；筛选框只做本地过滤。
- 设置页与详情页拿不到 sessionId（owner props 只有 `close` / `subject`），所以它们执行命令时用「最后一个画过的会话」：模块级 `lastSessionId` → localStorage `dsh-web-toggle:last-session` → 客户端已知的第一个会话。命中不了就如实提示「先打开任意一个任务」。
- 配置写入只走 `configEditor.edit(entry, current => …)`：拿不到编辑器时**如实报错**（`没有配置文件可写`、`writable: false`），绝不假装保存。
- 五个配置字段都是 `.volatile()`：改值原地生效，不重启插件。写入用 `saves` promise 串行化，避免两次点击互相覆盖。
- 名单是**分层且完整**的：`sessionTools[sid]`（非空）→ `globalTools`（非空）→ 内置默认（`LOCAL_TOOLS ∪ GUARDED_TOOLS`）。写入的是整份名单，所以「关掉一个工具」＝把它从这一层删掉，`keep reset` ＝交还上一层。
- 工具目录怎么来的：`restrict()` 的校验用的是 `this.view(scopeOf(this.ctx)).restrictableNames`，而 `scopeOf` 用的 `kScope` 符号没有导出给插件，`view()` 不带参数又只是全局视图（看不到 profile 围绕 Agent 组合出来的名字）。所以拿到目录的办法是**让 restrict 自己报**：先 `restrict({ deny: ['__webtoggle_probe__'] })`，成功说明探针名居然存在（立刻 dispose），失败就从 `names unknown global tool "…"; known global tools: …` 的尾部解析出该作用域接受的完整名单。真正下发时若仍被拒（名单里混进了不存在的名字），再来一次 `openRestriction()`：解析内核名单、取交集重试。
- 已经在断网状态时改白名单（`retune()`）：先按新名单建好新的 restrict + guard，再撤销旧的，中间不会出现「变宽」的空档；正在执行的轮次跳过并在回执里写 `跳过 N（正在执行）`，等下一轮切开关时自然带上新名单。

## 性能

- Host 半侧：一次切换只做一次 `view()` 读取 + 约 34 个名字的集合过滤；平时只有两个事件监听器，`agent/pre-step` 里也只是 `Set.has` 一次。
- 客户端：一个小组件，状态不变就不重渲染；本地记忆一次 `localStorage` 读取；不轮询。唯一的定时器是"浏览器记着关"时那一次 0ms 探针，同一页面每个会话最多一次。

## 边界与限制

- **轮次进行中不改**：任务正在跑时点按钮会直接拒绝并提示，等这一轮结束再切。理由是不会在轮次中途换工具集（那会让同一轮的前后请求声明不一致）。
- **是工具层的门，不是网络层的墙**：DSH 内核没有"按会话断网"的能力（`dsh-sandbox-local` 只约束文件系统，没有网络规则），所以这层挡的是"手里的工具"，不是 TCP 连接。
  - 因此仍有三个洞：① shell 过滤是字面匹配，精心伪装的命令能绕（要更狠就只能连 shell 一起隐藏）；② 关之前已经跑起来的后台任务（例如 `curl`）不会自动断，用 `job_list` + `job_kill` 收尾；③ `run_code` 是内核保留名字，`restrict()` 不接受，PTC 模式下它仍可见（它自身没有网络 API，但能起的子代理是否受限取决于内核）；④ 真要在系统层断绝，只能在无网 VM/容器里跑 DSH。
- **只影响被关的那一个会话**：其余会话、以及本会话的本地工具（文件、检索、计划、记忆、技能）照常工作。
- **重启重置**：DSH 重启后 Host 侧状态清零（工具恢复可见）。按钮挂载时如果浏览器记着「关」，会向 Host 探一次 `/webtoggle status` 把显示纠正过来，因此不会出现「明明开着却显示关」。
  - 探针每个会话在一个页面生命周期内只跑一次（模块级 `probedSessions`）。切到别的会话再切回来，既不重发命令也不弹提示；只有真出现「记忆为关、宿主已开」时提示一次。
  - 宿主确认仍是关闭时保持沉默——按钮本来就是灭的，再弹一句「仍是关闭」只是噪音。
- 会话销毁会撤销遮罩并清理记录，限制不会泄漏到别的会话。

## 相关实现

- `index.js`：`/webtoggle` 命令（含 `config` / `surface` / `tools` / `keep` / `allow`）、`Config` 五个 volatile 字段、`restrictableOf()` 探针式目录、`openRestriction()` 收窄重试、`tools.restrict()` 遮罩与 `tools.guard()` 命令过滤的 disposer 管理、`retune()` 换名单、请求序列重建、会话销毁清理。
- `client.js`：三个槽位组件（输入框开关 + 小箭头浮层、设置页、插件详情页）、共用面板 `PanelView`、按会话铭记的显示状态、`commands.execute` 调用。

## 拒绝文案为什么写成指令

`OFFLINE_NOTICE`（`index.js` 顶部）追加在每一条 guard 拒绝理由末尾。它刻意不是"这条命令被拦了"这种描述句，而是四段式指令：

1. **先给规则**：本会话不允许使用一切形式的联网工具——范围是"全部联网工具"，不是"这一条命令"。
2. **封掉绕路**：换工具、写脚本、编码后执行、起子进程找替代通道，都算同一个动作。
3. **给出口**：真需要联网就停下、向用户说明、请用户暂时打开开关。
4. **给误判通道**：怀疑误判也走第 3 条，不要自己试。

理由：模型看到"被拦了"会倾向于换一种写法再试一次；看到"规则 + 禁止换路 + 唯一出口"才会停下来找人。中英各一份，跟着会话语言走不了（命令结果不带语言上下文），所以两条都给。

## 命令过滤的三层（`index.js`）

1. **字面匹配**：`NETWORK_COMMAND` 认客户端、包管理联网子命令、URL、UNC、解释器的网络模块。
2. **去伪装再匹配**：`squashQuotes()` 去掉 `'` `"` `` ` `` `^` `\` `+` 与 `${IFS}`，把 `so''cket`、`"cur""l"`、`'so'+'cket'` 还原成真名后再匹配一次。
3. **看它要执行的文件**：`inspectScripts()` 对解释器 + 脚本扩展名的组合，按 workdir → 会话目录 → 进程目录解析并读文件（≤256 KB，一层递归）；`inspectPackageScript()` 对 `npm run x` / `pnpm x` 读 `package.json` 的 `scripts.x`，同样匹配并检查其中引用的脚本。

读不到文件一律放行：读不到的东西也跑不起来，而 fail-closed 会让正常工程挂掉。开销：断网时每次 `ops_bash` 最多多读一个几百 KB 以内的文件，不做目录遍历。
