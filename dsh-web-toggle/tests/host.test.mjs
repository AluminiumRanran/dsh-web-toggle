/**
 * 离线验证 Host 半侧（index.js）的状态机，不依赖真实 DSH：
 * 用假的 ctx / agent 跑一遍开关、幂等、轮次拒绝、参数校验与销毁清理。
 * 用法：node tests/host.test.mjs
 */
import assert from 'node:assert/strict'
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
  for (const name of ['ops_inspect_local_file', 'ops_glob', 'ops_grep', 'write', 'edit', 'todo_write', 'present', 'remember']) {
    assert.equal(allow.has(name), true, `断网后应保留本地工具 ${name}`)
  }
  assert.equal(allow.has('read'), false, '未列入白名单的工具默认隐藏（fail closed）')
  assert.equal(allow.has('acp_cache'), false, '目录里没有的名字应被过滤，而不是让 restrict 抛错')
  assert.equal(allow.has('schedule_list'), true, '只读的计划查询属于本地工具')
  assert.equal(allow.has('ops_bash'), false, '严格断网连 shell 一起隐藏')
  console.log('11 白名单内容 ok')
}

// 12. 双用途工具（ops_bash）留着，但联网命令被 guard 拦下
{
  const { agent, guards, guardDisposals, restrictions } = makeAgent('s13')
  call(agent, 'local')
  assert.equal(guards.length, 1, '宽松断网应注册一个 guard')
  assert.equal(restrictions.length, 1)
  assert.ok(restrictions[0].allow.includes('ops_bash'), '宽松断网保留 shell')
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
  ]) {
    assert.equal(typeof bash(command), 'string', `应拦下：${command}`)
  }
  for (const command of ['ls -la', 'node scripts/test.mjs', 'git status', 'npm test', 'python -c "print(1+1)"', 'rm -rf tmp/x', 'cat package.json']) {
    assert.equal(bash(command), undefined, `不应拦下：${command}`)
  }
  assert.equal(guard({ name: 'write', arguments: { file_path: 'a' } }), undefined, '别的工具不受这个 guard 影响')
  assert.equal(typeof guard({ name: 'ops_bash', arguments: {} }), 'string', '没有可检查的命令时按保守处理拒绝')

  call(agent, 'on')
  assert.deepEqual(guardDisposals, ['registered', 'lifted'], '恢复时应撤销 guard')
  console.log('12 shell 命令过滤 ok')
}

// 13. 两种断网模式：strict 不注册 guard，local 才注册；strict ⇄ local 会重挂遮罩
{
  const { agent, guards } = makeAgent('s14')
  const strict = call(agent, 'off')
  assert.match(strict.text, /\[web:off\]/, 'strict 标记为 [web:off]')
  assert.equal(guards.length, 0, 'strict 不注册 guard（shell 已隐藏）')

  const relaxed = call(agent, 'local')
  assert.match(relaxed.text, /\[web:local\]/, 'local 标记为 [web:local]')
  assert.equal(guards.length, 1, 'local 注册 guard')

  const again = call(agent, 'local')
  assert.equal(again.text.includes('没有重复加限制'), true, '重复 local 幂等')
  assert.equal(guards.length, 1)

  const back = call(agent, 'off')
  assert.match(back.text, /\[web:off\]/, '可以从 local 切回 strict')
  const on = call(agent, 'on')
  assert.match(on.text, /\[web:on\]/, '恢复联网')
  console.log('13 两种断网模式 ok')
}

console.log('\n全部通过')
