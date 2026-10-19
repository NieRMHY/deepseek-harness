// Add by MHY, deletion joins an owner-started close without closing a live writer.
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceCommands } from '../../../api/workspace-controller/src/commands.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { generationLogPath } from '../src/format.ts'
import { SessionWriteLease } from '../src/lease.ts'
import { JsonlBackendTracker } from '../src/storage.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe.each(['none', 'zstd'] as const)('Session deletion joins natural close (%s)', (compression) => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-delete-close-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend()
    ctx.effect(() => ctx.storage.backend.register('fixture', backend))
    ctx.effect(() => async () => { await backend.close() })
    const facility = new DomainFacility(ctx, { backend: 'fixture' })
    ctx.effect(() => {
      const unmount = ctx.storage.mount('domain', facility)
      ctx.provide('storageDomain', facility)
      return async () => { await facility.closeAll(); unmount() }
    })
    await ctx.plugin(JsonlSessionPersistence, { root, compression })
    await ctx.plugin(WorkspaceRegistry)
    const id = SessionId('closing-writer')
    const predecessor = generationLogPath(root, undefined, id, 3, compression)
    await mkdir(dirname(predecessor), { recursive: true })
    const header = JSON.stringify({ type: 'session', version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }) + '\n'
    await writeFile(predecessor, compression === 'none' ? header : await compressZstdFrame(header))
    const writer = await ctx.sessionPersistence.open(id, 'write')
    const session = ctx.sessions.create(id, { meta: { createdAt: 1 } })
    const path = generationLogPath(root, undefined, id, writer.header.version, compression)
    return { ctx, root, session, path, commands: new WorkspaceCommands(ctx) }
  }

  it.each(['success', 'failure'] as const)('waits for the controller-triggered close and preserves its %s outcome', async (closeOutcome) => {
    const { ctx, root, session, path, commands } = await fixture()
    const dir = dirname(path)
    const names = (await readdir(dir)).filter(name => /[.]jsonl([.]zstd)?$/.test(name)).sort()
    expect(names).toHaveLength(2)
    const before = await Promise.all(names.map(name => readFile(join(dir, name))))
    const forget = vi.spyOn(ctx.workspaceRegistry, 'forgetSession')
    const releaseEntered = Promise.withResolvers<undefined>()
    const releaseGate = Promise.withResolvers<undefined>()
    const deleteEntered = Promise.withResolvers<undefined>()
    const release = SessionWriteLease.prototype.release
    const failure = new Error('owner close failed after releasing its lease')
    vi.spyOn(SessionWriteLease.prototype, 'release').mockImplementationOnce(async function (this: SessionWriteLease) {
      releaseEntered.resolve(undefined)
      await releaseGate.promise
      await release.call(this)
      if (closeOutcome === 'failure') throw failure
    })
    const claimDelete = JsonlBackendTracker.prototype.claimDelete
    vi.spyOn(JsonlBackendTracker.prototype, 'claimDelete').mockImplementationOnce(function (this: JsonlBackendTracker, id) {
      const claiming = claimDelete.call(this, id)
      deleteEntered.resolve(undefined)
      return claiming
    })
    let settled = false
    const deleting = commands.deleteSession({ sessionId: session.id }).then(
      (value) => { settled = true; return { kind: 'success' as const, value } },
      (error: unknown) => { settled = true; return { kind: 'failure' as const, error } },
    )
    try {
      await releaseEntered.promise
      await deleteEntered.promise
      expect(ctx.sessions.get(session.id)).toBeUndefined()
      expect(settled).toBe(false)
      expect(forget).not.toHaveBeenCalled()
      expect(await Promise.all(names.map(name => readFile(join(dir, name))))).toEqual(before)
      const other = new Context()
      contexts.push(other)
      await other.plugin(JsonlSessionPersistence, { root, compression })
      await expect(other.sessionPersistence.delete(session.id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    } finally {
      releaseGate.resolve(undefined)
      await deleting
    }
    const result = await deleting
    if (closeOutcome === 'failure') {
      expect(result).toEqual({ kind: 'failure', error: failure })
      expect(forget).not.toHaveBeenCalled()
      expect((await readdir(dir)).filter(name => /[.]jsonl([.]zstd)?$/.test(name)).sort()).toEqual(names)
      expect(await Promise.all(names.map(name => readFile(join(dir, name))))).toEqual(before)
    } else {
      expect(result).toEqual({ kind: 'success', value: { deleted: true, archivedSessionIds: [] } })
      expect(forget).toHaveBeenCalledWith(session.id)
      expect((await readdir(dir)).filter(name => /[.]jsonl([.]zstd)?$/.test(name))).toEqual([])
      expect(await ctx.sessionPersistence.list()).toEqual([])
    }
  })
})
