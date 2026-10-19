import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
// Modify by MHY, 0.2.1 的 JSONL 插件改用具名模块导出。
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'
import { SessionWriteLease } from '../src/lease.ts'

/**
 * Add by MHY, 2026-09-24：删除必须清掉目录里的**每一代**规范日志。
 *
 * 会话格式在 0.1.7 升到 V4，而迁移是「发布后继、从不删源」——一次写打开会让
 * 同一目录同时存在 v3 与 v4 两份。只删最高代时，较低的代仍可被解析（列举取
 * 「数值最高的规范代」，v3 就成了那个最高代），会话会重新出现，而 rmdir 因目录
 * 非空报 ENOTEMPTY 被吞掉，delete 依然返回 true —— 接口说删成功，实际没删干净。
 */

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe.each(['none', 'zstd'] as const)('Session deletion across format generations (%s)', (compression) => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-delete-generations-'))
    roots.push(root)
    const id = SessionId('two-generations')
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ].map((event, seq) => ({ ...event, seq, time: seq + 10 }))
    const header = { type: 'session', version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const path = generationLogPath(root, undefined, id, 3, compression)
    const first = JSON.stringify(header) + '\n'
    const body = events.map(row => JSON.stringify(row) + '\n').join('')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, compression === 'none' ? first + body
      : Buffer.concat([await compressZstdFrame(first), await compressZstdFrame(body)]))
    async function mount() {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root, compression })
      return ctx
    }
    return { id, root, path, mount }
  }

  it('removes the V3 predecessor and its published V4 successor together', async () => {
    const f = await fixture()
    const ctx = await f.mount()
    const dir = dirname(f.path)

    // 写打开发布 V4 后继；迁移从不删源，所以两代同时在盘上。
    const handle = await ctx.sessionPersistence.open(f.id, 'write')
    await handle.close()
    const before = (await readdir(dir)).sort()
    expect(before.filter(name => /[.]jsonl([.]zstd)?$/.test(name))).toHaveLength(2)
    expect(await ctx.sessionPersistence.list()).toContainEqual(
      expect.objectContaining({ header: expect.objectContaining({ id: f.id }) }),
    )

    expect(await ctx.sessionPersistence.delete(f.id)).toBe(true)

    // 任何残留的规范代都会让会话重新出现在 list() 里，所以要求一个不剩。
    // session.lock 之类的会话自有产物不在删除范围内，目录本身可以留下。
    const leftovers = (await readdir(dir)).filter(name => /\.jsonl(\.zstd)?$/.test(name))
    expect(leftovers).toEqual([])
    expect(await ctx.sessionPersistence.list()).not.toContainEqual(
      expect.objectContaining({ header: expect.objectContaining({ id: f.id }) }),
    )
  })

  // Add by MHY, 删除必须遵守真实 writer 生命周期及同一内核租约。
  it.each(['same store', 'other store'])('refuses a live writer in the %s without losing any generation', async (owner) => {
    const f = await fixture()
    const holder = await f.mount()
    const deleter = owner === 'same store' ? holder : await f.mount()
    const handle = await holder.sessionPersistence.open(f.id, 'write')
    const dir = dirname(f.path)
    const names = (await readdir(dir)).filter(name => /[.]jsonl([.]zstd)?$/.test(name)).sort()
    expect(names).toHaveLength(2)
    const before = await Promise.all(names.map(name => readFile(join(dir, name))))

    await expect(deleter.sessionPersistence.delete(f.id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    expect((await readdir(dir)).filter(name => /[.]jsonl([.]zstd)?$/.test(name)).sort()).toEqual(names)
    expect(await Promise.all(names.map(name => readFile(join(dir, name))))).toEqual(before)
    expect(await deleter.sessionPersistence.list()).toContainEqual(
      expect.objectContaining({ header: expect.objectContaining({ id: f.id }) }),
    )
    await handle.append([{ type: 'turn/start', seq: SessionSeq(2), time: 12, data: { turn: 2 } }])
    expect((await handle.read()).events.map(event => event.seq)).toEqual([0, 1, 2])

    await handle.close()
    expect(await deleter.sessionPersistence.delete(f.id)).toBe(true)
    expect((await readdir(dir)).filter(name => /[.]jsonl([.]zstd)?$/.test(name))).toEqual([])
    expect(await deleter.sessionPersistence.list()).toEqual([])
  })

  it('refuses an unmaterialized local writer until its owner closes it', async () => {
    const f = await fixture()
    const ctx = await f.mount()
    const id = SessionId('pending-creator')
    const handle = await ctx.sessionPersistence.create({
      id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false,
    })
    await expect(ctx.sessionPersistence.delete(id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await handle.flush()
    await expect(ctx.sessionPersistence.delete(id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await handle.close()
    expect(await ctx.sessionPersistence.delete(id)).toBe(true)
  })

  it('includes a successor published after lookup but before acquiring the deletion lease', async () => {
    const f = await fixture()
    const ctx = await f.mount()
    const holder = await f.mount()
    const dir = dirname(f.path)
    const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
    vi.spyOn(SessionWriteLease, 'acquire').mockImplementationOnce(async (...args) => {
      const writer = await holder.sessionPersistence.open(f.id, 'write')
      await writer.close()
      expect((await readdir(dir)).filter(name => /[.]jsonl([.]zstd)?$/.test(name))).toHaveLength(2)
      return acquire(...args)
    })

    expect(await ctx.sessionPersistence.delete(f.id)).toBe(true)
    expect((await readdir(dir)).filter(name => /[.]jsonl([.]zstd)?$/.test(name))).toEqual([])
    expect(await ctx.sessionPersistence.list()).toEqual([])
  })

  it('releases its lease and local claim when cancelled before unlinking', async () => {
    const f = await fixture()
    const ctx = await f.mount()
    const handle = await ctx.sessionPersistence.open(f.id, 'write')
    await handle.close()
    const dir = dirname(f.path)
    const names = (await readdir(dir)).filter(name => /[.]jsonl([.]zstd)?$/.test(name)).sort()
    const before = await Promise.all(names.map(name => readFile(join(dir, name))))
    const abort = new AbortController()
    const reason = new Error('cancel deletion after acquiring lease')
    const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
    vi.spyOn(SessionWriteLease, 'acquire').mockImplementationOnce(async (...args) => {
      const lease = await acquire(...args)
      abort.abort(reason)
      return lease
    })

    await expect(ctx.sessionPersistence.delete(f.id, abort.signal)).rejects.toBe(reason)
    expect((await readdir(dir)).filter(name => /[.]jsonl([.]zstd)?$/.test(name)).sort()).toEqual(names)
    expect(await Promise.all(names.map(name => readFile(join(dir, name))))).toEqual(before)
    const successor = await ctx.sessionPersistence.open(f.id, 'write')
    await successor.close()
    expect(await ctx.sessionPersistence.delete(f.id)).toBe(true)
  })

  it('reports false once the stored generations are gone', async () => {
    const f = await fixture()
    const ctx = await f.mount()
    expect(await ctx.sessionPersistence.delete(f.id)).toBe(true)
    // 第二次删除：磁盘上已无记录。
    expect(await ctx.sessionPersistence.delete(f.id)).toBe(false)
  })

  it('reports false for a session that never materialized', async () => {
    const f = await fixture()
    const ctx = await f.mount()
    expect(await ctx.sessionPersistence.delete(SessionId('never-written'))).toBe(false)
  })
})
