/**
 * The main session's waiting guard.
 *
 * The hand-off rules in the prompt ask the main session to send long work to a
 * worker, but an instruction is only a wish: the model can still sit in a
 * `bash` call for two minutes and answer nothing meanwhile. Upstream
 * dsh-superagent does not rely on the wish either — it caps the router shell at
 * five seconds and puts a guard on the main session that refuses `sleep`, a
 * timeout over thirty seconds, and a job wait over five seconds. This is the
 * same guard, adapted to a profile that has no agent preset: the denial reason
 * carries the way out, so the refused call teaches the next one.
 */

/** Limits the guard enforces on the main session, in milliseconds. */
export interface NoWaitLimits {
  /** Longest a single command may hold the main session. */
  maxCommandMs: number
  /** Longest a `job_output` wait may hold the main session. */
  maxWaitMs: number
}

/**
 * `sleep` at a command position: the start, after a separator or a brace, after
 * a newline, or after a keyword or command that runs it. A path-qualified
 * `/usr/bin/sleep` counts; `sleepy` does not.
 */
const SLEEP =
  /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/

/** Shared half of every denial: what to do instead of waiting in place. */
const WHY =
  '这是中枢会话，report、后台任务结束和新消息都会自己作为新消息进来，结束这一轮就行，别在原地等。'

const seconds = (ms: number): number => Math.round(ms / 1000)

/**
 * The reason a main-session tool call is refused, or `undefined` when the call
 * does not make the session wait.
 *
 * @param name - the tool name being called.
 * @param input - the parsed arguments, as the tool layer hands them over.
 * @param limits - the configured ceilings.
 * @returns a denial reason for `tools.guard`, or `undefined` to allow the call.
 */
export function noWaitReason(
  name: string,
  input: Record<string, unknown>,
  limits: NoWaitLimits,
): string | undefined {
  if (name === 'bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined
    const background = input.run_in_background === true
    if (SLEEP.test(command)) {
      return `${WHY}命令里不要 sleep：要看结果就 run_in_background，等它结束推回来。`
    }
    if (timeoutMs !== undefined && timeoutMs > limits.maxCommandMs) {
      return `${WHY}单条命令最多等 ${seconds(limits.maxCommandMs)} 秒：更久的用 run_in_background，或者派给 worker。`
    }
    if (timeoutMs === undefined && !background) {
      return `${WHY}要么给 timeoutMs（不超过 ${seconds(limits.maxCommandMs)} 秒），要么 run_in_background。`
    }
  }
  if (name === 'job_output' && input.wait === true) {
    const wait = typeof input.timeout_ms === 'number' ? input.timeout_ms : Number.POSITIVE_INFINITY
    if (wait > limits.maxWaitMs) {
      return `${WHY}job_output 最多等 ${seconds(limits.maxWaitMs)} 秒；任务结束会自己推给你。`
    }
  }
  return undefined
}

/**
 * Whether an agent is a worker rather than the main session. A worker is a
 * subagent: it is the one that is allowed to wait, because waiting is the work.
 *
 * @param origin - the session header origin, when the session has one.
 * @returns true for a subagent session.
 */
export function isWorkerSession(origin: string | undefined): boolean {
  return origin === 'subagent'
}
