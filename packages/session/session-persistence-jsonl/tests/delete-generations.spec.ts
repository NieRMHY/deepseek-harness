import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

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
    expect(before.length).toBeGreaterThan(1)

    expect(await ctx.sessionPersistence.delete(f.id)).toBe(true)

    // 任何残留的规范代都会让会话重新出现在 list() 里，所以要求一个不剩。
    // session.lock 之类的会话自有产物不在删除范围内，目录本身可以留下。
    const leftovers = (await readdir(dir)).filter(name => /\.jsonl(\.zstd)?$/.test(name))
    expect(leftovers).toEqual([])
    expect(await ctx.sessionPersistence.list()).not.toContainEqual(
      expect.objectContaining({ id: f.id }),
    )
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
