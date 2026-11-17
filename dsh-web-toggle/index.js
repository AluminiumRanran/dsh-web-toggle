/**
 * Host half of the web-toggle bundle: a per-Session network switch.
 *
 * Registers `/webtoggle [on|off|status]`. Turning the switch off keeps ONLY the
 * tools that cannot reach the network, through one `agent.ctx.tools.restrict()`
 * call on that Agent (scope-bound, so it never leaks to another Session), and
 * keeps the exact disposer that lifts it. Turning it on calls that disposer.
 *
 * * Why per-tool modes instead of denying `web_search`/`web_fetch` only: those are just
 * the official network tools. A browser tool can open a page, an MCP server can
 * forward a request. Every tool therefore has one of three modes — `keep`, `hide`,
 * `inspect` — and anything this plugin has never heard of defaults to `keep`,
 * because a public release must not assume which plugins a deployment installed.
 *
 * `ops_bash` ships as `inspect`: it is the only way to do local work (build, test,
 * move files), so it stays visible and every call is checked by a command guard that
 * refuses network-looking traffic. That guard is a filter, not a wall — see README
 * for the limits.
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
 * * browser half draws; `toolModes` and `sessionModes` decide, per tool, what the switch
 * does — per deployment, and per Session.
 */
export const Config = z.object({
  pluginPage: z.boolean().default(true).volatile().description('Reserved: the bundle detail page is always shown, because it is the entry that restores the other panels.'),
  settingsSection: z.boolean().default(true).volatile().description('Add a "Web switch" section to the settings sidebar.'),
  composerPanel: z.boolean().default(true).volatile().description('Show the small arrow next to the composer toggle that opens this Session\'s panel.'),
  debug: z.boolean().default(false).volatile().description('Write the machine-readable state into every command receipt. Off by default: a successful command prints one short line, and errors always print in full.'),
  toolModes: z.dict(z.string()).default({}).volatile().description('Per-tool mode (keep|hide|inspect|refuse) for every Session; a tool named nowhere stays available.'),
  sessionModes: z.dict(z.dict(z.string())).default({}).volatile().description('Per-tool mode overrides for one Session, keyed by Session id.'),
  offSessions: z.dict(z.boolean()).default({}).volatile().description('Sessions whose switch is off, keyed by Session id. The browser half writes this instead of running a command, so flipping the switch in a panel leaves no receipt in the chat.'),
  knownTools: z.array(z.string()).default([]).volatile().description('Tool names seen last turn. The panel draws its list from here, so browsing tools never writes a chat receipt.'),
})

/** Settings field of each browser surface, keyed by the name the command accepts. */
const SURFACE_FIELDS = Object.freeze({
  plugin: 'pluginPage',
  settings: 'settingsSection',
  composer: 'composerPanel',
})

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

/**
 * The four modes a tool can have while the network is off. This is the plugin's whole
 * vocabulary: the panels, the command line and the configuration file all use it.
 *
 * - `keep`    the tool stays visible and usable.
 * - `hide`    the tool disappears from the model's catalog: it cannot see or call it.
 *             Hiding rewrites the tool list, which also invalidates the prompt cache of
 *             the next request — the price of making a tool truly unreachable.
 * - `inspect` the tool stays visible, but every call is checked before it runs (see
 *             `callGuard`). Meant for general-purpose tools such as the shell, which
 *             carry a command line to read; the tool list (and the cache) is untouched.
 * - `refuse`  the tool stays visible in the catalog, but every call is refused before it
 *             runs, without reading its arguments. It is the cache-friendly hard block:
 *             the model still sees the tool, gets a written refusal, and the request
 *             prefix does not change from on to off.
 *
 * Anything not named anywhere defaults to `inspect`: a tool this plugin has never heard
 * of is still allowed to run, but its arguments are scanned first. A public release
 * cannot assume which plugins a deployment has installed, so the shape is "hide what is
 * known to reach the network, check everything else, except what the configuration
 * explicitly keeps". Inspecting is also the cache-friendly choice: unlike `hide`, it does
 * not change the tool list, so the prompt prefix survives a switch.
 */
const MODES = ['keep', 'hide', 'inspect', 'refuse']

/** The one tool whose calls can be inspected: it carries a command string to read. */
const INSPECT_NAME = 'ops_bash'

/**
 * Names whose whole purpose is to reach the network, grouped by the plugin family that
 * registers them. Prefixes keep a family covered when a deployment has a newer version
 * than this list; exact names cover one-off tools.
 */
const HIDE_PREFIXES = ['web_', 'bsk_', 'computer_', 'mcp__', 'video_', 'workbuddy_', 'snowluma_']

/** Exact names that reach the network: delegates, remote servers, scheduled delivery. */
const DEFAULT_HIDE = new Set([
  'list_mcp_resource_templates',
  'list_mcp_resources',
  'plugin_manager',
  'read_mcp_resource',
  'schedule_create',
  'schedule_edit',
  'send_message',
  'subagent',
  'subagent_fork',
  'wait_agent',
  'workflow',
])

/**
 * Whether this plugin ships an opinion about a name at all (as opposed to falling back
 * to the blanket `inspect`). The panels badge exactly these rows.
 * @param name - the tool name.
 */
function curated(name) {
  return name === INSPECT_NAME || DEFAULT_HIDE.has(name) || HIDE_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * The mode this plugin ships for a tool it has never been told about.
 * Hiding by prefix rather than by an exhaustive list is deliberate: a new `web_*` tool
 * must not need a plugin update before the switch covers it. Everything else falls back
 * to `inspect`, so an unknown third-party tool still runs, but its arguments are read
 * first; the configuration can move any specific name to `keep`.
 * @param name - the tool name.
 * @returns `inspect`, `hide`, or `keep`.
 */
function defaultMode(name) {
  if (name === INSPECT_NAME) return 'inspect'
  if (HIDE_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'hide'
  if (DEFAULT_HIDE.has(name)) return 'hide'
  return 'inspect'
}

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

  /** 读一层字符串数组配置（工具名清单），丢掉空值与非字符串。 */
  function confTools(name) {
    const raw = conf(name, [])
    if (!Array.isArray(raw)) return []
    return raw.filter((item) => typeof item === 'string' && item !== '')
  }

  /** One layer of the "tool name -> mode" table, with anything unexpected dropped. */
  function modesAt(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [name, mode] of Object.entries(raw)) {
      if (typeof name === 'string' && name !== '' && MODES.includes(mode)) out[name] = mode
    }
    return out
  }

  /** The overrides stored for one Session (a broken value counts as "none"). */
  function sessionModesOf(sessionId) {
    if (sessionId === undefined) return {}
    const map = conf('sessionModes', {})
    if (map === null || typeof map !== 'object' || Array.isArray(map)) return {}
    return modesAt(map[sessionId])
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
  const appliedOff = new Map()

  /** 参数最多读这么多字符：再多也只扫前一段，避免大载荷拖慢每次调用。 */
  const MAX_ARGUMENT_CHARS = 32 * 1024

  /**
   * Flatten a call's arguments into one searchable string. Only what a shallow JSON view
   * can show is read: deeply nested or cyclic payloads are not worth the cost here.
   * @param args - the tool call's arguments.
   * @returns the text, or undefined when there is nothing to read.
   */
  function argumentText(args) {
    if (args === null || typeof args !== 'object') {
      return typeof args === 'string' ? args.slice(0, MAX_ARGUMENT_CHARS) : undefined
    }
    try {
      const text = JSON.stringify(args)
      return typeof text === 'string' ? text.slice(0, MAX_ARGUMENT_CHARS) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Refuse one guarded call, deciding by that tool's mode.
   * Runs before dispatch (the kernel's `tools.guard()`), only while the switch is off.
   * `refuse` tools are rejected unconditionally; `inspect` tools are checked for network
   * traffic in their arguments. Everything else passes straight through.
   * The check fails closed: an inspected call whose arguments
   * carry no readable command is refused rather than guessed through.
   * @param exec - the pending execution (`{ name, arguments, agent, ... }`).
   * @returns a denial reason, or undefined to let the call through.
   */
  function callGuard(exec) {
    if (exec === null || typeof exec !== 'object') return undefined
    const mode = exec.agent === undefined ? defaultMode(exec.name) : modeOf(exec.agent, exec.name)
    if (mode === 'refuse') {
      return `本会话已断网：${exec.name} 被设为「调用时拒绝」，这次调用不会执行，也不必换个写法重试。${OFFLINE_NOTICE}`
    }
    if (mode !== 'inspect') return undefined
    const args = exec.arguments
    const command = args !== null && typeof args === 'object' ? args.command : undefined
    // `ops_bash` 是「有命令就必须能读」的那一个：读不到命令文本就当检查不了，宁可拒绝。
    if (exec.name === INSPECT_NAME && typeof command !== 'string') {
      return `本会话已断网：这条工具调用没有可检查的命令文本，为稳妥起见拒绝执行。${OFFLINE_NOTICE}`
    }
    // 没有命令文本可读的工具（MCP、生图、读取器……）：退一步看参数本身。
    if (typeof command !== 'string') {
      const spilled = argumentText(args)
      if (spilled !== undefined && looksNetworked(spilled)) {
        return `本会话已断网：这次 ${exec.name} 调用的参数看起来会联网（网络 URL、下载或远程地址），已被拦下。纯本地的调用照常执行。${OFFLINE_NOTICE}`
      }
      return undefined
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
    // 配置是事实来源：面板里点的按钮只写配置，这里在请求发出前把它落到 restrict/guard 上。
    const target = payload?.agent
    if (target !== undefined && target.session !== undefined) {
      try {
        reconcile(target)
        // 工具目录也顺手记进配置：面板读配置画列表，浏览时不产生命令回执。
        refreshKnownTools(target)
      } catch (error) {
        // 装不上也要让这一轮照常跑：下一轮 pre-step 会再试一次。
        ctx.logger?.warn?.(`[web-toggle] reconcile failed: ${messageOf(error)}`)
      }
    }
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
    const row = appliedOff.get(id)
    if (row === undefined) return
    appliedOff.delete(id)
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
   * 配置里记的「这个 Session 要不要断网」。浏览器半侧点按钮时只写这里（命令会在聊天里
   * 留回执），所以配置是唯一的事实来源，运行时状态由它推出来。
   * @param sessionId - the Session id.
   * @returns true when the Session is meant to be off.
   */
  function desiredOff(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    const map = conf('offSessions', {})
    if (map === null || typeof map !== 'object' || Array.isArray(map)) return false
    return map[sessionId] === true
  }

  /**
   * Whether the web tools are denied for the Agent in front of us. A row left behind
   * by an earlier Agent of the same Session does not count: the restriction lives on
   * that Agent's scope, so a re-created Agent starts with the tools visible.
   * @param agent - the Agent whose state is asked for.
   * @returns true when this exact Agent is restricted.
   */
  function isOff(agent) {
    const row = appliedOff.get(agent.session.id)
    return row !== undefined && row.agent === agent
  }

  /**
   * 把这一层能看到的工具名记进配置：面板读配置画列表，因此浏览工具不必发命令。
   * @param agent - the Agent about to run a step.
   */
  function refreshKnownTools(agent) {
    try {
      const names = scopedNames(agent)
      if (names.length === 0) return
      const known = confTools('knownTools')
      if (known.length === names.length && known.every((name, index) => name === names[index])) return
      void saveConfig((current) => ({ ...current, knownTools: names })).catch(() => {})
    } catch (error) {
      // 记不下就算了：面板退回缓存与建议名单，开关本身不受影响。
    }
  }

  /**
   * 把配置里记的开关落到这个 Agent 上：配置说要断网就装限制，说不要就撤掉。
   * 只在状态真的不一致时动手，所以每轮调一次也很便宜。
   * @param agent - the Agent about to run a step.
   * @returns true when the runtime state was changed.
   */
  function reconcile(agent) {
    const sessionId = agent?.session?.id
    if (sessionId === undefined) return false
    const desired = desiredOff(sessionId)
    if (desired === isOff(agent)) return false
    // switchOff/switchOn 自己会往 pendingSeries 里塞标记，pre-step 随后把它翻成
    // startsRequestSeries，于是这一轮的请求会用新的工具表重建。
    if (desired) switchOff(agent)
    else switchOn(agent)
    return true
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
      global: modesAt(conf('toolModes', {})),
      session: sessionModesOf(sessionId),
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
  function markerText(agent, text, extra) {
    const off = agent?.session?.id === undefined ? false : isOff(agent)
    const payload = extra === undefined ? '' : ` ${extra}`
    return `${text}${payload} ${markerOf(off)} [web-state]${JSON.stringify(stateOf(agent))}`
  }

  /**
   * 默认只写一句人话：聊天里的命令回执用户会一直看到，机器标记会反复刷屏。
   * 机器标记只在两种情况下附带——读命令（面板要靠它重建状态），或者用户开了 debug。
   * 错误永远完整打印，debug 时再额外附上状态，方便贴出来排查。
   */
  function result(agent, kind, text, extra, withState = false) {
    const verbose = conf('debug', false) === true
    if (kind !== 'success') return verbose ? { kind, text: markerText(agent, text, extra) } : { kind, text }
    if (!verbose && !withState) return { kind, text: extra === undefined ? text : `${text} ${extra}` }
    return { kind, text: markerText(agent, text, extra) }
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
          ? '已断网：从下一次请求起，设为「隐藏」的工具消失；设为「内容检查」的工具保留但每次调用都会检查内容；设为「调用时拒绝」的工具保留可见但调用一律被拒；其余工具照常可用。 / Network off for this session: hidden tools disappear, inspected tools stay but every call is checked, refused tools stay visible but every call is blocked, and everything else keeps working.'
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

  /** The mode in force for one tool: Session override, then global override, then default. */
  function modeOf(agent, name) {
    const session = sessionModesOf(agent?.session?.id)
    if (MODES.includes(session[name])) return session[name]
    const global = modesAt(conf('toolModes', {}))
    if (MODES.includes(global[name])) return global[name]
    return defaultMode(name)
  }

  /**
   * Every tool name this Agent's scope would accept from `restrict()`.
   * It has to be asked through the Agent: a plugin's own view is the global one and
   * misses whatever a profile composes around the Agent.
   * @param agent - the Agent whose scope is read.
   * @returns the sorted names, empty when the scope cannot be read.
   */
  function scopedNames(agent) {
    const known = restrictableOf(agent)
    if (known === undefined) return []
    return [...known].sort((left, right) => left.localeCompare(right))
  }

  /**
   * Split the catalog by mode: what must disappear while the network is off, what must
   * stay visible but be checked on every call, and what must stay visible but be
   * refused outright.
   * @param agent - the Agent whose catalog is split.
   */
  function splitByMode(agent) {
    const hide = []
    const inspect = []
    const refuse = []
    for (const name of scopedNames(agent)) {
      const mode = modeOf(agent, name)
      if (mode === 'hide') hide.push(name)
      else if (mode === 'inspect') inspect.push(name)
      else if (mode === 'refuse') refuse.push(name)
    }
    return { hide, inspect, refuse }
  }

  /**
   * Turn the switch off for one Agent: hide the `hide` names, leave `inspect` names to
   * the guard. An empty deny list is correct — it means "nothing to hide here".
   * @param agent - the Agent being restricted.
   * @param deny - the names that must disappear.
   * @returns the disposer, or the error that stopped the restriction.
   */
  function openRestriction(agent, deny) {
    if (deny.length === 0) return { dispose: () => {} }
    try {
      return { dispose: agent.ctx.tools.restrict({ deny }) }
    } catch (error) {
      // The catalog can move between our read and this call (a plugin unloading, a tool
      // re-registering under the same Session). `restrict()` names the tools it rejected
      // and validates before applying anything, so narrowing the list once is safe: the
      // names it does accept are still hidden from this point on.
      const known = namesFromUnknownToolError(error)
      if (known === undefined) return { error }
      const narrowed = deny.filter((name) => known.has(name))
      if (narrowed.length === 0) return { dispose: () => {} }
      try {
        return { dispose: agent.ctx.tools.restrict({ deny: narrowed }) }
      } catch (retry) {
        return { error: retry }
      }
    }
  }

  /**
   * Turn the network off for this Session: hide what the catalog says to hide, then put
   * the command guard in front of what must stay visible.
   * @param agent - the receiving Agent.
   */
  function switchOff(agent) {
    const sessionId = agent.session.id
    pendingSeries.add(sessionId)
    const { hide, inspect, refuse } = splitByMode(agent)
    const opened = openRestriction(agent, hide)
    if (opened.error !== undefined) {
      pendingSeries.delete(sessionId)
      return result(agent, 'error', `没能关掉联网开关 / Could not turn the network off: ${messageOf(opened.error)}`)
    }
    let disposeGuard
    try {
      if (inspect.length + refuse.length > 0) disposeGuard = agent.ctx.tools.guard(callGuard)
    } catch (error) {
      // The restriction is already applied; lift it again so "off" never half-lands.
      safely(() => opened.dispose())
      pendingSeries.delete(sessionId)
      return result(agent, 'error', `没能装上命令检查 / Could not install the command check: ${messageOf(error)}`)
    }
    appliedOff.set(sessionId, { agent, dispose: opened.dispose, disposeGuard })
    return report(agent, true)
  }

  /**
   * Turn the network back on: lift the restriction and the guard, and let the next
   * admitted step rebuild the request series so the model sees the tools again.
   * A row left behind by an earlier Agent of the same Session is lifted as well: its
   * disposers belong to that dead scope, but dropping the row keeps the bookkeeping
   * honest for the Session that outlives it.
   * @param agent - the receiving Agent.
   */
  function switchOn(agent) {
    const sessionId = agent.session.id
    pendingSeries.add(sessionId)
    const row = appliedOff.get(sessionId)
    appliedOff.delete(sessionId)
    if (row !== undefined) {
      safely(() => row.dispose?.())
      safely(() => row.disposeGuard?.())
    }
    return report(agent, true)
  }

  /**
   * Re-apply the modes to every Session that is still switched off. Build the new
   * restriction before lifting the old one, so there is never a window where neither
   * applies. A Session with a running turn is skipped: its tool set is already admitted,
   * and the next `off` (or the turn's end) picks the change up.
   * @returns how many Agents were retuned and how many were skipped.
   */
  function retune() {
    let applied = 0
    let skipped = 0
    for (const [sessionId, row] of [...appliedOff]) {
      if (turnIsOpen(row.agent)) {
        skipped += 1
        continue
      }
      const { hide, inspect, refuse } = splitByMode(row.agent)
      const opened = openRestriction(row.agent, hide)
      if (opened.error !== undefined) {
        skipped += 1
        continue
      }
      let disposeGuard
      if (inspect.length + refuse.length > 0) {
        try {
          disposeGuard = row.agent.ctx.tools.guard(callGuard)
        } catch {
          disposeGuard = undefined
        }
      }
      pendingSeries.add(sessionId)
      appliedOff.set(sessionId, { agent: row.agent, dispose: opened.dispose, disposeGuard })
      safely(() => row.dispose?.())
      safely(() => row.disposeGuard?.())
      applied += 1
    }
    return { applied, skipped }
  }

  /**
   * 把开关写回配置：命令、面板、重启之后看到的是同一份状态。
   * 运行时已经切好了，配置写不进去时不再往回执里塞第二句抱怨（debug 时会带原因）。
   * @param agent - the Agent whose Session switch changed.
   * @param off - the new value.
   */
  async function persistOff(agent, off) {
    const sessionId = agent.session.id
    await saveConfig((current) => {
      const raw = current.offSessions
      const map = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
      if (off) map[sessionId] = true
      else delete map[sessionId]
      return { ...current, offSessions: map }
    })
  }

  /** Parse `on|true|1|show|yes` as true and `off|false|0|hide|no` as false. */
  function parseSwitch(token) {
    const value = typeof token === 'string' ? token.trim().toLowerCase() : ''
    if (value === 'on' || value === 'true' || value === '1' || value === 'show' || value === 'yes') return true
    if (value === 'off' || value === 'false' || value === '0' || value === 'hide' || value === 'no') return false
    return undefined
  }

  /**
   * Parse one word into a mode. `on`/`off` are accepted as the older spelling of
   * `keep`/`hide`, so a panel cached in a browser tab keeps working across an upgrade.
   * `reject`/`block`/`deny` are accepted for `refuse`.
   * @param token - the word after the tool name.
   */
  function parseMode(token) {
    const value = typeof token === 'string' ? token.trim().toLowerCase() : ''
    if (value === '') return undefined
    if (value === 'keep' || value === 'on' || value === 'true' || value === '1' || value === 'show' || value === 'yes') return 'keep'
    if (value === 'hide' || value === 'off' || value === 'false' || value === '0' || value === 'drop' || value === 'no') return 'hide'
    if (value === 'inspect' || value === 'check' || value === 'scan' || value === 'match' || value === 'pattern') return 'inspect'
    if (value === 'refuse' || value === 'reject' || value === 'block' || value === 'blocked' || value === 'deny') return 'refuse'
    return undefined
  }

  /**
   * Store one tool's mode. A value equal to what the scope already inherits is deleted
   * instead of written, so the configuration file only shows real deviations.
   * @param agent - the Agent the command ran for.
   * @param name - the tool name.
   * @param mode - `keep`, `hide`, or `inspect`.
   * @param global - whether the edit lands in the global layer.
   * @returns what the write did.
   */
  async function writeMode(agent, name, mode, global) {
    const sessionId = agent.session.id
    return saveConfig((current) => {
      if (global) {
        const modes = modesAt(current.toolModes)
        if (mode === defaultMode(name)) delete modes[name]
        else modes[name] = mode
        return { ...current, toolModes: modes }
      }
      const all = current.sessionModes !== null && typeof current.sessionModes === 'object' ? { ...current.sessionModes } : {}
      const layer = modesAt(all[sessionId])
      // 和继承来的值相同就删掉：这一层只记真正偏离下一层的设置。
      const inherited = modesAt(current.toolModes)[name] ?? defaultMode(name)
      if (mode === inherited) delete layer[name]
      else layer[name] = mode
      if (Object.keys(layer).length === 0) delete all[sessionId]
      else all[sessionId] = layer
      return { ...current, sessionModes: all }
    })
  }

  /** Hand one scope back to the layer below it. */
  async function resetModes(agent, global) {
    const sessionId = agent.session.id
    return saveConfig((current) => {
      if (global) return { ...current, toolModes: {} }
      const all = current.sessionModes !== null && typeof current.sessionModes === 'object' ? { ...current.sessionModes } : {}
      delete all[sessionId]
      return { ...current, sessionModes: all }
    })
  }

  /** One sentence describing the surface switches and the current split. */
  function describeConfig(agent) {
    const surfaces = surfacesOf()
    const { hide, inspect, refuse } = splitByMode(agent)
    const flags = `pluginPage=${surfaces.plugin ? 'on' : 'off'} settingsSection=${surfaces.settings ? 'on' : 'off'} composerPanel=${surfaces.composer ? 'on' : 'off'}`
    const writable = canSave() ? '' : '（本 profile 不能写配置，改动只在本次运行生效 / this profile cannot save, changes last until restart）'
    return `${flags}；隐藏 ${hide.length} 个、内容检查 ${inspect.length} 个、调用时拒绝 ${refuse.length} 个，其余放行 / hiding ${hide.length}, inspecting ${inspect.length}, refusing ${refuse.length}, everything else kept.${writable}`
  }

  /**
   * The catalog the panels draw: every tool this scope knows plus any name the
   * configuration mentions, each with its mode and whether that mode is the default.
   * @param agent - the Agent the command ran for.
   */
  function catalogueOf(agent) {
    const names = new Set(scopedNames(agent))
    for (const name of Object.keys(modesAt(conf('toolModes', {})))) names.add(name)
    for (const name of Object.keys(sessionModesOf(agent.session.id))) names.add(name)
    return {
      tools: [...names]
        .sort((left, right) => left.localeCompare(right))
        .map((name) => ({ name, mode: modeOf(agent, name), builtIn: curated(name) })),
    }
  }

  /**
   * Read or write the plugin's own settings: the three browser surfaces, the per-tool
   * modes, and the catalog the panels render.
   * @param agent - the Agent the command ran for (its Session owns the per-Session layer).
   * @param verb - `config`, `surface`, `tools`, `mode`, or the older `keep`/`allow`.
   * @param args - the remaining tokens.
   * @returns the command result the UI renders.
   */
  async function configure(agent, verb, args) {
    const global = args.includes('--global')
    const sessionId = agent.session.id
    const tokens = args.filter((token) => token !== '--global')
    // Every answer can carry the fresh catalog, so a panel updates its switches from one
    // round-trip instead of asking again.
    const toolsMarker = () => `[web-tools]${JSON.stringify(catalogueOf(agent))}`
    // 默认模式里编辑类回执不带目录：面板自己知道刚刚改了什么，不必来回刷屏。
    const diagnostics = () => (conf('debug', false) === true ? toolsMarker() : undefined)
    const tunedText = (tuned) =>
      tuned.applied === 0 && tuned.skipped === 0 ? '' : ` 已刷新 ${tuned.applied}${tuned.skipped === 0 ? '' : `，跳过 ${tuned.skipped}（正在执行）`}`

    if (verb === 'config') return result(agent, 'success', describeConfig(agent), diagnostics())

    if (verb === 'tools') {
      const catalogue = catalogueOf(agent)
      const summary = `共 ${catalogue.tools.length} 个可用工具 / ${catalogue.tools.length} tool(s) in this catalogue`
      // 目录是给客户端画的，写进聊天就是几百个名字的噪音：默认只回一句，
      // 面板显式带 --json（或打开 debug）时才附上机器可读的那一段。
      const verbose = args.includes('--json') || conf('debug', false) === true
      if (!verbose) return result(agent, 'success', summary)
      return result(agent, 'success', summary, `[web-tools]${JSON.stringify(catalogue)}`, true)
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
        diagnostics(),
      )
    }

    // Everything below edits one tool's mode. `keep <tool> on|off` and
    // `allow add|remove <tool>` are the older spellings and stay aliases.
    const action = (tokens[0] ?? '').toLowerCase()
    const scope = global ? '全局 / global' : '本会话 / this Session'

    if (action === '' || action === 'list') return result(agent, 'success', describeConfig(agent), diagnostics())

    if (action === 'reset' || action === 'clear') {
      const saved = await resetModes(agent, global)
      if (!saved.saved) return result(agent, 'error', `没能保存工具设置 / Could not save the tool modes: ${saved.reason}`)
      return result(
        agent,
        'success',
        `已把${scope}的工具设置交还给上一层 / Reset the ${global ? 'global' : 'Session'} tool modes to the layer below.${tunedText(retune())}`,
        diagnostics(),
      )
    }

    let name = ''
    let mode
    if (verb === 'allow') {
      // `allow add|remove <tool>`: the verb already carries the direction.
      const removing = action === 'remove' || action === 'rm' || action === 'delete' || action === 'del' || action === '-' || action === 'off'
      name = tokens[1] ?? ''
      mode = removing ? 'hide' : 'keep'
    } else {
      // `mode <tool> keep|hide|inspect` (and the older `keep <tool> on|off`).
      name = tokens[0] ?? ''
      mode = parseMode(tokens[1])
    }
    if (name === '') return result(agent, 'error', `用法 / usage: /${COMMAND} mode <tool> keep|hide|inspect|refuse [--global]`)
    if (mode === undefined) return result(agent, 'error', `用法 / usage: /${COMMAND} mode ${name} keep|hide|inspect|refuse [--global]`)
    const saved = await writeMode(agent, name, mode, global)
    if (!saved.saved) return result(agent, 'error', `没能保存工具设置 / Could not save the tool mode: ${saved.reason}`)
    const tuned = retune()
    const warning = scopedNames(agent).includes(name)
      ? ''
      : `这个目录里没有 ${name}（已记下，注册后即生效）/ "${name}" is not in this catalogue (recorded, takes effect once registered)；`
    const note =
      mode === 'hide'
        ? `已让 ${name} 在断网时隐藏 / "${name}" is hidden while the network is off.`
        : mode === 'inspect'
          ? `已让 ${name} 在断网时保留，但每次调用都会检查内容 / "${name}" stays visible while the network is off, with every call inspected.`
          : mode === 'refuse'
            ? `已让 ${name} 在断网时保留可见，但每次调用都会被拒绝 / "${name}" stays visible while the network is off, and every call is refused.`
            : `已让 ${name} 在断网时保留 / "${name}" stays available while the network is off.`
    return result(agent, 'success', `${warning}${note}（${scope}）${tunedText(tuned)} ${describeConfig(agent)}`, diagnostics())
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
    if (
      requested === 'config' ||
      requested === 'surface' ||
      requested === 'tools' ||
      requested === 'mode' ||
      requested === 'keep' ||
      requested === 'allow'
    ) {
      if (agent?.session?.id === undefined) {
        return { kind: 'error', text: '没有可配置的会话 / No Session to configure.' }
      }
      return configure(agent, requested, args)
    }
    if (agent?.session?.id === undefined) {
      return { kind: 'error', text: '没有可切换的会话 / No Session to switch.' }
    }
    // 读命令先把配置落到运行时（面板里点的按钮只写配置），否则回执会说旧状态。
    if (requested === 'status') {
      if (!turnIsOpen(agent)) reconcile(agent)
      return report(agent, false)
    }
    if (requested !== '' && requested !== 'on' && requested !== 'off') {
      return {
        kind: 'error',
        text: `用法 / usage: /${COMMAND} [on|off|status] | /${COMMAND} tools | /${COMMAND} mode <tool> keep|hide|inspect|refuse [--global] | /${COMMAND} surface <plugin|settings|composer> on|off`,
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
    const outcome = next ? switchOff(agent) : switchOn(agent)
    // 运行时切成功才回写配置；失败时保持配置不变，下次再试。写入是异步的，命令不等它：
    // 面板在下一帧读到配置，运行时状态此刻已经切好了。
    if (outcome.kind === 'success') persistOff(agent, next).catch(() => {})
    return outcome
  }

  ctx.commands.register({
    name: COMMAND,
    description: 'Turn this Session\'s network tools off, and decide per tool what the switch keeps, hides, inspects, or refuses.',
    input: { hint: 'on|off|status|tools|mode <tool> keep|hide|inspect|refuse [--global]|mode reset [--global]|surface <plugin|settings|composer> on|off' },
    handler: ({ agent, rawInput }) => toggle(agent, rawInput),
  })
}
