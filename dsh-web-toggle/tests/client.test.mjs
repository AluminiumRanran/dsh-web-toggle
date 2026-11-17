/**
 * 离线验证 Browser 半侧（client.js）：用极简的 React 打桩 + 假的 ctx/remote，
 * 检查槽位注册、亮灭两态渲染、点击后发出的命令、以及各类失败提示。
 * 这不是浏览器，只保证组件逻辑与命令线格式正确。
 * 用法：node tests/client.test.mjs
 */
import assert from 'node:assert/strict'

// ---- 浏览器环境打桩 --------------------------------------------------------
const storages = new Map()
globalThis.localStorage = {
  getItem: (key) => (storages.has(key) ? storages.get(key) : null),
  setItem: (key, value) => storages.set(key, String(value)),
  removeItem: (key) => storages.delete(key),
}
// 探针用的 0ms 定时器只入队，由 flushTimers() 手动执行，避免测试里冒出意料之外的第二次命令。
let timers = []
globalThis.window = {
  setTimeout: (fn) => {
    timers.push(fn)
    return timers.length
  },
  clearTimeout: () => {},
}
/** 执行所有排队中的定时器（挂载探针就在这里面）。 */
const flushTimers = () => {
  const pending = timers
  timers = []
  for (const fn of pending) fn()
}

// ---- 极简 React 打桩 ------------------------------------------------------
// 真实环境里 client.js 的 factory 只在页面加载时执行一次，之后切会话是组件重挂载。
// 所以这里：factory 只跑一次（模块级缓存共享），每次 mount 只换一套 hook 池。
const makePool = () => {
  const values = new Map()
  const effects = new Map()
  let cursor = 0
  return {
    begin() {
      cursor = 0
    },
    useState(initial) {
      const index = cursor++
      if (!values.has(index)) values.set(index, typeof initial === 'function' ? initial() : initial)
      return [values.get(index), (next) => values.set(index, typeof next === 'function' ? next(values.get(index)) : next)]
    },
    useRef(initial) {
      const index = cursor++
      if (!values.has(index)) values.set(index, { current: initial })
      return values.get(index)
    },
    useEffect(run, deps) {
      const index = cursor++
      const previous = effects.get(index)
      const unchanged =
        previous !== undefined &&
        deps !== undefined &&
        previous.deps !== undefined &&
        previous.deps.length === deps.length &&
        deps.every((item, at) => Object.is(item, previous.deps[at]))
      if (unchanged) return
      effects.set(index, { deps })
      run()
    },
  }
}
let currentPool
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => currentPool.useState(initial),
  useRef: (initial) => currentPool.useRef(initial),
  useEffect: (run, deps) => currentPool.useEffect(run, deps),
}

// ---- 载入 client.js（只用它交给 ModuleLoader 的描述） ---------------------
let loadedModule
globalThis.window.__ModuleLoader__ = {
  load(definition) {
    loadedModule = definition
  },
}
await import('../client.js')
assert.ok(loadedModule !== undefined, 'client.js 应调用 __ModuleLoader__.load')
assert.equal(loadedModule.id, 'dsh-web-toggle', '浏览器模块 id 必须等于包名')

// —— 页面级单例：factory 一次、apply 一次，等价于同一个页面活到测试结束 ——
const page = (() => {
  const moduleExports = loadedModule.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  assert.deepEqual(moduleExports.inject, ['slots', 'locale', 'remote', 'remote.commands'])

  const dictionary = {}
  const state = { slot: undefined, component: undefined, remote: undefined, effects: [] }
  const ctx = {
    locale: {
      register(namespace, localeOrDicts, dict) {
        assert.equal(namespace, 'web-toggle')
        // 真实接口：register(ns, 'zh', {...}) 或 register(ns, { en: {...}, zh: {...} })
        if (typeof localeOrDicts === 'string') {
          Object.assign(dictionary, dict)
          return
        }
        for (const [locale, entries] of Object.entries(localeOrDicts)) {
          assert.ok(['en', 'zh'].includes(locale), `意外的 locale：${locale}`)
          Object.assign(dictionary, entries)
        }
      },
      bind() {
        return (key) => dictionary[key] ?? key
      },
    },
    slots: {
      inject(name, factory) {
        assert.equal(name, 'conversation.input.left')
        factory()
      },
      register(definition, component) {
        state.slot = definition
        state.component = component
        return () => {}
      },
    },
    effect(run, label) {
      state.effects.push(label)
      return run()
    },
    get(name) {
      return name === 'remote' ? state.remote : undefined
    },
  }
  moduleExports.apply(ctx)
  const t = (key) => dictionary[key] ?? key
  return { state, dictionary, t }
})()

/**
 * 挂载一次组件实例：新的 hook 池，会话 id 可变。
 * 模块级状态（已探过的会话等）与 page 单例一起跨 mount 保留，正好模拟切走再切回。
 */
function mount(sessionId = 'session-a') {
  currentPool = makePool()
  const render = (props) => {
    currentPool.begin()
    return page.state.component({
      t: page.t,
      sessionId,
      useSessions: (selector) => selector({ byId: {} }),
      ...props,
    })
  }
  return { state: page.state, dictionary: page.dictionary, render, t: page.t }
}
/** 一个回固定结果的假 remote，同时记录每次调用。 */
const stubRemote = (calls, text) => ({
  commands: {
    execute: async (...args) => {
      calls.push(args)
      return { ok: true, value: { result: { kind: 'success', text } } }
    },
  },
})

// ---- 1. 默认渲染：亮着 -----------------------------------------------------
{
  storages.clear()
  const { render, t } = mount('s1')
  const tree = render({})
  const button = tree.children[0]
  assert.equal(tree.props['data-off'], 'false')
  assert.equal(button.props['aria-pressed'], 'true')
  assert.equal(button.props.title, t('title.on'))
  assert.equal(tree.children[1], null, '初始不应有提示')
  console.log('1 默认亮态渲染 ok')
}

// ---- 2. 槽位定义与样式表 ---------------------------------------------------
{
  const { state, t } = mount('s2')
  assert.equal(state.slot.name, 'conversation.input.left')
  assert.equal(state.slot.id, 'web-toggle')
  assert.equal(state.slot.locale, 'web-toggle')
  assert.equal(state.slot.order, 11)
  assert.equal(typeof state.slot.label(), 'string')
  assert.ok(t('label') !== 'label', '运行期字典应已注册')
  assert.ok(state.effects.some((label) => String(label).includes('stylesheet')))
  console.log('2 槽位与样式注册 ok')
}

// ---- 3. 点一次：发 off，灭态 + 提示，并记住 ------------------------------
{
  storages.clear()
  const { state, render, dictionary } = mount('s3')
  const calls = []
  state.remote = stubRemote(calls, '联网工具已关闭 [web:off]')
  let tree = render({})
  tree.children[0].props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 3, 'execute 应带三个 wire 参数')
  assert.deepEqual(calls[0].slice(0, 2), ['s3', '/webtoggle off'])
  tree = render({})
  assert.equal(tree.props['data-off'], 'true')
  assert.equal(tree.children[0].props['aria-pressed'], 'false')
  assert.equal(globalThis.localStorage.getItem('dsh-web-toggle:off:s3'), '1', '应记住 off')
  assert.equal(tree.children[1].props['data-kind'], 'ok')
  assert.equal(tree.children[1].children[0], dictionary['note.off'])
  console.log('3 关闭流程 ok')
}

// ---- 4. 记住 off 后重新挂载：显示灭态、探针只发一次、宿主确认时不出提示 --
{
  storages.clear()
  globalThis.localStorage.setItem('dsh-web-toggle:off:s4', '1')
  const calls = []
  const first = mount('s4')
  first.state.remote = stubRemote(calls, '本来就是关闭的 [web:off]')
  let tree = first.render({})
  assert.equal(tree.props['data-off'], 'true', '应读回记住的状态')
  flushTimers()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.length, 1, '挂载应只探一次')
  assert.equal(calls[0][1], '/webtoggle status')
  tree = first.render({})
  assert.equal(tree.props['data-off'], 'true')
  assert.equal(tree.children[1], null, '宿主确认仍是关闭时不应弹提示（切来切去不再重复出现）')

  // 再点一次 → on
  const onCalls = []
  first.state.remote = stubRemote(onCalls, '联网工具已恢复 [web:on]')
  tree.children[0].props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(onCalls[0][1], '/webtoggle on')
  tree = first.render({})
  assert.equal(tree.props['data-off'], 'false')
  assert.equal(globalThis.localStorage.getItem('dsh-web-toggle:off:s4'), null)
  console.log('4 重新挂载与恢复 ok')
}

// ---- 5. 切走再切回：不重发 status、不再弹提示 ---------------------------
{
  storages.clear()
  globalThis.localStorage.setItem('dsh-web-toggle:off:s5', '1')
  const firstCalls = []
  const first = mount('s5')
  first.state.remote = stubRemote(firstCalls, '本来就是关闭的 [web:off]')
  first.render({})
  flushTimers()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(firstCalls.length, 1)

  // 模拟切到别的会话再切回来：组件重新挂载，模块级缓存还在
  const secondCalls = []
  const second = mount('s5')
  second.state.remote = stubRemote(secondCalls, '本来就是关闭的 [web:off]')
  const tree = second.render({})
  flushTimers()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(secondCalls.length, 0, '同一页面内不应重复探测')
  assert.equal(tree.props['data-off'], 'true')
  assert.equal(tree.children[1], null, '不应再次弹提示')
  console.log('5 切走切回不重复提示 ok')
}

// ---- 6. 轮次进行中：按钮禁用、点了也不发命令 -----------------------------
{
  storages.clear()
  const { state, render, t } = mount('s6')
  let called = 0
  state.remote = { commands: { execute: async () => (called++, { ok: true, value: { result: { kind: 'success', text: '[web:on]' } } }) } }
  const tree = render({ useSessions: (selector) => selector({ byId: { s6: { running: true } } }) })
  assert.equal(tree.children[0].props.disabled, true)
  assert.equal(tree.children[0].props.title, t('title.running'))
  assert.equal(called, 0)
  console.log('6 运行中禁用 ok')
}

// ---- 7. 失败分支 ---------------------------------------------------------
{
  storages.clear()
  const { state, render, t } = mount('s7')

  // 7.1 没有 remote
  state.remote = undefined
  let tree = render({})
  tree.children[0].props.onClick()
  await Promise.resolve()
  tree = render({})
  assert.equal(tree.children[1].props['data-kind'], 'error')
  assert.equal(tree.children[1].children[0], t('error.noRemote'))

  // 7.2 命令未注册（value undefined）
  state.remote = { commands: { execute: async () => ({ ok: true, value: undefined }) } }
  tree = render({})
  tree.children[0].props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  tree = render({})
  assert.equal(tree.children[1].children[0], t('error.commandMissing'))

  // 7.3 Remote 失败
  state.remote = { commands: { execute: async () => ({ ok: false, error: { message: 'socket closed' } }) } }
  tree = render({})
  tree.children[0].props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  tree = render({})
  assert.match(tree.children[1].children[0], /socket closed/)

  // 7.4 Host 明确拒绝：原文展示，状态不变
  state.remote = {
    commands: {
      execute: async () => ({ ok: true, value: { result: { kind: 'error', text: '当前任务正在执行，等这一轮结束后再切换联网开关' } } }),
    },
  }
  tree = render({})
  tree.children[0].props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  tree = render({})
  assert.equal(tree.children[1].children[0], '当前任务正在执行，等这一轮结束后再切换联网开关')
  assert.equal(tree.props['data-off'], 'false', '被拒绝时状态不变')
  console.log('7 失败分支 ok')
}

// ---- 8. 挂载探针：记住 off 但宿主已重置 → 纠正成亮态并提示 -------------
{
  storages.clear()
  globalThis.localStorage.setItem('dsh-web-toggle:off:s8', '1')
  const { state, render, t } = mount('s8')
  const calls = []
  state.remote = stubRemote(calls, '本来就是开启的 [web:on]')
  let tree = render({})
  flushTimers()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], '/webtoggle status')
  assert.equal(globalThis.localStorage.getItem('dsh-web-toggle:off:s8'), null, '应把记忆纠正成 on')
  tree = render({})
  assert.equal(tree.props['data-off'], 'false')
  assert.equal(tree.children[1].props['data-kind'], 'ok')
  assert.equal(tree.children[1].children[0], t('note.syncedOn'))
  console.log('8 挂载探针纠正 ok')
}

console.log('\n全部通过')
