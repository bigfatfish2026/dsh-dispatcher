/**
 * 桌面快照文件：把只读出口的 `TicketsPayload` 原子落成一个文件，给不能每 2 秒
 * fork 一个 node 进程的消费者（桌宠是 Rust，只读文件）用。
 *
 * 三条规矩：
 *
 * 1. **原子替换。** 先写 `<file>.tmp`，再 `rename()` 覆盖。读方任何时刻要么读到
 *    旧整份、要么读到新整份，不会撞上半截 JSON。
 * 2. **内容没变就不写。** 比较的是去掉 `generatedAt` 的正文（版本号、计数、票
 *    数组）；稳态巡检、重复投递不再把同一份内容重写一遍，也不白改 mtime。
 * 3. **只写该写的票。** 默认全量未结票 + 最近 N 张已结票（见
 *    `snapshotRecentClosed`），计数 `counts` 仍按全量日志算——屏上的「N 未结」
 *    不会因为截断而少。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TicketReadout, TicketsPayload } from './readout'

/** 快照文件的落盘配置。 */
export interface SnapshotFileConfig {
  /** 绝对路径；相对路径由调用方先按 DSH_HOME 解析好。 */
  file: string
  /** 未结票之外再带最近多少张结票；0 = 不带。 */
  recentClosed?: number
}

/** 比较用的正文：`generatedAt` 不进比较，否则每次都是「变了」。 */
function bodyOf(payload: TicketsPayload): string {
  return JSON.stringify({
    v: payload.v,
    counts: payload.counts,
    tickets: payload.tickets,
  })
}

/** 文件内容：正文 + 这一次的 generatedAt，键顺序固定。 */
function contentOf(payload: TicketsPayload): string {
  return `${JSON.stringify({
    v: payload.v,
    generatedAt: payload.generatedAt,
    counts: payload.counts,
    tickets: payload.tickets,
  })}\n`
}

export class TicketSnapshotFile {
  /** 上一次真正写进文件的正文；构造时尽量从旧文件里认出来，避免重启后空写一次。 */
  private lastBody: string | undefined
  private loaded = false

  constructor(
    private readonly readout: TicketReadout,
    private readonly config: SnapshotFileConfig,
    private readonly warn: (message: string) => void = () => {},
  ) {}

  /** 上一次写进去的正文（测试与诊断用）。 */
  get lastWrittenBody(): string | undefined {
    return this.lastBody
  }

  /**
   * 对齐一次磁盘：内容真的变了才写。返回是否落了字节。
   *
   * 同步写：一份几百张票的 JSON 是几百 KB，片内一次写几毫秒；异步会把
   * commit 之后的顺序搞乱（下一次 commit 可能先落盘），不值得。
   */
  write(): boolean {
    const payload = this.readout.payload({ recentClosed: this.config.recentClosed })
    const body = bodyOf(payload)
    this.loadOnce()
    if (body === this.lastBody) return false
    const content = contentOf(payload)
    const tmp = `${this.config.file}.tmp`
    try {
      mkdirSync(dirname(this.config.file), { recursive: true })
      writeFileSync(tmp, content)
      // rename 在同一文件系统内是原子的：读方要么旧整份、要么新整份。
      renameSync(tmp, this.config.file)
    } catch (error) {
      this.warn(
        `[dispatcher] 快照文件写不进去（${this.config.file}）：${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
    this.lastBody = body
    return true
  }

  /** 只读一次旧文件；认不出形状就当没有，第一次 write 照常落一份。 */
  private loadOnce(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(readFileSync(this.config.file, 'utf8')) as TicketsPayload
      if (parsed && parsed.v === 1 && Array.isArray(parsed.tickets)) this.lastBody = bodyOf(parsed)
    } catch {
      // 没有旧文件、或者旧文件不是这个形状：当作第一次写。
    }
  }
}
