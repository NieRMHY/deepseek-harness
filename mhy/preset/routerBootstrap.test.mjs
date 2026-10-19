// Add by MHY, 使用真实 Session/AgentLoop、官方 observation 和工具链路，不连接模型网络或主实例。
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '../../packages/core/tools/src/index.ts'
import SystemPrompt from '../../packages/core/system-prompt/src/index.ts'
import SessionStore, { Session } from '../../packages/core/session/src/index.ts'
import AgentRegistry from '../../packages/core/agent/src/index.ts'
import AgentLoop from '../../packages/core/agent-loop/src/index.ts'
import { ReactLoopAgent } from '../../packages/core/agent-loop/src/agent.ts'
import LlmRuntime, { createUserMessage as CreateUserMessage } from '../../packages/llm/llm/src/index.ts'
import SessionProjectionRegistry from '../../packages/session/session-projection/src/index.ts'
import SqliteSessionQueryEngine from '../../packages/session-query/session-query-sqlite/src/index.ts'
import { MockAdapter, textResponse as TextResponse, toolCallResponse as ToolCallResponse } from '../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as router from './router-bootstrap-v1.mjs'
import { ReadSessionRouting, sessionMode as SessionMode } from './router-core.mjs'

async function Setup(t, script = [TextResponse('ok')], routerMode = 'spec') {
  const ctx = new Context()
  t.after(async function Dispose() { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  for (const name of ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'str_replace_editor']) {
    ctx.tools.register(defineTool({
      name, description: name, parameters: {},
      output: { schema: { type: 'string' }, render: function Render(_args, value) { return [{ type: 'text', text: value }] } },
      execute: async function Execute() { return 'tool-ok' },
    }))
  }
  await ctx.plugin(router, { routerMode })
  return { ctx, adapter }
}

async function CreateAgent(ctx, id, seed) {
  return await ctx.agents.create({
    sessionId: id, agentOptions: { provider: 'mock', model: 'mock-pro' },
    ...(seed === undefined ? {} : { seed }),
  })
}

function UserMessage(text) {
  return CreateUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

async function Send(agent, text) {
  agent.followup(UserMessage(text))
  await agent.whenIdle()
  const end = agent.session.snapshotEvents().findLast(function IsEnd(event) { return event.type === 'turn/end' })
  assert.equal(end?.data.reason.kind, 'completed', JSON.stringify(end))
}

async function Assemble(ctx, agent) {
  return await ctx.systemPrompt.assemble({ agent, scope: agent })
}

function ToolNames(assembly) {
  return assembly.tools.map(function Name(tool) { return tool.name }).sort()
}

function Persona(assembly) {
  return assembly.sections.find(function IsPersona(section) { return section.name === 'router-persona' }).text
}

async function Call(ctx, name, agent, args = {}) {
  const result = await ctx.tools.execute({
    callId: 'router-test-call', name, arguments: args, signal: new AbortController().signal,
    ...(agent === undefined ? {} : { agent }),
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  return result.value
}

for (const [text, band, expectedTools] of [
  ['构建一个网页', 'react', ['bash', 'read', 'write', 'edit']],
  ['修复崩溃报错', 'spec', ['bash', 'read', 'edit', 'glob', 'grep']],
]) {
  test(`真实首轮请求在 user/message 持久化前分配 ${band} 模式`, async function RouteFirstRequest(t) {
    const { ctx, adapter } = await Setup(t)
    const { agent } = await CreateAgent(ctx, band)
    assert.ok(agent instanceof ReactLoopAgent)
    assert.ok(agent.session instanceof Session)
    assert.equal(agent.session.events, undefined)
    const events = []
    ctx.on('session/event', function ObserveEvent(session, event) {
      if (session === agent.session && event.type === 'user/message') events.push(event)
    })
    await Assemble(ctx, agent)
    await Send(agent, text)
    assert.equal(adapter.requests.length, 1)
    assert.deepEqual(ToolNames(adapter.requests[0]), [...expectedTools].sort())
    assert.equal(adapter.requests[0].messages[0].content[0].text.includes('hands-on'), band === 'react')
    assert.equal(events.length, 1)
    assert.equal(events[0].data.source.kind, 'user')
    assert.match(await Call(ctx, 'dev_router_status', agent), new RegExp(`band=${band}`))
  })
}

test('真实 weak 请求在同一轮持久化指导，不在 session/event 中重入 append', async function GuideWeakRequest(t) {
  const { ctx, adapter } = await Setup(t, [TextResponse('ok'), TextResponse('again')])
  const { agent } = await CreateAgent(ctx, 'weak')
  await Send(agent, '你好')
  const users = adapter.requests[0].messages.filter(function IsUser(message) { return message.role === 'user' })
  assert.equal(users.length, 2)
  assert.equal(users[0].source.kind, 'user')
  assert.equal(users[1].source.kind, 'plugin')
  assert.match(users[1].content[0].text, /Router: classify this task/)
  await Send(agent, '构建一个网页')
  assert.match(await Call(ctx, 'dev_router_status', agent), /mode=weak.*band=weak/)
  assert.equal(agent.inbox.nextStep.length, 0)
})

test('已有 Session 的完整日志重放后保留首条真实用户分类', async function ReplaySessionMode(t) {
  const { ctx, adapter } = await Setup(t, [TextResponse('built'), TextResponse('continued')])
  const handle = await CreateAgent(ctx, 'restored')
  await Send(handle.agent, '构建一个网页')
  const original = handle.agent.session
  const seed = original.snapshotEvents()
  await handle.dispose()
  const { agent } = await CreateAgent(ctx, 'restored', seed)
  assert.ok(agent.session instanceof Session)
  assert.notEqual(agent.session, original)
  assert.equal(await SessionMode(agent.session, ctx.sessionQuery), 1)
  await Send(agent, '修复崩溃报错')
  assert.equal(adapter.requests.length, 2)
  assert.match(await Call(ctx, 'dev_router_status', agent), /mode=1[.]00.*band=react/)
  assert.ok(!ToolNames(adapter.requests[1]).includes('glob'))
})

for (const routerMode of ['spec', 'standard']) {
  test(`${routerMode} 的真实工具调用后提升为完整 catalog，重放后仍保持提升`, async function PromoteAfterToolCall(t) {
    const { ctx, adapter } = await Setup(t, [ToolCallResponse('call-1', 'bash', {}), TextResponse('done')], routerMode)
    const handle = await CreateAgent(ctx, `promotion-${routerMode}`)
    await Send(handle.agent, '构建一个网页')
    assert.equal(adapter.requests.length, 2)
    assert.ok(!ToolNames(adapter.requests[0]).includes('dev_router_status'))
    assert.ok(ToolNames(adapter.requests[1]).includes('dev_router_status'))
    assert.equal((await ReadSessionRouting(handle.agent.session, ctx.sessionQuery)).hasToolCall, true)
    const seed = handle.agent.session.snapshotEvents()
    await handle.dispose()
    const { agent } = await CreateAgent(ctx, `promotion-${routerMode}`, seed)
    const assembly = await Assemble(ctx, agent)
    assert.ok(ToolNames(assembly).includes('dev_router_status'))
  })
}

test('真实 A/B 交错 assemble 后，A 的 status、set、auto 不修改 B', async function IsolateToolSessions(t) {
  const { ctx } = await Setup(t, [TextResponse('a'), TextResponse('b')])
  const { agent: agentA } = await CreateAgent(ctx, 'A')
  const { agent: agentB } = await CreateAgent(ctx, 'B')
  await Send(agentA, '构建一个网页')
  await Send(agentB, '修复崩溃报错')
  await Assemble(ctx, agentA)
  const beforeB = await Assemble(ctx, agentB)
  assert.match(await Call(ctx, 'dev_router_status', agentA), /mode=1[.]00.*band=react/)
  assert.match(await Call(ctx, 'dev_router_mode', agentA, { mode: 'weak' }), /mode=weak/)
  assert.match(await Call(ctx, 'dev_router_status', agentA), /override=yes/)
  assert.match(await Call(ctx, 'dev_router_status', agentB), /mode=0[.]00.*band=spec/)
  assert.match(await Call(ctx, 'dev_router_status', agentB), /override=no/)
  const afterB = await Assemble(ctx, agentB)
  assert.deepEqual(ToolNames(afterB), ToolNames(beforeB))
  assert.equal(Persona(afterB), Persona(beforeB))
  assert.match(await Call(ctx, 'dev_router_mode', agentA, { mode: 'auto' }), /mode=1[.]00.*band=react/)
  assert.match(await Call(ctx, 'dev_router_status', agentA), /override=no/)
  assert.match(await Call(ctx, 'dev_router_status', agentB), /override=no/)
})

test('无调用 agent 时不回退最后 assemble 的真实 Session', async function RejectUnownedCalls(t) {
  const { ctx } = await Setup(t)
  const { agent } = await CreateAgent(ctx, 'last')
  await Send(agent, '修复崩溃报错')
  await Assemble(ctx, agent)
  assert.equal(await Call(ctx, 'dev_router_status'), 'no agent session')
  assert.equal(await Call(ctx, 'dev_router_mode', undefined, { mode: 'react' }), 'no agent session')
  assert.equal(await Call(ctx, 'dev_mode_subagent', undefined, { mode: 'react', task: '构建一个网页' }), 'no agent route available')
  assert.match(await Call(ctx, 'dev_router_status', agent), /mode=0[.]00.*band=spec/)
  assert.match(await Call(ctx, 'dev_router_status', agent), /override=no/)
})
