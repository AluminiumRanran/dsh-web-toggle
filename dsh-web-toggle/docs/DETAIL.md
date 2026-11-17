# 联网开关

输入框工具栏上的一个小开关，只干一件事：控制**当前会话**的模型能碰到哪些工具。它不维护白名单，只维护**例外**——每个工具有一个模式，名单外的工具一律放行。

## 用法

- 工具栏左侧的「联网」按钮：亮着 = 开，图标被斜线划掉 = 关。
- 点一下切换。旁边的小箭头打开本会话面板（开关 + 每个工具的模式）。
- 也可以在输入框里敲命令：

| 命令 | 作用 |
| --- | --- |
| `/webtoggle` | 切换本会话的联网开关 |
| `/webtoggle off` | 关（幂等：重复关不会叠加限制） |
| `/webtoggle on` | 开 |
| `/webtoggle status` | 只看当前状态，不改 |
| `/webtoggle config` | 看面板配置与按模式的统计 |
| `/webtoggle tools` | 只回工具总数；`tools --json` 才附完整目录（客户端靠它画面板） |
| `/webtoggle surface <settings\|composer> on\|off` | 开关某处面板（`plugin` 固定显示，见下） |
| `/webtoggle mode <tool> keep\|hide\|inspect\|refuse [--global]` | 给某个工具定模式（默认本会话） |
| `/webtoggle mode reset [--global]` | 这一层模式表交还上一层 |
| `/webtoggle keep <tool> on\|off [--global]` | `mode` 的旧写法（`on` → keep，`off` → hide） |
| `/webtoggle allow add\|remove <tool> [--global]` | 更早的写法，仍可用 |

命令结果默认只回一句人话；`debug` 配置打开时才带机器可读标记（`tools` 另有 `--json` 开关，见下）：`[web:on]` / `[web:off]` 供按钮同步真实状态，`[web-state]{...}` 供面板画配置（开关、三个入口、两层模式表、能否写配置），`[web-tools]{...}` 是工具目录（每项含 `mode` / `builtIn`）。`tools` 是读命令，**永远**带这两段标记——面板打开时只发这一条，一次往返就能把开关和目录都画对，不会再往聊天里刷一串状态。

错误结果不附加任何机器标记（默认模式下），错误信息本身始终完整。

## 四种模式

| 模式 | 断网时 | 用途 |
| --- | --- | --- |
| `keep` | 照常可见、不做检查 | 确认是纯本地的工具 |
| `hide` | 从工具列表消失（`restrict({ deny })`） | 一看就是联网的通道 |
| `inspect` | 保留可见，但每次调用前过 `tools.guard()` 检查参数 | 双用途执行器、没被点名的工具 |
| `refuse` | 保留可见，但每次调用直接拒绝（不读参数） | 一律不许用、又不想改工具列表 |

只有 `hide` 会改工具列表，因此也只有它会打断提示词缓存；其余三种在断网期间只是调用前多一道判断。

出厂默认：名字以 `web_` / `bsk_` / `computer_` / `mcp__` / `video_` / `workbuddy_` / `snowluma_` 开头的，以及 `plugin_manager`、`schedule_create`、`schedule_edit`、`subagent`、`subagent_fork`、`workflow`、`send_message`、`wait_agent`、`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` → `hide`；**其余全部 → `inspect`**（`ops_bash` 也在其中）；`refuse` 出厂不指派给任何工具。

之所以从「白名单」改回「例外表」：插件要能公开发布，就不能假设别人装了什么。白名单是 fail-closed，别人新装的工具会被无故挡掉。例外表只挡明确列出的通道，没列出的名字落在 `inspect` 上——可见、可用，但断网时参数仍会被检查一次；确认安全的工具由用户自己升到 `keep`。

## 行为

- 关闭后，本会话的 Agent 上下文被 `tools.restrict({ deny: [...hide] })` 加上遮罩：下一次请求的工具声明里没有那些名字，模型硬调用只会得到 unknown tool。`deny` 为空时**完全不限制**（没有 hide 名单就不需要遮罩）。
- `inspect` 或 `refuse` 名单非空时才注册 `tools.guard()`：按 `exec.name` 查模式——`refuse` 直接拒（不读参数）；`inspect` 有命令文本的先查命令、再查它要执行的脚本与 `package.json` 脚本，没有命令文本的（MCP、读取器、生图……）退一步查参数 JSON。命中联网特征（`curl`/`wget`/`ssh`/`git clone`/`pnpm add`/`pip install`/`http(s)://`/UNC 共享/导入 `http`,`net`,`tls` 模块等）就在执行前被拒绝，本地调用照常跑。guard 与 restrict 同作用域，恢复时一并撤销。
- 被隐藏的工具名字只留内核肯接受的（见下「工具目录怎么来的」），插件没装或没有某个工具时不会因为 `restrict()` 报 unknown tool 而整体失败：拒绝时解析内核名单、取交集重试一次。
- 恢复时调用当时存下的 disposer，遮罩被精确撤销，工具列表原样回来。
- 状态按**会话**记录，互不影响：关掉 A 会话不会影响 B 会话，也不影响其他会话的本地工作。
- 工具列表变了会重建请求序列（`agent/pre-step` → `startsRequestSeries`），避免新声明被上游当成「延迟追加」。

## 三处面板与分层模式

三个入口都注册在客户端槽位上，都读同一个状态、走同一条命令线：

| 槽位 | id | 作用 |
| --- | --- | --- |
| `conversation.input.left` | `web-toggle` | 输入框的开关；旁边小箭头是本会话面板 |
| `settings.section` | `web-toggle` | 设置页侧边栏的全局面板 |
| `plugins.detail.section` | `web-toggle` | 插件详情页的全局面板（只认本包） |

- 入口开关是**真卸载**：关掉时把 `ctx.slots.register` 的 disposer 连同它的 `ctx.effect` 一起撤销，导航项与图标一起消失；重新打开时再注册回来。详情页那一处**永不卸载**——它是把另外两个入口重新打开的保底，命令层面 `surface plugin off` 只回一句说明。
- 三个面板里都有「工具」区：列出全部工具、每行一个按钮，点一下在 `keep → hide → inspect → refuse → keep` 之间循环，发 `mode <name> <next>[ --global]`；按钮上写的就是当前模式，筛选框只做本地过滤。
- 目录不进聊天：客户端把 `tools --json` 的结果存进 `localStorage`（键 `dsh-web-toggle:catalogue`），面板打开时直接画缓存，缓存缺失或用户点「刷新」时才真的发命令。三处面板的显示开关同样记在 `dsh-web-toggle:surfaces` 里，刷新页面后不会闪一下再消失。
- 设置页与详情页拿不到 sessionId（owner props 只有 `close` / `subject`），所以它们执行命令时用「最后一个画过的会话」：模块级 `lastSessionId` → localStorage `dsh-web-toggle:last-session` → 客户端已知的第一个会话。命中不了就如实提示「先打开任意一个任务」。
- 配置写入只走 `configEditor.edit(entry, current => …)`：拿不到编辑器时**如实报错**（`没有配置文件可写`、`writable: false`），绝不假装保存。
- 配置字段都是 `.volatile()`：改值原地生效，不重启插件。写入用 `saves` promise 串行化，避免两次点击互相覆盖。
- 模式是**分层**的：`sessionModes[sid][name]` → `toolModes[name]` → `defaultMode(name)`（出厂默认见上，兜底是 `inspect`）。往某一层写的时候，若值恰好等于从上层继承来的值，就把这一条**删掉**（而不是记一条同样的），所以「恢复默认」在面板上看是自动回到出厂模式，`mode reset` 则把整层交还给上一层。
- 工具目录怎么来的：`restrict()` 的校验用的是 `this.view(scopeOf(this.ctx)).restrictableNames`，而 `scopeOf` 用的 `kScope` 符号没有导出给插件，`view()` 不带参数又只是全局视图（看不到 profile 围绕 Agent 组合出来的名字）。所以拿到目录的办法是**让 restrict 自己报**：先 `restrict({ deny: ['__webtoggle_probe__'] })`，成功说明探针名居然存在（立刻 dispose），失败就从 `names unknown global tool "…"; known global tools: …` 的尾部解析出该作用域接受的完整名单。真正下发时若仍被拒（名单里混进了不存在的名字），再来一次 `openRestriction()`：解析内核名单、取交集重试。
- 目录里还会并入配置中出现过、但当前没注册的名字：这样把工具卸掉之后仍然能在面板里看到它、把模式改回 `keep`。
- 已经在断网状态时改模式（`retune()`）：先按新名单建好新的 restrict + guard，再撤销旧的，中间不会出现「变宽」的空档；正在执行的轮次跳过并在回执里写 `跳过 N（正在执行）`，等下一轮切开关时自然带上新名单。

## 性能

- Host 半侧：一次切换只做一次目录读取（约 100 个名字的过滤）+ 一次 `deny` 数组构造；平时只有两个事件监听器，`agent/pre-step` 里也只是 `Set.has` 一次。
- 客户端：一个小组件，状态不变就不重渲染；本地记忆一次 `localStorage` 读取；不轮询。唯一的定时器是"浏览器记着关"时那一次 0ms 探针，同一页面每个会话最多一次。

## 边界与限制

- **轮次进行中不改**：任务正在跑时点按钮会直接拒绝并提示，等这一轮结束再切。理由是不会在轮次中途换工具集（那会让同一轮的前后请求声明不一致）。改模式同理：只写配置、不下发，回执里写「跳过 N（正在执行）」。
- **是工具层的门，不是网络层的墙**：DSH 内核没有"按会话断网"的能力（`dsh-sandbox-local` 只约束文件系统，没有网络规则），所以这层挡的是"手里的工具"，不是 TCP 连接。
  - 因此仍有三个洞：① `inspect` 是字面匹配，精心伪装的命令能绕；② 关之前已经跑起来的后台任务（例如 `curl`）不会自动断，用 `job_list` + `job_kill` 收尾；③ `run_code` 是内核保留名字，`restrict()` 不接受，PTC 模式下它仍可见（它自身没有网络 API，但能起的子代理是否受限取决于内核）；④ 真要在系统层断绝，只能在无网 VM/容器里跑 DSH。
- **只影响被关的那一个会话**：其余会话、以及本会话里 `keep` 的工具（文件、检索、计划、记忆、技能）照常工作。
- **重启重置**：DSH 重启后 Host 侧状态清零（工具恢复可见）。按钮挂载时如果浏览器记着「关」，会向 Host 探一次 `/webtoggle status` 把显示纠正过来，因此不会出现「明明开着却显示关」。
  - 探针每个会话在一个页面生命周期内只跑一次（模块级 `probedSessions`）。切到别的会话再切回来，既不重发命令也不弹提示；只有真出现「记忆为关、宿主已开」时提示一次。
  - 宿主确认仍是关闭时保持沉默——按钮本来就是灭的，再弹一句「仍是关闭」只是噪音。
- 会话销毁会撤销遮罩并清理记录，限制不会泄漏到别的会话。

## 相关实现

- `index.js`：`/webtoggle` 命令（含 `config` / `surface` / `tools` / `mode` / 旧别名 `keep`、`allow`）、`Config` 六个 volatile 字段、`restrictableOf()` 探针式目录、`openRestriction()` 收窄重试、`defaultMode()` / `modeOf()` / `splitByMode()`、`retune()` 换模式、`tools.guard()` 内容检查、请求序列重建、会话销毁清理。
- `client.js`：三个槽位组件（输入框开关 + 小箭头浮层、设置页、插件详情页）、共用面板 `PanelView`（三态循环按钮）、乐观更新 `planOf` / `applyPlan`、按会话铭记的显示状态、`commands.execute` 调用。

## 拒绝文案为什么写成指令

`OFFLINE_NOTICE`（`index.js` 顶部）追加在每一条 guard 拒绝理由末尾。它刻意不是"这条命令被拦了"这种描述句，而是四段式指令：

1. **先给规则**：本会话不允许使用一切形式的联网工具——范围是"全部联网工具"，不是"这一条命令"。
2. **封掉绕路**：换工具、写脚本、编码后执行、起子进程找替代通道，都算同一个动作。
3. **给出口**：真需要联网就停下、向用户说明、请用户暂时打开开关。
4. **给误判通道**：怀疑误判也走第 3 条，不要自己试。

理由：模型看到"被拦了"会倾向于换一种写法再试一次；看到"规则 + 禁止换路 + 唯一出口"才会停下来找人。中英各一份，跟着会话语言走不了（命令结果不带语言上下文），所以两条都给。

## 命令过滤的三层（`index.js`）

只作用于 `inspect` 模式的工具（默认 `ops_bash`）：

1. **字面匹配**：`NETWORK_COMMAND` 认客户端、包管理联网子命令、URL、UNC、解释器的网络模块。
2. **去伪装再匹配**：`squashQuotes()` 去掉 `'` `"` `` ` `` `^` `\` `+` 与 `${IFS}`，把 `so''cket`、`"cur""l"`、`'so'+'cket'` 还原成真名后再匹配一次。
3. **看它要执行的文件**：`inspectScripts()` 对解释器 + 脚本扩展名的组合，按 workdir → 会话目录 → 进程目录解析并读文件（≤256 KB，一层递归）；`inspectPackageScript()` 对 `npm run x` / `pnpm x` 读 `package.json` 的 `scripts.x`，同样匹配并检查其中引用的脚本。

读不到文件一律放行：读不到的东西也跑不起来，而 fail-closed 会让正常工程挂掉。开销：断网时每次 `inspect` 工具的调用最多多读一个几百 KB 以内的文件，不做目录遍历。

## 公开性设计备注

- 不了解你的环境：不假设装了什么、不假设工具存在、不假设语言。
- 不写死工具名：出厂只区分「联网前缀 / 显式名单 / 通用执行器」，其余放行。
- 配置是数据不是代码：模式表存在 profile 里，面板改、命令改、手改 `cordis.yml` 都行，三层继承关系写在文档里。
- 破坏性变更给迁移路径：`0.4.0` 的 `toolModes`/`sessionModes` 与 `0.3.x` 的 `globalTools`/`sessionTools` 语义相反，README 里照抄了迁移步骤，不做自动转换。

## 声明

本插件使用 AI 辅助完成（设计、实现、测试与文档均由人和 AI 协作产出，并经真机红队测试）。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
