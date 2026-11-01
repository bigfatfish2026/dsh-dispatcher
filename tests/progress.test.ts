import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_NOTIFY_SCRIPT, DEFAULT_TIMEOUT_MS, oneLine, sendProgress } from '../src/progress'

const tempDirs: string[] = []

function tempScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'progress-'))
  tempDirs.push(dir)
  const file = join(dir, 'notify.sh')
  writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 })
  return file
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('oneLine', () => {
  it('flattens newlines and runs of spaces into one line', () => {
    expect(oneLine('编译中\n\n  已经 3 分钟  ')).toBe('编译中 已经 3 分钟')
  })

  it('cuts a long note and marks the cut', () => {
    const out = oneLine('a'.repeat(300), 10)
    expect(out).toBe(`${'a'.repeat(10)}…`)
  })
})

describe('sendProgress', () => {
  it('points at the notify script by default', () => {
    // 主人手机上那条消息靠它推，插件里不存第二份 openid。
    expect(DEFAULT_NOTIFY_SCRIPT).toBe('/home/julia/fatfish/notify.sh')
    expect(DEFAULT_TIMEOUT_MS).toBe(5000)
  })

  it('reports sent when the script exits 0', async () => {
    // 不 mock 子进程，直接给一条能跑的命令行：注入成功路径。
    const result = await sendProgress('编译中，已 2 分钟', { script: tempScript('exit 0') })
    expect(result).toEqual({ sent: true })
  })

  it('hands the note to the script as one flattened argument', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'progress-'))
    tempDirs.push(dir)
    const caught = join(dir, 'arg.txt')
    const script = tempScript(`printf '%s' "$1" > ${caught}`)
    await sendProgress('编译中\n  已 2 分钟 ', { script })
    expect(readFileSync(caught, 'utf8')).toBe('编译中 已 2 分钟')
  })

  it('reports not sent and logs when the script exits non-zero', async () => {
    const logged: string[] = []
    const result = await sendProgress('这一步会失败', {
      script: tempScript('exit 1'),
      log: (message) => logged.push(message),
    })
    expect(result).toEqual({ sent: false })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('progress push failed')
  })

  it('reports not sent when the script is missing', async () => {
    const logged: string[] = []
    const result = await sendProgress('脚本不在', {
      script: '/nonexistent/notify.sh',
      log: (message) => logged.push(message),
    })
    expect(result).toEqual({ sent: false })
    expect(logged).toHaveLength(1)
  })

  it('kills a slow script at the timeout instead of holding the turn', async () => {
    const logged: string[] = []
    const result = await sendProgress('很慢的推送', {
      script: tempScript('sleep 5'),
      timeoutMs: 200,
      log: (message) => logged.push(message),
    })
    expect(result).toEqual({ sent: false })
    expect(logged[0]).toContain('timed out after 200ms')
  })

  it('skips an empty note without running anything', async () => {
    const result = await sendProgress('   \n ', { script: '/bin/false' })
    expect(result).toEqual({ sent: false })
  })
})
