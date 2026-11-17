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
    /** Cache of the tool catalogue: the panel draws from it instead of asking每开一次。 */
    const CATALOGUE_KEY = 'dsh-web-toggle:catalogue'
    /** Browser-local memory of the last Session drawn, so the global pages can run commands. */
    const LAST_SESSION_KEY = 'dsh-web-toggle:last-session'
    /**
     * Sessions already reconciled with the Host in this page. Kept outside the
     * component so switching away and back neither re-runs `/webtoggle status` nor
     * re-raises the "the host restarted" note; a real page reload clears it.
     */
    const probedSessions = new Set()
    /**
     * Which surfaces the configuration currently shows. The Host owns this, every panel
     * publishes what it learns, and `apply` mounts or unmounts the slots to match — a
     * hidden surface has to leave no empty entry behind, not merely render nothing.
     */
    const liveSurfaces = { plugin: true, settings: true, composer: true }
    /** Remembered surfaces, so a reload draws the same panels before any command runs. */
    const SURFACES_KEY = 'dsh-web-toggle:surfaces'
    try {
      if (typeof localStorage !== 'undefined') {
        const stored = JSON.parse(localStorage.getItem(SURFACES_KEY) ?? 'null')
        if (stored !== null && typeof stored === 'object') {
          for (const key of Object.keys(liveSurfaces)) {
            if (typeof stored[key] === 'boolean') liveSurfaces[key] = stored[key]
          }
        }
      }
    } catch (error) {
      /* 存不下或读不出就用默认值：三个入口都显示 */
    }
    /** Re-sync callbacks run whenever `liveSurfaces` changes. */
    const surfaceWatchers = new Set()

    /**
     * Publish the surfaces one Host answer carried.
     * @param next - the `surfaces` object of a `[web-state]` payload.
     */
    const publishSurfaces = (next) => {
      if (next === null || next === undefined || typeof next !== 'object') return
      let changed = false
      for (const key of Object.keys(liveSurfaces)) {
        const value = next[key]
        if (typeof value !== 'boolean' || value === liveSurfaces[key]) continue
        liveSurfaces[key] = value
        changed = true
      }
      if (!changed) return
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(SURFACES_KEY, JSON.stringify(liveSurfaces))
      } catch (error) {
        /* 记不住就算了：这一次照样生效 */
      }
      for (const watcher of [...surfaceWatchers]) {
        try {
          watcher()
        } catch (error) {
          /* one broken watcher must not stop the others */
        }
      }
    }

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
.dswt-navicon{display:inline-flex;align-items:center;justify-content:center}
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
/* The popover sits absolutely inside the tool row, so it follows the composer no matter
   how the shell transforms it; JS only supplies the offset up to the card's top edge. */
.dswt-pop{position:absolute;z-index:60;left:0;bottom:calc(100% + 6px)}
.dswt-panel{width:min(320px,calc(100vw - 24px));max-height:min(60vh,420px);overflow:auto;display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:var(--dsw-radius-lg,12px);border:.5px solid var(--dsw-alias-border-l1,light-dark(rgba(0,0,0,.12),rgba(255,255,255,.16)));background:var(--dsw-specific-menu,light-dark(#fff,#202127));color:var(--dsw-alias-label-primary,light-dark(#1a1a1a,#f2f3f5));font-size:12px;font-weight:400;line-height:1.5;box-shadow:var(--dsw-elevation-prominent,0 12px 32px light-dark(rgba(0,0,0,.16),rgba(0,0,0,.5)));backdrop-filter:var(--dsw-menu-backdrop-filter,none)}
.dswt-panel[data-inline="true"]{width:auto;max-height:none;overflow:visible;box-shadow:none;padding:0;border:none;background:0 0;backdrop-filter:none;font-size:13px;color:inherit}
.dswt-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600;font-size:13px}
.dswt-section{display:flex;flex-direction:column;gap:6px}
.dswt-section-title{font-weight:600}
.dswt-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dswt-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.45}
.dswt-chips{display:flex;flex-wrap:wrap;gap:4px}
.dswt-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 4px 1px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px}
.dswt-chip button{border:none;background:0 0;cursor:pointer;color:inherit;padding:0 2px;line-height:1;font-size:12px;opacity:.65}
.dswt-chip button:hover{opacity:1}
.dswt-tools{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto;margin:2px 0;padding-right:2px}
.dswt-tool{padding:1px 0}
.dswt-tool-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;display:inline-flex;align-items:center;gap:4px}
.dswt-badge{font-family:inherit;font-size:10px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary);line-height:14px}
.dswt-btn[data-mode="keep"]{color:var(--dsw-alias-state-success-primary,#2f9e44)}
.dswt-btn[data-mode="inspect"]{color:var(--dsw-alias-state-warning-primary,#e8590c)}
.dswt-btn[data-mode="hide"]{opacity:.72}
.dswt-btn[data-mode="refuse"]{color:var(--dswt-danger,#e03131)}
.dswt-refresh{padding:2px 8px;font-size:11px;flex:none}
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
        'note.saved': 'Saved',
        'error.badInput': 'That is not a form this panel sends.',
        'error.noConfig': 'The Host has no configuration row for this plugin, so the panel cannot save.',
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
        'panel.stateOff': 'Off: hidden tools are gone, inspected calls are checked, refused tools stay visible but every call is blocked.',
        'panel.stateOn': 'On: the full tool list is available.',
        'panel.sessionKeep': 'Extra tools this task keeps',
        'panel.globalKeep': 'Extra tools every task keeps',
        'panel.sessionTools': 'Tools in this task',
        'panel.globalTools': 'Tools for every task',
        'panel.filter': 'filter tools',
        'panel.refresh': 'refresh',
        'panel.refreshHint': 'Ask the host for the tool list again (one receipt shows up in the chat).',
        'panel.noTools': 'No tool matches this filter.',
        'panel.mode.keep': 'keep',
        'panel.mode.hide': 'hide',
        'panel.mode.inspect': 'inspect',
        'panel.mode.refuse': 'refuse call',
        'panel.builtIn': 'built-in',
        'panel.cycle': 'Click to switch this tool to the next mode',
        'panel.alwaysOn': 'always shown',
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
        'panel.hint.keep': 'Every tool has one of four modes: keep, hide, inspect every call, or refuse every call. Hiding rewrites the tool list (and costs a cache miss); inspecting and refusing leave the list untouched. A tool named nowhere is inspected.',
        'panel.hint.global': 'This list covers every task. The per-task list lives in the caret beside the composer toggle.',
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
        'note.saved': '已保存',
        'error.badInput': '面板不认识这条写法。',
        'error.noConfig': '宿主里找不到本插件的配置行，面板改不了。',
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
        'panel.stateOff': '已断网：隐藏的工具不再出现；检查的工具保留但每次调用都会看参数；调用时拒绝的工具保留可见但调用一律被拒。',
        'panel.stateOn': '已联网：完整工具列表可用。',
        'panel.sessionKeep': '本任务额外保留的工具',
        'panel.globalKeep': '所有任务额外保留的工具',
        'panel.sessionTools': '本任务的工具',
        'panel.globalTools': '所有任务的工具',
        'panel.filter': '筛选工具',
        'panel.refresh': '刷新',
        'panel.refreshHint': '重新向宿主读一次工具列表（聊天里会出现一条回执）。',
        'panel.noTools': '没有匹配的工具。',
        'panel.mode.keep': '放行',
        'panel.mode.hide': '拒绝',
        'panel.mode.inspect': '检查',
        'panel.mode.refuse': '调用时拒绝',
        'panel.builtIn': '内置',
        'panel.cycle': '点一下切到下一种模式',
        'panel.alwaysOn': '始终显示',
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
        'panel.hint.keep': '每个工具有四种模式：放行、拒绝（从列表移除）、检查（保留可见，每次调用看参数）、调用时拒绝（保留可见，调用一律被拒）。没配置过的工具默认「检查」；「检查」和「调用时拒绝」不会改动工具列表，缓存不掉。',
        'panel.hint.global': '这里是所有任务共用的名单；单个任务的名单在输入框开关旁的小箭头里。',
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

    /**
     * Read the tool catalogue the Host appends to `tools` results.
     * @param text - the command result text.
     * @returns `{ tools }` with one row per tool, or undefined when absent.
     */
    const parseTools = (text) => {
      if (typeof text !== 'string') return undefined
      // The catalogue JSON sits before the [web-state] marker, so it is matched by shape
      // (compact JSON has no spaces) instead of by end-of-string.
      const matched = /\[web-tools\](\{[^\s]*\})/.exec(text)
      if (matched === null) return undefined
      try {
        const parsed = JSON.parse(matched[1])
        if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.tools)) return undefined
        return parsed
      } catch (error) {
        return undefined
      }
    }

    /** Read the cached catalogue; undefined when never fetched or unavailable. */
    const readCatalogueCache = () => {
      try {
        if (typeof localStorage === 'undefined') return undefined
        const raw = localStorage.getItem(CATALOGUE_KEY)
        if (raw === null) return undefined
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.tools)) return undefined
        if (parsed.tools.length === 0) return undefined
        return parsed
      } catch (error) {
        return undefined
      }
    }

    /** Remember the catalogue so the next panel open needs no command round-trip. */
    const writeCatalogueCache = (catalogue) => {
      try {
        if (typeof localStorage === 'undefined') return
        if (catalogue === undefined || !Array.isArray(catalogue.tools)) return
        localStorage.setItem(CATALOGUE_KEY, JSON.stringify({ tools: catalogue.tools }))
      } catch (error) {
        // 存不下就算了：下一次打开就多问一次。
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
    /** One element's box, or null when the environment cannot measure (tests, SSR). */
    const measure = (node) =>
      node !== null && node !== undefined && typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null

    /** The composer card around the tool row: the nearest ancestor tall enough to be it. */
    const cardOf = (element) => {
      let node = element === null || element === undefined ? null : element.parentElement
      let depth = 0
      while (node !== null && node !== undefined && depth < 8) {
        const rect = measure(node)
        if (rect !== null && rect.height >= 80 && rect.width >= 200) return node
        node = node.parentElement
        depth += 1
      }
      return null
    }

    const globeGlyph = (size = 14) =>
      h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, focusable: false },
        h('circle', { cx: 8, cy: 8, r: 5.9, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M8 2.1c1.9 1.6 1.9 10.2 0 11.8M8 2.1c-1.9 1.6-1.9 10.2 0 11.8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M2.4 6.2h11.2M2.4 9.8h11.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
      )

    /** The settings-section glyph. The shell falls back to its generic gear otherwise. */
    const SectionIcon = (props) =>
      h('span', { className: 'dswt-navicon', 'aria-hidden': true }, globeGlyph(props === undefined || props === null || props.size === undefined ? 16 : props.size))

    /** The caret glyph that opens the Session panel. */
    const caretGlyph = () =>
      h(
        'svg',
        { viewBox: '0 0 10 10', width: 10, height: 10, 'aria-hidden': true, focusable: false },
        h('path', { d: 'M2 4l3 3 3-3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )

    /** Read one `on|off` token the way the Host reads it. */
    const switchOf = (token) => {
      const word = typeof token === 'string' ? token.toLowerCase() : ''
      if (word === 'on' || word === 'true' || word === '1' || word === 'show' || word === 'yes') return true
      if (word === 'off' || word === 'false' || word === '0' || word === 'hide' || word === 'no') return false
      return undefined
    }

    /** Read one `keep|hide|inspect` token the way the Host reads it. */
    const modeOf = (token) => {
      const word = typeof token === 'string' ? token.toLowerCase() : ''
      if (word === 'keep' || word === 'on' || word === 'true' || word === '1' || word === 'show' || word === 'yes') return 'keep'
      if (word === 'hide' || word === 'off' || word === 'false' || word === '0' || word === 'drop' || word === 'no') return 'hide'
      if (word === 'inspect' || word === 'check' || word === 'scan' || word === 'match' || word === 'pattern') return 'inspect'
      if (word === 'refuse' || word === 'reject' || word === 'block' || word === 'blocked' || word === 'deny') return 'refuse'
      return undefined
    }

    /**
     * 一条命令打算做什么，从它自己的文本读出来。默认模式（debug 关闭）宿主只回
     * 一句人话，没有机器状态可解析，于是面板按这次请求自己把界面改到位。
     * @param rawInput - 刚发出去的参数文本。
     * @returns `{ kind, ... }`，不是本插件的形态时回 null。
     */
    const planOf = (rawInput) => {
      const [head = '', ...rest] = String(rawInput).trim().split(/\s+/)
      const global = rest.includes('--global')
      const tokens = rest.filter((token) => token !== '--global')
      const action = String(tokens[0] ?? '').toLowerCase()
      if (head === 'on' || head === 'off') return { kind: 'switch', off: head === 'off' }
      if (head === 'surface') {
        const value = switchOf(tokens[1])
        if (action !== 'settings' && action !== 'composer' && action !== 'plugin') return null
        if (value === undefined) return null
        return { kind: 'surface', key: action, value }
      }
      if (head === 'mode') {
        if (action === 'reset' || action === 'clear') return { kind: 'reset', global }
        const name = tokens[0]
        const next = modeOf(tokens[1])
        if (typeof name !== 'string' || name === '' || next === undefined) return null
        return { kind: 'mode', name, mode: next, global }
      }
      if (head === 'keep' || head === 'allow') {
        // 旧写法：keep <tool> on|off / allow add|remove <tool>，都落到同一个模式上。
        if (action === 'reset' || action === 'clear') return { kind: 'reset', global }
        const name = head === 'keep' ? tokens[0] : tokens[1]
        if (typeof name !== 'string' || name === '') return null
        const next = head === 'keep' ? modeOf(tokens[1]) : ['remove', 'rm', 'del', 'delete', '-', 'off'].includes(action) ? 'hide' : 'keep'
        if (next === undefined) return null
        return { kind: 'mode', name, mode: next, global }
      }
      return null
    }

        /**
         * The shared panel body, drawn both in the composer popover (`mode: 'session'`)
         * and on the two configuration pages (`mode: 'global'`). Both show every tool the
         * Host knows with its own switch; the popover edits this Session's layer, the pages
         * edit the global one. The appearance switches sit at the bottom, where the page has
         * room for them.
         * @param props - `t`, `mode`, `state`, `catalogue`, `busy`, `error`, `note`, `onRun`.
         */
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
       * 一条按钮改动怎么写进配置、怎么读回来。
       *
       * 面板里的每次点击都必须静默：走命令会在聊天里留一条 `> webtoggle · …` 回执，
       * 而写配置不会。于是事实来源是配置（`settings` 服务的插件那一行），宿主在每轮
       * 请求前把配置落到 `restrict` / `guard` 上。
       */
      const SETTINGS_NS = 'web-toggle'
      /** 三个入口在配置里对应的字段。 */
      const SURFACE_FIELDS = Object.freeze({ plugin: 'pluginPage', settings: 'settingsSection', composer: 'composerPanel' })
      /** 出厂就带「内容检查」的工具：双用途的那个 shell。 */
      const INSPECT_NAME = 'ops_bash'
      /** 名字以这些前缀开头的工具，出厂按「隐藏」处理。 */
      const HIDE_PREFIXES = ['web_', 'bsk_', 'computer_', 'mcp__', 'video_', 'workbuddy_', 'snowluma_']
      /** 逐个点名隐藏的工具（前缀覆盖不到的联网 / 间接联网通道）。 */
      const DEFAULT_HIDE = new Set([
        'list_mcp_resource_templates', 'list_mcp_resources', 'plugin_manager', 'read_mcp_resource',
        'schedule_create', 'schedule_edit', 'send_message', 'subagent', 'subagent_fork',
        'wait_agent', 'workflow',
      ])
      /** 面板里先摆出来的名字：没有完整工具表时的最小可用集合。 */
      const SUGGESTED = [
        'web_search', 'web_fetch', 'ops_bash', 'computer_use_activate', 'subagent',
        'send_message', 'workflow', 'plugin_manager', 'video_storyboard', 'workbuddy_draw_image',
      ]

      /** 出厂就带意见的工具返回那个模式，其余返回 undefined。 */
      const curatedMode = (name) => {
        const text = typeof name === 'string' ? name : ''
        if (text === INSPECT_NAME) return 'inspect'
        for (const prefix of HIDE_PREFIXES) if (text.startsWith(prefix)) return 'hide'
        if (DEFAULT_HIDE.has(text)) return 'hide'
        return undefined
      }

      /** 没有配置时这个工具是什么模式（与宿主 `defaultMode` 一致）。 */
      const defaultModeFor = (name) => curatedMode(name) ?? 'inspect'

      /** The `settings` Remote namespace, or undefined when the Host has none. */
      const settingsFace = () => {
        const remote = remoteOf()
        const settings = remote === undefined ? undefined : remote.settings
        return settings !== undefined && typeof settings.describe === 'function' && typeof settings.mutate === 'function'
          ? settings
          : undefined
      }

      /** 这条配置行看起来是不是本插件的。 */
      const isOurs = (entry) => {
        const value = entry?.value
        if (value === null || typeof value !== 'object') return false
        return value.toolModes !== undefined || value.sessionModes !== undefined
          || value.offSessions !== undefined || value.composerPanel !== undefined
      }

      /** 读一遍配置：拿到本插件那一行（值、可写性、revision）。 */
      async function readFace(t) {
        const face = settingsFace()
        if (face === undefined) return { ok: false, text: t('error.noRemote') }
        try {
          const response = await face.describe()
          if (response === undefined || response.ok !== true) {
            return { ok: false, text: format(t('error.failed'), { reason: describeFailure(response === undefined ? undefined : response.error, t) }) }
          }
          const value = response.value !== null && typeof response.value === 'object' ? response.value : {}
          const list = Array.isArray(value.namespaces) ? value.namespaces : []
          const view = list.find((entry) => entry !== null && typeof entry === 'object' && entry.ns === SETTINGS_NS)
            ?? list.find((entry) => entry !== null && typeof entry === 'object' && isOurs(entry))
          if (view === undefined) return { ok: false, text: t('error.noConfig') }
          return { ok: true, view, writable: value.writable !== false }
        } catch (error) {
          return { ok: false, text: format(t('error.failed'), { reason: describeFailure(error, t) }) }
        }
      }

      /** 把一层「名字 → 模式」读成干净的表。 */
      const modesIn = (raw) => {
        const out = {}
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
        for (const [name, mode] of Object.entries(raw)) {
          if (typeof name === 'string' && typeof mode === 'string') out[name] = mode
        }
        return out
      }

      /** 从配置行推出面板要画的状态。 */
      const stateFrom = (view, sessionId, writable) => {
        const value = view !== null && typeof view === 'object' && view.value !== null && typeof view.value === 'object' ? view.value : {}
        const sessionModes = value.sessionModes !== null && typeof value.sessionModes === 'object' ? value.sessionModes : {}
        return {
          off: sessionId !== undefined && value.offSessions !== null && typeof value.offSessions === 'object' && value.offSessions[sessionId] === true,
          surfaces: {
            plugin: true,
            settings: value.settingsSection !== false,
            composer: value.composerPanel !== false,
          },
          global: modesIn(value.toolModes),
          session: sessionId === undefined ? {} : modesIn(sessionModes[sessionId]),
          writable: writable !== false,
        }
      }

      /** 面板列出的工具：配置里的 + 上次读到的完整目录 + 出厂建议。 */
      const catalogueFrom = (view, sessionId) => {
        const state = stateFrom(view, sessionId, true)
        const value = view !== null && typeof view === 'object' && view.value !== null && typeof view.value === 'object' ? view.value : {}
        // 宿主每轮把工具目录记进 knownTools：这是完整列表，且读它不用发命令。
        const known = Array.isArray(value.knownTools) ? value.knownTools.filter((name) => typeof name === 'string') : []
        const names = new Set(known.length > 0 ? known : SUGGESTED)
        const cached = readCatalogueCache()
        for (const entry of cached === undefined ? [] : cached.tools) {
          if (typeof entry?.name === 'string') names.add(entry.name)
        }
        for (const name of Object.keys(state.global)) names.add(name)
        for (const name of Object.keys(state.session)) names.add(name)
        const rows = []
        for (const name of names) {
          rows.push({
            name,
            mode: state.session[name] ?? state.global[name] ?? defaultModeFor(name),
            builtIn: curatedMode(name) !== undefined,
          })
        }
        return rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      }

      /** 一条改动对应的配置写入：与继承值相同就去掉这一条，配置里只留真正的偏离。 */
      const opsFor = (plan, view, sessionId) => {
        const state = stateFrom(view, sessionId, true)
        if (plan.kind === 'switch') {
          const path = ['offSessions', sessionId]
          return [plan.off ? { op: 'set', path, value: true } : { op: 'unset', path }]
        }
        if (plan.kind === 'surface') {
          const field = SURFACE_FIELDS[plan.key]
          if (field === undefined) return []
          // 默认就是显示：显示＝去掉这个键，隐藏＝写 false。
          return [plan.value ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value: false }]
        }
        if (plan.kind === 'reset') {
          return [plan.global ? { op: 'unset', path: ['toolModes'] } : { op: 'unset', path: ['sessionModes', sessionId] }]
        }
        if (plan.kind === 'mode') {
          const inherited = plan.global ? defaultModeFor(plan.name) : (state.global[plan.name] ?? defaultModeFor(plan.name))
          const path = plan.global ? ['toolModes', plan.name] : ['sessionModes', sessionId, plan.name]
          return [plan.mode === inherited ? { op: 'unset', path } : { op: 'set', path, value: plan.mode }]
        }
        return []
      }

      /** 一次写入；失败时把人话错误交回去。 */
      async function writeOps(face, view, ops, t) {
        try {
          const response = await face.mutate(view.ns, ops, view.revision)
          if (response === undefined || response.ok !== true) {
            return { ok: false, text: format(t('error.failed'), { reason: describeFailure(response === undefined ? undefined : response.error, t) }) }
          }
          return { ok: true }
        } catch (error) {
          return { ok: false, text: format(t('error.failed'), { reason: describeFailure(error, t) }) }
        }
      }

      /**
       * 执行面板的一次操作：写配置、读回状态与目录。
       * 外形与旧的命令回执一致（`text` 里仍附带 `[web-tools]`），所以上层的
       * `parseTools` / `applyPlan` / 目录缓存都不用改。
       * @param sessionId - the Session the panel is drawn for.
       * @param rawInput - 面板发出的同一套文本（`on|off|surface …|mode …|tools`）。
       * @param t - the translator.
       * @returns `{ ok, text, state, off }`; `ok` false carries a rendered message.
       */
      async function run(sessionId, rawInput, t) {
        if (sessionId === undefined) return { ok: false, text: t('error.noSession'), state: undefined }
        const face = settingsFace()
        if (face === undefined) return { ok: false, text: t('error.noRemote'), state: undefined }
        const plan = planOf(rawInput)
        const reading = plan === null && /^(tools|status)(\s|$)/i.test(String(rawInput).trim())
        if (plan === null && !reading) return { ok: false, text: t('error.badInput'), state: undefined }
        const read = await readFace(t)
        if (read.ok !== true) return { ok: false, text: read.text, state: undefined }
        if (read.writable === false) {
          return { ok: false, text: t('panel.hint.readonly'), state: stateFrom(read.view, sessionId, false) }
        }
        if (plan !== null) {
          const ops = opsFor(plan, read.view, sessionId)
          if (ops.length > 0) {
            const written = await writeOps(face, read.view, ops, t)
            if (written.ok !== true) return { ok: false, text: written.text, state: stateFrom(read.view, sessionId, true) }
          }
        }
        const fresh = plan === null ? read : await readFace(t)
        if (fresh.ok !== true) return { ok: false, text: fresh.text, state: undefined }
        const state = stateFrom(fresh.view, sessionId, true)
        const tools = catalogueFrom(fresh.view, sessionId)
        return {
          ok: true,
          text: `${t('note.saved')} [web-tools]${JSON.stringify({ tools })}`,
          state,
          off: state.off,
        }
      }

      function PanelView(props) {
        const t = props.t
        const state = props.state
        const global = props.mode === 'global'
        const [filter, setFilter] = useState('')
        const disabled = props.busy === true
        const writable = state === null || state === undefined ? true : state.writable !== false
        const surfaces = state?.surfaces ?? liveSurfaces
        const catalogue = Array.isArray(props.catalogue) ? props.catalogue : []
        const needle = filter.trim().toLowerCase()
        // 三态循环的顺序：保留 → 隐藏 → 内容检查 → 保留。
        const MODE_CYCLE = ['keep', 'hide', 'inspect', 'refuse']
        const currentMode = (entry) => (MODE_CYCLE.includes(entry.mode) ? entry.mode : 'keep')
        const nextMode = (mode) => MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length]
        const modeLabel = (mode) => t(`panel.mode.${MODE_CYCLE.includes(mode) ? mode : 'keep'}`)
        const rows = catalogue.filter((entry) => needle === '' || String(entry.name).toLowerCase().includes(needle))
        const scopeFlag = global ? ' --global' : ''

        const surfaceRow = (key, labelKey) =>
          h(
            'div',
            { className: 'dswt-row', key },
            h('span', null, t(labelKey)),
            key === 'plugin'
              ? h('span', { className: 'dswt-hint' }, t('panel.alwaysOn'))
              : h(
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
          h(
            'div',
            { className: 'dswt-section' },
            h('div', { className: 'dswt-section-title' }, global ? t('panel.globalTools') : t('panel.sessionTools')),
            h(
              'div',
              { className: 'dswt-add' },
              h('input', {
                className: 'dswt-input',
                value: filter,
                placeholder: t('panel.filter'),
                spellCheck: false,
                disabled,
                onChange: (event) => setFilter(event.target.value),
              }),
              null === props.onRefresh || props.onRefresh === undefined
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dswt-btn dswt-refresh',
                      disabled,
                      title: t('panel.refreshHint'),
                      onClick: () => props.onRefresh(),
                    },
                    t('panel.refresh'),
                  ),
            ),
            rows.length === 0
              ? h('div', { className: 'dswt-hint' }, t('panel.noTools'))
              : h(
                  'div',
                  { className: 'dswt-tools' },
                  rows.map((entry) =>
                    h(
                      'div',
                      { className: 'dswt-row dswt-tool', key: entry.name },
                      h(
                        'span',
                        { className: 'dswt-tool-name', title: entry.name },
                        entry.name,
                        entry.builtIn === true ? h('span', { className: 'dswt-badge' }, t('panel.builtIn')) : null,
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dswt-btn',
                          'data-mode': currentMode(entry),
                          disabled: disabled || !writable,
                          title: t('panel.cycle'),
                          onClick: () => props.onRun(`mode ${entry.name} ${nextMode(currentMode(entry))}${scopeFlag}`),
                        },
                        modeLabel(currentMode(entry)),
                      ),
                    ),
                  ),
                ),
            h('div', { className: 'dswt-hint' }, t('panel.hint.keep')),
          ),
          h(
            'div',
            { className: 'dswt-section' },
            h('div', { className: 'dswt-section-title' }, t('panel.surfaceTitle')),
            surfaceRow('plugin', 'panel.surface.plugin'),
            surfaceRow('settings', 'panel.surface.settings'),
            surfaceRow('composer', 'panel.surface.composer'),
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
        // The catalogue the popover lists: asked for when the panel opens, refreshed after
        // every edit so the switches keep matching what the Host actually keeps.
        const [catalogue, setCatalogue] = useState([])
        // A local mirror of the published surfaces, so hiding the caret re-renders at once.
        const [surfaces, setSurfaces] = useState({ ...liveSurfaces })
        const rootRef = useRef(null)
        const caretRef = useRef(null)
        const aliveRef = useRef(true)
        const busyRef = useRef(false)

        useEffect(() => {
          aliveRef.current = true
          return () => {
            aliveRef.current = false
          }
        }, [])

        // Follow the surfaces the configuration publishes, wherever they were published.
        useEffect(() => {
          const watcher = () => setSurfaces({ ...liveSurfaces })
          surfaceWatchers.add(watcher)
          return () => {
            surfaceWatchers.delete(watcher)
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

        // The popover is positioned against the composer card, not the viewport: fixed
        // coordinates break inside transformed ancestors, and the panel belongs above the
        // card, not over the text the user is typing.
        useEffect(() => {
          if (!open) return undefined
          let attempts = 0
          const place = () => {
            const element = rootRef.current
            if (element === null || element === undefined) {
              // No ref (a shell that mounts the cell differently): keep the panel usable
              // rather than dropping it.
              setAnchor({ left: 0, bottom: 32 })
              return
            }
            const rootRect = measure(element)
            const card = cardOf(element)
            const cardRect = card === null ? rootRect : measure(card)
            if (rootRect === null || cardRect === null || rootRect.width === 0 || cardRect.height === 0) {
              // Layout is not ready yet: show the panel at a safe default and look again
              // on the next frame so it never opens at a stale position.
              setAnchor({ left: 0, bottom: 32 })
              if (attempts < 5 && typeof window.requestAnimationFrame === 'function') {
                attempts += 1
                window.requestAnimationFrame(place)
              }
              return
            }
            setAnchor({
              left: Math.round(cardRect.left - rootRect.left),
              bottom: Math.round(rootRect.bottom - cardRect.top + 8),
            })
          }
          place()
          window.addEventListener('resize', place)
          window.addEventListener('scroll', place, true)
          const dismiss = (event) => {
            const element = rootRef.current
            if (element !== null && element !== undefined && element.contains(event.target)) return
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

        /** 把一条改动落到浮层的面板状态与工具目录上。 */
        const applyPlan = (plan) => {
          if (plan === null) return false
          if (plan.kind === 'switch') {
            commit(plan.off)
            return true
          }
          if (plan.kind === 'surface') {
            setPanel((current) => (current === null ? current : { ...current, surfaces: { ...current.surfaces, [plan.key]: plan.value } }))
            publishSurfaces({ ...liveSurfaces, [plan.key]: plan.value })
            return true
          }
          if (plan.kind === 'mode') {
            setCatalogue((rows) => rows.map((row) => (row.name === plan.name ? { ...row, mode: plan.mode } : row)))
            setPanel((current) => {
              if (current === null) return current
              const field = plan.global ? 'global' : 'session'
              const table = current[field] !== null && typeof current[field] === 'object' ? { ...current[field] } : {}
              table[plan.name] = plan.mode
              return { ...current, [field]: table }
            })
            return true
          }
          return false
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
            if (cancelled || settingsFace() === undefined) return
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
          const next = !off
          void invoke(next ? 'off' : 'on').then((outcome) => {
            // 默认模式里回执没有机器标记：按这次请求自己把按钮改到位。
            if (outcome.ok && outcome.off === undefined) commit(next)
          })
        }

        /** Ask the Host for the catalogue and fold its state into the panel. */
        const loadCatalogue = async () => {
          const outcome = await run(sessionId, 'tools --json', t)
          if (!aliveRef.current) return outcome
          if (outcome.state !== undefined) {
            setPanel(outcome.state)
            publishSurfaces(outcome.state.surfaces)
          }
          const parsed = parseTools(outcome.text)
          if (parsed !== undefined) {
            setCatalogue(parsed.tools)
            writeCatalogueCache(parsed)
          }
          return outcome
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
          if (outcome.off !== undefined) commit(outcome.off)
          if (outcome.state !== undefined) {
            setPanel(outcome.state)
            publishSurfaces(outcome.state.surfaces)
          }
          if (!outcome.ok) {
            setPanelBusy(false)
            setPanelError(outcome.text)
            return false
          }
          // 默认模式里回执没有机器状态，按这次请求自己把面板改到位；只有整份名单
          // 被换掉的 reset/clear 才需要再问一次目录。
          if (!applyPlan(planOf(rawInput))) await loadCatalogue()
          if (!aliveRef.current) return false
          setPanelBusy(false)
          setPanelNote(t('panel.note.saved'))
          return true
        }

        /** Re-read the catalogue on demand: this is the one command that prints a receipt. */
        const refreshCatalogue = () => {
          if (sessionId === undefined) return
          setPanelBusy(true)
          void loadCatalogue().then(() => {
            if (aliveRef.current) setPanelBusy(false)
          })
        }

        /** Open the popover, asking the Host for the state and the catalogue it draws. */
        const openPanel = () => {
          const next = !open
          setOpen(next)
          if (!next) return
          setPanelError(null)
          if (panel !== null && catalogue.length > 0) return
          // 目录里几百个名字，写进聊天只是噪音：缓存命中就只画缓存，不发命令。
          const cached = readCatalogueCache()
          if (cached !== undefined) {
            setCatalogue(cached.tools)
            return
          }
          setPanelBusy(true)
          // 一次 `tools --json` 就够：它的回执同时带状态和目录，比 status+tools 少一条聊天回执。
          Promise.resolve(run(sessionId, 'tools --json', t)).then((tools) => {
            if (!aliveRef.current) return
            setPanelBusy(false)
            if (tools.state !== undefined) {
              setPanel(tools.state)
              publishSurfaces(tools.state.surfaces)
            }
            const parsed = parseTools(tools.text)
            if (parsed !== undefined) {
              setCatalogue(parsed.tools)
              writeCatalogueCache(parsed)
            }
            if (!tools.ok) setPanelError(tools.text)
          })
        }

        const title = running ? t('title.running') : off ? t('title.off') : t('title.on')
        // The caret follows the configuration; hiding it hands this Session's list to the
        // configuration pages, which stay reachable either way.
        const showCaret = surfaces.composer !== false

        return h(
          'div',
          { className: 'dswt-root', ref: rootRef, 'data-off': off ? 'true' : 'false', 'data-busy': busy ? 'true' : 'false', role: 'group', 'aria-label': t('group.aria') },
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
                { className: 'dswt-pop', style: { left: anchor.left + 'px', bottom: anchor.bottom + 'px' } },
                h(PanelView, {
                  t,
                  mode: 'session',
                  state: panel,
                  catalogue,
                  busy: panelBusy,
                  error: panelError,
                  note: panelNote,
                  onRun: panelRun,
                  onRefresh: refreshCatalogue,
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
        const [catalogue, setCatalogue] = useState([])
        const aliveRef = useRef(true)

        useEffect(() => {
          aliveRef.current = true
          return () => {
            aliveRef.current = false
          }
        }, [])

        // One `status` and one `tools` on mount give the page the configuration and the
        // catalogue it draws.
        useEffect(() => {
          let cancelled = false
          // 先画缓存：目录几百行，写进聊天就是噪音，默认不为它付一条回执。
          const cached = readCatalogueCache()
          if (cached !== undefined) {
            setCatalogue(cached.tools)
            return () => {
              cancelled = true
            }
          }
          setBusy(true)
          Promise.resolve(run('tools --json', t)).then((tools) => {
            if (cancelled || !aliveRef.current) return
            setBusy(false)
            if (tools.state !== undefined) {
              setState(tools.state)
              publishSurfaces(tools.state.surfaces)
            }
            const parsed = parseTools(tools.text)
            if (parsed !== undefined) {
              setCatalogue(parsed.tools)
              writeCatalogueCache(parsed)
            }
            if (!tools.ok) setError(tools.text)
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
          if (outcome.state !== undefined) {
            setState(outcome.state)
            publishSurfaces(outcome.state.surfaces)
          }
          if (!outcome.ok) {
            setBusy(false)
            setError(outcome.text)
            return false
          }
          // 默认模式里回执只有一句人话：配置页同样按这次请求自己改界面，只有
          // reset/clear 这种整份名单被换掉的操作才回头重新读目录。
          const plan = planOf(rawInput)
          if (plan !== null && plan.kind === 'mode') {
            setCatalogue((rows) => rows.map((row) => (row.name === plan.name ? { ...row, mode: plan.mode } : row)))
            setState((current) => {
              if (current === null) return current
              const table = current.global !== null && typeof current.global === 'object' ? { ...current.global } : {}
              table[plan.name] = plan.mode
              return { ...current, global: table }
            })
          } else if (plan !== null && plan.kind === 'surface') {
            setState((current) => (current === null ? current : { ...current, surfaces: { ...current.surfaces, [plan.key]: plan.value } }))
            publishSurfaces({ ...liveSurfaces, [plan.key]: plan.value })
          } else {
            const tools = await run('tools --json', t)
            if (!aliveRef.current) return false
            const parsed = parseTools(tools.text)
            if (parsed !== undefined) {
              setCatalogue(parsed.tools)
              writeCatalogueCache(parsed)
            }
            if (tools.state !== undefined) {
              setState(tools.state)
              publishSurfaces(tools.state.surfaces)
            }
          }
          setBusy(false)
          setNote(t('panel.note.saved'))
          return true
        }

        /** 页面上的「刷新」：只有这一步会真的发命令、在聊天里留一条回执。 */
        const refresh = () => {
          setBusy(true)
          void run('tools --json', t).then((tools) => {
            if (!aliveRef.current) return
            setBusy(false)
            const parsed = parseTools(tools.text)
            if (parsed !== undefined) {
              setCatalogue(parsed.tools)
              writeCatalogueCache(parsed)
            }
            if (tools.state !== undefined) {
              setState(tools.state)
              publishSurfaces(tools.state.surfaces)
            }
            if (!tools.ok) setError(tools.text)
          })
        }

        // A hidden surface is unmounted by `apply`, never drawn: rendering nothing would
        // still leave an empty entry in the sidebar.
        if (liveSurfaces[surface] === false) return null
        return h(ui.PanelView, {
          t,
          mode: 'global',
          state,
          catalogue,
          busy,
          error,
          note,
          onRun,
          onRefresh: refresh,
        })
      }
    }

    return {
      // `remote` and `remote.commands` gate activation until the Host Remotes this
      // control calls are mounted.
      inject: ['slots', 'locale', 'remote', 'remote.commands', 'remote.settings'],
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

        // Slots are mounted on demand: a surface the configuration hides must leave no
        // empty entry behind, so "hidden" means the registration itself goes away.
        const mounts = { composer: null, plugin: null, settings: null }

        /** Turn a Cordis effect handle into a function that always disposes it. */
        const disposeOf = (handle) => {
          if (typeof handle === 'function') return handle
          if (handle !== null && typeof handle === 'object' && typeof handle.dispose === 'function') return () => handle.dispose()
          return () => {}
        }

        /** Mount or unmount one slot so it matches `wanted`. */
        const syncSlot = (key, wanted, label, mount) => {
          if (wanted === true && mounts[key] === null) mounts[key] = disposeOf(ctx.effect(mount, label))
          if (wanted !== true && mounts[key] !== null) {
            const dispose = mounts[key]
            mounts[key] = null
            dispose()
          }
        }

        /** Re-sync every optional slot with the published surfaces. */
        const syncSlots = () => {
          // Composer: the toggle, its caret, and the Session popover.
          syncSlot('composer', liveSurfaces.composer !== false, 'web-toggle: composer slot', () =>
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
            ),
          )

          // This bundle's detail page. It is the guaranteed entry and never unmounts:
          // the other two surfaces can be hidden, this one is how they come back.
          syncSlot('plugin', true, 'web-toggle: detail slot', () =>
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
            ),
          )

          // Settings sidebar: the page and its glyph go together.
          syncSlot('settings', liveSurfaces.settings !== false, 'web-toggle: settings slot', () => {
            const stopPage = disposeOf(
              ctx.effect(
                () =>
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
                  ),
                'web-toggle: settings section',
              ),
            )
            const stopIcon = disposeOf(
              ctx.effect(
                () => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: 'web-toggle' }, SectionIcon)),
                'web-toggle: settings icon',
              ),
            )
            return () => {
              stopPage()
              stopIcon()
            }
          })
        }

        surfaceWatchers.add(syncSlots)
        ctx.effect(
          () => () => {
            surfaceWatchers.delete(syncSlots)
          },
          'web-toggle: surface watcher',
        )
        syncSlots()
      },
    }
  },
})
