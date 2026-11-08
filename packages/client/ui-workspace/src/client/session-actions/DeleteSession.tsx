/**
 * Add by MHY, 2026-09-24：本 fork 独有的「彻底删除会话」入口。
 *
 * The delete action: a `sidebar.workspaces.session.menu.item` row over the
 * injected request callback, plus the `shell.overlay` dialog that confirms
 * first. Deleting is not archiving — it removes the persisted log, the
 * projection checkpoint, every durable registry slot, and the archive-set
 * entry — so unlike archive, which a quiet Session performs on one click and
 * offers undo for, this action always asks before it destroys anything.
 *
 * The row only raises the request; the dialog entry answers it. That keeps the
 * destructive call in one place and lets the dialog own its own in-flight and
 * error state.
 */
import { useState } from 'react'
import { Button, IconTrashOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SessionDeleteConfirmInjected, SessionDeleteConfirmProps, SessionDeleteConfirmRequest,
  SessionDeleteInjected, SessionMenuItemProps,
} from '../contract/slots.ts'
import browserCss from '../rows/WorkspaceBrowser.module.css'

/**
 * Menu row (order 500): delete one Session outright.
 * @param props - owner share, the delete share, and the locale seat.
 * @returns the row.
 */
export function DeleteSessionMenuItem({
  sessionId, requestSessionDelete, t,
}: SessionMenuItemProps<SessionDeleteInjected>) {
  return (
    <MenuItemButton
      icon={<IconTrashOutlineRegular size={14} />}
      onSelect={() => { requestSessionDelete(sessionId) }}
    >
      {t('menu.deleteSession')}
    </MenuItemButton>
  )
}

/**
 * The `shell.overlay` entry: nothing while no confirmation is pending,
 * otherwise one dialog per request (keyed by the Session). Confirming deletes
 * the log and every durable trace; cancelling leaves the Session as it was.
 * @param props - the request hook, its settlement, the delete hop, and the locale seat.
 * @returns the open dialog, or null.
 */
export function SessionDeleteConfirmDialog({
  useDeleteRequest, settleSessionDelete, deleteSession, t,
}: SessionDeleteConfirmProps) {
  const request = useDeleteRequest(pending => pending)
  if (request === null) return null
  return (
    <DeleteConfirmForm
      key={request.sessionId}
      request={request}
      deleteSession={deleteSession}
      onSettle={settleSessionDelete}
      t={t}
    />
  )
}

/** One request's dialog: in-flight and error state die with it. */
function DeleteConfirmForm({ request, deleteSession, onSettle, t }: {
  request: SessionDeleteConfirmRequest
  deleteSession: SessionDeleteConfirmInjected['deleteSession']
  onSettle: () => void
  t: SessionDeleteConfirmProps['t']
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    if (deleting) return
    onSettle()
  }
  const confirm = () => {
    setDeleting(true)
    setError(null)
    deleteSession(request.sessionId).then(() => {
      setDeleting(false)
      onSettle()
    }).catch((reason: unknown) => {
      setDeleting(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('delete.confirm.title')}
      description={t('delete.confirm.desc', { title: request.displayTitle })}
      footer={(
        <>
          <Button variant="outline" disabled={deleting} onClick={close}>{t('cancel')}</Button>
          <Button
            variant="outline"
            className={browserCss.deleteAction}
            disabled={deleting}
            onClick={confirm}
          >
            {t('delete.confirm.action')}
          </Button>
        </>
      )}
    >
      <div className={browserCss.deleteStatus} role="status">{t('delete.confirm.warning')}</div>
      {deleting && <div className={browserCss.deleteStatus} role="status">{t('delete.confirm.pending')}</div>}
      {error !== null && <div className={browserCss.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
