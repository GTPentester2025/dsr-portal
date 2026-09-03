import { useState } from 'react'
import { api, STATUS_LABELS, type CaseDetail } from '../../lib/api'
import { humanise, fmtDateTime } from '../../lib/sla'
import { Button, Card } from '../ui'
import { Icon } from '../Icon'
import { useToast } from '../Toast'

/**
 * The SLA clock: how much of the window is gone, how long is left, and the
 * controls that stop and restart it.
 *
 * Two dates required mental arithmetic to answer the only question that
 * matters on this screen, so the bar and the remaining time lead instead.
 * Pause was previously an API-only feature — the endpoint existed and no
 * screen offered it — and paused time was fetched but never shown, so a
 * clock that had legitimately stood still for a fortnight read as ticking.
 */
export function SlaCard({
  c,
  canAct,
  reload,
}: {
  c: CaseDetail
  canAct: boolean
  reload: () => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState('')
  const clock = c.slaClock
  if (!clock) return null

  const start = new Date(clock.startedAt).getTime()
  const due = new Date(clock.dueAt).getTime()
  const now = Date.now()
  const total = Math.max(1, due - start)
  const used = Math.min(1, Math.max(0, (now - start) / total))
  const remainingMs = due - now
  const breached = remainingMs < 0 || clock.state === 'breached'
  const closed = c.status === 'closed' || clock.state === 'stopped'
  const paused = clock.state === 'paused'

  const tone = closed
    ? 'var(--t-faint)'
    : paused
      ? 'var(--t-info)'
      : breached
        ? 'var(--t-danger)'
        : used > 0.75
          ? 'var(--t-warning)'
          : 'var(--t-positive)'

  const act = async (verb: 'pause' | 'resume') => {
    setBusy(verb)
    try {
      await api.post(`/internal/cases/${c.id}/sla/${verb}`)
      toast.success(verb === 'pause' ? 'Clock paused' : 'Clock resumed')
      reload()
    } catch (e) {
      toast.error('That did not work', (e as Error).message)
    } finally {
      setBusy('')
    }
  }

  // Every extension in the record, not only the latest justification: a case
  // extended twice must show both reasons or the first one exists only in the
  // audit log.
  const extensions = c.history.filter(
    (h) => h.toStatus === 'extended' && h.fromStatus !== 'extended',
  )
  const latestJustification = clock.extensionJustification

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Icon name={paused ? 'pause' : 'clock'} size={15} style={{ color: tone }} className="shrink-0" />
        <p className="text-[13.5px] font-semibold" style={{ color: tone }}>
          {closed
            ? 'Clock stopped'
            : paused
              ? 'Clock paused'
              : breached
                ? `Overdue by ${humanise(-remainingMs)}`
                : `${humanise(remainingMs)} left`}
        </p>

        {/* min-w-0 lets the bar shrink below its basis; without it the row is
            wider than the card on a phone and pushes the page sideways. */}
        <div className="h-1.5 min-w-0 flex-1 basis-32 overflow-hidden rounded-full bg-sunken">
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${used * 100}%`, background: tone, transitionTimingFunction: 'var(--ease-out-expo)' }}
          />
        </div>

        <span className="mono text-[11px] text-faint">{Math.round(used * 100)}% used</span>
        <span className="mono text-[11px] text-faint">due {fmtDateTime(clock.dueAt)}</span>

        {canAct && !closed && (
          <span className="flex gap-1.5">
            {paused ? (
              <Button
                variant="secondary"
                icon="play"
                loading={busy === 'resume'}
                onClick={() => void act('resume')}
              >
                Resume
              </Button>
            ) : (
              <Button
                variant="ghost"
                icon="pause"
                loading={busy === 'pause'}
                onClick={() => void act('pause')}
              >
                Pause clock
              </Button>
            )}
          </span>
        )}
      </div>

      {clock.pausedTotalSecs > 0 && (
        <p className="mt-2 text-[11.5px] text-muted">
          <Icon name="pause" size={10} className="mr-1 inline-block" />
          Held for {humanise(clock.pausedTotalSecs * 1000)} in total while paused — that time
          does not count against the deadline.
        </p>
      )}

      {(extensions.length > 0 || latestJustification) && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">
            Extension{extensions.length > 1 ? 's' : ''}
          </p>
          {extensions.length > 0 ? (
            <ul className="space-y-1">
              {extensions.map((h) => (
                <li key={h.id} className="text-[12px] leading-relaxed text-muted">
                  <span className="tabular text-faint">{fmtDateTime(h.createdAt)}</span>
                  {' — '}
                  {h.note || 'No justification recorded'}
                  {h.actorName ? <span className="text-faint"> · {h.actorName}</span> : null}
                  {h.fromStatus && (
                    <span className="text-faint">
                      {' '}
                      (from {STATUS_LABELS[h.fromStatus] ?? h.fromStatus})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] leading-relaxed text-muted">{latestJustification}</p>
          )}
        </div>
      )}
    </Card>
  )
}
