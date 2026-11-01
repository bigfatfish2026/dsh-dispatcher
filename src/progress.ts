import { execFile } from 'node:child_process'

/**
 * One line of progress, pushed straight to the person on QQ.
 *
 * Why this exists: the prototype pushed progress with a heartbeat script and a
 * `progress/` jsonl that a timer drained. That kept a second system alive just
 * to move text, and the main session still had to be told it happened. Here the
 * worker calls a tool, the plugin runs the notify script itself, and the line
 * lands on the person's phone without waking a single session.
 *
 * The script owns the openid and the token exchange; the plugin keeps no second
 * copy of either.
 */
export const DEFAULT_NOTIFY_SCRIPT = '/home/julia/fatfish/notify.sh'

/** A push must never hold a turn: the child is killed at this point. */
export const DEFAULT_TIMEOUT_MS = 5000

export interface ProgressOptions {
  /** Script to run. Defaults to DEFAULT_NOTIFY_SCRIPT; tests inject a stub. */
  script?: string
  /** Hard cap on the child process, in milliseconds. */
  timeoutMs?: number
  /** Where a failure goes. A push that fails is reported, never thrown. */
  log?(message: string): void
}

export interface ProgressResult {
  /** True when the notify script exited 0. */
  sent: boolean
}

/**
 * Flatten to one line: the push is a QQ text message, and a multi-line note
 * arrives as a wall of text. Newlines and runs of spaces collapse to one space.
 */
export function oneLine(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * Run the notify script with one line of text.
 *
 * Resolves `{ sent }` for every outcome — empty text, a non-zero exit, a timeout
 * that killed the child, a missing script. A progress note is a courtesy, so a
 * failed push must not fail the tool call the model is making.
 */
export function sendProgress(text: string, options: ProgressOptions = {}): Promise<ProgressResult> {
  const message = oneLine(text)
  if (!message) return Promise.resolve({ sent: false })

  const script = options.script ?? DEFAULT_NOTIFY_SCRIPT
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<ProgressResult>((resolve) => {
    // `bash script text` rather than a shebang exec: notify.sh is not required
    // to keep its executable bit, and this is how every other caller runs it.
    execFile(
      'bash',
      [script, message],
      { timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
      (error) => {
        if (error) {
          const reason = (error as NodeJS.ErrnoException & { killed?: boolean }).killed
            ? `timed out after ${timeout}ms`
            : error.message
          options.log?.(`[dispatcher] progress push failed: ${reason}`)
          resolve({ sent: false })
          return
        }
        resolve({ sent: true })
      },
    )
  })
}
