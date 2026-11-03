import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { TicketEvent } from '../store'
import type { TicketBackend } from './backend'

/**
 * The one implementation that exists today: an append-only JSONL file.
 *
 * 一行一个事件，只追加；读的时候整份重放，坏行跳过。路径由调用方解析好再给
 * （见 store.ts 的 `resolveStateFile`），这里只认绝对路径。行为逐字节保持原样：
 * 一次 writeSync 写完「补换行 + 正文」，崩溃留下的半行不会被下一条粘上。
 */
export class JsonlTicketStore implements TicketBackend {
  private readonly file: string
  /** 坏行报到哪儿；省略就安静跳过。 */
  private readonly log?: (message: string) => void
  /** 上次读入/追加时的 `size:mtimeMs`；变了说明文件被外部改过。 */
  private signature: string | undefined
  /** 有没有量过 signature：没量过就得整份读一次。 */
  private observed = false

  constructor(file: string, log?: (message: string) => void) {
    this.file = file
    this.log = log
  }

  /** 文件路径。门面的 `path` 也走这个。 */
  get location(): string {
    return this.file
  }

  /** `size:mtimeMs` of the log, or undefined while it does not exist. */
  private statFile(): { size: number; signature: string } | undefined {
    try {
      const stat = statSync(this.file)
      return { size: stat.size, signature: `${stat.size}:${stat.mtimeMs}` }
    } catch {
      return undefined
    }
  }

  changed(): boolean {
    if (!this.observed) return true
    return this.statFile()?.signature !== this.signature
  }

  load(): TicketEvent[] {
    // 读之前先量一次：读的过程中别人追加的字节，下一轮 changed() 还得看得出来。
    const info = this.statFile()
    const events: TicketEvent[] = []
    const bad: number[] = []
    if (existsSync(this.file)) {
      const text = readFileSync(this.file, 'utf8')
      let line = 0
      for (const raw of text.split('\n')) {
        line += 1
        const trimmed = raw.trim()
        if (!trimmed) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          // 崩溃留下的半截行，或者别人写坏的字节：跳过这一行，不能因此让整次读取失败。
          bad.push(line)
          continue
        }
        const event = parsed as TicketEvent
        // 能 parse 不等于是一条事件：null、数字、数组、缺 id/at 的行同样跳过。
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          typeof event.id !== 'string' ||
          typeof event.at !== 'string'
        ) {
          bad.push(line)
          continue
        }
        events.push(event)
      }
    }
    if (bad.length > 0) {
      this.log?.(
        `[dispatcher] ticket log ${this.file}: skipped ${bad.length} line(s) that are not events (line ${bad.join(', ')})`,
      )
    }
    this.signature = info?.signature
    this.observed = true
    return events
  }

  append(event: TicketEvent): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const fd = openSync(this.file, 'a+')
    try {
      // 上一次崩在半行：末字节不是换行就先补一个，否则这一条会粘在坏行尾巴上，
      // 两条一起被当成坏行丢掉——被丢的可能正是 done 或 delivered。
      const { size } = fstatSync(fd)
      let prefix = ''
      if (size > 0) {
        const last = Buffer.alloc(1)
        readSync(fd, last, 0, 1, size - 1)
        if (last[0] !== 0x0a) prefix = '\n'
      }
      // 前缀和正文合成一次 writeSync：O_APPEND 下一次写完，没有半写的中间态。
      writeSync(fd, `${prefix}${JSON.stringify(event)}\n`)
    } finally {
      closeSync(fd)
    }
    this.signature = this.statFile()?.signature
    this.observed = true
  }
}
