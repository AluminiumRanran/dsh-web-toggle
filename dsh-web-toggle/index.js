/**
 * Host half of the web-toggle bundle: a per-Session network switch.
 *
 * Registers `/webtoggle [on|off|status]`. Turning the switch off keeps ONLY the
 * tools that cannot reach the network, through one `agent.ctx.tools.restrict()`
 * call on that Agent (scope-bound, so it never leaks to another Session), and
 * keeps the exact disposer that lifts it. Turning it on calls that disposer.
 *
 * Why an allowlist instead of denying `web_search`/`web_fetch`: those are only the
 * official network tools. A shell can `curl`, a browser tool can open a page, an
 * MCP server can forward a request. Keeping the local tools and hiding everything
 * else is the only closed form: a tool a later plugin adds stays hidden until it
 * is named here.
 *
 * The tool catalog changes under a live Session, so the next admitted step starts
 * a new request series: the recorded series can no longer describe the catalog,
 * and a rebuilt series sends the new declarations instead of "deferred additions".
 *
 * The Host half has no locale service, so command text is bilingual.
 */

export const inject = ['commands', 'agents', 'tools']

/** The command name. */
const COMMAND = 'webtoggle'

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
export function apply(ctx) {
  /**
   * Sessions whose web tools are currently denied: `sessionId -> { agent, dispose }`.
   * A row that exists for THIS agent means "off"; the disposer is the only thing
   * that lifts the restriction, so the row and the Agent lifetime stay in step.
   */
  const offSessions = new Map()

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
   * Build the command result for one state.
   * @param agent - the Agent whose state is reported.
   * @param changed - whether this call changed the state.
   * @returns the result the UI renders (and the Session log records).
   */
  function report(agent, changed) {
    const off = isOff(agent)
    const marker = markerOf(off)
    if (off) {
      return {
        kind: 'success',
        text: changed
          ? `已断网：从下一次请求起，本会话只剩本地工具，联网、下载、上传、浏览、MCP、子代理全部隐藏。 ${marker} / Network off for this session: only local tools remain from the next request.`
          : `本会话本来就是断网状态，没有重复加限制。 ${marker} / The network was already off for this session.`,
      }
    }
    return {
      kind: 'success',
      text: changed
        ? `已恢复联网：完整工具列表回到本会话。 ${marker} / Network restored for this session.`
        : `本会话本来就是联网状态，没有改动。 ${marker} / The network was already on for this session.`,
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
    const known = safely(() => ctx.tools.view().restrictableNames)
    const allow = known === undefined ? [] : LOCAL_TOOLS.filter((name) => known.has(name))
    if (allow.length === 0) {
      return {
        kind: 'error',
        text: '无法断网：本部署没有注册任何可保留的本地工具 / Could not switch off: none of the local tools are registered here.',
      }
    }
    // Arm BEFORE the restriction lands: if the restriction is resolvable while the
    // mark is missing, a request could describe the old catalog.
    pendingSeries.add(sessionId)
    let dispose
    try {
      // Scope-bound: the restriction applies to this Agent alone, and it fails closed —
      // a tool that is not in the allowlist (including one added later) is hidden.
      dispose = agent.ctx.tools.restrict({ allow })
    } catch (error) {
      pendingSeries.delete(sessionId)
      return {
        kind: 'error',
        text: `无法断网 / Could not turn the network off: ${messageOf(error)}`,
      }
    }
    offSessions.set(sessionId, { agent, dispose })
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
      }
      offSessions.delete(sessionId)
      return report(agent, false)
    }
    offSessions.delete(sessionId)
    try {
      row.dispose()
    } catch (error) {
      // The layer may already be torn down; the state is on either way, but say so.
      return {
        kind: 'error',
        text: `已取消记录，但撤销限制时报告错误 / Recorded as on, but lifting the restriction reported: ${messageOf(error)}`,
      }
    }
    pendingSeries.add(sessionId)
    return report(agent, true)
  }

  /**
   * Switch this Session's web tools on or off.
   * @param agent - the receiving Agent (the Session whose switch is being changed).
   * @param rawInput - `on`, `off`, `status`, or empty to toggle.
   * @returns the command result the UI renders.
   */
  function toggle(agent, rawInput) {
    if (agent?.session?.id === undefined) {
      return { kind: 'error', text: '没有可切换的会话 / No Session to switch.' }
    }
    const requested = typeof rawInput === 'string' ? (rawInput.trim().toLowerCase().split(/\s+/)[0] ?? '') : ''
    if (requested === 'status') return report(agent, false)
    if (requested !== '' && requested !== 'on' && requested !== 'off') {
      return {
        kind: 'error',
        text: `用法 / usage: /${COMMAND} [on|off|status]（不带参数则切换 / no argument toggles）`,
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
      return {
        kind: 'error',
        text: '当前任务正在执行，等这一轮结束后再切换联网开关 / This task is running; switch the web tools after the turn ends.',
      }
    }
    return next ? switchOff(agent) : switchOn(agent)
  }

  ctx.commands.register({
    name: COMMAND,
    description: 'Turn the web tools (web_search / web_fetch) on or off for this Session.',
    input: { hint: 'on|off|status' },
    handler: ({ agent, rawInput }) => toggle(agent, rawInput),
  })
}
