/**
 * 离线验证 Browser 半侧（client.js）：用极简的 React 打桩 + 假 ctx/remote，
 * 检查三个入口的槽位注册、亮灭两态渲染、点击后发出的命令、浮层面板与配置页，
 * 以及各类失败提示。这不是浏览器，只保证组件逻辑与命令线格式正确。
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
// 探针与提示用的定时器只入队，由 flushTimers() 手动执行，避免测试里冒出意料之外的第二次命令。
let timers = []
globalThis.window = {
  setTimeout: (fn) => {
    timers.push(fn)
    return timers.length
  },
  clearTimeout: () => {},
  innerWidth: 1200,
  innerHeight: 900,
  addEventListener: () => {},
  removeEventListener: () => {},
}
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: () => {} },
}
/** 执行所有排队中的定时器（挂载探针、提示自动消失都在这里面）。 */
const flushTimers = () => {
  const pending = timers
  timers = []
  for (const fn of pending) fn()
}

/** 让所有排队中的微任务跑完（假 remote 的 await 链有好几跳）。 */
const settle = () => new Promise((resolve) => globalThis.setTimeout(resolve, 0))

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
      const cleanup = run()
      if (typeof cleanup === 'function') effects.set(index + 10000, { deps, cleanup })
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
  assert.deepEqual(moduleExports.inject, ['slots', 'locale', 'remote', 'remote.commands', 'remote.settings'])

  const dictionary = {}
  const state = { slots: {}, remote: undefined, effects: [], sessions: undefined }
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
        assert.ok(typeof name === 'string' && name.length > 0, 'inject 需要槽位名')
        // 真实 inject 返回 factory 的结果（即槽位的卸载函数），effect 把它当成清理逻辑。
        return factory()
      },
      register(definition, component) {
        state.slots[definition.name] = { definition, component }
        // 真实的 slots.register 返回卸载函数：入口关闭后槽位必须真的消失。
        return () => {
          if (state.slots[definition.name]?.component === component) delete state.slots[definition.name]
        }
      },
    },
    effect(run, label) {
      state.effects.push(label)
      return run()
    },
    get(name) {
      if (name === 'remote') return state.remote
      if (name === 'sessions') return state.sessions
      return undefined
    },
  }
  moduleExports.apply(ctx)
  const t = (key) => dictionary[key] ?? key
  return { state, dictionary, t }
})()

/** 输入框那个组件的类型（其余两个页面从 slots 里另取）。 */
const composer = page.state.slots['conversation.input.left']
assert.ok(composer !== undefined, '应注册 conversation.input.left')
assert.equal(composer.definition.id, 'web-toggle')
assert.equal(composer.definition.order, 11)

/**
 * 挂载一次组件实例：新的 hook 池，会话 id 可变。
 * 模块级状态（已探过的会话等）与 page 单例一起跨 mount 保留，正好模拟切走再切回。
 */
function mount(sessionId = 'session-a') {
  currentPool = makePool()
  const render = (props = {}) => {
    currentPool.begin()
    return expand(
      composer.component({
        t: page.t,
        sessionId,
        useSessions: (selector) => selector({ byId: {} }),
        ...props,
      }),
    )
  }
  return { state: page.state, dictionary: page.dictionary, render, t: page.t }
}

/** 挂载一次配置页（设置页 / 插件详情页）。 */
function mountPage(name, props) {
  currentPool = makePool()
  const slot = page.state.slots[name]
  assert.ok(slot !== undefined, `应注册 ${name}`)
  const render = (next = {}) => {
    currentPool.begin()
    return expand(slot.component({ t: page.t, ...props, ...next }))
  }
  return { render, t: page.t, definition: slot.definition }
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

/**
 * 一个走配置线的假宿主：`describe` 报当前状态，`mutate` 记下 ops 并改状态。
 * 面板上的一切点击都该走这条线，`calls` 里绝不该出现命令。
 */
function stubSettings(calls, options = {}) {
  const state = { off: options.off === true, writable: options.writable !== false, revision: 1 }
  const sessionId = options.sessionId ?? 's1'
  const namespaces = () => (options.namespaces !== undefined ? options.namespaces : [{
    ns: 'web-toggle',
    value: {
      pluginPage: true,
      settingsSection: true,
      composerPanel: true,
      toolModes: {},
      sessionModes: {},
      offSessions: state.off ? { [sessionId]: true } : {},
    },
    user: {},
    revision: state.revision,
    writable: state.writable,
    applies: 'live',
  }])
  return {
    state,
    remote: {
      settings: {
        describe: async () => {
          if (options.describeError !== undefined) return { ok: false, error: { message: options.describeError } }
          return { ok: true, value: { writable: state.writable, hasDocument: true, namespaces: namespaces() } }
        },
        mutate: async (ns, ops) => {
          if (options.mutateError !== undefined) return { ok: false, error: { message: options.mutateError } }
          calls.push(ops)
          for (const op of ops) if (op.path[0] === 'offSessions') state.off = op.op === 'set' && op.value === true
          state.revision += 1
          return { ok: true, value: {} }
        },
      },
      commands: {
        execute: async () => {
          throw new Error('按钮不该走命令线')
        },
      },
    },
  }
}

/**
 * 一个有状态的假宿主：**走配置线**（`remote.settings.describe/mutate`），和插件现在的做法一致。
 * `state.ops` 记录每次写进去的 ops，`state.calls` 只会因为命令线被用到而变长——按钮绝不该碰它。
 */
function fakeHost(initial = {}) {
  const state = {
    off: false,
    surfaces: { plugin: true, settings: true, composer: true },
    // 两层「工具名 -> 模式」覆盖表，和宿主那边一样。
    global: {},
    session: {},
    writable: true,
    ...initial,
  }
  state.ops = []
  state.commands = []
  state.describes = 0
  state.revision = 1
  // 面板画出来的目录，以及插件自带的默认模式。
  const CATALOGUE = ['bash', 'grep', 'ops_bash', 'read', 'web_fetch', 'web_search', 'write']
  const DEFAULT_MODES = { ops_bash: 'inspect', web_fetch: 'hide', web_search: 'hide' }
  const modeIn = (name) => state.session[name] ?? state.global[name] ?? DEFAULT_MODES[name] ?? 'inspect'
  const catalogue = () => ({
    tools: [...CATALOGUE].sort().map((name) => ({ name, mode: modeIn(name), builtIn: DEFAULT_MODES[name] !== undefined })),
  })
  const value = () => {
    const offSessions = {}
    if (state.off) offSessions.s1 = true
    return {
      pluginPage: true,
      settingsSection: state.surfaces.settings,
      composerPanel: state.surfaces.composer,
      debug: false,
      toolModes: { ...state.global },
      sessionModes: Object.keys(state.session).length === 0 ? {} : { s1: { ...state.session } },
      knownTools: [...CATALOGUE].sort(),
      offSessions,
    }
  }
  const applyOps = (ops) => {
    state.ops.push(ops)
    for (const op of ops) {
      const path = op.path.join('/')
      if (path === 'composerPanel') state.surfaces.composer = op.value === true
      else if (path === 'settingsSection') state.surfaces.settings = op.value === true
      else if (path.startsWith('offSessions/')) state.off = op.value === true
      else if (path.startsWith('toolModes/')) {
        const name = op.path[1]
        if (op.op === 'set') state.global[name] = op.value
        else delete state.global[name]
      } else if (path.startsWith('sessionModes/')) {
        if (op.op === 'unset' && op.path.length === 2) for (const key of Object.keys(state.session)) delete state.session[key]
        else if (op.path.length === 3) {
          const name = op.path[2]
          if (op.op === 'set') state.session[name] = op.value
          else delete state.session[name]
        }
      }
    }
    state.revision += 1
  }
  const view = () => ({
    off: state.off,
    surfaces: { ...state.surfaces, plugin: true },
    global: { ...state.global },
    session: { ...state.session },
    writable: state.writable,
  })
  return {
    state,
    view,
    catalogue,
    remote: {
      settings: {
        describe: async (...args) => {
          // 真实内核按声明校验参数个数：settings/describe 是零参数，多传一个就报
          // 「expected 0 argument(s), got 1」，所以这里照抄，防止再写出带参数的调用。
          if (args.length > 0) throw new Error(`client api: settings/describe expected 0 argument(s), got ${args.length}`)
          state.describes += 1
          return {
            ok: true,
            value: {
              writable: state.writable,
              hasDocument: true,
              namespaces: [{ ns: 'web-toggle', value: value(), user: {}, revision: state.revision, writable: state.writable, applies: 'live' }],
            },
          }
        },
        mutate: async (ns, ops) => {
          if (ns !== 'web-toggle') return { ok: false, error: { message: 'unknown namespace' } }
          applyOps(ops)
          return { ok: true, value: {} }
        },
      },
      commands: {
        execute: async (sessionId, line) => {
          state.commands.push([sessionId, line])
          return { ok: true, value: { result: { kind: 'success', text: 'ok' } } }
        },
      },
    },
  }
}

// ---- 树查询小工具 ---------------------------------------------------------
/** 深度优先找出所有 className 命中的元素。 */
function queryAll(node, className, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(className)) out.push(node)
  for (const child of node.children ?? []) queryAll(child, className, out)
  return out
}
/** 一个元素的全部文本。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  return (node.children ?? []).map(textOf).join('')
}
/** 找到文本命中的按钮（面板里的操作按钮）。 */
function buttonWith(node, text) {
  return queryAll(node, 'dswt-btn').find((button) => textOf(button).trim() === text)
}
/** 最近一次写进配置的 ops（读目录不算写，所以不会出现在这里）。 */
const lastOps = (host) => host.state.ops.at(-1) ?? []
/** 最近一次 ops 里有没有动过这个字段。 */
const touched = (host, field) => JSON.stringify(lastOps(host)).includes(`"${field}"`)
/**
 * 兼容旧断言的助手：`/webtoggle mode web_search hide` 这种写法翻译成
 * 「最近一次 ops 里有没有出现这几个词」。按钮一律走配置线，命令线只留给读目录。
 */
const lastCommand = (host, expected) => {
  if (expected === undefined) return JSON.stringify(lastOps(host))
  const text = JSON.stringify(lastOps(host))
  const words = expected.replace(/^\/webtoggle\s+/, '').split(/\s+/).filter(Boolean)
  const [head, ...rest] = words
  if (head === 'tools') return lastOps(host).length === 0
  if (head === 'off' || head === 'on') return text.includes('"offSessions"')
  if (head === 'surface') return text.includes(`"${SURFACE_FIELD_OF[rest[0]] ?? rest[0]}"`)
  if (head === 'mode') {
    // 与继承值相同的模式写回时是 unset（配置里只留真正的偏离）。
    return lastOps(host).some((op) => op.path.includes(rest[0]) && (op.op === 'unset' || op.value === rest[1]))
  }
  return rest.every((word) => text.includes(`"${word}"`))
}
const SURFACE_FIELD_OF = { plugin: 'pluginPage', settings: 'settingsSection', composer: 'composerPanel' }

/** 面板里名字为 name 的那一行工具。 */
const toolRow = (tree, name) => queryAll(tree, 'dswt-tool').find((row) => queryAll(row, 'dswt-tool-name')[0]?.children?.[0] === name)

/** 工具行里的提示（可能不存在）。 */
function noteOf(tree) {
  return queryAll(tree, 'dswt-note')[0]
}

/**
 * 展开函数组件：真实 React 会执行子组件，这里手动调用，和父组件共用同一套 hook 池
 * （子组件总是在父组件所有 hook 之后渲染，索引对得上）。
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    return expand(node.type(node.props))
  }
  node.children = (node.children ?? []).map(expand)
  return node
}

// ---- 1. 默认渲染：亮着 -----------------------------------------------------
{
  storages.clear()
  const { render, t } = mount('s1')
  const tree = render()
  assert.equal(tree.props['data-off'], 'false')
  const trigger = queryAll(tree, 'dswt-trigger')[0]
  assert.equal(trigger.props['aria-pressed'], 'true')
  assert.equal(trigger.props.title, t('title.on'))
  assert.equal(noteOf(tree), undefined, '初始不应有提示')
  console.log('1 默认亮态渲染 ok')
}

// ---- 2. 三个槽位与样式表 ---------------------------------------------------
{
  storages.clear()
  const { state, t } = mount('s2')
  assert.equal(state.slots['conversation.input.left'].definition.locale, 'web-toggle')
  assert.equal(typeof state.slots['conversation.input.left'].definition.label(), 'string')

  const settings = state.slots['settings.section']
  assert.ok(settings !== undefined, '应注册 settings.section')
  assert.equal(settings.definition.id, 'web-toggle')
  assert.equal(typeof settings.definition.label(), 'string')
  assert.equal(settings.definition.label(), t('settings.title'))

  const detail = state.slots['plugins.detail.section']
  assert.ok(detail !== undefined, '应注册 plugins.detail.section')
  assert.equal(detail.definition.id, 'web-toggle')

  // 侧边栏图标必须挂在同名 id 上，否则壳会退回它自己的齿轮图标。
  const icon = state.slots['settings.section.icon']
  assert.ok(icon !== undefined, '应注册 settings.section.icon')
  assert.equal(icon.definition.id, 'web-toggle')
  const glyph = icon.component({ size: 16, active: true })
  assert.equal(glyph.type, 'span')
  assert.equal(glyph.props.className, 'dswt-navicon')

  assert.ok(t('label') !== 'label', '运行期字典应已注册')
  assert.ok(state.effects.some((label) => String(label).includes('stylesheet')))
  console.log('2 三个槽位与样式注册 ok')
}

// ---- 3. 点一次：写进配置，灭态 + 提示，并记住 ---------------------------
{
  storages.clear()
  const { state, render, dictionary } = mount('s3')
  const calls = []
  const host = stubSettings(calls, { sessionId: 's3' })
  state.remote = host.remote
  let tree = render()
  queryAll(tree, 'dswt-trigger')[0].props.onClick()
  await settle()
  assert.deepEqual(calls, [[{ op: 'set', path: ['offSessions', 's3'], value: true }]], '按钮应只写配置')
  assert.equal(host.state.commands, undefined, '按钮不该碰命令线')
  tree = render()
  assert.equal(tree.props['data-off'], 'true')
  assert.equal(globalThis.localStorage.getItem('dsh-web-toggle:off:s3'), '1', '应记住 off')
  assert.equal(noteOf(tree).props['data-kind'], 'ok')
  assert.equal(textOf(noteOf(tree)), dictionary['note.off'])
  console.log('3 关闭流程 ok')
}

// ---- 4. 记住 off 后重新挂载：显示灭态、探针只读一次、宿主确认时不出提示 --
{
  storages.clear()
  globalThis.localStorage.setItem('dsh-web-toggle:off:s4', '1')
  const calls = []
  const first = mount('s4')
  const host = stubSettings(calls, { off: true, sessionId: 's4' })
  first.state.remote = host.remote
  let tree = first.render()
  assert.equal(tree.props['data-off'], 'true', '应读回记住的状态')
  flushTimers()
  await settle()
  assert.equal(calls.length, 0, '探针只读配置，不写')
  tree = first.render()
  assert.equal(tree.props['data-off'], 'true')
  assert.equal(noteOf(tree), undefined, '宿主确认仍是关闭时不应弹提示（切来切去不再重复出现）')

  // 再点一次 → on
  queryAll(tree, 'dswt-trigger')[0].props.onClick()
  await settle()
  assert.deepEqual(calls.at(-1), [{ op: 'unset', path: ['offSessions', 's4'] }])
  tree = first.render()
  assert.equal(tree.props['data-off'], 'false')
  assert.equal(globalThis.localStorage.getItem('dsh-web-toggle:off:s4'), null)
  console.log('4 重新挂载与恢复 ok')
}

// ---- 5. 切走再切回：不重复读配置、不再弹提示 ---------------------------
{
  storages.clear()
  globalThis.localStorage.setItem('dsh-web-toggle:off:s5', '1')
  const first = mount('s5')
  const host = stubSettings([], { off: true, sessionId: 's5' })
  first.state.remote = host.remote
  first.render()
  flushTimers()
  await settle()
  assert.equal(host.state.revision, 1, '探针不该写配置')

  // 模拟切到别的会话再切回来：组件重新挂载，模块级缓存还在
  let describes = 0
  const watched = { ...host.remote, settings: { ...host.remote.settings, describe: async () => (describes++, host.remote.settings.describe()) } }
  const second = mount('s5')
  second.state.remote = watched
  const tree = second.render()
  flushTimers()
  await settle()
  assert.equal(describes, 0, '同一页面内不应重复探测')
  assert.equal(tree.props['data-off'], 'true')
  assert.equal(noteOf(tree), undefined, '不应再次弹提示')
  console.log('5 切走切回不重复提示 ok')
}

// ---- 6. 轮次进行中：按钮禁用、点了也不发命令 -----------------------------
{
  storages.clear()
  const { state, render, t } = mount('s6')
  let called = 0
  state.remote = { commands: { execute: async () => (called++, { ok: true, value: { result: { kind: 'success', text: '[web:on]' } } }) } }
  const tree = render({ useSessions: (selector) => selector({ byId: { s6: { running: true } } }) })
  const trigger = queryAll(tree, 'dswt-trigger')[0]
  assert.equal(trigger.props.disabled, true)
  assert.equal(trigger.props.title, t('title.running'))
  assert.equal(called, 0)
  console.log('6 运行中禁用 ok')
}

// ---- 7. 失败分支 --------------------------------------------------------
{
  storages.clear()
  const { state, render, t } = mount('s7')

  // 7.1 没有 remote
  state.remote = undefined
  let tree = render()
  queryAll(tree, 'dswt-trigger')[0].props.onClick()
  await settle()
  tree = render()
  assert.equal(noteOf(tree).props['data-kind'], 'error')
  assert.equal(textOf(noteOf(tree)), t('error.noRemote'))

  // 7.2 配置里没有本插件那一行
  state.remote = stubSettings([], { namespaces: [] }).remote
  tree = render()
  queryAll(tree, 'dswt-trigger')[0].props.onClick()
  await settle()
  tree = render()
  assert.equal(textOf(noteOf(tree)), t('error.noConfig'))

  // 7.3 读配置就失败
  state.remote = stubSettings([], { describeError: 'socket closed' }).remote
  tree = render()
  queryAll(tree, 'dswt-trigger')[0].props.onClick()
  await settle()
  tree = render()
  assert.match(textOf(noteOf(tree)), /socket closed/)

  // 7.4 宿主拒绝写入：原文展示，状态不变
  state.remote = stubSettings([], { mutateError: '当前任务正在执行，等这一轮结束后再切换联网开关' }).remote
  tree = render()
  queryAll(tree, 'dswt-trigger')[0].props.onClick()
  await settle()
  tree = render()
  assert.match(textOf(noteOf(tree)), /当前任务正在执行，等这一轮结束后再切换联网开关/)
  assert.equal(tree.props['data-off'], 'false', '被拒绝时状态不变')
  console.log('7 失败分支 ok')
}

// ---- 8. 挂载探针：记住 off 但宿主已重置 → 纠正成亮态并提示 -------------
{
  storages.clear()
  globalThis.localStorage.setItem('dsh-web-toggle:off:s8', '1')
  const { state, render, t } = mount('s8')
  // 宿主那边是开的：配置里没有这个会话的 off 记录。
  state.remote = stubSettings([], { off: false, sessionId: 's8' }).remote
  let tree = render()
  flushTimers()
  await settle()
  assert.equal(globalThis.localStorage.getItem('dsh-web-toggle:off:s8'), null, '应把记忆纠正成 on')
  tree = render()
  assert.equal(tree.props['data-off'], 'false')
  assert.equal(noteOf(tree).props['data-kind'], 'ok')
  assert.equal(textOf(noteOf(tree)), t('note.syncedOn'))
  console.log('8 挂载探针纠正 ok')
}

// ---- 9. 小箭头：点开面板、逐个开关工具 -------------------------
{
  storages.clear()
  const host = fakeHost()
  const { state, render, t } = mount('s9')
  state.remote = host.remote
  let tree = render()
  const caret = queryAll(tree, 'dswt-caret')[0]
  assert.ok(caret !== undefined, '应画出小箭头')
  assert.equal(caret.props['aria-expanded'], 'false')
  caret.props.onClick()
  await settle()
  assert.equal(host.state.describes >= 1, true, '打开时要读一次配置/目录')
  assert.equal(host.state.commands.length, 0, '打开面板不该发命令：缓存命中就只画缓存')
  tree = render()
  tree = render()
  tree = render()
  const panels = queryAll(tree, 'dswt-panel')
  assert.equal(panels.length, 1, '应画出面板')
  assert.equal(panels[0].props['data-inline'], 'false')

  // 面板上的「断网」
  buttonWith(tree, t('panel.switchOff')).props.onClick()
  await settle()
  assert.ok(lastCommand(host, '/webtoggle off'), '面板里的开关也走命令线')
  tree = render()
  assert.equal(tree.props['data-off'], 'true', '面板操作也应更新开关')

  // 目录里每个工具一行开关：点一下就把 web_search 收进本会话名单
  tree = render()
  tree = render()
  const row = toolRow(tree, 'web_search')
  assert.ok(row !== undefined, '目录里应有 web_search 这一行')
  const toggle = queryAll(row, 'dswt-btn')[0]
  assert.equal(toggle.props['data-mode'], 'hide', '默认是隐藏')
  toggle.props.onClick()
  await settle()
  assert.ok(lastCommand(host, '/webtoggle mode web_search inspect'), '点一下切到下一种模式')
  assert.equal(host.state.session.web_search, 'inspect', '宿主那边的模式要变')
  tree = render()
  tree = render()
  assert.equal(queryAll(toolRow(tree, 'web_search'), 'dswt-btn')[0].props['data-mode'], 'inspect', '回执后按钮要跟着变')

  // 再点：检查 -> 调用时拒绝
  queryAll(toolRow(tree, 'web_search'), 'dswt-btn')[0].props.onClick()
  await settle()
  assert.ok(lastCommand(host, '/webtoggle mode web_search refuse'), 'ops=' + JSON.stringify(host.state.ops.at(-1)))
  assert.equal(host.state.session.web_search, 'refuse')
  tree = render()
  tree = render()
  assert.equal(queryAll(toolRow(tree, 'web_search'), 'dswt-btn')[0].props['data-mode'], 'refuse', '第四态要有自己的 data-mode')
  assert.equal(textOf(queryAll(toolRow(tree, 'web_search'), 'dswt-btn')[0]), t('panel.mode.refuse'), '按钮要写出当前模式')

  // 再点：调用时拒绝 -> 放行
  queryAll(toolRow(tree, 'web_search'), 'dswt-btn')[0].props.onClick()
  await settle()
  assert.ok(lastCommand(host, '/webtoggle mode web_search keep'))
  assert.equal(host.state.session.web_search, 'keep')
  tree = render()
  tree = render()
  assert.equal(queryAll(toolRow(tree, 'web_search'), 'dswt-btn')[0].props['data-mode'], 'keep')
  assert.equal(textOf(queryAll(toolRow(tree, 'web_search'), 'dswt-btn')[0]), t('panel.mode.keep'), '按钮要写出当前模式')

  // 第四次：回到拒绝（隐藏），循环闭合
  queryAll(toolRow(tree, 'web_search'), 'dswt-btn')[0].props.onClick()
  await settle()
  assert.ok(lastCommand(host, '/webtoggle mode web_search hide'))

  // 筛选框只影响列表，不发命令
  const before = host.state.ops.length
  const filter = queryAll(tree, 'dswt-input').find((input) => input.props.placeholder === t('panel.filter'))
  filter.props.onChange({ target: { value: 'web' } })
  tree = render()
  assert.equal(queryAll(tree, 'dswt-tool').length, 2, '只剩两个 web_* 工具')
  assert.equal(host.state.ops.length, before, '筛选不该惊动宿主')
  filter.props.onChange({ target: { value: 'zzz' } })
  tree = render()
  assert.equal(queryAll(tree, 'dswt-tool').length, 0)
  assert.equal(textOf(queryAll(tree, 'dswt-hint').find((hint) => textOf(hint) === t('panel.noTools'))), t('panel.noTools'))
  console.log('9 浮层面板与工具开关 ok')
}

// ---- 10. 小箭头按配置隐藏 ------------------------------------------------
{
  storages.clear()
  const host = fakeHost({ surfaces: { plugin: true, settings: true, composer: false } })
  const { state, render } = mount('s10')
  state.remote = host.remote
  let tree = render()
  assert.ok(queryAll(tree, 'dswt-caret').length === 1, '状态未知时先按显示处理')
  // 打开一次会取回宿主状态，之后按配置收起
  queryAll(tree, 'dswt-caret')[0].props.onClick()
  await settle()
  tree = render()
  tree = render()
  assert.equal(queryAll(tree, 'dswt-caret').length, 0, '配置关掉小箭头后不应再画')
  assert.equal(queryAll(tree, 'dswt-trigger').length, 1, '开关本身不受影响')
  console.log('10 小箭头按配置隐藏 ok')
}

// ---- 11. 设置页：全局面板，改的是配置而不是本会话状态 --------------------
{
  storages.clear()
  const host = fakeHost({ global: { read: 'keep', grep: 'keep' } })
  page.state.remote = host.remote
  const { render, t } = mountPage('settings.section')
  let tree = render()
  await settle()
  tree = render()
  tree = render()
  assert.ok(lastCommand(host, '/webtoggle tools --json'), '页面挂载时只取一次目录')
  assert.equal(host.state.commands.length, 0, '页面挂载不该发命令')
  const panels = queryAll(tree, 'dswt-panel')
  assert.equal(panels.length, 1)
  assert.equal(panels[0].props['data-inline'], 'true', '页面里的面板应是内联的')
  assert.equal(queryAll(toolRow(tree, 'read'), 'dswt-btn')[0].props['data-mode'], 'keep', '应显示全局保留的工具')
  assert.equal(queryAll(toolRow(tree, 'web_search'), 'dswt-btn')[0].props['data-mode'], 'hide', '联网工具要显示为隐藏')
  assert.equal(buttonWith(tree, t('panel.switchOff')), undefined, '全局面板不显示本会话开关')

  // 点「隐藏」改设置页自身
  const row = queryAll(tree, 'dswt-row').find((item) => textOf(item).includes(t('panel.surface.settings')))
  assert.ok(row !== undefined, '应有设置页那一行')
  buttonWith(row, t('panel.hide')).props.onClick()
  await settle()
  assert.ok(lastCommand(host, '/webtoggle surface settings off'))
  tree = render()
  assert.equal(tree, null, '关掉之后这个页面自己也不画了')

  // 换个入口把它重新打开：输入框面板底部的三行开关里点「显示」
  const reopened = fakeHost({ global: { ops_bash: 'keep' } })
  page.state.remote = reopened.remote
  const composerAgain = mount('s11')
  let composerTree = composerAgain.render()
  queryAll(composerTree, 'dswt-caret')[0].props.onClick()
  await settle()
  composerTree = composerAgain.render()
  composerTree = composerAgain.render()
  const settingsRow = queryAll(composerTree, 'dswt-row').find((item) => textOf(item).includes(t('panel.surface.settings')))
  assert.ok(settingsRow !== undefined, '输入框面板里也要有这一行')
  buttonWith(settingsRow, t('panel.show')).props.onClick()
  await settle()
  assert.ok(lastCommand(reopened, '/webtoggle surface settings on'), '从别处把设置页装回来')
  const again = mountPage('settings.section')
  let pageTree = again.render()
  await settle()
  pageTree = again.render()
  pageTree = pageTree
  assert.equal(queryAll(pageTree, 'dswt-panel').length, 1, '配置允许时应画回来')

  // 全局长名单：点一下 bash 就写进 globalTools（命令带 --global）
  const bashRow = toolRow(pageTree, 'bash')
  assert.ok(bashRow !== undefined, '目录里应有 bash: ' + JSON.stringify(queryAll(pageTree, 'dswt-tool').map((r) => textOf(r))) + ' cache=' + String(globalThis.localStorage.getItem('dsh-web-toggle:catalogue')).slice(0, 120))
  assert.equal(queryAll(bashRow, 'dswt-btn')[0].props['data-mode'], 'inspect', '没配置过的工具默认检查')
  queryAll(bashRow, 'dswt-btn')[0].props.onClick()
  await settle()
  assert.ok(lastCommand(reopened, '/webtoggle mode bash refuse --global'), '全局面板要带 --global')
  assert.equal(reopened.state.global.bash, 'refuse')
  console.log('11 设置页面板 ok')
}

// ---- 12. 插件详情页：只认自己的包 ---------------------------------------
{
  storages.clear()
  const host = fakeHost()
  page.state.remote = host.remote
  const { render } = mountPage('plugins.detail.section', { subject: { kind: 'bundle', pkg: { name: 'some-other-plugin' } } })
  assert.equal(render(), null, '别的插件的详情页不画')

  const mine = mountPage('plugins.detail.section', { subject: { kind: 'bundle', pkg: { name: 'dsh-web-toggle' } } })
  await settle()
  const tree = mine.render()
  assert.ok(queryAll(tree, 'dswt-panel').length === 1, '自己的详情页应画面板')
  console.log('12 详情页只认自己的包 ok')
}

// ---- 13. 配置页拿不到会话时如实说明 -------------------------------------
{
  storages.clear()
  page.state.remote = fakeHost().remote
  // 把模块级「最后会话」清掉：先把它写成空再看页面
  globalThis.localStorage.removeItem('dsh-web-toggle:last-session')
  // 用插件详情页：它是常驻入口，不受「设置页被关掉」影响。
  const { render, t } = mountPage('plugins.detail.section', { subject: { kind: 'bundle', pkg: { name: 'dsh-web-toggle' } } })
  let tree = render()
  await settle()
  tree = render()
  // 之前用例里挂过 composer，模块级 lastSessionId 还在，所以这里应能正常画；
  // 断掉 remote 才轮到错误提示。
  page.state.remote = undefined
  // 目录缓存会让页面直接画出来、根本不去连宿主；要测失败提示得先清掉它。
  globalThis.localStorage.removeItem('dsh-web-toggle:catalogue')
  const broken = mountPage('plugins.detail.section', { subject: { kind: 'bundle', pkg: { name: 'dsh-web-toggle' } } })
  tree = broken.render()
  await settle()
  tree = broken.render()
  assert.equal(textOf(queryAll(tree, 'dswt-error')[0]), t('error.noRemote'))
  console.log('13 配置页失败提示 ok')
}

// ---- 14. 关掉一个入口＝真的卸载槽位，详情页永远在 -----------------------
{
  storages.clear()
  const host = fakeHost({ surfaces: { plugin: true, settings: true, composer: false } })
  page.state.remote = host.remote
  const instance = mount('s14')
  let tree = instance.render()
  assert.ok(queryAll(tree, 'dswt-trigger').length === 1, '状态未知时先按显示处理')
  // 取回宿主状态后，输入框的槽位应当整条卸载（不只是内容变空）
  queryAll(tree, 'dswt-caret')[0].props.onClick()
  await settle()
  assert.equal(page.state.slots['conversation.input.left'], undefined, '关掉后整个槽位要卸载')
  assert.ok(page.state.slots['plugins.detail.section'] !== undefined, '详情页是保底入口，永远在')
  assert.ok(page.state.slots['settings.section'] !== undefined, '设置页仍在')

  // 从设置页把它重新打开：槽位要装回来
  const settingsPage = mountPage('settings.section')
  tree = settingsPage.render()
  await settle()
  tree = settingsPage.render()
  tree = settingsPage.render()
  const row = queryAll(tree, 'dswt-row').find((item) => textOf(item).includes(page.t('panel.surface.composer')))
  assert.ok(row !== undefined, '设置页应能改小箭头的显示')
  buttonWith(row, page.t('panel.show')).props.onClick()
  await settle()
  assert.ok(page.state.slots['conversation.input.left'] !== undefined, '打开后槽位要回来')
  console.log('14 入口真卸载 / 详情页常开 ok')
}

console.log('\n全部通过')
