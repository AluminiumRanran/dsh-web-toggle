/**
 * Browser half of the web-toggle bundle.
 *
 * Renders one toggle in the composer tool row (conversation.input.left) and drives
 * the bundle's Host `/webtoggle` command. The button state is per Session: the
 * browser remembers it under the Session id so a page reload keeps showing the
 * truth, and a mount with a remembered "off" asks the Host once (`/webtoggle
 * status`) because a DSH restart resets the Host side.
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
    /** How long a settled note stays in the tool row. */
    const NOTE_MS = 9000

    const CSS = `
.dswt-root{display:inline-flex;align-items:center;gap:2px;min-width:0;max-width:100%;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px}
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
.dswt-note{display:inline-flex;align-items:center;min-width:0;max-width:220px;margin-left:2px;padding:0 8px;color:var(--dsw-alias-label-secondary);font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dswt-note[data-kind="ok"]{color:var(--dsw-alias-state-success-primary)}
.dswt-note[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}
`

    const DICT = {
      en: {
        'group.aria': 'Web tools',
        'label': 'Web',
        'title.on': 'Web tools are on: this task can use web_search and web_fetch. Click to turn them off.',
        'title.off': 'Web tools are off: this task cannot see web_search or web_fetch. Click to turn them back on.',
        'title.running': 'This task is running; switch the web tools once the turn ends.',
        'note.off': 'Web off',
        'note.offTitle': 'This task no longer has web_search or web_fetch; the next request carries the shorter tool list.',
        'note.on': 'Web on',
        'note.onTitle': 'web_search and web_fetch are back in this task\u2019s tool list from the next request.',
        'note.syncedOff': 'Web off (kept)',
        'note.syncedOffTitle': 'The host reports this task\u2019s web tools are still off.',
        'note.syncedOn': 'Web on',
        'note.syncedOnTitle': 'The host restarted, so this task\u2019s web tools are on again.',
        'error.noRemote': 'The command service is unavailable on this page, so the switch cannot change anything.',
        'error.noSession': 'Open a task to switch its web tools.',
        'error.commandMissing': 'The /webtoggle command is not registered, so this build cannot switch the web tools.',
        'error.failed': 'Could not switch the web tools: {reason}',
        'error.failedNoReason': 'the host returned no reason',
        'error.running': 'This task is running; switch the web tools after the turn ends.',
      },
      zh: {
        'group.aria': '联网工具',
        'label': '联网',
        'title.on': '联网工具已开启：本任务可以调用 web_search / web_fetch。点击关闭。',
        'title.off': '联网工具已关闭：本任务看不到 web_search / web_fetch。点击恢复。',
        'title.running': '当前任务正在执行，等这一轮结束后再切换联网开关。',
        'note.off': '联网已关闭',
        'note.offTitle': '本任务不再有 web_search / web_fetch，下一次请求带的就是精简后的工具列表。',
        'note.on': '联网已开启',
        'note.onTitle': 'web_search / web_fetch 从下一次请求起回到本任务的工具列表。',
        'note.syncedOff': '联网已关闭（保持）',
        'note.syncedOffTitle': '宿主报告本任务的联网工具仍处于关闭状态。',
        'note.syncedOn': '联网已开启',
        'note.syncedOnTitle': '宿主已重启，本任务的联网工具因此恢复开启。',
        'error.noRemote': '当前页面无法使用命令服务，开关改不了任何东西。',
        'error.noSession': '请先打开一个任务再切换联网工具。',
        'error.commandMissing': '/webtoggle 命令未注册（Host 半侧未生效），因此无法切换联网工具。',
        'error.failed': '切换联网工具失败：{reason}',
        'error.failedNoReason': '宿主未返回原因',
        'error.running': '当前任务正在执行，等这一轮结束后再切换联网工具。',
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

    /** The globe glyph: a round window with two meridians and a latitude line. */
    const globeGlyph = () =>
      h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: false },
        h('circle', { cx: 8, cy: 8, r: 5.9, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M8 2.1c1.9 1.6 1.9 10.2 0 11.8M8 2.1c-1.9 1.6-1.9 10.2 0 11.8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M2.4 6.2h11.2M2.4 9.8h11.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
      )

    /**
     * Build the slot component over one plugin context.
     * @param ctx - the Client plugin context (carries the `remote` facade).
     * @returns the React component registered into `conversation.input.left`.
     */
    function createWebToggle(ctx) {
      /** The Remote facade, read lazily because namespaces mount after apply. */
      const remoteOf = () => {
        try {
          return ctx.get('remote')
        } catch (error) {
          return undefined
        }
      }

      return function WebToggle(props) {
        const t = typeof props.t === 'function' ? props.t : (key) => key
        const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : undefined
        // The slot always hands over the session store hook; a deployment without it
        // simply never reports a running turn.
        const useSessions = typeof props.useSessions === 'function' ? props.useSessions : (selector) => selector(undefined)
        const running = useSessions((state) => (state === undefined ? false : state.byId?.[sessionId]?.running === true))

        const [off, setOff] = useState(() => readPreference(sessionId))
        const [busy, setBusy] = useState(false)
        const [note, setNote] = useState(null)
        const aliveRef = useRef(true)
        const busyRef = useRef(false)

        useEffect(() => {
          aliveRef.current = true
          return () => {
            aliveRef.current = false
          }
        }, [])

        // A different Session in the same component: show that Session's state.
        useEffect(() => {
          setNote(null)
          setOff(readPreference(sessionId))
        }, [sessionId])

        useEffect(() => {
          if (note === null) return undefined
          const timer = window.setTimeout(() => {
            if (aliveRef.current) setNote(null)
          }, NOTE_MS)
          return () => window.clearTimeout(timer)
        }, [note])

        /** Show one error in the tool row. */
        const fail = (text) => {
          setNote({ kind: 'error', text, title: text })
          return false
        }

        /** Commit one observed state to the button and to storage. */
        const commit = (nextOff) => {
          setOff(nextOff)
          writePreference(sessionId, nextOff)
        }

        /**
         * Run one `/webtoggle` form and fold the Host's answer into the button.
         * @param rawInput - `on`, `off`, or `status`.
         * @param quiet - true for the mount-time probe, which must not write a note.
         * @returns whether the Host confirmed a state.
         */
        async function invoke(rawInput, quiet = false) {
          if (busyRef.current) return false
          if (sessionId === undefined) return quiet ? false : fail(t('error.noSession'))
          const remote = remoteOf()
          // The generated stub counts three wire parameters: agentId, line, submittedAttachments.
          const commands = remote === undefined ? undefined : remote.commands
          if (commands === undefined || typeof commands.execute !== 'function') {
            return quiet ? false : fail(t('error.noRemote'))
          }
          busyRef.current = true
          if (!quiet) {
            setBusy(true)
            setNote(null)
          }
          try {
            const result = await commands.execute(sessionId, `/webtoggle ${rawInput}`, [])
            if (!aliveRef.current) return false
            if (result === undefined || result.ok !== true) {
              const reason = result === undefined ? t('error.failedNoReason') : describeFailure(result.error, t)
              return quiet ? false : fail(format(t('error.failed'), { reason }))
            }
            // `undefined` means the Host resolved no command with that name.
            const execution = result.value
            if (execution === undefined) return quiet ? false : fail(t('error.commandMissing'))
            const outcome = execution.result
            if (outcome === undefined || outcome.kind !== 'success') {
              // The Host's own text explains refusals precisely (running, no web tools),
              // so it is shown verbatim.
              const text = typeof outcome?.text === 'string' && outcome.text !== '' ? outcome.text : t('error.failedNoReason')
              return quiet ? false : fail(text)
            }
            const marker = parseMarker(outcome.text)
            if (marker !== undefined) commit(marker === 'off')
            if (quiet) return marker !== undefined
            const nextOff = marker === undefined ? readPreference(sessionId) : marker === 'off'
            setNote(
              nextOff
                ? { kind: 'ok', text: t('note.off'), title: t('note.offTitle') }
                : { kind: 'ok', text: t('note.on'), title: t('note.onTitle') },
            )
            return true
          } catch (error) {
            return aliveRef.current && !quiet ? fail(format(t('error.failed'), { reason: describeFailure(error, t) })) : false
          } finally {
            busyRef.current = false
            if (aliveRef.current) setBusy(false)
          }
        }

        // The Host forgets the switch when DSH restarts while this browser remembers it.
        // One `/webtoggle status` reconciles that case; a remembered "on" needs no probe.
        useEffect(() => {
          if (sessionId === undefined || running) return undefined
          if (!readPreference(sessionId)) return undefined
          let cancelled = false
          const timer = window.setTimeout(async () => {
            const remote = remoteOf()
            const commands = remote === undefined ? undefined : remote.commands
            if (cancelled || commands === undefined || typeof commands.execute !== 'function') return
            const before = readPreference(sessionId)
            const answered = await invoke('status', true)
            if (cancelled || !answered || !aliveRef.current) return
            const after = readPreference(sessionId)
            if (before && !after) setNote({ kind: 'ok', text: t('note.syncedOn'), title: t('note.syncedOnTitle') })
            else if (before && after) setNote({ kind: 'ok', text: t('note.syncedOff'), title: t('note.syncedOffTitle') })
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

        const title = running ? t('title.running') : off ? t('title.off') : t('title.on')

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
          note === null
            ? null
            : h('span', { className: 'dswt-note', 'data-kind': note.kind, 'aria-live': 'polite', title: note.title }, note.text),
        )
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
        const WebToggle = createWebToggle(ctx)
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'web-toggle',
              order: 11,
              locale: NS,
              label: () => t('group.aria'),
            },
            WebToggle,
          ),
        )
      },
    }
  },
})
