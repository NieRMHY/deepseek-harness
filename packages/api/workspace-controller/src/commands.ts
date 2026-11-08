/** Workspace command implementation and stable Remote failure mapping. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  WorkspaceActiveSessionError,
  WorkspaceArchivedSessionPinError,
  WorkspaceId,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  WorkspaceUnknownSessionError,
} from '@deepseek-ai/dsh-workspace'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { workspaceView } from './feed.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceDeleteSessionRequest,
  WorkspaceDeleteSessionValue,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
} from './types.ts'

/** Implements Workspace mutations against the authoritative registry. */
export class WorkspaceCommands {
  private operationTail = Promise.resolve()

  /** @param ctx - Host context containing the Workspace registry. */
  constructor(private readonly ctx: Context) {}

  /**
   * Create or resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.enqueue(async () => {
      try {
        const existing = await this.ctx.workspaceRegistry.resolveByPath(request.path)
        if (existing !== undefined) {
          return { workspace: workspaceView(existing), created: false }
        }
        const workspace = await this.ctx.workspaceRegistry.create(request.path)
        return { workspace: workspaceView(workspace), created: true }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'workspace/invalid-path',
          `cannot create a Workspace at "${request.path}": ${errorMessage(error)}`,
          { path: request.path },
          { cause: error },
        )
      }
    })
  }

  /**
   * Rename one Workspace after serializing title ownership checks.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    const title = request.title.trim()
    if (title === '') {
      return Promise.reject(new RemoteError('gateway/bad-request', 'Workspace rename requires a non-blank title', {}))
    }
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      if (title !== workspace.title) {
        if (this.ctx.workspaceRegistry.list().some(candidate =>
          candidate.id !== workspace.id && candidate.title === title)) {
          throw new RemoteError(
            'workspace/name-conflict',
            `Workspace name '${title}' is already in use`,
            { name: title },
          )
        }
        await workspace.setTitle(title)
      }
      return { workspace: workspaceView(workspace) }
    })
  }

  /**
   * Delete one Workspace registration without deleting its directory or Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.enqueue(async () => {
      if (!await this.ctx.workspaceRegistry.delete(WorkspaceId(request.workspaceId))) {
        throw workspaceNotFound(request.workspaceId)
      }
      return { deleted: true }
    })
  }

  /**
   * Move one Workspace within the durable registry order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  async insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    try {
      const workspaceIds = await this.ctx.workspaceRegistry.insertBefore(
        WorkspaceId(request.workspaceId),
        request.beforeWorkspaceId === undefined
          ? undefined
          : WorkspaceId(request.beforeWorkspaceId),
      )
      return { workspaceIds: [...workspaceIds] }
    } catch (error) {
      if (!(error instanceof WorkspaceOrderInvalidError)) throw error
      throw workspaceNotFound(error.workspaceId)
    }
  }

  /**
   * Move one accounted Session within a Workspace's manual order.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  async insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    const workspace = this.requireWorkspace(request.workspaceId)
    try {
      await workspace.insertSessionBefore(request.sessionId, request.beforeSessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceMoveInvalidError)) throw error
      throw new RemoteError(
        'workspace/move-invalid',
        error.message,
        {
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          ...request.beforeSessionId === undefined
            ? {}
            : { beforeSessionId: request.beforeSessionId },
        },
        { cause: error },
      )
    }
    return { workspace: workspaceView(workspace) }
  }

  /**
   * Add one known Session to the registry-global archive set. Without
   * `stopActivity` a Session with running work is refused as
   * `workspace/session-active` with the activity the registry's providers
   * reported; with it, the providers stop that work first.
   * @param request - Session identity to archive and whether to stop its work.
   * @returns the complete resulting archive set.
   */
  async archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    try {
      await this.ctx.workspaceRegistry.archiveSession(
        request.sessionId,
        request.stopActivity === true ? { stopActivity: true } : {},
      )
    } catch (error) {
      if (error instanceof WorkspaceUnknownSessionError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
      }
      if (error instanceof WorkspaceActiveSessionError) {
        throw new RemoteError(
          'workspace/session-active',
          error.message,
          { sessionId: request.sessionId, activity: error.activity },
          { cause: error },
        )
      }
      throw error
    }
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }

  /**
   * Drop one Session from the registry-global archive set. An id that is not
   * archived is not an error: the call is idempotent, so a lost race with
   * another surface resolves as a no-op.
   * @param request - Session identity to unarchive.
   * @returns the complete resulting archive set.
   */
  async unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    await this.ctx.workspaceRegistry.unarchiveSession(request.sessionId)
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }

  /**
   * Add one known unarchived Session to the registry-global pin set.
   * @param request - Session identity to pin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  async pinSession(request: WorkspacePinSessionRequest): Promise<WorkspacePinValue> {
    try {
      await this.ctx.workspaceRegistry.pinSession(request.sessionId)
    } catch (error) {
      if (error instanceof WorkspaceUnknownSessionError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
      }
      if (error instanceof WorkspaceArchivedSessionPinError) {
        throw new RemoteError('gateway/bad-request', error.message, {}, { cause: error })
      }
      throw error
    }
    return { pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds] }
  }

  /**
   * Drop one Session from the registry-global pin set. An id that is not
   * pinned is not an error: the call is idempotent, so a lost race with
   * another surface resolves as a no-op.
   * @param request - Session identity to unpin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  async unpinSession(request: WorkspaceUnpinSessionRequest): Promise<WorkspacePinValue> {
    await this.ctx.workspaceRegistry.unpinSession(request.sessionId)
    return { pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds] }
  }

  /**
   * Permanently delete one Session and every subagent Session it delegated:
   * their persisted logs, projection-cache checkpoints, durable registry
   * slots, and archive-set entries. A fork carries `parentSession` without the
   * subagent origin and is an independent conversation, so it never follows
   * its source.
   * Modify by MHY: Session work is stopped through the Workspace providers
   * before a live Session is cancelled, flushed, and detached. A stop or flush
   * failure preserves its stored transcript and registry slots.
   * @param request - Session identity to delete.
   * @returns deletion receipt plus the complete updated archive set.
   */
  async deleteSession(request: WorkspaceDeleteSessionRequest): Promise<WorkspaceDeleteSessionValue> {
    const sessionId = request.sessionId
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('session deletion is unavailable: no session persistence service is composed')
    }
    // Add by MHY, 2026-10-21：子 agent 是独立 Session（header.parentSession + origin:'subagent'），
    // 原先只删请求里的那一个 id：父会话删除后，子会话日志仍留在磁盘上，而侧边栏按
    // origin === 'subagent' 把它们过滤掉，于是变成既看不见、也没有删除入口的孤儿。
    const descendants = await this.subagentDescendants(sessionId, persistence)

    // Modify by MHY, stop providers also own work for cold Sessions; a failed stop must preserve the transcript.
    // 这一步同时取消仍在运行的后代（subagent 的 archive-admission 监听 workspace/session-stop）。
    await this.ctx.parallel('workspace/session-stop', { sessionId })

    // 子会话先删、父会话最后删：父会话的持久化删除是整棵子树的提交点，
    // 中途失败时父会话仍在会话列表里，用户可以重试。
    for (const descendant of descendants) {
      // 子会话也可能持有自己的提醒和后台任务，走同一条停止路径。
      await this.ctx.parallel('workspace/session-stop', { sessionId: descendant })
      await this.deleteStoredSession(descendant, persistence, false)
    }
    await this.deleteStoredSession(sessionId, persistence, true)
    return {
      deleted: true,
      archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds],
    }
  }

  /**
   * Every subagent Session delegated by `rootId`, at any depth, read from
   * stored headers plus live Agents. A damaged unrelated Session only narrows
   * the search to live descendants; it never blocks deleting `rootId`.
   * @param rootId - Session whose subagent subtree is collected.
   * @param persistence - stored-session source for cold descendants.
   * @returns descendant ids, each parent before its own descendants.
   */
  private async subagentDescendants(rootId: SessionId, persistence: SessionPersistence): Promise<SessionId[]> {
    const headers: SessionHeader[] = this.ctx.sessions.list().map(session => session.header)
    for (const agent of this.ctx.agents.list()) headers.push(agent.session.header)
    try {
      for (const snapshot of await persistence.list()) headers.push(snapshot.header)
    } catch (error: unknown) {
      this.ctx.logger.warn(`session deletion: listing stored Sessions failed, only live subagents cascade: ${String(error)}`)
    }
    const childrenOf = new Map<SessionId, SessionId[]>()
    for (const header of headers) {
      const { parentSession, origin } = header
      if (parentSession === undefined || origin !== 'subagent') continue
      const siblings = childrenOf.get(parentSession) ?? []
      siblings.push(header.id)
      childrenOf.set(parentSession, siblings)
    }
    const descendants: SessionId[] = []
    const visited = new Set<SessionId>([rootId])
    const pending: SessionId[] = [rootId]
    while (pending.length > 0) {
      const parentId = pending.shift() as SessionId
      for (const childId of childrenOf.get(parentId) ?? []) {
        if (visited.has(childId)) continue
        visited.add(childId)
        descendants.push(childId)
        pending.push(childId)
      }
    }
    return descendants
  }

  /**
   * Delete one Session's durable data after its work has stopped: detach a
   * live Session, remove its transcript, then forget its registry and cache
   * slots. A subagent descendant whose transcript is already gone is only
   * forgotten, so an earlier or concurrent removal stays idempotent.
   * @param sessionId - Session to delete.
   * @param persistence - persistence service owning the transcript.
   * @param required - whether a missing transcript is an error.
   */
  private async deleteStoredSession(
    sessionId: SessionId,
    persistence: SessionPersistence,
    required: boolean,
  ): Promise<void> {
    const liveSession = this.ctx.sessions.get(sessionId)
    if (liveSession !== undefined) {
      const agent = this.ctx.agents.get(sessionId)
      if (agent !== undefined) {
        agent.cancel({ kind: 'disposed' })
        await agent.whenIdle()
      }
      await this.ctx.sessions.flush(liveSession)
      this.ctx.agents.remove(sessionId)
      this.ctx.sessions.remove(sessionId)
    }
    // Modify by MHY, 2026-09-11：persistence.delete() 的返回值必须检查。
    // 它返回 false 表示"磁盘上没找到该会话的日志"——此时什么都没删掉。
    // 旧代码丢弃返回值、无条件继续 forgetSession()，而 forgetSession 会把该 id
    // 从归档集合里摘掉：结果是**日志还在磁盘上、却从归档列表消失**，UI 按
    // sessionVisible(!archived) 判定，会话就"跑到未归档里去了"——用户报告的
    // 正是这个现象。只有确实删除成功才解除归档；否则如实报错。
    const removed = await persistence.delete(sessionId)
    if (!removed && required) {
      throw new RemoteError(
        'session/not-found',
        `session "${sessionId}" has no stored transcript to delete`,
        { sessionId },
      )
    }
    // 客户端靠 api-session/removed 摘除列表行，而该事件由 session/disposed 转发，
    // 只对"活会话"触发；已归档/久未打开的会话不在 live registry 里（上面的 if
    // 分支没进）。因此 forgetSession 内部会发出 workspace/session-forgotten，
    // 由 session-controller 补发一次移除通知——见 workspace/src/index.ts。
    // Modify by MHY, 2026-09-11
    await this.ctx.workspaceRegistry.forgetSession(sessionId)
    await this.ctx.get('sessionProjectionCache')?.forget(sessionId)
  }

  private requireWorkspace(workspaceId: WorkspaceId): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
    if (workspace === undefined) throw workspaceNotFound(workspaceId)
    return workspace
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function workspaceNotFound(workspaceId: WorkspaceId): RemoteError<'workspace/not-found'> {
  return new RemoteError(
    'workspace/not-found',
    `Workspace "${workspaceId}" not found`,
    { workspaceId },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
