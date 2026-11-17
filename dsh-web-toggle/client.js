/**
 * Browser half of the web-toggle bundle.
 *
 * Draws three surfaces, all driven by the Host `/webtoggle` command:
 *
 * - the toggle in the composer tool row (`conversation.input.left`), with a small
 *   caret that opens this Session's panel;
 * - a "Web switch" section in the settings sidebar (`settings.section`);
 * - a section on this bundle's detail page (`plugins.detail.section`).
 *
 * The last two are global: they edit the plugin's own configuration (which surfaces
 * show, and which extra tools every Session keeps). The composer panel is where the
 * per-Session switch and the per-Session keep-list live. Every surface is registered
 * unconditionally and renders null when the configuration hides it, so flipping a
 * switch never re-registers slots.
 *
 * The button state is per Session: the browser remembers it under the Session id so a
 * page reload keeps showing the truth, and a mount with a remembered "off" asks the
 * Host once (`/webtoggle status`) because a DSH restart resets the Host side.
 * Remotes used: commands.
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-toggle',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    /** Locale namespace of this control. */
    const NS = 'web-toggle'
    /** Marker used to install the stylesheet once and remove it on unload. */
    const STYLE_ID = 'dsh-web-toggle/styles'
    /** Browser-local per-Session state: `1` means the switch is off. */
    const STORAGE_PREFIX = 'dsh-web-toggle:off:'
    /** Browser-local memory of the last Session drawn, so the global pages can run commands. */
    const LAST_SESSION_KEY = 'dsh-web-toggle:last-session'
    /**
     * Sessions already reconciled with the Host in this page. Kept outside the
     * component so switching away and back neither re-runs `/webtoggle status` nor
     * re-raises the "the host restarted" note; a real page reload clears it.
     */
    const probedSessions = new Set()
    /** How long a settled note stays in the tool row. */
    const NOTE_MS = 9000
    /** The last Session id any composer drew in this page; the global panels need one. */
    let lastSessionId

    const CSS = `
.dswt-root{position:relative;display:inline-flex;align-items:center;gap:2px;min-width:0;max-width:100%;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px}
.dswt-root[data-off="true"]{color:var(--dsw-alias-label-secondary)}
.dswt-root[data-busy="true"]{opacity:.7}
.dswt-trigger{border-radius:var(--dsw-radius-sm,6px);height:28px;color:inherit;cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:5px;padding:0 8px;font:inherit;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}
@media (hover:hover){.dswt-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}}
.dswt-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}
.dswt-trigger:disabled{cursor:default;opacity:.55}
.dswt-icon{position:relative;flex:none;display:inline-flex;opacity:.85}
.dswt-icon svg{width:14px;height:14px}
.dswt-root[data-off="false"] .dswt-icon{color:var(--dsw-alias-state-success-primary)}
.dswt-root[data-off="true"] .dswt-icon::after{content:"";position:absolute;left:-1px;top:50%;width:16px;height:1.5px;border-radius:1px;background:currentColor;transform:rotate(-45deg);transform-origin:center}
.dswt-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dswt-caret{width:16px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:var(--dsw-radius-sm,6px);background:0 0;color:inherit;cursor:pointer;padding:0;opacity:.7}
@media (hover:hover){.dswt-caret:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));opacity:1}}
.dswt-caret:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}
.dswt-caret svg{width:10px;height:10px;transition:transform .12s ease}
.dswt-caret[aria-expanded="true"] svg{transform:rotate(180deg)}
.dswt-note{display:inline-flex;align-items:center;min-width:0;max-width:220px;margin-left:2px;padding:0 8px;color:var(--dsw-alias-label-secondary);font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dswt-note[data-kind="ok"]{color:var(--dsw-alias-state-success-primary)}
.dswt-note[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}
.dswt-panel{position:fixed;z-index:60;width:290px;max-height:70vh;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:12px;border:1px solid var(--dsw-alias-border-neutral,rgba(127,127,127,.25));background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,#111);font-size:12px;font-weight:400;line-height:1.5;box-shadow:0 10px 30px rgba(0,0,0,.18)}
.dswt-panel[data-inline="true"]{position:static;width:auto;max-height:none;box-shadow:none;padding:0;border:none;background:0 0;font-size:13px}
.dswt-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600;font-size:13px}
.dswt-section{display:flex;flex-direction:column;gap:6px}
.dswt-section-title{font-weight:600}
.dswt-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dswt-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.45}
.dswt-chips{display:flex;flex-wrap:wrap;gap:4px}
.dswt-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 4px 1px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px}
.dswt-chip button{border:none;background:0 0;cursor:pointer;color:inherit;padding:0 2px;line-height:1;font-size:12px;opacity:.65}
.dswt-chip button:hover{opacity:1}
.dswt-add{display:flex;gap:6px;align-items:center}
.dswt-input{flex:1;min-width:0;height:26px;padding:0 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-neutral,rgba(127,127,127,.35));background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit}
.dswt-input:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}
.dswt-btn{height:26px;padding:0 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-neutral,rgba(127,127,127,.35));background:0 0;color:inherit;cursor:pointer;font:inherit;white-space:nowrap}
.dswt-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dswt-btn:disabled{cursor:default;opacity:.55}
.dswt-btn[data-primary="true"]{border-color:transparent;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.dswt-error{color:var(--dsw-alias-state-error-primary,#c62828)}
.dswt-ok{color:var(--dsw-alias-state-success-primary,#2e7d32)}
`

    const DICT = {
      en: {
        'group.aria': 'Network switch',
        'label': 'Web',
        'title.on': 'Network is on for this task: web search, browser, MCP and shell tools can reach the internet. Click to cut them off.',
        'title.off': 'Network is off for this task: the internet-facing tools are hidden, and shell commands that would fetch anything are refused. Click to restore.',
        'title.running': 'This task is running; switch the web tools once the turn ends.',
        'title.panel': 'Open this task\'s network panel',
        'note.off': 'Network off',
        'note.offTitle': 'The internet-facing tools are hidden from the next request; shell commands that would fetch anything are refused.',
        'note.on': 'Network on',
        'note.onTitle': 'The full tool list is back in this task from the next request.',
        'note.syncedOn': 'Network on',
        'note.syncedOnTitle': 'The host restarted, so this task can reach the internet again.',
        'error.noRemote': 'The command service is unavailable on this page, so the switch cannot change anything.',
        'error.noSession': 'Open a task to switch its web tools.',
        'error.commandMissing': 'The /webtoggle command is not registered, so this build cannot switch the web tools.',
        'error.failed': 'Could not switch the network: {reason}',
        'error.failedNoReason': 'the host returned no reason',
        'error.running': 'This task is running; switch the web tools after the turn ends.',
        'settings.title': 'Web switch',
        'settings.description': 'Per-task network switch: hide every internet-facing tool and refuse shell commands that would fetch anything.',
        'panel.title': 'Network switch',
        'panel.thisTask': 'This task',
        'panel.switchOff': 'Cut the network',
        'panel.switchOn': 'Restore the network',
        'panel.stateOff': 'Off: internet-facing tools are hidden, and shell commands that would fetch anything are refused.',
        'panel.stateOn': 'On: the full tool list is available.',
        'panel.sessionKeep': 'Extra tools this task keeps',
        'panel.globalKeep': 'Extra tools every task keeps',
        'panel.add': 'Add',
        'panel.placeholder': 'tool name, for example read',
        'panel.empty': 'Nothing extra yet.',
        'panel.remove': 'Stop keeping {name}',
        'panel.surfaceTitle': 'Where this page appears',
        'panel.surface.plugin': 'This plugin\'s detail page',
        'panel.surface.settings': 'Settings sidebar',
        'panel.surface.composer': 'Caret beside the composer toggle',
        'panel.show': 'Show',
        'panel.hide': 'Hide',
        'panel.hint.keep': 'A kept tool stays available while the network is off. Tools not listed here are hidden.',
        'panel.hint.global': 'The per-task list lives in the caret beside the composer toggle.',
        'panel.hint.session': 'Only this task is affected; other tasks keep their own switch.',
        'panel.hint.readonly': 'This profile cannot save configuration, so changes last until the app restarts.',
        'panel.note.saved': 'Saved.',
        'panel.note.refreshed': 'Refreshed from the host.',
        'panel.noSession': 'Open any task once, then come back: the panel needs a task to talk to the host.',
        'panel.writableHidden': '',
      },
      zh: {
        'group.aria': '联网开关',
        'label': '联网',
        'title.on': '本任务可以联网：网页搜索、浏览器、MCP、shell 都能出网。点击断网。',
        'title.off': '本任务已断网：能出网的工具都隐藏了，shell 里的联网命令会被拦。点击恢复。',
        'title.running': '当前任务正在执行，等这一轮结束后再切换联网开关。',
        'title.panel': '打开本任务的联网面板',
        'note.off': '已断网',
        'note.offTitle': '从下一次请求起，能出网的工具都被隐藏，shell 里的联网命令会被拦。',
        'note.on': '已联网',
        'note.onTitle': '完整工具列表从下一次请求起回到本任务。',
        'note.syncedOn': '已联网',
        'note.syncedOnTitle': '宿主已重启，本任务因此恢复联网。',
        'error.noRemote': '当前页面无法使用命令服务，开关改不了任何东西。',
        'error.noSession': '请先打开一个任务再切换联网工具。',
        'error.commandMissing': '/webtoggle 命令未注册（Host 半侧未生效），因此无法切换联网工具。',
        'error.failed': '切换联网开关失败：{reason}',
        'error.failedNoReason': '宿主未返回原因',
        'error.running': '当前任务正在执行，等这一轮结束后再切换联网工具。',
        'settings.title': '联网开关',
        'settings.description': '按任务断网：隐藏所有能出网的工具，并拦下 shell 里的联网命令。',
        'panel.title': '联网开关',
        'panel.thisTask': '本任务',
        'panel.switchOff': '断网',
        'panel.switchOn': '恢复联网',
        'panel.stateOff': '已断网：能出网的工具都隐藏了，shell 里的联网命令会被拦下。',
        'panel.stateOn': '已联网：完整工具列表可用。',
        'panel.sessionKeep': '本任务额外保留的工具',
        'panel.globalKeep': '所有任务额外保留的工具',
        'panel.add': '添加',
        'panel.placeholder': '工具名，例如 read',
        'panel.empty': '还没有额外保留的工具。',
        'panel.remove': '不再保留 {name}',
        'panel.surfaceTitle': '这些面板显示在哪里',
        'panel.surface.plugin': '本插件详情页',
        'panel.surface.settings': '设置页侧边栏',
        'panel.surface.composer': '输入框开关旁的小箭头',
        'panel.show': '显示',
        'panel.hide': '隐藏',
        'panel.hint.keep': '保留名单里的工具在断网时依然可用；没列出来的工具一律隐藏。',
        'panel.hint.global': '按任务设置的白名单在输入框开关旁的小箭头里。',
        'panel.hint.session': '只影响本任务，其他任务各有各的开关。',
        'panel.hint.readonly': '这个 profile 不能保存配置，改动在应用重启后失效。',
        'panel.note.saved': '已保存。',
        'panel.note.refreshed': '已从宿主刷新。',
        'panel.noSession': '先打开任意一个任务，再回到这里：面板需要有一个任务才能和宿主通信。',
        'panel.writableHidden': '',
      },
    }

    /** Fill `{name}` placeholders in one localized pattern. */
    const format = (pattern, values) =>
      pattern.replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))

    /** The best available message for a failed Remote result or a thrown error. */
    const describeFailure = (error, t) => {
      if (error !== null && typeof error === 'object') {
        const details = error.details
        if (details !== null && typeof details === 'object' && typeof details.reason === 'string' && details.reason !== '') {
          return details.reason
        }
        if (typeof error.message === 'string' && error.message !== '') return error.message
      }
      if (typeof error === 'string' && error !== '') return error
      return t('error.failedNoReason')
    }

    /**
     * Read the state marker the Host appends to every result (`[web:on]` / `[web:off]`).
     * @param text - the command result text.
     * @returns `'on'`, `'off'`, or undefined when the text carries no marker.
     */
    const parseMarker = (text) => {
      if (typeof text !== 'string') return undefined
      const matched = /\[web:(on|off)\]/.exec(text)
      return matched === null ? undefined : matched[1]
    }

    /**
     * Read the machine-readable state the Host appends to every result.
     * @param text - the command result text.
     * @returns the parsed state, or undefined when the text carries none.
     */
    const parseState = (text) => {
      if (typeof text !== 'string') return undefined
      const matched = /\[web-state\](\{[\s\S]*\})\s*$/.exec(text)
      if (matched === null) return undefined
      try {
        const parsed = JSON.parse(matched[1])
        if (parsed === null || typeof parsed !== 'object') return undefined
        return parsed
      } catch (error) {
        return undefined
      }
    }

    /** Storage key of one Session's remembered state. */
    const storageKey = (sessionId) => STORAGE_PREFIX + sessionId

    /** Read this Session's remembered state; storage can be unavailable in a locked-down page. */
    const readPreference = (sessionId) => {
      try {
        if (typeof localStorage === 'undefined' || sessionId === undefined) return false
        return localStorage.getItem(storageKey(sessionId)) === '1'
      } catch (error) {
        return false
      }
    }

    /** Persist this Session's state (only "off" is stored; "on" clears the key). */
    const writePreference = (sessionId, off) => {
      try {
        if (typeof localStorage === 'undefined' || sessionId === undefined) return
        if (off) localStorage.setItem(storageKey(sessionId), '1')
        else localStorage.removeItem(storageKey(sessionId))
      } catch (error) {
        /* storage denied: the switch stays page-scoped */
      }
    }

    /** Remember the last drawn Session, so a global page opened later can address one. */
    const rememberSession = (sessionId) => {
      lastSessionId = sessionId
      try {
        if (typeof localStorage !== 'undefined' && sessionId !== undefined) localStorage.setItem(LAST_SESSION_KEY, sessionId)
      } catch (error) {
        /* storage denied: the in-memory value still works for this page */
      }
    }

    /** Read the remembered Session id, if this page ever drew one. */
    const readRememberedSession = () => {
      if (lastSessionId !== undefined) return lastSessionId
      try {
        if (typeof localStorage === 'undefined') return undefined
        const stored = localStorage.getItem(LAST_SESSION_KEY)
        return stored === undefined || stored === null || stored === '' ? undefined : stored
      } catch (error) {
        return undefined
      }
    }

    /** The globe glyph: a round window with two meridians and a latitude line. */
    const globeGlyph = () =>
      h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: false },
        h('circle', { cx: 8, cy: 8, r: 5.9, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M8 2.1c1.9 1.6 1.9 10.2 0 11.8M8 2.1c-1.9 1.6-1.9 10.2 0 11.8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M2.4 6.2h11.2M2.4 9.8h11.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
      )

    /** The caret glyph that opens the Session panel. */
    const caretGlyph = () =>
      h(
        'svg',
        { viewBox: '0 0 10 10', width: 10, height: 10, 'aria-hidden': true, focusable: false },
        h('path', { d: 'M2 4l3 3 3-3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )

    /**
     * Build the slot components over one plugin context.
     * @param ctx - the Client plugin context (carries the `remote` facade).
     */
    function createComponents(ctx) {
      /** The Remote facade, read lazily because namespaces mount after apply. */
      const remoteOf = () => {
        try {
          return ctx.get('remote')
        } catch (error) {
          return undefined
        }
      }

      /**
       * Pick a Session id for a page that is not rendered inside one: the last drawn
       * composer wins, then the remembered id, then any Session the client knows.
       * @returns the Session id, or undefined when this page knows of none.
       */
      const anySessionId = () => {
        const remembered = readRememberedSession()
        if (remembered !== undefined) return remembered
        try {
          const sessions = ctx.get('sessions')
          const snapshot = sessions?.list?.getSnapshot?.()
          const byId = snapshot?.byId
          if (byId !== null && typeof byId === 'object') {
            const first = Object.keys(byId)[0]
            if (first !== undefined) return first
          }
        } catch (error) {
          /* no session service: the caller reports it */
        }
        return undefined
      }

      /**
       * Run one `/webtoggle` line and turn the answer into a small outcome record.
       * @param sessionId - the Session the command runs for.
       * @param rawInput - the argument text behind `/webtoggle `.
       * @param t - the translator.
       * @returns `{ ok, text, state, off }`; `ok` false carries a rendered message.
       */
      async function run(sessionId, rawInput, t) {
        if (sessionId === undefined) return { ok: false, text: t('error.noSession'), state: undefined }
        const remote = remoteOf()
        const commands = remote === undefined ? undefined : remote.commands
        if (commands === undefined || typeof commands.execute !== 'function') {
          return { ok: false, text: t('error.noRemote'), state: undefined }
        }
        try {
          const result = await commands.execute(sessionId, `/webtoggle ${rawInput}`, [])
          if (result === undefined || result.ok !== true) {
            const reason = result === undefined ? t('error.failedNoReason') : describeFailure(result.error, t)
            return { ok: false, text: format(t('error.failed'), { reason }), state: undefined }
          }
          // `undefined` means the Host resolved no command with that name.
          const execution = result.value
          if (execution === undefined) return { ok: false, text: t('error.commandMissing'), state: undefined }
          const outcome = execution.result
          if (outcome === undefined) return { ok: false, text: t('error.failedNoReason'), state: undefined }
          const state = parseState(outcome.text)
          const marker = parseMarker(outcome.text)
          if (outcome.kind !== 'success') {
            const text = typeof outcome.text === 'string' && outcome.text !== '' ? outcome.text : t('error.failedNoReason')
            return { ok: false, text, state }
          }
          return {
            ok: true,
            text: typeof outcome.text === 'string' ? outcome.text : '',
            state,
            off: marker === undefined ? undefined : marker === 'off',
          }
        } catch (error) {
          return { ok: false, text: format(t('error.failed'), { reason: describeFailure(error, t) }), state: undefined }
        }
      }

      /**
       * The shared panel body. It renders the same controls in the composer popover
       * (`mode: 'session'`) and on the two configuration pages (`mode: 'global'`);
       * a page whose configuration hides it renders null instead.
       * @param props - `t`, `mode`, `state`, `busy`, `error`, `note`, `onRun`.
       */
      function PanelView(props) {
        const t = props.t
        const state = props.state
        const global = props.mode === 'global'
        const [draft, setDraft] = useState('')
        const disabled = props.busy === true
        const writable = state === null || state === undefined ? true : state.writable !== false
        const surfaces = state?.surfaces ?? { plugin: true, settings: true, composer: true }
        const keep = global ? state?.global ?? [] : state?.session ?? []

        const submit = () => {
          const name = draft.trim()
          if (name === '') return
          const done = props.onRun(`allow add ${name}${global ? ' --global' : ''}`)
          setDraft('')
          if (done && typeof done.then === 'function') done.then(() => undefined)
        }

        const surfaceRow = (key, labelKey) =>
          h(
            'div',
            { className: 'dswt-row', key },
            h('span', null, t(labelKey)),
            h(
              'button',
              {
                type: 'button',
                className: 'dswt-btn',
                disabled,
                'aria-pressed': surfaces[key] ? 'true' : 'false',
                onClick: () => props.onRun(`surface ${key} ${surfaces[key] ? 'off' : 'on'}`),
              },
              surfaces[key] ? t('panel.hide') : t('panel.show'),
            ),
          )

        return h(
          'div',
          { className: 'dswt-panel', 'data-inline': global ? 'true' : 'false' },
          h('div', { className: 'dswt-panel-head' }, h('span', null, global ? t('panel.title') : t('panel.thisTask'))),
          global
            ? null
            : h(
                'div',
                { className: 'dswt-section' },
                h('div', { className: 'dswt-hint' }, state?.off ? t('panel.stateOff') : t('panel.stateOn')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dswt-btn',
                    'data-primary': 'true',
                    disabled,
                    onClick: () => props.onRun(state?.off ? 'on' : 'off'),
                  },
                  state?.off ? t('panel.switchOn') : t('panel.switchOff'),
                ),
              ),
          global
            ? h(
                'div',
                { className: 'dswt-section' },
                h('div', { className: 'dswt-section-title' }, t('panel.surfaceTitle')),
                surfaceRow('plugin', 'panel.surface.plugin'),
                surfaceRow('settings', 'panel.surface.settings'),
                surfaceRow('composer', 'panel.surface.composer'),
              )
            : null,
          h(
            'div',
            { className: 'dswt-section' },
            h('div', { className: 'dswt-section-title' }, global ? t('panel.globalKeep') : t('panel.sessionKeep')),
            keep.length === 0
              ? h('div', { className: 'dswt-hint' }, t('panel.empty'))
              : h(
                  'div',
                  { className: 'dswt-chips' },
                  keep.map((name) =>
                    h(
                      'span',
                      { className: 'dswt-chip', key: name },
                      name,
                      h(
                        'button',
                        {
                          type: 'button',
                          title: format(t('panel.remove'), { name }),
                          'aria-label': format(t('panel.remove'), { name }),
                          disabled,
                          onClick: () => props.onRun(`allow remove ${name}${global ? ' --global' : ''}`),
                        },
                        '×',
                      ),
                    ),
                  ),
                ),
            h(
              'div',
              { className: 'dswt-add' },
              h('input', {
                className: 'dswt-input',
                value: draft,
                placeholder: t('panel.placeholder'),
                spellCheck: false,
                disabled,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    submit()
                  }
                },
              }),
              h('button', { type: 'button', className: 'dswt-btn', disabled: disabled || draft.trim() === '', onClick: submit }, t('panel.add')),
            ),
            h('div', { className: 'dswt-hint' }, t('panel.hint.keep')),
          ),
          h('div', { className: 'dswt-hint' }, global ? t('panel.hint.global') : t('panel.hint.session')),
          writable ? null : h('div', { className: 'dswt-hint dswt-error' }, t('panel.hint.readonly')),
          props.error === null || props.error === undefined ? null : h('div', { className: 'dswt-error' }, props.error),
          props.note === null || props.note === undefined ? null : h('div', { className: 'dswt-ok' }, props.note),
        )
      }

      /** The composer toggle plus its caret and popover panel. */
      function WebToggle(props) {
        const t = typeof props.t === 'function' ? props.t : (key) => key
        const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : undefined
        // The slot always hands over the session store hook; a deployment without it
        // simply never reports a running turn.
        const useSessions = typeof props.useSessions === 'function' ? props.useSessions : (selector) => selector(undefined)
        const running = useSessions((state) => (state === undefined ? false : state.byId?.[sessionId]?.running === true))

        const [off, setOff] = useState(() => readPreference(sessionId))
        const [busy, setBusy] = useState(false)
        const [note, setNote] = useState(null)
        const [open, setOpen] = useState(false)
        const [panel, setPanel] = useState(null)
        const [panelBusy, setPanelBusy] = useState(false)
        const [panelNote, setPanelNote] = useState(null)
        const [panelError, setPanelError] = useState(null)
        const [anchor, setAnchor] = useState(null)
        const caretRef = useRef(null)
        const aliveRef = useRef(true)
        const busyRef = useRef(false)

        useEffect(() => {
          aliveRef.current = true
          return () => {
            aliveRef.current = false
          }
        }, [])

        // The global pages need a Session to address the Host; a drawn composer is the
        // most reliable source of one.
        useEffect(() => {
          rememberSession(sessionId)
        }, [sessionId])

        // A different Session in the same component: show that Session's state.
        useEffect(() => {
          setNote(null)
          setPanel(null)
          setPanelNote(null)
          setPanelError(null)
          setOpen(false)
          setOff(readPreference(sessionId))
        }, [sessionId])

        useEffect(() => {
          if (note === null && panelNote === null) return undefined
          const timer = window.setTimeout(() => {
            if (!aliveRef.current) return
            setNote(null)
            setPanelNote(null)
          }, NOTE_MS)
          return () => window.clearTimeout(timer)
        }, [note, panelNote])

        // The popover is positioned against the caret in viewport coordinates, so a
        // scrolling tool row cannot clip it.
        useEffect(() => {
          if (!open) return undefined
          const place = () => {
            const element = caretRef.current
            if (element === null || element === undefined) {
              // No measurable anchor (a slot that mounts differently): keep the panel
              // reachable instead of dropping it.
              setAnchor({ left: Math.max(8, (window.innerWidth - 290) / 2), bottom: 96 })
              return
            }
            const rect = element.getBoundingClientRect()
            setAnchor({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 300)), bottom: window.innerHeight - rect.top + 8 })
          }
          place()
          window.addEventListener('resize', place)
          window.addEventListener('scroll', place, true)
          const dismiss = (event) => {
            const root = caretRef.current?.closest?.('.dswt-root')
            if (root !== null && root !== undefined && root.contains(event.target)) return
            setOpen(false)
          }
          document.addEventListener('mousedown', dismiss)
          return () => {
            window.removeEventListener('resize', place)
            window.removeEventListener('scroll', place, true)
            document.removeEventListener('mousedown', dismiss)
          }
        }, [open])

        /** Show one error in the tool row. */
        const fail = (text) => {
          setNote({ kind: 'error', text, title: text })
          return false
        }

        /** Commit one observed state to the button and to storage. */
        const commit = (nextOff) => {
          setOff(nextOff)
          writePreference(sessionId, nextOff)
          // The Host just answered for this Session, so a later re-mount does not need
          // to ask it again.
          if (sessionId !== undefined) probedSessions.add(sessionId)
        }

        /**
         * Run one `/webtoggle` form and fold the Host's answer into the button.
         * @param rawInput - `on`, `off`, `status`, or a configuration form.
         * @param quiet - true for the mount-time probe, which must not write a note.
         * @returns the outcome record; `ok` is true only when the Host confirmed.
         */
        async function invoke(rawInput, quiet = false) {
          if (busyRef.current) return { ok: false, text: '', state: undefined }
          if (!quiet) {
            busyRef.current = true
            setBusy(true)
            setNote(null)
          }
          const outcome = await run(sessionId, rawInput, t)
          if (!quiet) {
            busyRef.current = false
            if (aliveRef.current) setBusy(false)
          }
          if (!aliveRef.current) return outcome
          if (!outcome.ok) {
            if (!quiet) fail(outcome.text)
            return outcome
          }
          if (outcome.off !== undefined) commit(outcome.off)
          if (outcome.state !== undefined) setPanel(outcome.state)
          if (quiet) return outcome
          const nextOff = outcome.off === undefined ? readPreference(sessionId) : outcome.off
          setNote(
            nextOff
              ? { kind: 'ok', text: t('note.off'), title: t('note.offTitle') }
              : { kind: 'ok', text: t('note.on'), title: t('note.onTitle') },
          )
          return outcome
        }

        // The Host forgets the switch when DSH restarts while this browser remembers it.
        // One `/webtoggle status` reconciles that case; a remembered "on" needs no probe,
        // and a Session already probed in this page is not probed again — switching away
        // and back must not fire the command or a note every time.
        useEffect(() => {
          if (sessionId === undefined || running) return undefined
          if (!readPreference(sessionId)) return undefined
          if (probedSessions.has(sessionId)) return undefined
          let cancelled = false
          const timer = window.setTimeout(async () => {
            const remote = remoteOf()
            const commands = remote === undefined ? undefined : remote.commands
            if (cancelled || commands === undefined || typeof commands.execute !== 'function') return
            probedSessions.add(sessionId)
            const before = readPreference(sessionId)
            const outcome = await invoke('status', true)
            if (cancelled || !outcome.ok || !aliveRef.current) return
            const after = readPreference(sessionId)
            // Only a correction deserves a note: when the Host confirms the remembered
            // "off", the button already shows it and silence is the honest answer.
            if (before && !after) setNote({ kind: 'ok', text: t('note.syncedOn'), title: t('note.syncedOnTitle') })
          }, 0)
          return () => {
            cancelled = true
            window.clearTimeout(timer)
          }
        }, [sessionId, running])

        /** Flip the switch for this Session. */
        const toggle = () => {
          if (busyRef.current) return
          if (sessionId === undefined) {
            fail(t('error.noSession'))
            return
          }
          if (running) {
            fail(t('error.running'))
            return
          }
          invoke(off ? 'on' : 'off')
        }

        /** Run one panel command, keeping the panel's own progress and messages. */
        const panelRun = async (rawInput) => {
          if (sessionId === undefined) {
            setPanelError(t('error.noSession'))
            return false
          }
          setPanelBusy(true)
          setPanelError(null)
          setPanelNote(null)
          const outcome = await run(sessionId, rawInput, t)
          if (!aliveRef.current) return false
          setPanelBusy(false)
          if (outcome.off !== undefined) commit(outcome.off)
          if (outcome.state !== undefined) setPanel(outcome.state)
          if (!outcome.ok) {
            setPanelError(outcome.text)
            return false
          }
          setPanelNote(t('panel.note.saved'))
          return true
        }

        /** Open the popover, asking the Host once for the state it should show. */
        const openPanel = () => {
          const next = !open
          setOpen(next)
          if (!next) return
          setPanelError(null)
          if (panel !== null) return
          setPanelBusy(true)
          run(sessionId, 'status', t).then((outcome) => {
            if (!aliveRef.current) return
            setPanelBusy(false)
            if (outcome.state !== undefined) setPanel(outcome.state)
            if (!outcome.ok) setPanelError(outcome.text)
          })
        }

        const title = running ? t('title.running') : off ? t('title.off') : t('title.on')
        // The caret and the popover follow the configuration; a hidden caret means the
        // configuration page owns this Session's list.
        const showCaret = panel === null || panel.surfaces === undefined ? true : panel.surfaces.composer !== false

        return h(
          'div',
          { className: 'dswt-root', 'data-off': off ? 'true' : 'false', 'data-busy': busy ? 'true' : 'false', role: 'group', 'aria-label': t('group.aria') },
          h(
            'button',
            {
              type: 'button',
              className: 'dswt-trigger',
              'aria-pressed': off ? 'false' : 'true',
              'aria-label': t('group.aria'),
              title: busy ? t('title.running') : title,
              disabled: busy || running,
              onMouseDown: (event) => event.preventDefault(),
              onClick: toggle,
            },
            h('span', { className: 'dswt-icon', 'aria-hidden': true }, globeGlyph()),
            h('span', { className: 'dswt-label' }, t('label')),
          ),
          showCaret
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dswt-caret',
                  ref: caretRef,
                  'aria-expanded': open ? 'true' : 'false',
                  'aria-label': t('title.panel'),
                  title: t('title.panel'),
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: openPanel,
                },
                caretGlyph(),
              )
            : null,
          note === null
            ? null
            : h('span', { className: 'dswt-note', 'data-kind': note.kind, 'aria-live': 'polite', title: note.title }, note.text),
          open && anchor !== null
            ? h(
                'div',
                { style: { position: 'fixed', left: anchor.left + 'px', bottom: anchor.bottom + 'px', zIndex: 60 } },
                h(PanelView, {
                  t,
                  mode: 'session',
                  state: panel,
                  busy: panelBusy,
                  error: panelError,
                  note: panelNote,
                  onRun: panelRun,
                }),
              )
            : null,
        )
      }

      // `run` and `anySessionId` are shared with the configuration pages: those render
      // outside a Session and have to resolve one themselves.
      return { WebToggle, PanelView, run, anySessionId }
    }

    /**
     * Build a page component for a configuration surface. It renders the shared panel
     * in global mode, or null when this surface is configured off.
     * @param ctx - the Client plugin context.
     * @param ui - the components built over `ctx`, so the panel type stays stable.
     * @param surface - `plugin` or `settings`.
     */
    function createPage(ctx, ui, surface) {
      // The pages are not rendered inside a Session, so each call resolves one: the
      // last composer drawn, then the remembered id, then any Session this client knows.
      const run = (rawInput, t) => {
        const sessionId = ui.anySessionId()
        if (sessionId === undefined) return Promise.resolve({ ok: false, text: t('panel.noSession'), state: undefined })
        return ui.run(sessionId, rawInput, t)
      }

      return function Page(props) {
        const t = typeof props.t === 'function' ? props.t : (key) => key
        const [state, setState] = useState(null)
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState(null)
        const [note, setNote] = useState(null)
        const aliveRef = useRef(true)

        useEffect(() => {
          aliveRef.current = true
          return () => {
            aliveRef.current = false
          }
        }, [])

        // One `status` on mount gives the page the configuration it draws.
        useEffect(() => {
          let cancelled = false
          setBusy(true)
          run('status', t).then((outcome) => {
            if (cancelled || !aliveRef.current) return
            setBusy(false)
            if (outcome.state !== undefined) setState(outcome.state)
            if (!outcome.ok) setError(outcome.text)
          })
          return () => {
            cancelled = true
          }
        }, [])

        const onRun = async (rawInput) => {
          setBusy(true)
          setError(null)
          setNote(null)
          const outcome = await run(rawInput, t)
          if (!aliveRef.current) return false
          setBusy(false)
          if (outcome.state !== undefined) setState(outcome.state)
          if (!outcome.ok) {
            setError(outcome.text)
            return false
          }
          setNote(t('panel.note.saved'))
          return true
        }

        const hidden = state !== null && state.surfaces !== undefined && state.surfaces[surface] === false
        if (hidden) return null
        return h(ui.PanelView, {
          t,
          mode: 'global',
          state,
          busy,
          error,
          note,
          onRun,
        })
      }
    }

    return {
      // `remote` and `remote.commands` gate activation until the Host Remotes this
      // control calls are mounted.
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          const selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']'
          if (document.querySelector(selector) !== null) return () => {}
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-web-toggle'
          tag.dataset.pluginCss = STYLE_ID
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => {
            tag.remove()
          }
        }, 'web-toggle: stylesheet')

        ctx.effect(() => ctx.locale.register(NS, DICT), 'web-toggle: dictionaries')

        const t = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (key) => key
        const ui = createComponents(ctx)
        // The configuration pages are built once: constructing a component type inside a
        // render would remount the panel and drop whatever the user was typing.
        const pluginPage = createPage(ctx, ui, 'plugin')
        const settingsPage = createPage(ctx, ui, 'settings')

        // Composer: the toggle, its caret, and the Session popover.
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'web-toggle',
              order: 11,
              locale: NS,
              label: () => t('group.aria'),
            },
            ui.WebToggle,
          ),
        )

        // Configuration page on this bundle's detail page.
        ctx.slots.inject('plugins.detail.section', () =>
          ctx.slots.register(
            {
              name: 'plugins.detail.section',
              id: 'web-toggle',
              order: 20,
              locale: NS,
            },
            (props) => {
              const pkg = props?.subject?.pkg
              if (pkg === undefined || pkg === null || pkg.name !== 'dsh-web-toggle') return null
              return h(pluginPage, props)
            },
          ),
        )

        // Configuration page in the settings sidebar.
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'web-toggle',
              order: 60,
              locale: NS,
              label: () => t('settings.title'),
            },
            settingsPage,
          ),
        )
      },
    }
  },
})
