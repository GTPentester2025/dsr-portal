import { useState } from 'react'
import { api, type CaseDetail } from '../../lib/api'
import { Button, Card, Textarea } from '../ui'
import { Icon } from '../Icon'
import { useToast } from '../Toast'

const fmtWhen = (v: string) => new Date(v).toLocaleString()

/**
 * The internal discussion, distinct from the Activity record.
 *
 * Activity is what happened to the case; comments are what the team thinks
 * about it — "waiting on legal", "same person as last month's request".
 * Append-only: a note that can be edited after the fact is worthless in a
 * dispute, which is the one moment anyone rereads it. Watchers are notified
 * of each comment.
 */
export function CommentsCard({
  c,
  canComment,
  reload,
}: {
  c: CaseDetail
  canComment: boolean
  reload: () => void
}) {
  const toast = useToast()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const comments = c.comments ?? []

  const post = async () => {
    setBusy(true)
    try {
      await api.post(`/internal/cases/${c.id}/comments`, { body: draft })
      setDraft('')
      toast.success('Comment added')
      reload()
    } catch (e) {
      toast.error('Comment not saved', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (comments.length === 0 && !canComment) return null

  return (
    <Card
      title="Internal notes"
      subtitle="Visible to the team only — never sent to the requester. Watchers are notified."
    >
      <div className="space-y-3">
        {comments.length === 0 ? (
          <p className="text-[12.5px] text-faint">No notes yet.</p>
        ) : (
          <ul className="space-y-3">
            {comments.map((cm) => (
              <li key={cm.id} className="rounded-lg border border-line bg-sunken/40 px-3 py-2.5">
                <p className="mb-1 flex flex-wrap items-baseline gap-x-2 text-[11.5px]">
                  <span className="font-medium text-ink">{cm.author_name ?? 'Former user'}</span>
                  <span className="tabular text-faint">{fmtWhen(cm.created_at)}</span>
                </p>
                <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">
                  {cm.body}
                </p>
              </li>
            ))}
          </ul>
        )}

        {canComment && (
          <div className="border-t border-line pt-3">
            <Textarea
              rows={2}
              value={draft}
              placeholder="Add a note for the team…"
              aria-label="New internal note"
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[11px] text-faint">
                <Icon name="eyeOff" size={10} className="mr-1 inline-block" />
                Notes cannot be edited or deleted once posted.
              </span>
              <Button
                variant="secondary"
                icon="plus"
                loading={busy}
                disabled={!draft.trim()}
                onClick={() => void post()}
              >
                Add note
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
