// Add by MHY, permanent deletion must stop composed Session work before removing durable data.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalJobRegistry from '../../../jobs/jobs-local/src/index.ts'
import type { JobOutcome } from '../../../jobs/jobs/src/index.ts'
import { installSubagentArchiveAdmission } from '../../../subagent/subagent/src/archive-admission.ts'
import { agentFor, gatedScheduleBackend, harness as scheduleHarness } from '../../../schedule/schedule/tests/harness.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { WorkspaceCommands } from '../src/commands.ts'

const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(options: Parameters<typeof scheduleHarness>[0] = {}) {
  const test = await scheduleHarness(options)
  const { ctx } = test
  roots.push(ctx)
  const removeStored = vi.fn(async (_sessionId: SessionId) => true)
  Object.assign(ctx.sessionPersistence, { list: async () => [], delete: removeStored })
  await ctx.plugin(WorkspaceRegistry)
  const forget = vi.spyOn(ctx.workspaceRegistry, 'forgetSession')
  return { ...test, commands: new WorkspaceCommands(ctx), removeStored, forget }
}

describe('permanent Session deletion stops activity', () => {
  it('stops reminders, owned jobs, and subagents before flushing and deleting a live Session', async () => {
    const { ctx, service, commands, removeStored } = await setup()
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('delete-test')
    installSubagentArchiveAdmission(ctx)
    const order: string[] = []
    const parent = agentFor(ctx, 'delete-live')
    const cancelParent = vi.fn(() => { order.push('cancel') })
    parent.cancel = cancelParent
    parent.whenIdle = vi.fn(async () => { order.push('idle') })
    await ctx.agents.register(parent)
    const childCancel = vi.fn()
    const child = {
      ...agentFor(ctx, 'delete-child', { parentSession: parent.id, origin: 'subagent' }),
      status: 'running' as const,
      cancel: childCancel,
    }
    await ctx.agents.register(child)
    const done = Promise.withResolvers<JobOutcome>()
    const cancelJob = vi.fn(() => { done.resolve({ status: 'killed' }) })
    const jobId = ctx.jobs.start({
      kind: 'bash', label: 'delete-owned-job', owner: parent.id,
      run: () => ({ cancel: cancelJob, done: done.promise }),
    })
    await service.create(parent.id, { title: 'Delete reminder', prompt: 'Later', after_seconds: 3_600 })
    const foreignId = SessionId('keep-reminder')
    const foreign = await service.create(foreignId, { title: 'Keep reminder', prompt: 'Later', after_seconds: 3_600 })
    const stopping = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('workspace/session-stop', async ({ sessionId }) => {
      expect(sessionId).toBe(parent.id)
      order.push('stop')
      stopping.resolve(undefined)
      await release.promise
    })
    ctx.on('session/flush', () => { order.push('flush') })
    ctx.on('agent/disposed', ({ agent }) => { if (agent.id === parent.id) order.push('agent-removed') })
    ctx.on('session/disposed', (session) => { if (session.id === parent.id) order.push('session-removed') })
    removeStored.mockImplementation(async () => {
      expect(await service.list({ sessionId: parent.id })).toEqual([])
      expect(cancelJob).toHaveBeenCalledTimes(1)
      expect(childCancel).toHaveBeenCalledWith({ kind: 'parent' })
      expect(ctx.agents.get(parent.id)).toBeUndefined()
      expect(ctx.sessions.get(parent.id)).toBeUndefined()
      order.push('delete')
      return true
    })
    const deleting = commands.deleteSession({ sessionId: parent.id })
    try {
      await stopping.promise
      expect(removeStored).not.toHaveBeenCalled()
      expect(ctx.sessions.get(parent.id)).toBe(parent.session)
    } finally {
      release.resolve(undefined)
    }
    await expect(deleting).resolves.toEqual({ deleted: true, archivedSessionIds: [] })
    expect(order).toEqual(['stop', 'cancel', 'idle', 'flush', 'agent-removed', 'session-removed', 'delete'])
    expect(cancelParent).toHaveBeenCalledWith({ kind: 'disposed' })
    expect((await ctx.jobs.wait(jobId, 1_000, parent.id)).status).toBe('killed')
    expect((await service.list({ sessionId: foreignId })).map(row => row.id)).toEqual([foreign.id])
  })

  it('stops persistent reminders for an archived Session with no live Agent or Session', async () => {
    const { ctx, service, commands, removeStored } = await setup()
    const session = ctx.sessions.create(SessionId('delete-cold'))
    await ctx.workspaceRegistry.archiveSession(session.id)
    ctx.sessions.remove(session.id)
    await service.create(session.id, { title: 'Cold reminder', prompt: 'Later', after_seconds: 3_600 })
    removeStored.mockImplementation(async () => {
      expect(await service.list({ sessionId: session.id })).toEqual([])
      return true
    })
    await expect(commands.deleteSession({ sessionId: session.id })).resolves.toEqual({ deleted: true, archivedSessionIds: [] })
    expect(removeStored).toHaveBeenCalledWith(session.id)
  })

  it('preserves the transcript and registry when a real reminder stop fails', async () => {
    const pool = new MemoryMediaPool()
    const backend = gatedScheduleBackend(pool, {
      deleteRecord: async () => { throw new Error('schedule delete failed') },
    })
    const { ctx, service, commands, removeStored, forget } = await setup({ pool, backend })
    const session = ctx.sessions.create(SessionId('stop-failure'))
    await ctx.workspaceRegistry.pinSession(session.id)
    await service.create(session.id, { title: 'Keep on failure', prompt: 'Later', after_seconds: 3_600 })
    await expect(commands.deleteSession({ sessionId: session.id })).rejects.toThrow()
    expect(removeStored).not.toHaveBeenCalled()
    expect(forget).not.toHaveBeenCalled()
    expect(ctx.sessions.get(session.id)).toBe(session)
    expect(ctx.workspaceRegistry.pinnedSessionIds).toContain(session.id)
    expect(await service.list({ sessionId: session.id })).toHaveLength(1)
  })

  it('preserves the transcript and live registries when the final flush fails', async () => {
    const { ctx, commands, removeStored, forget } = await setup()
    const agent = agentFor(ctx, 'flush-failure')
    await ctx.agents.register(agent)
    ctx.on('session/flush', () => { throw new Error('flush failed') })
    await expect(commands.deleteSession({ sessionId: agent.id })).rejects.toThrow()
    expect(removeStored).not.toHaveBeenCalled()
    expect(forget).not.toHaveBeenCalled()
    expect(ctx.sessions.get(agent.id)).toBe(agent.session)
    expect(ctx.agents.get(agent.id)).toBe(agent)
  })

  it.each(['reject', 'missing'] as const)('keeps archive slots when transcript deletion is %s', async (failure) => {
    const { ctx, commands, removeStored, forget } = await setup()
    const session = ctx.sessions.create(SessionId('storage-failure'))
    await ctx.workspaceRegistry.archiveSession(session.id)
    ctx.sessions.remove(session.id)
    if (failure === 'reject') removeStored.mockRejectedValue(new Error('disk failure'))
    else removeStored.mockResolvedValue(false)
    await expect(commands.deleteSession({ sessionId: session.id })).rejects.toThrow()
    expect(forget).not.toHaveBeenCalled()
    expect(ctx.workspaceRegistry.archivedSessionIds).toContain(session.id)
  })

  it('fails before stopping or detaching when persistence is unavailable', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const session = ctx.sessions.create(SessionId('no-persistence'))
    const stop = vi.fn()
    ctx.on('workspace/session-stop', stop)
    await expect(new WorkspaceCommands(ctx).deleteSession({ sessionId: session.id })).rejects.toThrow('no session persistence')
    expect(stop).not.toHaveBeenCalled()
    expect(ctx.sessions.get(session.id)).toBe(session)
  })
})
