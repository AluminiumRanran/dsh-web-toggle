/**
 * 离线验证 Host 半侧（index.js）的状态机，不依赖真实 DSH：
 * 用假的 ctx / agent 跑一遍开关、幂等、轮次拒绝、参数校验与销毁清理。
 * 用法：node tests/host.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

/** 假工具目录：本地工具 + 各种能出网的通道 + 一个未列入白名单的本地工具。 */
const CATALOG = new Set([
  // 本地
  'acp_read_original_image',
  'acp_status',
  'ask_user_question',
  'compress',
  'create_goal',
  'create_skill',
  'create_worktree',
  'decompress',
  'edit',
  'get_goal',
  'job_kill',
  'job_list',
  'job_output',
  'list_agents',
  'list_subagent_models',
  'load_workspace_dependencies',
  'ops_discover_tools',
  'ops_glob',
  'ops_grep',
  'ops_inspect_local_file',
  'present',
  'read_animation',
  'read_image',
  'remember',
  'schedule_list',
  'schedule_view',
  'search_context',
  'skill',
  'switch_session_preset',
  'todo_write',
  'update_goal',
  'working_directory',
  'write',
  // 能出网 / 能驱动别人出网
  'bsk_page',
  'bsk_session',
  'computer_ctrl',
  'mcp__snowluma__qq_send_message',
  'ops_bash',
  'plugin_manager',
  'read_mcp_resource',
  'schedule_create',
  'send_message',
  'subagent',
  'subagent_fork',
  'video_probe',
  'web_fetch',
  'web_search',
  'workbuddy_draw_image',
  'workflow',
  // 插件没听说过的本地工具：默认放行，公开版不假设清单是完整的
  'read',
])

/** 造一个能被 apply 接受的 ctx，并记录注册过的命令与监听器。 */
function makeCtx() {
  const commands = new Map()
  const listeners = new Map()
  const services = new Map()
  const ctx = {
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
      },
    },
    agents: {
      turnBoundaryOf: () => ({ openTurnStartSeq: null }),
    },
    tools: {
      // 本部署的工具目录：既含本地工具，也含各种能出网的工具；'read' 是未列入白名单的
      // 本地工具，'acp_cache' 故意不注册，用来验证"只保留目录里真实存在的名字"。
      view: () => ({ restrictableNames: CATALOG, knownNames: CATALOG }),
    },
    // 配置相关：真实运行时由 profile 的 config editor 提供，测试里可按需塞入。
    get(name) {
      return services.get(name)
    },
    fiber: { entry: { options: { id: 'web-toggle' } } },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
  }
  return { ctx, commands, listeners, services }
}

/** 造一个 agent：tools.restrict 记录调用并返回一个可观察的 disposer。 */
function makeAgent(id, { running = false } = {}) {
  const restrictions = []
  const disposals = []
  const guards = []
  const guardDisposals = []
  const agent = {
    status: running ? 'running' : 'idle',
    session: { id },
    ctx: {
      tools: {
        guard(fn) {
          guards.push(fn)
          guardDisposals.push('registered')
          return () => guardDisposals.push('lifted')
        },
        restrict(filter) {
          // 关闭 = 只藏 mode=hide 的少数工具；名单外的一律继续可用。
          assert.equal(filter.allow, undefined, '关闭应使用 deny，而不是 allow 白名单')
          assert.ok(Array.isArray(filter.deny), 'deny 必须是数组')
          for (const name of filter.deny) {
            assert.ok(CATALOG.has(name), `deny 里出现了目录中没有的工具：${name}`)
          }
          restrictions.push(filter)
          let lifted = false
          const dispose = () => {
            if (lifted) disposals.push('double-dispose')
            lifted = true
            disposals.push('lifted')
          }
          return dispose
        },
      },
    },
  }
  return { agent, restrictions, disposals, guards, guardDisposals }
}

const { ctx, commands, listeners } = makeCtx()
apply(ctx, { debug: { get: () => true } })
const command = commands.get('webtoggle')
assert.ok(command !== undefined, '应注册 webtoggle 命令')

const call = (agent, rawInput) => command.handler({ agent, rawInput })

// 1. 初始状态：开
{
  const { agent, restrictions } = makeAgent('s1')
  const result = call(agent, 'status')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /\[web:on\]/)
  assert.equal(restrictions.length, 0)
  console.log('1 初始状态=开 ok')
}

// 2. off 加上一次限制，回报 off
{
  const { agent, restrictions } = makeAgent('s1')
  const result = call(agent, 'off')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /\[web:off\]/)
  assert.equal(restrictions.length, 1)
  console.log('2 off 生效 ok')
}

// 3. 幂等：重复 off 不再 restrict
{
  const { agent, restrictions } = makeAgent('s1')
  call(agent, 'off')
  call(agent, 'off')
  call(agent, '')
  assert.equal(restrictions.length, 1, '重复关闭不应叠加限制')
  console.log('3 重复关闭幂等 ok')
}

// 4. on 撤销，且只撤销一次
{
  const { agent, restrictions, disposals } = makeAgent('s1')
  call(agent, 'off')
  const on = call(agent, 'on')
  assert.match(on.text, /\[web:on\]/)
  assert.equal(disposals.filter((item) => item === 'lifted').length, 1)
  call(agent, 'on')
  assert.equal(disposals.filter((item) => item === 'lifted').length, 1, '重复开启不应重复 dispose')
  assert.equal(restrictions.length, 1)
  console.log('4 on 撤销 ok')
}

// 5. 无参切换
{
  const { agent } = makeAgent('s1')
  assert.match(call(agent, '').text, /\[web:off\]/)
  assert.match(call(agent, '').text, /\[web:on\]/)
  console.log('5 无参切换 ok')
}

// 6. 轮次进行中拒绝，且不加限制
{
  const { agent, restrictions } = makeAgent('s1', { running: true })
  const result = call(agent, 'off')
  assert.equal(result.kind, 'error')
  assert.equal(restrictions.length, 0)
  console.log('6 运行中拒绝 ok')
}

// 7. 会话隔离：两条会话互不影响
{
  const a = makeAgent('sa')
  const b = makeAgent('sb')
  call(a.agent, 'off')
  assert.match(call(b.agent, 'status').text, /\[web:on\]/, '另一个会话不应被波及')
  assert.equal(b.restrictions.length, 0)
  console.log('7 会话隔离 ok')
}

// 8. 非法参数
{
  const { agent } = makeAgent('s1')
  assert.equal(call(agent, 'maybe').kind, 'error')
  console.log('8 参数校验 ok')
}

// 9. 会话销毁：撤销限制并清理记录
{
  const { agent, disposals } = makeAgent('s1')
  call(agent, 'off')
  const disposed = listeners.get('agent/disposed')
  assert.equal(typeof disposed, 'function', '应监听 agent/disposed')
  disposed({ agent })
  assert.deepEqual(disposals, ['lifted'])
  const another = makeAgent('s1')
  assert.match(call(another.agent, 'status').text, /\[web:on\]/, '销毁后记录应清空')
  console.log('9 销毁清理 ok')
}

// 10. pre-step：有标记时重建请求序列，消费后不再重复
{
  const preStep = listeners.get('agent/pre-step')
  assert.equal(typeof preStep, 'function', '应监听 agent/pre-step')
  const { agent } = makeAgent('s10')
  preStep.__armed = undefined
  call(agent, 'off')
  const payload = { agent, signal: { aborted: false } }
  const decision = { kind: 'enter', messages: [{ role: 'user' }] }
  const wrapped = await preStep(payload, async () => decision)
  assert.equal(wrapped.startsRequestSeries, true, '关掉后下一步应重建请求序列')
  const again = await preStep(payload, async () => decision)
  assert.equal(again.startsRequestSeries, undefined, '标记只消费一次')

  const { agent: running } = makeAgent('s11')
  call(running, 'off')
  const aborted = await preStep({ agent: running, signal: { aborted: true } }, async () => decision)
  assert.equal(aborted.startsRequestSeries, undefined, '被取消的步骤不消费标记')
  console.log('10 请求序列重建 ok')
}

// 11. 默认分类：联网工具隐藏，shell 与其余工具放行
{
  const { agent, restrictions } = makeAgent('s12')
  call(agent, 'off')
  const deny = new Set(restrictions[0].deny)
  for (const name of [
    'web_search',
    'web_fetch',
    'bsk_page',
    'bsk_session',
    'computer_ctrl',
    'mcp__snowluma__qq_send_message',
    'read_mcp_resource',
    'video_probe',
    'workbuddy_draw_image',
    'subagent',
    'subagent_fork',
    'send_message',
    'workflow',
    'plugin_manager',
    'schedule_create',
  ]) {
    assert.equal(deny.has(name), true, `默认应隐藏 ${name}`)
  }
  for (const name of ['ops_bash', 'ops_inspect_local_file', 'ops_glob', 'ops_grep', 'write', 'edit', 'todo_write', 'present', 'remember', 'schedule_list', 'read']) {
    assert.equal(deny.has(name), false, `默认不该隐藏 ${name}`)
  }
  assert.equal(deny.has('acp_cache'), false, '目录里没有的名字不会被塞进 deny')

  // 名单之外的默认是「检查」：留在工具表里，但每次调用看参数
  const shown = await call(agent, 'tools')
  const listed = JSON.parse(shown.text.slice(shown.text.indexOf('[web-tools]') + 11).split(' [web:')[0]).tools
  const row = (name) => listed.find((tool) => tool.name === name)
  assert.equal(row('write').mode, 'inspect', '没配置过的工具默认检查')
  assert.equal(row('working_directory').mode, 'inspect', '未分类的工具同样默认检查')
  assert.equal(row('web_search').mode, 'hide', '明确分类的仍然是隐藏')
  assert.equal(row('ops_bash').mode, 'inspect', 'shell 是检查')
  console.log('11 默认三态分类 ok')
}

// 12. 双用途工具（ops_bash）留着，但联网命令被 guard 拦下
{
  const { agent, guards, guardDisposals } = makeAgent('s13')
  call(agent, 'off')
  assert.equal(guards.length, 1, '关闭时应注册一个 guard')
  const guard = guards[0]
  const bash = (command) => guard({ name: 'ops_bash', arguments: { command } })

  for (const command of [
    'curl https://example.com',
    'wget http://x/y.zip',
    'git clone https://github.com/a/b',
    'pnpm add lodash',
    'pip install requests',
    'node -e "require(\'https\').get(...)"',
    'python -c "import urllib.request"',
    'ssh user@host',
    'Invoke-WebRequest http://x',
    'robocopy . \\\\server\\share /E',
    // 红队复现：Python 原生 socket/ssl
    `python -c "import socket;print(socket.gethostbyname('www.baidu.com'))"`,
    `python -c "import socket,ssl;s=socket.create_connection(('x',443),12)"`,
    `python -c "import ssl"`,
    // 红队复现：npm 取元数据/打包
    'npm view lodash version',
    'npm pack lodash --pack-destination .',
    'pnpm publish --dry-run',
    // 红队复现：PowerShell .NET WebClient，URL 拆段拼接
    `powershell -NoProfile -Command '$u="htt"+"ps"+"://x"; $c=New-Object Net.WebClient; $c.DownloadString($u)'`,
    'powershell -EncodedCommand ZgBvAG8A',
    // 编码载荷管道进 shell
    "echo aHR0cHM6Ly9leGFtcGxlLmNvbQ== | base64 -d | sh",
    // 其它联网子命令
    'git submodule update --init',
    'gh release list',
    'pip index versions requests',
  ]) {
    assert.equal(typeof bash(command), 'string', `应拦下：${command}`)
  }
  for (const command of [
    'ls -la',
    'node scripts/test.mjs',
    'git status',
    'git log --oneline -3',
    'git commit -m "fix docs"',
    'npm test',
    'npm run build',
    'pnpm build',
    'pnpm run build',
    'npm ls',
    'python -c "print(1+1)"',
    'python scripts/build.py',
    'rm -rf tmp/x',
    'cat package.json',
    "echo 'www.baidu.com'",
  ]) {
    assert.equal(bash(command), undefined, `不应拦下：${command}`)
  }
  assert.equal(guard({ name: 'write', arguments: { file_path: 'a' } }), undefined, '别的工具不受这个 guard 影响')

  // 拒绝原因要写成可执行指令，而不是只说"被拦了"
  const reason = bash('curl https://example.com')
  assert.ok(reason.includes('一切形式的联网工具'), '要说明本会话禁用一切联网工具')
  assert.ok(reason.includes('向用户说明'), '要给出出口：请用户暂时打开开关')
  assert.ok(reason.includes('不要写脚本'), '要明确禁止换通道绕过（写脚本/编码/子进程）')
  assert.ok(reason.includes('误判'), '要说明误判时的处理方式')
  const noCommand = guard({ name: 'ops_bash', arguments: {} })
  assert.ok(noCommand.includes('一切形式的联网工具'), '无命令文本的拒绝也要带同一条规则')
  assert.equal(typeof guard({ name: 'ops_bash', arguments: {} }), 'string', '没有可检查的命令时按保守处理拒绝')

  call(agent, 'on')
  assert.deepEqual(guardDisposals, ['registered', 'lifted'], '恢复时应撤销 guard')
  // —— 第二轮红队：引号拆分、脚本文件、npm run ——
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-toggle-'))
  const pkg = path.join(tmp, 'pkg')
  fs.mkdirSync(pkg)
  fs.writeFileSync(path.join(tmp, 'net.py'), "import socket\nprint(socket.gethostbyname('x'))\n")
  fs.writeFileSync(path.join(tmp, 'plain.py'), "print('local only')\n")
  fs.writeFileSync(path.join(tmp, 'plain.js'), "console.log('local only')\n")
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
    scripts: { deploy: 'curl https://example.com', build: 'node plain.js', dev: 'vite --host' },
  }))
  fs.writeFileSync(path.join(pkg, 'plain.js'), "console.log('local only')\n")

  // 引号拆分能被还原后命中
  assert.equal(typeof bash(`printf 'import so''cket\n' > ${path.join(tmp, 'x.py')}`), 'string', "so''cket 要能还原成 socket")
  assert.equal(typeof bash('echo "cur""l example"'), 'string', '"cur""l" 要能还原成 curl')
  // 写盘再执行：读脚本内容
  assert.equal(typeof bash(`python ${path.join(tmp, 'net.py')}`), 'string', '执行含 socket 的脚本要拦')
  assert.equal(bash(`python ${path.join(tmp, 'plain.py')}`), undefined, '纯本地脚本照常放行')
  assert.equal(bash(`node ${path.join(tmp, 'plain.js')}`), undefined, '纯本地 node 脚本照常放行')
  // npm run 的脚本体要看
  const runScript = (command) => guard({ name: 'ops_bash', arguments: { command, workdir: pkg } })
  assert.equal(typeof runScript('npm run deploy'), 'string', 'npm 脚本体里的 curl 要拦')
  assert.equal(typeof runScript('pnpm deploy'), 'string', 'pnpm 脚本体同样要拦')
  assert.equal(runScript('npm run build'), undefined, '本地 npm 脚本照常放行')
  assert.equal(runScript('npm run dev'), undefined, 'vite 之类本地脚本不受影响')

  // 加号拼接 / 动态导入 / 解码载荷
  assert.equal(typeof bash(`python -c "s=__import__('so'+'cket')"`), 'string', '加号拼接的模块名要还原')
  assert.equal(typeof bash(`python -c "import base64;exec(base64.b64decode('eA=='))"`), 'string', 'b64decode 包裹的载荷要拦')

  // —— 误判修复：asyncio、点分数字 ——
  assert.equal(bash(`python -c "import asyncio;print('ok')"`), undefined, 'asyncio 本身不该拦')
  assert.equal(bash(`python -c "print('1.2.3.4')"`), undefined, '点分数字不该当成 IP 拦')
  assert.equal(bash(`node -e "console.log('v1.2.3.4')"`), undefined, '版本号同样放行')
  assert.equal(typeof bash(`python -c "import asyncio;asyncio.open_connection('h',80)"`), 'string', 'asyncio.open_connection 仍要拦')

  console.log('12 shell 命令过滤 ok')
}

/** 从结果文本里取回机器可读状态；没有就说明半侧没按约定上报。 */
const toolsOf = (text) => {
  const matched = /\[web-tools\](\{[^\s]*\})/.exec(text)
  assert.ok(matched !== null, `结果要带 [web-tools]：${text}`)
  return JSON.parse(matched[1])
}

const stateOf = (text) => {
  const matched = /\[web-state\](\{.*\})\s*$/.exec(text)
  assert.ok(matched !== null, `结果要带 [web-state]：${text}`)
  return JSON.parse(matched[1])
}

/** 造一个带配置编辑器与 volatile 配置引用的 ctx（模拟运行时）。 */
function makeConfigCtx(initial = {}) {
  const { ctx, commands, listeners } = makeCtx()
  const values = {
    pluginPage: true,
    settingsSection: true,
    composerPanel: true,
    toolModes: {},
    sessionModes: {},
    offSessions: {},
    knownTools: [],
    lockAfterStart: true,
    startedSessions: {},
    debug: true,
    ...initial,
  }
  const writes = []
  ctx.get = (name) => (name === 'configEditor' ? {
    async edit(entry, update) {
      assert.equal(entry.options.id, 'web-toggle', '只编辑本插件自己的 profile 行')
      const next = update({
        ...values,
        toolModes: { ...values.toolModes },
        sessionModes: { ...values.sessionModes },
      })
      writes.push(next)
      Object.assign(values, next)
      return next
    },
  } : undefined)
  const config = Object.fromEntries(Object.keys(values).map((key) => [key, { get: () => values[key] }]))
  return { ctx, commands, listeners, values, writes, config }
}

// 13. 配置面：三个显示位置 + 白名单（本会话 / 全局）+ 状态上报
{
  const { ctx: configCtx, commands: configCommands, values, writes, config } = makeConfigCtx()
  apply(configCtx, config)
  const run = configCommands.get('webtoggle').handler
  const call2 = (agent, rawInput) => run({ agent, rawInput })
  const { agent } = makeAgent('c1')

  const initial = await call2(agent, 'status')
  assert.equal(stateOf(initial.text).surfaces.plugin, true, '默认三个入口都显示')
  assert.equal(stateOf(initial.text).writable, true, '有编辑器时可写')

  // 三个显示位置
  const hidden = await call2(agent, 'surface settings off')
  assert.equal(hidden.kind, 'success')
  assert.equal(values.settingsSection, false, 'surface settings off 要落到配置')
  assert.equal(stateOf(hidden.text).surfaces.settings, false, '结果要回报新状态')
  assert.equal(writes.length, 1, '一次点击只写一次配置')
  // 详情页是保底入口：永远开，拒绝关闭，并把理由说清楚
  const locked = await call2(agent, 'surface plugin off')
  assert.equal(locked.kind, 'success', '关闭详情页要给一句解释，而不是报错')
  assert.match(locked.text, /始终显示|always shown/, '要说清详情页不能关')
  assert.equal(values.pluginPage, true, 'pluginPage 不该被改')
  assert.equal(stateOf(locked.text).surfaces.plugin, true, '状态里详情页始终为开')
  await call2(agent, 'surface composer off')
  assert.deepEqual(
    [values.pluginPage, values.settingsSection, values.composerPanel],
    [true, false, false],
    '侧边栏与小箭头可以单独关闭，详情页保持开',
  )
  await call2(agent, 'surface composer on')
  assert.equal(values.composerPanel, true, '也能再打开')
  assert.equal((await call2(agent, 'surface nope on')).kind, 'error', '未知入口要报错')
  assert.equal((await call2(agent, 'surface settings')).kind, 'error', '缺 on/off 要报用法')

  // 工具模式：值与继承来的相同就不落盘，只记真正的偏离
  const hid = await call2(agent, 'mode read hide')
  assert.equal(hid.kind, 'success', `mode 应成功：${hid.text}`)
  assert.equal(values.sessionModes.c1.read, 'hide', '默认加到本会话')
  assert.equal(stateOf(hid.text).session.read, 'hide', '状态里要出现本会话的模式')
  // web_search 默认就是 hide：再写一次 hide 等于没改
  await call2(agent, 'mode web_search hide')
  assert.equal(values.sessionModes.c1.web_search, undefined, '和默认一致的值不落盘')
  const back = await call2(agent, 'mode web_search keep')
  assert.equal(values.sessionModes.c1.web_search, 'keep', '与默认不同才写')
  assert.equal(stateOf(back.text).session.web_search, 'keep', '状态要跟着变')
  // 目录里没有的名字照样记下，但要明确提醒
  const typo = await call2(agent, 'mode nope hide')
  assert.equal(typo.kind, 'success', '未知名字不该硬拒绝')
  assert.ok(typo.text.includes('这个目录里没有 nope'), '要提示名字可能写错')
  await call2(agent, 'mode nope keep')

  // 全局层
  const sessionBefore = { ...values.sessionModes.c1 }
  const globalMode = await call2(agent, 'mode write hide --global')
  assert.equal(globalMode.kind, 'success', `全局改模式应成功：${globalMode.text}`)
  assert.equal(values.toolModes.write, 'hide', '--global 落到全局层')
  assert.deepEqual(stateOf(globalMode.text).global, values.toolModes, '状态里要出现全局层')
  assert.deepEqual(values.sessionModes.c1, sessionBefore, '全局改动不该污染本会话')

  // 交还上一层
  await call2(agent, 'mode reset')
  assert.equal(values.sessionModes.c1, undefined, 'reset 删掉本会话那一层')
  await call2(agent, 'mode reset --global')
  assert.deepEqual(values.toolModes, {}, '清空全局层')

  // 旧写法仍是别名
  const legacy = await call2(agent, 'keep web_search on')
  assert.equal(legacy.kind, 'success', `keep on 旧写法应兼容：${legacy.text}`)
  assert.equal(values.sessionModes.c1.web_search, 'keep', 'on 等价于 keep')
  await call2(agent, 'allow add workflow')
  assert.equal(values.sessionModes.c1.workflow, 'keep', 'allow add 等价于 keep')
  await call2(agent, 'allow remove workflow')
  assert.equal(values.sessionModes.c1.workflow, undefined, 'allow remove 等价于回到默认')

  const described = await call2(agent, 'config')
  assert.match(described.text, /pluginPage=/, 'config 要能读出当前开关')
  assert.match(described.text, /隐藏 \d+ 个/, 'config 要说清当前分类')

  // 配置缺失（没有 configEditor）时要明说，不能假装保存成功
  const { ctx: bareCtx, commands: bareCommands } = makeCtx()
  const bareValues = { pluginPage: true, settingsSection: true, composerPanel: true, toolModes: {}, sessionModes: {}, debug: true }
  const bareConfig = Object.fromEntries(Object.keys(bareValues).map((key) => [key, { get: () => bareValues[key] }]))
  apply(bareCtx, bareConfig)
  const bare = (agentRef, rawInput) => bareCommands.get('webtoggle').handler({ agent: agentRef, rawInput })
  const refused = await bare(agent, 'surface settings off')
  assert.equal(refused.kind, 'error', '没有编辑器时不能报成功')
  assert.match(refused.text, /没有配置文件可写/, '要说清是 profile 不可写')
  assert.equal(stateOf(refused.text).writable, false, '状态要如实报告不可写')
  console.log('13 配置面（显示位置 / 白名单 / 无编辑器） ok')
}

// 14. 模式改动要立刻作用到已经断网的会话；正在执行的会话跳过
{
  const { ctx: configCtx, commands: configCommands, values, config } = makeConfigCtx()
  apply(configCtx, config)
  const run = configCommands.get('webtoggle').handler
  const call2 = (agentRef, rawInput) => run({ agent: agentRef, rawInput })
  const { agent, restrictions, disposals, guards } = makeAgent('c2')

  await call2(agent, 'off')
  assert.equal(restrictions.length, 1)
  assert.ok(!restrictions[0].deny.includes('ops_bash'), 'shell 默认是内容检查，不该被藏起来')
  assert.ok(restrictions[0].deny.includes('web_search'), '联网工具默认隐藏')

  await call2(agent, 'mode read hide')
  assert.equal(restrictions.length, 2, '改模式后要重新下发一次')
  assert.ok(restrictions[1].deny.includes('read'), '新名单要包含刚隐藏的工具')
  assert.ok(disposals.includes('lifted'), '旧限制要撤销，避免层层叠加')

  // 把 shell 改成「保留」：其它工具仍是检查，所以 guard 还要重装一份
  const before = guards.length
  await call2(agent, 'mode ops_bash keep')
  assert.ok(guards.length > before, '还有别的工具要检查，guard 要跟着重装')
  assert.equal(typeof guards.at(-1)({ agent, name: 'ops_bash', arguments: { command: 'curl https://a.b' } }), 'undefined', 'shell 改成保留后不再拦命令')

  // 「调用时拒绝」：连参数都不看，一律拒
  await call2(agent, 'mode ops_bash refuse')
  assert.equal(typeof guards.at(-1)({ agent, name: 'ops_bash', arguments: { command: 'echo hi' } }), 'string', '调用时拒绝不看参数，直接拒')

  // 参数扫描：非 shell 工具的参数里有 URL 也要拦
  const readGuard = guards.at(-1)
  assert.equal(typeof readGuard({ agent, name: 'read_image', arguments: { file_path: 'https://example.com/a.png' } }), 'string', '检查模式要扫参数')
  assert.equal(readGuard({ agent, name: 'read_image', arguments: { file_path: 'D:/a.png' } }), undefined, '本地路径照常放行')

  await call2(agent, 'mode ops_bash inspect')
  const afterShell = restrictions.length

  // 正在执行时不能改动这一轮的工具表：只存配置，跳过下发
  agent.status = 'running'
  const skipped = await call2(agent, 'mode write hide')
  assert.equal(restrictions.length, afterShell, '执行中不重新下发')
  assert.equal(values.sessionModes.c2.write, 'hide', '配置仍要保存')
  assert.match(skipped.text, /跳过 1/, '要如实说明跳过了几个会话')

  // 下一轮结束后再切换一次，新配置就位
  agent.status = 'idle'
  await call2(agent, 'on')
  await call2(agent, 'off')
  assert.ok(restrictions.at(-1).deny.includes('write'), '恢复后再断网要带上新设置')
  await call2(agent, 'on')
  console.log('14 模式改动即时生效 / 执行中跳过 ok')
}

// 15. 工具目录：列出全部工具并给出模式，可逐个改（会话 / 全局两层）
{
  const { ctx: configCtx, commands: configCommands, values, config } = makeConfigCtx()
  apply(configCtx, config)
  const run = configCommands.get('webtoggle').handler
  const call3 = (agentRef, rawInput) => run({ agent: agentRef, rawInput })
  const { agent } = makeAgent('c15')
  const entry = (catalogue, name) => catalogue.tools.find((tool) => tool.name === name)

  const listed = await call3(agent, 'tools')
  assert.equal(listed.kind, 'success', `tools 应成功：${listed.text}`)
  const catalogue = toolsOf(listed.text)
  const names = catalogue.tools.map((tool) => tool.name)
  assert.deepEqual(names, [...names].sort(), '目录按名字排序')
  assert.ok(names.includes('web_search'), '目录要包含联网工具')
  assert.equal(entry(catalogue, 'web_search').mode, 'hide', '联网工具默认隐藏')
  assert.equal(entry(catalogue, 'ops_bash').mode, 'inspect', 'shell 默认内容检查')
  assert.equal(entry(catalogue, 'write').mode, 'inspect', '没配置过的工具默认检查')
  assert.equal(entry(catalogue, 'ops_bash').builtIn, true, '默认分类里的工具要带标记')
  assert.equal(entry(catalogue, 'write').builtIn, false, '默认检查的工具不算内置项')

  const kept = await call3(agent, 'mode web_search keep')
  assert.equal(kept.kind, 'success', `mode keep 应成功：${kept.text}`)
  assert.equal(entry(toolsOf(kept.text), 'web_search').mode, 'keep', '改完目录立即变化')
  assert.equal(values.sessionModes.c15.web_search, 'keep', '落盘到 sessionModes')

  const refused = await call3(agent, 'mode write refuse')
  assert.equal(refused.kind, 'success', `refuse 应成功：${refused.text}`)
  assert.equal(entry(toolsOf(refused.text), 'write').mode, 'refuse', '目录要认第四态')

  const dropped = await call3(agent, 'mode ops_bash hide')
  assert.equal(entry(toolsOf(dropped.text), 'ops_bash').mode, 'hide', '内置项也能改')

  const reset = await call3(agent, 'mode reset')
  assert.equal(values.sessionModes.c15, undefined, 'reset 交还上一层（不留空对象）')
  assert.equal(entry(toolsOf(reset.text), 'web_search').mode, 'hide', '回到默认分类')

  const globalMode = await call3(agent, 'mode write hide --global')
  assert.equal(values.toolModes.write, 'hide', '--global 写全局层')
  assert.equal(entry(toolsOf(globalMode.text), 'write').mode, 'hide', '全局层立刻生效')

  // 配置里写过的名字即使没注册也要列出来，用户才能看见并改回去
  const unknown = await call3(agent, 'mode nope hide')
  assert.ok(toolsOf(unknown.text).tools.some((tool) => tool.name === 'nope'), '配置里的名字仍要列出')
  assert.match(unknown.text, /这个目录里没有 nope/, '要提醒名字可能写错')
  await call3(agent, 'mode reset')

  // 断网时改的模式要立刻生效：deny 里不该再有 web_search
  const { agent: live, restrictions } = makeAgent('c16')
  await call3(live, 'off')
  await call3(live, 'mode web_search keep')
  assert.equal(restrictions.length, 2, '改模式要重新下发')
  assert.ok(!restrictions.at(-1).deny.includes('web_search'), '改成保留后不该再被隐藏')
  await call3(live, 'on')
  console.log('15 工具目录 / 三态模式（会话、全局、即时生效） ok')
}

// 16. 默认模式：成功回执只写一句人话，机器标记只在读命令和 debug 模式里出现
{
  const { ctx: plainCtx, commands: plainCommands } = makeCtx()
  // 默认模式也要能存配置：挂一个只改内存的编辑器，debug 保持关闭。
  const plainValues = { pluginPage: true, settingsSection: true, composerPanel: true, toolModes: {}, sessionModes: {} }
  const plainConfig = Object.fromEntries(Object.keys(plainValues).map((key) => [key, { get: () => plainValues[key] }]))
  plainCtx.get = (name) =>
    name === 'configEditor' ? { async edit(entry, update) { Object.assign(plainValues, update({ ...plainValues })) } } : undefined
  apply(plainCtx, plainConfig)
  const plain = plainCommands.get('webtoggle').handler
  const run = (agentRef, rawInput) => plain({ agent: agentRef, rawInput })

  const { agent, restrictions } = makeAgent('d1')
  const status = await run(agent, 'status')
  assert.equal(status.kind, 'success')
  assert.ok(!status.text.includes('[web-state]'), '默认模式不该把状态 JSON 塞进聊天')
  assert.ok(!status.text.includes('[web:'), '默认模式不该带开关标记')

  const off = await run(agent, 'off')
  assert.equal(off.kind, 'success')
  assert.match(off.text, /已断网/, '仍要说清做了什么')
  assert.ok(!off.text.includes('[web-state]'), '开关回执不带 JSON')
  assert.equal(restrictions.length, 1, '限制照常下发')

  // 目录默认不写进聊天：只回一句数量，面板靠缓存画；要机器可读的那份得显式 --json。
  const quietTools = await run(agent, 'tools')
  assert.match(quietTools.text, /个可用工具/, '默认也要说清有多少个')
  assert.ok(!quietTools.text.includes('[web-tools]'), '默认不带目录 JSON')
  assert.ok(!quietTools.text.includes('[web-state]'), '默认不带状态 JSON')

  const tools = await run(agent, 'tools --json')
  assert.match(tools.text, /\[web-tools\]/, '--json 才附机器可读的目录')
  assert.match(tools.text, /\[web-state\]/, '--json 时带状态')
  assert.equal(stateOf(tools.text).off, true)
  const rowOf = (name) => toolsOf(tools.text).tools.find((tool) => tool.name === name)
  assert.equal(rowOf('ops_bash').mode, 'inspect', 'shell 标成内容检查')
  assert.equal(rowOf('web_search').mode, 'hide', '联网工具标成隐藏')

  // 编辑类命令在默认模式里不带目录：界面自己知道自己改了什么。
  const kept = await run(agent, 'keep web_search on')
  assert.equal(kept.kind, 'success')
  assert.ok(!kept.text.includes('[web-tools]'), '默认模式不刷目录')
  assert.ok(!kept.text.includes('[web-state]'), '默认模式不刷状态')

  // 错误照常完整打印，而且默认模式也不塞 JSON。
  const bad = await run(agent, 'surface nope on')
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /unknown surface/, '错误文案保留')
  assert.ok(!bad.text.includes('[web-state]'), '错误回执默认不带 JSON')

  // 打开 debug 之后，同一批命令恢复带机器标记。
  const { ctx: debugCtx, commands: debugCommands } = makeCtx()
  apply(debugCtx, { debug: { get: () => true } })
  const verbose = debugCommands.get('webtoggle').handler
  const { agent: verboseAgent } = makeAgent('d2')
  const loud = await verbose({ agent: verboseAgent, rawInput: 'off' })
  assert.match(loud.text, /\[web:off\]/, 'debug 模式带开关标记')
  assert.match(loud.text, /\[web-state\]\{/, 'debug 模式带状态 JSON')
  const loudError = await verbose({ agent: verboseAgent, rawInput: 'surface nope on' })
  assert.equal(loudError.kind, 'error')
  assert.match(loudError.text, /\[web-state\]/, 'debug 模式的错误也带状态，便于贴出来')
  console.log('16 默认回执安静 / debug 才带机器标记 ok')
}

// 17. 配置即状态：面板写进 offSessions 的开关，在下一轮请求前自动落到工具表上
{
  // 这一组专门测「配置推着运行时走」，所以把「开始后锁开关」关掉：锁着的话下面的
  // 「配置改回联网」本来就该被拒，那是第 18 组的事。
  const { ctx: configCtx, listeners: configListeners, values, config } = makeConfigCtx({ offSessions: { cfg1: true }, lockAfterStart: false })
  apply(configCtx, config)
  const preStep = configListeners.get('agent/pre-step')
  assert.equal(typeof preStep, 'function', '应监听 agent/pre-step')
  const { agent, restrictions, disposals } = makeAgent('cfg1')
  const decision = { kind: 'enter', messages: [{ role: 'user' }] }
  const step = () => preStep({ agent, signal: { aborted: false } }, async () => decision)

  // 配置说这个会话断网：不等任何人敲命令，开轮前就要把限制装上。
  const first = await step()
  assert.equal(restrictions.length, 1, '配置里的 off 要变成真的限制')
  assert.ok(restrictions[0].deny.includes('web_search'), '限制内容按模式算')
  assert.equal(first.startsRequestSeries, true, '工具表变了就要重建请求序列')

  // 下一轮：已经一致，不重复下发、也不重建。
  const second = await step()
  assert.equal(restrictions.length, 1, '状态一致时不重复下发')
  assert.equal(second.startsRequestSeries, undefined, '没有变化就不重建序列')

  // 配置改回联网：下一轮撤掉限制。
  values.offSessions = {}
  await step()
  assert.ok(disposals.includes('lifted'), '配置改回 on 时要撤掉限制')

  // 顺带把目录记进配置，面板读它画列表；不变时不重复写。
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(Array.isArray(values.knownTools) && values.knownTools.includes('web_search'), '目录要记进配置')
  console.log('17 配置即状态（自动下发 / 自动撤销） ok')
}

// 18. 会话开始后：开关默认上锁；解锁后「隐藏」自动降级成「调用时拒绝」（保住缓存）
{
  const { ctx: lockCtx, commands: lockCommands, listeners: lockListeners, values, config } = makeConfigCtx()
  apply(lockCtx, config)
  const run = lockCommands.get('webtoggle').handler
  const preStep = lockListeners.get('agent/pre-step')
  const decision = { kind: 'enter', messages: [{ role: 'user' }] }
  const tick = () => new Promise((resolve) => setImmediate(resolve))

  // 还没开始的会话：开关照常能切（用一个独立的 agent，免得和下面那轮互相影响）。
  const fresh = makeAgent('lk0')
  const early = await run({ agent: fresh.agent, rawInput: 'off' })
  assert.equal(early.kind, 'success', '第一轮之前可以切')
  await tick()

  // 跑完一轮：这个 Session 就算「已经开始」，并记进配置。
  const { agent, restrictions, guards } = makeAgent('lk1')
  const step = () => preStep({ agent, signal: { aborted: false } }, async () => decision)
  await step()
  await tick()
  assert.equal(values.startedSessions.lk1, true, '轮次一开始就要记下会话已开始')

  // 默认锁着：命令拒绝，runtime 不动。
  const locked = await run({ agent, rawInput: 'off' })
  assert.equal(locked.kind, 'error', '已开始的会话默认不允许切开关')
  assert.match(locked.text, /已锁定|locked/, '错误里要说清是锁住了')
  assert.equal(restrictions.length, 0, '被拒绝时不该装限制')

  // 面板绕开命令直接写配置：pre-step 也不认，并把配置改回运行时真值。
  values.offSessions = { lk1: true }
  await step()
  await tick()
  assert.equal(restrictions.length, 0, '锁着时配置写进来的 off 不该生效')
  assert.equal(values.offSessions.lk1, undefined, '配置要恢复成运行时的样子，面板才不会撒谎')

  // 在设置里解锁：之后允许在已开始的会话里切，但「隐藏」降级为「调用时拒绝」。
  const unlocked = await run({ agent, rawInput: 'lock off' })
  assert.equal(unlocked.kind, 'success', 'lock off 应能保存')
  assert.equal(values.lockAfterStart, false)
  const after = await run({ agent, rawInput: 'off' })
  assert.equal(after.kind, 'success', '解锁后可以切')
  assert.equal(restrictions.length, 0, '已开始的会话不再用 deny 改工具表')
  assert.equal(guards.length, 1, '改用 guard 在调用时拒绝')
  assert.match((await run({ agent, rawInput: 'status' })).text, /\[web:off\]/, '状态仍是断网')

  console.log('18 开始后锁开关 / 隐藏降级为运行时拒绝 ok')
}

console.log('\n全部通过')
