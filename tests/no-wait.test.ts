import { describe, expect, it } from 'vitest'
import { isWorkerSession, noWaitReason } from '../src/no-wait'

const limits = { maxCommandMs: 30_000, maxWaitMs: 5_000 }

describe('noWaitReason', () => {
  it('refuses sleep at a command position', () => {
    expect(noWaitReason('bash', { command: 'sleep 60' }, limits)).toContain('sleep')
    expect(noWaitReason('bash', { command: 'make && sleep 5' }, limits)).toContain('sleep')
    expect(noWaitReason('bash', { command: 'nohup sleep 5 &' }, limits)).toContain('sleep')
    expect(noWaitReason('bash', { command: '/usr/bin/sleep 3' }, limits)).toContain('sleep')
  })

  it('allows a word that merely contains sleep', () => {
    expect(noWaitReason('bash', { command: 'ls sleepy/', timeoutMs: 5_000 }, limits)).toBeUndefined()
  })

  it('refuses a command timeout over the ceiling', () => {
    expect(noWaitReason('bash', { command: 'make', timeoutMs: 31_000 }, limits)).toContain('30 秒')
    expect(noWaitReason('bash', { command: 'make', timeoutMs: 30_000 }, limits)).toBeUndefined()
  })

  it('refuses a foreground command with no timeout', () => {
    expect(noWaitReason('bash', { command: 'df -h' }, limits)).toContain('timeoutMs')
    expect(noWaitReason('bash', { command: 'make -j2', run_in_background: true }, limits)).toBeUndefined()
  })

  it('refuses a job wait over the ceiling', () => {
    expect(noWaitReason('job_output', { job_id: 'x', wait: true, timeout_ms: 9_000 }, limits)).toContain('5 秒')
    expect(noWaitReason('job_output', { job_id: 'x', wait: true }, limits)).toContain('5 秒')
    expect(noWaitReason('job_output', { job_id: 'x', wait: true, timeout_ms: 5_000 }, limits)).toBeUndefined()
    expect(noWaitReason('job_output', { job_id: 'x' }, limits)).toBeUndefined()
  })

  it('leaves other tools alone', () => {
    expect(noWaitReason('read', { file_path: '/tmp/x' }, limits)).toBeUndefined()
    expect(noWaitReason('dispatch_list', {}, limits)).toBeUndefined()
  })

  it('treats a subagent as a worker', () => {
    expect(isWorkerSession('subagent')).toBe(true)
    expect(isWorkerSession('user')).toBe(false)
    expect(isWorkerSession(undefined)).toBe(false)
  })
})
