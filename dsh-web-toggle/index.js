/**
 * Host half of the web-toggle bundle: a per-Session network switch.
 *
 * Registers `/webtoggle [on|off|status]`. Turning the switch off keeps ONLY the
 * tools that cannot reach the network, through one `agent.ctx.tools.restrict()`
 * call on that Agent (scope-bound, so it never leaks to another Session), and
 * keeps the exact disposer that lifts it. Turning it on calls that disposer.
 *
 * Why an allowlist instead of denying `web_search`/`web_fetch`: those are only the
 * official network tools. A browser tool can open a page, an MCP server can forward
 * a request. Keeping the local tools and hiding everything else is the closed form:
 * a tool a later plugin adds stays hidden until it is named here.
 *
 * `ops_bash` is the one dual-use tool that stays: it is the only way to do local work
 * (build, test, move files), so it is kept visible and fenced by a command guard that
 * refuses calls which look like network traffic. That guard is a filter, not a wall —
 * see README for the limits.
 *
 * The tool catalog changes under a live Session, so the next admitted step starts
 * a new request series: the recorded series can no longer describe the catalog,
 * and a rebuilt series sends the new declarations instead of "deferred additions".
 *
 * The Host half has no locale service, so command text is bilingual.
 *
 * Configuration lives in this plugin's own profile row and is written through the
 * config editor, never by rewriting `cordis.patch.yml` by hand. Every field is
 * `.volatile()`, so an edit lands in the running instance instead of restarting the
 * plugin: `config.field.get()` is the only read path.
 */

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import z from '@deepseek-ai/schemastery'

export const inject = ['commands', 'agents', 'tools']

/** The command name. */
const COMMAND = 'webtoggle'

/**
 * The bundle's settings. The first three decide which configuration surfaces the
 * browser half draws; `globalTools` and `sessionTools` widen the allowlist beyond the
 * built-in local names — per deployment, and per Session.
 */
export const Config = z.object({
  pluginPage: z.boolean().default(true).volatile().description('Reserved: the bundle detail page is always shown, because it is the entry that restores the other panels.'),
  settingsSection: z.boolean().default(true).volatile().description('Add a "Web switch" section to the settings sidebar.'),
  composerPanel: z.boolean().default(true).volatile().description('Show the small arrow next to the composer toggle that opens this Session\'s panel.'),
  globalTools: z.array(z.string()).default([]).volatile().description('Extra tool names every Session keeps while the network is off.'),
  sessionTools: z.dict(z.array(z.string())).default({}).volatile().description('Extra tool names kept for one Session, keyed by Session id.'),
})

/** Settings field of each browser surface, keyed by the name the command accepts. */
const SURFACE_FIELDS = Object.freeze({
  plugin: 'pluginPage',
  settings: 'settingsSection',
  composer: 'composerPanel',
})

/**
 * The tools the switch leaves visible: every one of them only touches this machine.
 * Files, search, planning, context bookkeeping, skills, jobs. Anything that can open
 * a socket — `ops_bash`, the browser tools, MCP servers, media generation, sub-agents,
 * the plugin manager, scheduled tasks — is deliberately absent, so "off" cannot leak.
 */
const LOCAL_TOOLS = [
  'acp_cache',
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
]

/**
 * Dual-use tools that stay visible while the switch is off, each fenced by a guard
 * instead of being hidden: `ops_bash` still runs local commands, but a command that
 * looks like network traffic is refused before it starts.
 */
/**
 * Every denial ends with this. It is written as an instruction, not a description:
 * the model must not go looking for another route to the network (a different tool,
 * a script file, an encoded payload, a child process all count), and when it genuinely
 * needs the network it should stop and ask the user to flip the switch back on.
 */
const OFFLINE_NOTICE =
  '规则：本会话暂时不允许使用一切形式的联网工具。不要换别的工具、不要写脚本或编码后执行、' +
  '不要起子进程去找替代通道——开关打开之前这里的任何联网尝试都会被拦下。真的需要联网时，' +
  '停下来向用户说明「需要联网」，请用户暂时打开开关；如果怀疑是误判，也照此处理。 / ' +
  'Rule: this task currently allows no networked tools of any kind. Do not reach for another ' +
  'tool, do not write a script or encode a payload to run, do not spawn a child process looking ' +
  'for a side channel — every networked attempt is blocked here until the switch is on. If you ' +
  'genuinely need the network, stop and tell the user you need it, and ask them to turn the ' +
  'switch back on for a while. Do the same if you suspect a false positive.'

const GUARDED_TOOLS = ['ops_bash']

/**
 * A name no deployment registers. `restrict()` validates before it applies anything, so
 * handing it this name is a free catalogue read: the error names every tool that scope
 * would accept, and nothing is left armed.
 */
const PROBE_NAME = '__webtoggle_probe__'

/**
 * Words that mean "this command wants the network": binaries, schemes, package fetches,
 * and the module names an interpreter needs before it can open a socket.
 *
 * Two rules were deliberately removed after a red-team pass, because they fired on
 * ordinary local work: a bare dotted quad (version numbers, build ids, log fragments)
 * and `asyncio` itself (`asyncio.sleep` is local; only `open_connection` leaves).
 */
const NETWORK_COMMAND = new RegExp(
  [
    // 命令行客户端
    String.raw`\b(curl|wget|nc|netcat|ncat|telnet|ssh|scp|sftp|ftp|lftp|socat|rsync|arp|nslookup|dig|ping|tracert|traceroute|whois)\b`,
    // PowerShell / .NET：拆段拼 URL 时类型名仍会露出来
    String.raw`\b(Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|bitsadmin|certutil|mshta|DownloadString|DownloadFile|WebClient|HttpClient|WebRequest|TcpClient|UdpClient|System\.Net|EncodedCommand)\b`,
    // 联网式仓库操作
    String.raw`\b(git|hg)\s+(clone|fetch|pull|push|ls-remote|archive|submodule)\b`,
    // 包管理器：只列会走 registry 的子命令，run/test/build/ls 这类本地命令不受影响
    String.raw`\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|rm|uninstall|update|up|upgrade|ci|pack|publish|view|info|show|search|audit|outdated|login|logout|adduser|whoami|token|dist-tag|deprecate|unpublish|star|stars|owner|access|org|team|repo|docs|home|ping|fetch|fund|cache|exec|dlx|create)\b`,
    String.raw`\b(pip|pip3|pipx|poetry|uv|cargo|go|gem|composer|dotnet)\s+(install|get|add|fetch|publish|index|download|update)\b`,
    String.raw`\bgh\s+(api|repo|release|pr|issue|auth|workflow|search|gist)\b`,
    // 脚本层：导入网络模块
    String.raw`(require|import|from)\s*\(?\s*['"](node:)?(https?|net|tls|dns|dgram|undici|ws|child_process|aiohttp|httpx)['"]`,
    String.raw`\bimport\s+(socket|ssl|ftplib|smtplib|poplib|imaplib|telnetlib|xmlrpc|webbrowser|http\.client|urllib|requests)\b`,
    String.raw`\bfrom\s+(socket|ssl|ftplib|smtplib|poplib|imaplib|telnetlib|xmlrpc|webbrowser|urllib|http)\s+import\b`,
    // 直接调网络函数（不写 import 也能连）
    String.raw`\b(socket\.socket|create_connection|open_connection|getaddrinfo|gethostbyname|wrap_socket|create_default_context|SSLSocket)\b`,
    String.raw`\b(urllib|http\.client|httpx|aiohttp|axios|node-fetch|XMLHttpRequest)\b`,
    // 动态导入与解码载荷：`__import__('so'+'cket')`、`b64decode(...)` 都是藏名字的写法
    String.raw`__import__\s*\(\s*['"]?(socket|ssl|urllib|requests|http)`,
    String.raw`\b(b64decode|unhexlify|fromhex)\b`,
    // 编码载荷再交给解释器
    String.raw`\bbase64\s+(-d|--decode|-[dD])\b[^|]*\|\s*(ba|da|z)?sh\b`,
    String.raw`\bbase64\s+(-d|--decode|-[dD])\b[^|]*\|\s*(xargs|eval|node|python|perl)\b`,
    // URL / UNC / SMB
    String.raw`\b(https?|ftp|wss?)://`,
    String.raw`\\\\[A-Za-z0-9_.$-]+\b`,
    String.raw`\bnet\s+use\b|\bNew-PSDrive\b`,
  ].join('|'),
  'i',
)

/**
 * The same keyword test with quoting tricks undone: `import so''cket`, `"cur""l"`,
 * `c\url` and `${IFS}` separated words all collapse to the literal the shell or the
 * interpreter ends up executing.
 * @param text - one command or script body.
 * @returns the collapsed form used for a second match pass.
 */
const squashQuotes = (text) =>
  text
    .replace(/['"`^\\+]/g, '')
    .replace(/\$\{?ifs\}?/gi, '')
    .replace(/\s+/g, ' ')

/**
 * Does this text look like network traffic?
 * @param text - a command line or a script body.
 * @returns true when either the literal or the de-quoted form matches.
 */
const looksNetworked = (text) => NETWORK_COMMAND.test(text) || NETWORK_COMMAND.test(squashQuotes(text))

/** Scripts a shell can hand to an interpreter, by extension. */
const SCRIPT_EXT = /\.(py|pyw|js|mjs|cjs|ts|mts|cts|sh|zsh|bash|ps1|psm1|rb|pl|php|bat|cmd)$/i

/** Interpreters that take a file argument. */
const INTERPRETER =
  /(^|[\s;&|(])(python3?|py|node|nodejs|bun|deno|ruby|perl|php|bash|sh|zsh|pwsh|powershell|source)(?=[\s;&|)]|$)/i

/** Read at most this much of a script before giving up (a huge file is not a script we fence). */
const MAX_SCRIPT_BYTES = 256 * 1024

/**
 * Split a command line into argument-ish tokens, keeping quoted runs together.
 * @param command - the raw command.
 * @returns the tokens with their quotes removed.
 */
function tokensOf(command) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = re.exec(command)) !== null) out.push(match[1] ?? match[2] ?? match[3])
  return out
}

/**
 * Files in this command line that look like scripts.
 * @param command - the raw command.
 * @returns one entry per candidate path.
 */
function scriptRefs(command) {
  const refs = []
  for (const token of tokensOf(command)) {
    const text = token.replace(/^['"]|['"]$/g, '')
    if (text.length === 0 || text.startsWith('-')) continue
    if (SCRIPT_EXT.test(text)) refs.push(text)
  }
  return refs
}

/**
 * Read a script a command is about to run, resolving it against the directories the
 * call could be using. Returns undefined when nothing readable is found, in which case
 * the call is allowed: a fence that fails closed on an unreadable path would break
 * ordinary work, and a script that is not on disk cannot run either.
 * @param exec - the pending execution, for `workdir` and the Session directory.
 * @param ref - the path from the command line.
 * @returns the script text, or undefined.
 */
function readScript(exec, ref) {
  const bases = []
  const args = exec.arguments
  if (args !== null && typeof args === 'object' && typeof args.workdir === 'string' && args.workdir !== '')
    bases.push(args.workdir)
  const cwd = exec.agent?.session?.cwd
  if (typeof cwd === 'string' && cwd !== '') bases.push(cwd)
  bases.push(process.cwd())
  for (const base of bases) {
    const path = isAbsolute(ref) ? ref : resolve(base, ref)
    try {
      if (statSync(path).size > MAX_SCRIPT_BYTES) return ''
      return readFileSync(path, 'utf8')
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Inspect the scripts a command line is about to run, one level deep, because writing
 * a script and running it was the cheapest way around a text-only fence.
 * @param exec - the pending execution.
 * @param command - a command line or the body of another script.
 * @param depth - how many hops are still allowed.
 * @returns a denial reason, or undefined.
 */
function inspectScripts(exec, command, depth = 0) {
  if (!INTERPRETER.test(command) && !/(^|[\s;&|])[./]/.test(command)) return undefined
  for (const ref of scriptRefs(command)) {
    const text = readScript(exec, ref)
    if (text === undefined || text === '') continue
    if (looksNetworked(text)) return `本会话已断网：脚本 ${ref} 里含联网调用，执行前被拦下。`
    if (depth < 1) {
      const nested = inspectScripts(exec, text, depth + 1)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** `npm run x` / `pnpm x` / `yarn x` / `bun x`. */
const PACKAGE_SCRIPT = /(?:^|[\s;&|(])npm\s+(?:run|run-script)\s+([^\s;&|]+)|(?:^|[\s;&|(])(?:pnpm|yarn|bun)\s+(?:run\s+)?([^\s;&|]+)/i

/**
 * Read a script body out of the nearest package.json.
 * @param exec - the pending execution, for `workdir` and the Session directory.
 * @param name - the script name.
 * @returns the body, or undefined when no package.json names it.
 */
function packageScriptBody(exec, name) {
  const args = exec.arguments
  const bases = []
  if (args !== null && typeof args === 'object' && typeof args.workdir === 'string' && args.workdir !== '')
    bases.push(args.workdir)
  const cwd = exec.agent?.session?.cwd
  if (typeof cwd === 'string' && cwd !== '') bases.push(cwd)
  bases.push(process.cwd())
  for (const base of bases) {
    try {
      const file = resolve(base, 'package.json')
      if (statSync(file).size > MAX_SCRIPT_BYTES) continue
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const body = parsed?.scripts?.[name]
      if (typeof body === 'string') return body
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * `npm run deploy` where deploy is `curl ...` is the same request as `curl ...`,
 * only one indirection away. Look the body up and apply the same rules to it.
 * @param exec - the pending execution.
 * @param command - the command line.
 * @returns a denial reason, or undefined.
 */
function inspectPackageScript(exec, command) {
  const match = PACKAGE_SCRIPT.exec(command)
  if (match === null) return undefined
  const name = match[1] ?? match[2]
  if (typeof name !== 'string' || name.startsWith('-')) return undefined
  const body = packageScriptBody(exec, name)
  if (typeof body !== 'string') return undefined
  if (looksNetworked(body)) return `本会话已断网：脚本 ${name} 里含联网调用，执行前被拦下。`
  const nested = inspectScripts(exec, body)
  if (nested !== undefined) return nested
  return undefined
}

/** Short machine marker appended to every result text, so the browser half reads state without parsing prose. */
const markerOf = (off) => `[web:${off ? 'off' : 'on'}]`

/** Render one thrown value as a short message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** Read a value, treating a throw as absent (a service may detach mid-call). */
const safely = (read) => {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * Mount the `/webtoggle` command and the series-restart listener.
 * @param ctx - the plugin context.
 */
export function apply(ctx, config) {
  /**
   * Read one configuration field. A build that mounted us without the schema
   * (an old profile row, a test harness) falls back to the documented default,
   * so the switch keeps working instead of throwing on every command.
   * @param name - the Config field.
   * @param fallback - the value to use when the field is absent.
   * @returns the live value.
   */
  function conf(name, fallback) {
    const ref = config === null || config === undefined ? undefined : config[name]
    if (ref === undefined || ref === null) return fallback
    return typeof ref.get === 'function' ? ref.get() : ref
  }

  /** One list-of-tool-names field, copied into a fresh array of non-empty strings. */
  function confTools(name) {
    const value = conf(name, [])
    if (!Array.isArray(value)) return []
    return value.filter((entry) => typeof entry === 'string' && entry !== '')
  }

  /** The extra tool names configured for one Session. */
  function sessionToolsOf(sessionId) {
    if (sessionId === undefined) return []
    const map = conf('sessionTools', {})
    if (map === null || typeof map !== 'object') return []
    const list = map[sessionId]
    if (!Array.isArray(list)) return []
    return list.filter((entry) => typeof entry === 'string' && entry !== '')
  }

  /**
   * The three surface switches, as the browser half reads them. The bundle detail page
   * is always shown: it is the guaranteed place to undo a hidden surface, so the
   * configuration can hide the other two but never lock itself out.
   */
  function surfacesOf() {
    return {
      plugin: true,
      settings: conf('settingsSection', true) === true,
      composer: conf('composerPanel', true) === true,
    }
  }

  /** Whether this profile can persist a configuration edit right now. */
  function canSave() {
    const editor = safely(() => ctx.get('configEditor'))
    if (editor === undefined || typeof editor.edit !== 'function') return false
    return safely(() => ctx.fiber.entry) !== undefined
  }

  /** Serialized configuration writes, so two clicks never interleave. */
  let saves = Promise.resolve()

  /**
   * Persist one configuration change through the profile's config editor. The
   * updater receives the row's current plain values and returns the next ones;
   * volatile fields make the running instance adopt them without a restart.
   * @param update - `(current) => next` for the whole row config.
   * @returns `{ saved: true }`, or `{ saved: false, reason }` to be reported.
   */
  async function saveConfig(update) {
    const entry = safely(() => ctx.fiber.entry)
    const editor = safely(() => ctx.get('configEditor'))
    if (entry === undefined) return { saved: false, reason: 'no-entry' }
    if (editor === undefined || typeof editor.edit !== 'function') return { saved: false, reason: 'no-editor' }
    const run = saves.then(() => editor.edit(entry, (current) => update(current ?? {})))
    // Keep the chain alive after a rejected write: the caller reports it.
    saves = run.catch(() => {})
    try {
      await run
      return { saved: true }
    } catch (error) {
      return { saved: false, reason: messageOf(error) }
    }
  }

  /**
   * Sessions that are switched off: `sessionId -> { agent, dispose, disposeGuard }`.
   * A row that exists for THIS agent means "off"; the disposers are the only things
   * that lift the restriction and the guard, so the row and the Agent lifetime stay
   * in step.
   */
  const offSessions = new Map()

  /**
   * Refuse one guarded call when the command looks like network traffic.
   * Runs before dispatch (the kernel's `tools.guard()`), only while the switch is off,
   * and only for `GUARDED_TOOLS`. It fails closed: a guarded call whose arguments
   * carry no readable command is refused rather than guessed through.
   * @param exec - the pending execution (`{ name, arguments, agent, ... }`).
   * @returns a denial reason, or undefined to let the call through.
   */
  function networkGuard(exec) {
    if (exec === null || typeof exec !== 'object') return undefined
    if (!GUARDED_TOOLS.includes(exec.name)) return undefined
    const args = exec.arguments
    const command = args !== null && typeof args === 'object' ? args.command : undefined
    if (typeof command !== 'string') {
      return `本会话已断网：这条工具调用没有可检查的命令文本，为稳妥起见拒绝执行。${OFFLINE_NOTICE}`
    }
    if (looksNetworked(command)) {
      return `本会话已断网：这条命令看起来会联网（下载、远程连接或网络 URL），已被拦下。本地命令照常可以执行。${OFFLINE_NOTICE}`
    }
    // 写脚本再执行原本是最省事的绕法：命令本身没有网络词，脚本里有。
    const script = inspectScripts(exec, command)
    if (script !== undefined) return `${script}${OFFLINE_NOTICE}`
    const packaged = inspectPackageScript(exec, command)
    if (packaged !== undefined) return `${packaged}${OFFLINE_NOTICE}`
    return undefined
  }

  /**
   * Sessions whose next admitted step must start a new request series, because the
   * tool catalog changed under them. Keyed by Session id, which outlives Agent
   * re-creation.
   */
  const pendingSeries = new Set()

  // Waterfall listener: take the downstream decision first, so every other listener
  // keeps its say, and only wrap the result for a session whose catalog changed.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const agent = payload?.agent
    if (agent === undefined || agent.session === undefined) return decision
    if (decision?.kind !== 'enter') return decision
    if (!pendingSeries.has(agent.session.id)) return decision
    // A step the loop will abandon (cancelled, or an empty admission) never becomes a
    // request, so consuming the mark there would silently drop the series restart.
    if (payload.signal?.aborted === true) return decision
    if (Array.isArray(decision.messages) && decision.messages.length === 0) return decision
    pendingSeries.delete(agent.session.id)
    // Spread the downstream decision so its own fields survive; the only field this
    // listener owns is the series restart it was asked for.
    return { ...decision, startsRequestSeries: true }
  })

  // A disposed Agent takes its layer and the restriction with it; drop the bookkeeping
  // and lift the restriction defensively, so nothing outlives the Session.
  ctx.on('agent/disposed', ({ agent }) => {
    const id = agent?.session?.id
    if (id === undefined) return
    pendingSeries.delete(id)
    const row = offSessions.get(id)
    if (row === undefined) return
    offSessions.delete(id)
    safely(() => row.dispose())
    safely(() => row.disposeGuard?.())
  })

  /** True when this Agent has no open turn right now. */
  function turnIsOpen(agent) {
    if (agent.status === 'running') return true
    const boundary = safely(() => ctx.agents.turnBoundaryOf(agent.session))
    return boundary !== undefined && boundary.openTurnStartSeq !== null
  }

  /**
   * Whether the web tools are denied for the Agent in front of us. A row left behind
   * by an earlier Agent of the same Session does not count: the restriction lives on
   * that Agent's scope, so a re-created Agent starts with the tools visible.
   * @param agent - the Agent whose state is asked for.
   * @returns true when this exact Agent is restricted.
   */
  function isOff(agent) {
    const row = offSessions.get(agent.session.id)
    return row !== undefined && row.agent === agent
  }

  /**
   * The machine-readable state every result carries, so the browser half never has
   * to guess what the Host decided: the switch, the three surfaces, and both lists.
   * @param agent - the Agent the command ran for (may be absent for global edits).
   */
  function stateOf(agent) {
    const sessionId = agent?.session?.id
    return {
      off: agent?.session?.id === undefined ? false : isOff(agent),
      surfaces: surfacesOf(),
      global: confTools('globalTools'),
      session: sessionToolsOf(sessionId),
      writable: canSave(),
    }
  }

  /**
   * Build one command result: the human sentence, the state marker, and the JSON state.
   * @param agent - the Agent the command ran for.
   * @param kind - `success` or `error`.
   * @param text - the sentence the UI renders.
   * @param extra - an optional machine-readable payload placed before the markers, so the
   *   panels can parse it without depending on message order.
   */
  function result(agent, kind, text, extra) {
    const off = agent?.session?.id === undefined ? false : isOff(agent)
    const payload = extra === undefined ? '' : ` ${extra}`
    return { kind, text: `${text}${payload} ${markerOf(off)} [web-state]${JSON.stringify(stateOf(agent))}` }
  }

  /**
   * Build the command result for one state.
   * @param agent - the Agent whose state is reported.
   * @param changed - whether this call changed the state.
   * @returns the result the UI renders (and the Session log records).
   */
  function report(agent, changed) {
    const off = isOff(agent)
    if (off) {
      return result(
        agent,
        'success',
        changed
          ? '已断网：从下一次请求起，本会话只剩本地工具（shell 保留，但联网类命令会被拦下），网页搜索、浏览器、MCP、生图/视频、子代理全部隐藏。 / Network off for this session: local work only, and shell commands that would fetch anything are refused.'
          : '本会话本来就是断网状态，没有重复加限制。 / The network was already off for this session.',
      )
    }
    return result(
      agent,
      'success',
      changed
        ? '已恢复联网：完整工具列表回到本会话。 / Network restored for this session.'
        : '本会话本来就是联网状态，没有改动。 / The network was already on for this session.',
    )
  }

  /**
   * The names `restrict()` would accept for one Agent. The plugin's own view is the
   * global one, and it misses whatever a profile composes *around* the Agent — the web
   * tools among them. When the Agent's handle has no view of its own, ask `restrict()`
   * directly: a probe name it rejects makes it report the catalogue it does accept.
   * @param agent - the Agent whose scope is asked for.
   * @returns the accepted names, or undefined when they cannot be learned.
   */
  function restrictableOf(agent) {
    // The probe comes first on purpose: it is the only call that runs in the Agent's own
    // scope, so it reports the catalogue `restrict()` will actually validate against. A
    // plain view() is the global one and misses everything a profile composes around the
    // Agent — the web tools among them.
    try {
      const probe = agent.ctx.tools.restrict({ deny: [PROBE_NAME] })
      // Accepted: the deployment does not validate names. Nothing was hidden by an empty
      // deny, so drop it and fall through to the views.
      safely(() => probe())
    } catch (error) {
      const probed = namesFromUnknownToolError(error)
      if (probed !== undefined) return probed
    }
    const direct = safely(() => agent?.ctx?.tools?.view?.().restrictableNames)
    if (direct !== undefined) return direct
    return safely(() => ctx.tools.view().restrictableNames)
  }

  /**
   * `restrict()` rejects an unknown name with `… unknown global tool "x"; known global
   * tools: a, b, c`. That tail is the authoritative allowlist catalogue for the scope
   * the call ran in, which is the only catalogue this plugin can reach.
   * @param error - the error `restrict()` threw.
   * @returns the accepted names, or undefined when the message is not that one.
   */
  function namesFromUnknownToolError(error) {
    const message = String(error?.message ?? '')
    const marker = 'known global tools: '
    const index = message.indexOf(marker)
    if (index < 0) return undefined
    const names = message
      .slice(index + marker.length)
      .split(',')
      .map((name) => name.trim().replace(/^["']|["']$/g, ''))
      .filter((name) => name !== '')
    return new Set(names)
  }

  /**
   * The list one scope keeps while the network is off. The three layers are complete
   * lists, nearest first: this Session's override, the global override, and the
   * built-in local names. An empty list is "not configured", not "keep nothing" — the
   * switch must never be able to leave a Session with no tools at all.
   * @param agent - the Agent whose allowlist is composed.
   * @returns the kept names and which layer supplied them.
   */
  function keepOf(agent) {
    const sessionId = agent?.session?.id
    const session = sessionToolsOf(sessionId)
    if (session.length > 0) return { list: session, source: 'session' }
    const global = confTools('globalTools')
    if (global.length > 0) return { list: global, source: 'global' }
    return { list: [...LOCAL_TOOLS, ...GUARDED_TOOLS], source: 'default' }
  }

  /**
   * The tool names this Agent keeps while the network is off, narrowed to what
   * `restrict()` accepts — it throws on an unknown name instead of ignoring it.
   * @param agent - the Agent whose allowlist is composed.
   * @returns the allowlist to hand to `tools.restrict()`.
   */
  function sessionAllow(agent) {
    const { list } = keepOf(agent)
    const unique = list.filter((name, index) => list.indexOf(name) === index)
    const known = restrictableOf(agent)
    if (known === undefined) return unique
    return unique.filter((name) => known.has(name))
  }

  /**
   * Apply a whitelist restriction, learning the accepted names when composing the list
   * was not enough: the first attempt doubles as a probe, and a retry keeps only the
   * names that scope admits.
   * @param agent - the Agent to restrict.
   * @param allow - the names to keep.
   * @returns the disposer, or the error that prevented the restriction.
   */
  function openRestriction(agent, allow) {
    try {
      return { dispose: agent.ctx.tools.restrict({ allow }) }
    } catch (error) {
      const known = namesFromUnknownToolError(error)
      if (known === undefined) return { error }
      const narrowed = allow.filter((name) => known.has(name))
      if (narrowed.length === allow.length) return { error }
      try {
        return { dispose: agent.ctx.tools.restrict({ allow: narrowed }) }
      } catch (retry) {
        return { error: retry }
      }
    }
  }

  /**
   * Hide every network-capable tool for one Agent and arm the request-series rebuild.
   * @param agent - the receiving Agent.
   * @returns the command result the UI renders.
   */
  function switchOff(agent) {
    const sessionId = agent.session.id
    // The allowlist must only name tools this deployment actually registers: a name
    // that is not in the catalog would make `restrict()` throw instead of narrowing.
    // Read once per toggle — this is the only catalog-sized work the plugin ever does.
    const allow = sessionAllow(agent)
    if (allow.length === 0) {
      return result(
        agent,
        'error',
        '无法断网：本部署没有注册任何可保留的本地工具 / Could not switch off: none of the local tools are registered here.',
      )
    }
    // Arm BEFORE the restriction lands: if the restriction is resolvable while the
    // mark is missing, a request could describe the old catalog.
    pendingSeries.add(sessionId)
    const opened = openRestriction(agent, allow)
    if (opened.error !== undefined) {
      pendingSeries.delete(sessionId)
      return result(agent, 'error', `无法断网 / Could not turn the network off: ${messageOf(opened.error)}`)
    }
    let disposeGuard
    try {
      // The kept dual-use tools are fenced here rather than hidden.
      disposeGuard = agent.ctx.tools.guard(networkGuard)
    } catch (error) {
      pendingSeries.delete(sessionId)
      safely(() => opened.dispose())
      return result(agent, 'error', `无法断网 / Could not turn the network off: ${messageOf(error)}`)
    }
    offSessions.set(sessionId, { agent, dispose: opened.dispose, disposeGuard })
    return report(agent, true)
  }

  /**
   * Lift the restriction on one Agent and arm the request-series rebuild.
   * @param agent - the receiving Agent.
   * @returns the command result the UI renders.
   */
  function switchOn(agent) {
    const sessionId = agent.session.id
    const row = offSessions.get(sessionId)
    if (row === undefined || row.agent !== agent) {
      // Nothing of this Agent's is restricted, but a stale row from an earlier Agent
      // of the same Session still owns a disposer: drop it rather than leak it.
      if (row !== undefined) {
        offSessions.delete(sessionId)
        safely(() => row.dispose())
        safely(() => row.disposeGuard?.())
      }
      offSessions.delete(sessionId)
      return report(agent, false)
    }
    offSessions.delete(sessionId)
    try {
      row.dispose()
      if (row.disposeGuard !== undefined) row.disposeGuard()
    } catch (error) {
      // The layer may already be torn down; the state is on either way, but say so.
      return result(
        agent,
        'error',
        `已取消记录，但撤销限制时报告错误 / Recorded as on, but lifting the restriction reported: ${messageOf(error)}`,
      )
    }
    pendingSeries.add(sessionId)
    return report(agent, true)
  }

  /**
   * Re-apply the allowlist to every Session that is currently off, so an edit takes
   * effect at once instead of waiting for the next on/off. A Session with an open turn
   * is skipped: its current request already declared a catalog, and splitting one turn
   * between two catalogs is exactly what the switch refuses to do.
   * @returns how many Sessions adopted the new list, and how many were skipped.
   */
  function retune() {
    let applied = 0
    let skipped = 0
    for (const [sessionId, row] of [...offSessions]) {
      if (turnIsOpen(row.agent)) {
        skipped += 1
        continue
      }
      const allow = sessionAllow(row.agent)
      if (allow.length === 0) {
        skipped += 1
        continue
      }
      // Arm first, then swap layers: the new restriction lands before the old one is
      // lifted, so the catalog never widens in between.
      pendingSeries.add(sessionId)
      const opened = openRestriction(row.agent, allow)
      if (opened.error !== undefined) {
        pendingSeries.delete(sessionId)
        skipped += 1
        continue
      }
      const previous = row.dispose
      const previousGuard = row.disposeGuard
      let nextGuard
      try {
        nextGuard = row.agent.ctx.tools.guard(networkGuard)
      } catch {
        nextGuard = previousGuard
      }
      offSessions.set(sessionId, { agent: row.agent, dispose: opened.dispose, disposeGuard: nextGuard })
      safely(() => previous())
      if (nextGuard !== previousGuard) safely(() => previousGuard?.())
      applied += 1
    }
    return { applied, skipped }
  }

  /** Parse `on`/`off` (and their obvious aliases); anything else is a usage error. */
  function parseSwitch(token) {
    const value = typeof token === 'string' ? token.trim().toLowerCase() : ''
    if (value === 'on' || value === 'true' || value === '1' || value === 'show' || value === 'yes') return true
    if (value === 'off' || value === 'false' || value === '0' || value === 'hide' || value === 'no') return false
    return undefined
  }

  /** The complete keep-list one scope currently holds, as a plain array. */
  function readOverride(current, global, sessionId) {
    if (global) return Array.isArray(current.globalTools) ? current.globalTools : []
    const map = current.sessionTools
    const list = map !== null && typeof map === 'object' ? map[sessionId] : undefined
    return Array.isArray(list) ? list : []
  }

  /** Replace the complete keep-list of one scope; an empty list means "inherit". */
  function writeOverride(current, global, sessionId, list) {
    if (global) return { ...current, globalTools: list }
    const map = current.sessionTools !== null && typeof current.sessionTools === 'object' ? { ...current.sessionTools } : {}
    if (list.length === 0) delete map[sessionId]
    else map[sessionId] = list
    return { ...current, sessionTools: map }
  }

  /**
   * Turn one tool on or off for one scope. The scope keeps a *complete* list, so the
   * first edit materialises the list that was in force (the built-in names, or the
   * layer below), and later edits just toggle a member.
   * @param agent - the Agent the command ran for.
   * @param name - the tool name.
   * @param value - true to keep it while the network is off, false to hide it.
   * @param global - whether the edit lands in the global layer.
   * @returns what the write did.
   */
  async function writeKeep(agent, name, value, global) {
    const sessionId = agent.session.id
    // A global edit starts from the global layer, not from whatever this Session already
    // narrowed down to: otherwise one task's list would leak into every other task.
    const globalList = confTools('globalTools')
    const base = global ? (globalList.length > 0 ? globalList : [...LOCAL_TOOLS, ...GUARDED_TOOLS]) : keepOf(agent).list
    const saved = await saveConfig((current) => {
      const existing = readOverride(current, global, sessionId)
      const list = existing.length > 0 ? existing : base
      const next = value === true ? (list.includes(name) ? list : [...list, name]) : list.filter((entry) => entry !== name)
      return writeOverride(current, global, sessionId, next)
    })
    return saved
  }

  /**
   * Reset one scope back to the layer below it.
   * @param agent - the Agent the command ran for.
   * @param global - whether the edit lands in the global layer.
   * @returns what the write did.
   */
  async function resetKeep(agent, global) {
    return saveConfig((current) => writeOverride(current, global, agent.session.id, []))
  }

  /** One sentence describing the lists and the surface switches. */
  function describeConfig(agent) {
    const surfaces = surfacesOf()
    const { list, source } = keepOf(agent)
    const flags = `pluginPage=${surfaces.plugin ? 'on' : 'off'} settingsSection=${surfaces.settings ? 'on' : 'off'} composerPanel=${surfaces.composer ? 'on' : 'off'}`
    const where = source === 'session' ? '本会话 / this Session' : source === 'global' ? '全局 / global' : '内置默认 / built-in'
    const writable = canSave() ? '' : '（本 profile 不能写配置，改动只在本次运行生效 / this profile cannot save, changes last until restart）'
    return `${flags}；保留 ${list.length} 个工具（${where}）/ keeping ${list.length} tool(s) from ${where}.${writable}`
  }

  /**
   * The catalogue the panels draw: every name this Agent's scope would accept, with
   * whether it is kept right now.
   * @param agent - the Agent the command ran for.
   */
  function catalogueOf(agent) {
    const known = restrictableOf(agent)
    const { list, source } = keepOf(agent)
    const kept = new Set(list)
    const names = known === undefined ? list : [...known]
    names.sort((left, right) => left.localeCompare(right))
    return {
      source,
      tools: names.map((name) => ({ name, kept: kept.has(name), builtIn: LOCAL_TOOLS.includes(name) || GUARDED_TOOLS.includes(name) })),
    }
  }

  /**
   * Read or write the plugin's own settings: the three browser surfaces, the keep-list,
   * and the tool catalogue the panels render.
   * @param agent - the Agent the command ran for (its Session owns the per-Session list).
   * @param verb - `config`, `surface`, `tools`, `keep`, or `allow`.
   * @param args - the remaining tokens.
   * @returns the command result the UI renders.
   */
  async function configure(agent, verb, args) {
    const global = args.includes('--global')
    const sessionId = agent.session.id
    const tokens = args.filter((token) => token !== '--global')
    // Every keep/surface answer carries the fresh catalogue, so a panel updates its
    // switches from one round-trip instead of asking again.
    const toolsMarker = () => `[web-tools]${JSON.stringify(catalogueOf(agent))}`
    const tunedText = (tuned) =>
      tuned.applied === 0 && tuned.skipped === 0 ? '' : ` 已刷新 ${tuned.applied}${tuned.skipped === 0 ? '' : `，跳过 ${tuned.skipped}（正在执行）`}`

    if (verb === 'config') return result(agent, 'success', describeConfig(agent))

    if (verb === 'tools') {
      const catalogue = catalogueOf(agent)
      return result(
        agent,
        'success',
        `共 ${catalogue.tools.length} 个可用工具 / ${catalogue.tools.length} tool(s) in this catalogue`,
        `[web-tools]${JSON.stringify(catalogue)}`,
      )
    }

    if (verb === 'surface') {
      const key = (tokens[0] ?? '').toLowerCase()
      const field = SURFACE_FIELDS[key]
      if (field === undefined) {
        return result(agent, 'error', `未知的显示位置 / unknown surface "${tokens[0] ?? ''}"; use plugin|settings|composer`)
      }
      if (key === 'plugin') {
        // Keep one door that cannot be closed: hiding this page is how a user could lose
        // the only surface the other two are restored from.
        return result(
          agent,
          'success',
          '本插件详情页始终显示，不能关闭：它是把其它面板重新打开的保底入口 / The bundle detail page is always shown; it is the entry that brings the other panels back.',
        )
      }
      const value = parseSwitch(tokens[1])
      if (value === undefined) return result(agent, 'error', `用法 / usage: /${COMMAND} surface ${key} on|off`)
      const saved = await saveConfig((current) => ({ ...current, [field]: value }))
      if (!saved.saved) {
        return result(
          agent,
          'error',
          `没能保存显示设置 / Could not save the surface setting: ${saved.reason === 'no-editor' || saved.reason === 'no-entry' ? '这个 profile 没有配置文件可写 / this profile has no writable configuration' : saved.reason}`,
        )
      }
      return result(
        agent,
        'success',
        `已把 ${key} 配置面板设为${value ? '显示' : '隐藏'} / ${key} panel is now ${value ? 'shown' : 'hidden'}. ${describeConfig(agent)}`,
        toolsMarker(),
      )
    }

    // Everything below edits the keep-list. `allow` is the older spelling and stays an
    // alias so a panel cached in a browser tab keeps working across an upgrade.
    const action = (tokens[0] ?? '').toLowerCase()
    const scope = global ? '全局 / global' : '本会话 / this Session'

    if (action === 'list' || action === '') return result(agent, 'success', describeConfig(agent))

    if (action === 'clear' || action === 'reset') {
      const saved = await resetKeep(agent, global)
      if (!saved.saved) return result(agent, 'error', `没能保存白名单 / Could not save the keep-list: ${saved.reason}`)
      return result(
        agent,
        'success',
        `已把${scope}保留名单交还给上一层 / Reset the ${global ? 'global' : 'Session'} keep-list to the layer below.${tunedText(retune())}`,
        toolsMarker(),
      )
    }

    const removing = action === 'remove' || action === 'rm' || action === 'delete' || action === 'del' || action === '-' || action === 'off'
    const adding = action === 'add' || action === '+' || action === 'set' || action === 'on' || verb === 'keep'
    if (!removing && !adding) {
      return result(agent, 'error', `用法 / usage: /${COMMAND} keep <tool> on|off [--global] | /${COMMAND} keep reset [--global] | /${COMMAND} tools`)
    }
    // `keep <tool> on|off` and `keep set <tool> on|off` and `allow add|remove <tool>` all
    // land here; find the name and the value whichever spelling was used.
    let name = ''
    let value
    if (verb === 'keep') {
      // `keep <tool> on|off`: the name comes first, the switch second.
      name = tokens[0] ?? ''
      value = parseSwitch(tokens[1])
    } else {
      // `allow add|remove <tool>`: the verb already carries the direction.
      name = tokens[1] ?? ''
      value = removing ? false : true
    }
    if (name === '') {
      return result(agent, 'error', `用法 / usage: /${COMMAND} keep <tool> on|off [--global]`)
    }
    if (value === undefined) {
      return result(agent, 'error', `用法 / usage: /${COMMAND} keep ${name} on|off [--global]`)
    }
    const known = restrictableOf(agent)
    const saved = await writeKeep(agent, name, value, global)
    if (!saved.saved) return result(agent, 'error', `没能保存白名单 / Could not save the keep-list: ${saved.reason}`)
    const tuned = retune()
    const warning = known !== undefined && !known.has(name)
      ? `这个目录里没有 ${name}（已记下，注册后即生效）/ "${name}" is not in this catalogue (recorded, takes effect once registered)；`
      : ''
    const note = value
      ? `已让 ${name} 在断网时保留 / "${name}" now stays available while the network is off.`
      : `已让 ${name} 在断网时隐藏 / "${name}" is now hidden while the network is off.`
    return result(agent, 'success', `${warning}${note}（${scope}）${tunedText(tuned)} ${describeConfig(agent)}`, toolsMarker())
  }

  /**
   * Switch this Session's web tools on or off, or configure the switch.
   * @param agent - the receiving Agent (the Session whose switch is being changed).
   * @param rawInput - `on`, `off`, `status`, `tools`, `surface …`, `keep …`, `allow …`, `config`, or empty to toggle.
   * @returns the command result the UI renders.
   */
  function toggle(agent, rawInput) {
    const text = typeof rawInput === 'string' ? rawInput.trim() : ''
    const [head = '', ...args] = text === '' ? [] : text.split(/\s+/)
    const requested = head.toLowerCase()
    // The configuration forms need no Agent state, but the Session still scopes the
    // per-Session list; only the plain switch needs a Session at all.
    if (requested === 'config' || requested === 'surface' || requested === 'tools' || requested === 'keep' || requested === 'allow') {
      if (agent?.session?.id === undefined) {
        return { kind: 'error', text: '没有可配置的会话 / No Session to configure.' }
      }
      return configure(agent, requested, args)
    }
    if (agent?.session?.id === undefined) {
      return { kind: 'error', text: '没有可切换的会话 / No Session to switch.' }
    }
    if (requested === 'status') return report(agent, false)
    if (requested !== '' && requested !== 'on' && requested !== 'off') {
      return {
        kind: 'error',
        text: `用法 / usage: /${COMMAND} [on|off|status] | /${COMMAND} tools | /${COMMAND} keep <tool> on|off [--global] | /${COMMAND} surface <plugin|settings|composer> on|off`,
      }
    }
    const current = isOff(agent)
    const next = requested === '' ? !current : requested === 'off'
    // Idempotent: a second "off" must not stack a second restriction, and a second
    // "on" must not dispose twice.
    if (next === current) return report(agent, false)
    // A turn that is already running has its tool set admitted; changing the catalog
    // mid-turn would either be ignored or split one request from its declarations, so
    // this switch queues nothing and refuses instead.
    if (turnIsOpen(agent)) {
      return result(
        agent,
        'error',
        '当前任务正在执行，等这一轮结束后再切换联网开关 / This task is running; switch the web tools after the turn ends.',
      )
    }
    return next ? switchOff(agent) : switchOn(agent)
  }

  ctx.commands.register({
    name: COMMAND,
    description: 'Punch the network switch for this Session, or configure which panels show and which tools stay.',
    input: { hint: 'on|off|status|tools|keep <tool> on|off [--global]|surface <plugin|settings|composer> on|off' },
    handler: ({ agent, rawInput }) => toggle(agent, rawInput),
  })
}
