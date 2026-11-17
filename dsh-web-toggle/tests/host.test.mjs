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
  // 未列入白名单的本地工具：必须一并隐藏（fail closed）
  'read',
])

/** 造一个能被 apply 接受的 ctx，并记录注册过的命令与监听器。 */
function makeCtx() {
  const commands = new Map()
  const listeners = new Map()
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
      view: () => ({ restrictableNames: CATALOG }),
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
  }
  return { ctx, commands, listeners }
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
          // 关闭 = 白名单：只给 allow，不给 deny。
          assert.equal(filter.deny, undefined, '关闭应使用 allow 白名单，而不是 deny 少数工具')
          assert.ok(Array.isArray(filter.allow) && filter.allow.length > 0, 'allow 不能为空')
          for (const name of filter.allow) {
            assert.ok(CATALOG.has(name), `allow 里出现了目录中没有的工具：${name}`)
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
apply(ctx)
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

// 11. 白名单内容：本地工具留下，能出网的一律隐藏，目录里没有的名字被过滤
{
  const { agent, restrictions } = makeAgent('s12')
  call(agent, 'off')
  const allow = new Set(restrictions[0].allow)
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
    assert.equal(allow.has(name), false, `断网后不应保留 ${name}`)
  }
  for (const name of ['ops_bash', 'ops_inspect_local_file', 'ops_glob', 'ops_grep', 'write', 'edit', 'todo_write', 'present', 'remember']) {
    assert.equal(allow.has(name), true, `断网后应保留本地工具 ${name}`)
  }
  assert.equal(allow.has('read'), false, '未列入白名单的工具默认隐藏（fail closed）')
  assert.equal(allow.has('acp_cache'), false, '目录里没有的名字应被过滤，而不是让 restrict 抛错')
  assert.equal(allow.has('schedule_list'), true, '只读的计划查询属于本地工具')
  console.log('11 白名单内容 ok')
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

console.log('\n全部通过')
