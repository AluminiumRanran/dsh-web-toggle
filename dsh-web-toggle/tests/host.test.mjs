/**
 * 离线验证 Host 半侧（index.js）的状态机，不依赖真实 DSH：
 * 用假的 ctx / agent 跑一遍开关、幂等、轮次拒绝、参数校验与销毁清理。
 * 用法：node tests/host.test.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

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
  const agent = {
    status: running ? 'running' : 'idle',
    session: { id },
    ctx: {
      tools: {
        restrict(filter) {
          assert.deepEqual([...filter.deny], ['web_search', 'web_fetch'])
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
  return { agent, restrictions, disposals }
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

console.log('\n全部通过')
