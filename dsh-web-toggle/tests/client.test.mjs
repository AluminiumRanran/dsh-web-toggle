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
  assert.deepEqual(moduleExports.inject, ['slots', 'locale', 'remote', 'remote.commands'])

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
        factory()
      },
      register(definition, component) {
        state.slots[definition.name] = { definition, component }
        return () => {}
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
 * 一个有状态的假宿主：照着 `/webtoggle` 的文法改状态，然后回带标记与状态 JSON 的文本。
 * 用它才能验证「面板上的操作会落到宿主、并且界面跟着回执更新」这条链路。
 */
function fakeHost(initial = {}) {
  const state = {
    off: false,
    surfaces: { plugin: true, settings: true, composer: true },
    global: [],
    session: [],
    writable: true,
    ...initial,
  }
  state.calls = []
  const push = (list, name) => {
    if (!list.includes(name)) list.push(name)
  }
  const drop = (list, name) => {
    const at = list.indexOf(name)
    if (at >= 0) list.splice(at, 1)
  }
  const apply = (line) => {
    const words = line.replace(/^\/webtoggle\s*/, '').trim().split(/\s+/)
    const [head, ...rest] = words
    if (head === 'off') state.off = true
    else if (head === 'on') state.off = false
    else if (head === 'surface') state.surfaces[rest[0]] = rest[1] === 'on'
    else if (head === 'allow') {
      const verb = rest[0]
      const global = rest.includes('--global')
      const list = global ? state.global : state.session
      const name = rest.find((word) => word !== '--global' && word !== verb)
      if (verb === 'add' && name !== undefined) push(list, name)
      else if (verb === 'remove' && name !== undefined) drop(list, name)
      else if (verb === 'clear') list.length = 0
    }
  }
  const view = () => ({
    off: state.off,
    surfaces: { ...state.surfaces },
    global: [...state.global],
    session: [...state.session],
    writable: state.writable,
  })
  return {
    state,
    view,
    remote: {
      commands: {
        execute: async (sessionId, line) => {
          state.calls.push([sessionId, line])
          apply(line)
          const marker = `[web:${state.off ? 'off' : 'on'}]`
          return { ok: true, value: { result: { kind: 'success', text: `ok ${marker} [web-state]${JSON.stringify(view())}` } } }
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

// ---- 3. 点一次：发 off，灭态 + 提示，并记住 ------------------------------
{
  storages.clear()
  const { state, render, dictionary } = mount('s3')
  const calls = []
  state.remote = stubRemote(calls, '联网工具已关闭 [web:off]')
  let tree = render()
  queryAll(tree, 'dswt-trigger')[0].props.onClick()
  await settle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 3, 'execute 应带三个 wire 参数')
  assert.deepEqual(calls[0].slice(0, 2), ['s3', '/webtoggle off'])
  tree = render()
  assert.equal(tree.props['data-off'], 'true')
  assert.equal(globalThis.localStorage.getItem('dsh-web-toggle:off:s3'), '1', '应记住 off')
  assert.equal(noteOf(tree).props['data-kind'], 'ok')
  assert.equal(textOf(noteOf(tree)), dictionary['note.off'])
  console.log('3 关闭流程 ok')
}

// ---- 4. 记住 off 后重新挂载：显示灭态、探针只发一次、宿主确认时不出提示 --
{
  storages.clear()
  globalThis.localStorage.setItem('dsh-web-toggle:off:s4', '1')
  const calls = []
  const first = mount('s4')
  first.state.remote = stubRemote(calls, '本来就是关闭的 [web:off]')
  let tree = first.render()
  assert.equal(tree.props['data-off'], 'true', '应读回记住的状态')
  flushTimers()
  await settle()
  assert.equal(calls.length, 1, '挂载应只探一次')
  assert.equal(calls[0][1], '/webtoggle status')
  tree = first.render()
  assert.equal(tree.props['data-off'], 'true')
  assert.equal(noteOf(tree), undefined, '宿主确认仍是关闭时不应弹提示（切来切去不再重复出现）')

  // 再点一次 → on
  const onCalls = []
  first.state.remote = stubRemote(onCalls, '联网工具已恢复 [web:on]')
  queryAll(tree, 'dswt-trigger')[0].props.onClick()
  await settle()
  assert.equal(onCalls[0][1], '/webtoggle on')
  tree = first.render()
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
  first.render()
  flushTimers()
  await settle()
  assert.equal(firstCalls.length, 1)

  // 模拟切到别的会话再切回来：组件重新挂载，模块级缓存还在
  const secondCalls = []
  const second = mount('s5')
  second.state.remote = stubRemote(secondCalls, '本来就是关闭的 [web:off]')
  const tree = second.render()
  flushTimers()
  await settle()
  assert.equal(secondCalls.length, 0, '同一页面内不应重复探测')
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

// ---- 7. 失败分支 ---------------------------------------------------------
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

  // 7.2 命令未注册（value undefined）
  state.remote = { commands: { execute: async () => ({ ok: true, value: undefined }) } }
  tree = render()
  queryAll(tree, 'dswt-trigger')[0].props.onClick()
  await settle()
  tree = render()
  assert.equal(textOf(noteOf(tree)), t('error.commandMissing'))

  // 7.3 Remote 失败
  state.remote = { commands: { execute: async () => ({ ok: false, error: { message: 'socket closed' } }) } }
  tree = render()
  queryAll(tree, 'dswt-trigger')[0].props.onClick()
  await settle()
  tree = render()
  assert.match(textOf(noteOf(tree)), /socket closed/)

  // 7.4 Host 明确拒绝：原文展示，状态不变
  state.remote = {
    commands: {
      execute: async () => ({ ok: true, value: { result: { kind: 'error', text: '当前任务正在执行，等这一轮结束后再切换联网开关' } } }),
    },
  }
  tree = render()
  queryAll(tree, 'dswt-trigger')[0].props.onClick()
  await settle()
  tree = render()
  assert.equal(textOf(noteOf(tree)), '当前任务正在执行，等这一轮结束后再切换联网开关')
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
  let tree = render()
  flushTimers()
  await settle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], '/webtoggle status')
  assert.equal(globalThis.localStorage.getItem('dsh-web-toggle:off:s8'), null, '应把记忆纠正成 on')
  tree = render()
  assert.equal(tree.props['data-off'], 'false')
  assert.equal(noteOf(tree).props['data-kind'], 'ok')
  assert.equal(textOf(noteOf(tree)), t('note.syncedOn'))
  console.log('8 挂载探针纠正 ok')
}

// ---- 9. 小箭头：点开面板、面板里的按钮落回命令线 -------------------------
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
  assert.equal(host.state.calls[0][1], '/webtoggle status', '打开时应问一次宿主')
  // 第一次渲染跑定位 effect，第二次才画在算好的坐标上（真实 React 是自动的）
  tree = render()
  tree = render()
  const panels = queryAll(tree, 'dswt-panel')
  assert.equal(panels.length, 1, '应画出面板')
  assert.equal(panels[0].props['data-inline'], 'false')

  // 面板上的「断网」
  buttonWith(tree, t('panel.switchOff')).props.onClick()
  await settle()
  assert.equal(host.state.calls.at(-1)[1], '/webtoggle off')
  tree = render()
  assert.equal(tree.props['data-off'], 'true', '面板操作也应更新开关')

  // 添加一个本会话工具
  const input = queryAll(tree, 'dswt-input')[0]
  input.props.onChange({ target: { value: 'read' } })
  tree = render()
  buttonWith(tree, t('panel.add')).props.onClick()
  await settle()
  assert.equal(host.state.calls.at(-1)[1], '/webtoggle allow add read')
  tree = render()
  assert.deepEqual(host.state.session, ['read'])
  assert.equal(queryAll(tree, 'dswt-chip')[0].children[0], 'read')

  // 再删掉
  const chipButton = queryAll(tree, 'dswt-chip')[0].children[1]
  chipButton.props.onClick()
  await settle()
  assert.equal(host.state.calls.at(-1)[1], '/webtoggle allow remove read')
  tree = render()
  assert.equal(queryAll(tree, 'dswt-chip').length, 0)
  console.log('9 浮层面板 ok')
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
  const host = fakeHost({ global: ['read'] })
  page.state.remote = host.remote
  const { render, t } = mountPage('settings.section')
  let tree = render()
  await settle()
  tree = render()
  assert.equal(host.state.calls[0][1], '/webtoggle status')
  const panels = queryAll(tree, 'dswt-panel')
  assert.equal(panels.length, 1)
  assert.equal(panels[0].props['data-inline'], 'true', '页面里的面板应是内联的')
  assert.equal(queryAll(tree, 'dswt-chip')[0].children[0], 'read', '应显示全局保留的工具')
  assert.equal(buttonWith(tree, t('panel.switchOff')), undefined, '全局面板不显示本会话开关')

  // 点「隐藏」改设置页自身
  const row = queryAll(tree, 'dswt-row').find((item) => textOf(item).includes(t('panel.surface.settings')))
  assert.ok(row !== undefined, '应有设置页那一行')
  buttonWith(row, t('panel.hide')).props.onClick()
  await settle()
  assert.equal(host.state.calls.at(-1)[1], '/webtoggle surface settings off')
  tree = render()
  assert.equal(tree, null, '关掉之后这个页面自己也不画了')

  // 关掉之后要用别处再打开；新开一个宿主，模拟换个入口重新显示
  const reopened = fakeHost({ global: ['read', 'grep'] })
  page.state.remote = reopened.remote
  const again = mountPage('settings.section')
  let page_tree = again.render()
  await settle()
  page_tree = again.render()
  assert.equal(queryAll(page_tree, 'dswt-panel').length, 1, '配置允许时应画回来')
  const input = queryAll(page_tree, 'dswt-input')[0]
  input.props.onChange({ target: { value: 'bash' } })
  page_tree = again.render()
  buttonWith(page_tree, t('panel.add')).props.onClick()
  await settle()
  assert.equal(reopened.state.calls.at(-1)[1], '/webtoggle allow add bash --global')
  assert.deepEqual(reopened.state.global, ['read', 'grep', 'bash'])
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
  const { render, t } = mountPage('settings.section')
  let tree = render()
  await settle()
  tree = render()
  // 之前用例里挂过 composer，模块级 lastSessionId 还在，所以这里应能正常画；
  // 断掉 remote 才轮到错误提示。
  page.state.remote = undefined
  const broken = mountPage('settings.section')
  tree = broken.render()
  await settle()
  tree = broken.render()
  assert.equal(textOf(queryAll(tree, 'dswt-error')[0]), t('error.noRemote'))
  console.log('13 配置页失败提示 ok')
}

console.log('\n全部通过')
