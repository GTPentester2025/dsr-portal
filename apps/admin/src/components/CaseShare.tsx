import { useState } from 'react'
import { api } from '../lib/api'
import { Alert, Button, Field, Modal, TextInput } from './ui'
import { Icon } from './Icon'
import { useToast } from './Toast'
import type { CaseDetail } from '../lib/api'

/**
 * Download the case as a PDF, or hand it to Outlook.
 *
 * A word on the attachment: no mail client can be opened with a file already
 * attached. mailto: has no attachment parameter, and neither Outlook Web's
 * compose deeplink nor the desktop protocol handler accepts one — the browser
 * would be handing an arbitrary local file to a mail client, which is exactly
 * the thing that is not allowed. So the PDF is downloaded first and the compose
 * window opens with everything else filled in; attaching is one drag.
 */
export function CaseShare({ c, onSent }: { c: CaseDetail; onSent?: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')

  const filename = `${c.caseRef}.pdf`

  const fetchPdf = async (): Promise<Blob> => {
    const res = await fetch(`/internal/cases/${c.id}/export.pdf`, { credentials: 'same-origin' })
    if (!res.ok) throw new Error(`Could not generate the PDF (${res.status})`)
    return res.blob()
  }

  const saveBlob = (blob: Blob) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const download = async () => {
    setBusy(true)
    try {
      saveBlob(await fetchPdf())
    } catch (e) {
      toast.error('Download failed', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const recipients = to
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean)

  const valid = recipients.length > 0 && recipients.every((r) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(r))

  const due = c.dueAt ? new Date(c.dueAt) : null
  const daysLeft = due ? Math.ceil((due.getTime() - Date.now()) / 86_400_000) : null
  const urgency =
    daysLeft === null
      ? ''
      : daysLeft < 0
        ? ` — OVERDUE by ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'}`
        : daysLeft <= 3
          ? ` — due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`
          : ''

  const subject = `[${c.zoneId}] ${c.caseRef} — ${c.requestTypes.map(titleCase).join(', ') || 'Privacy request'}${urgency}`

  /**
   * Written as a briefing rather than a data dump: what is being asked, by
   * when, and what the recipient is expected to do. A colleague opening this
   * should be able to act without opening the portal first.
   */
  const body = [
    `Hello,`,
    ``,
    `I need your help with privacy request ${c.caseRef}.`,
    note ? `` : null,
    note ? note : null,
    ``,
    `WHAT IS BEING ASKED`,
    `  Request type   ${c.requestTypes.map(titleCase).join(', ') || 'Not specified'}`,
    `  Requester      ${c.requesterName ? `${c.requesterName} <${c.requesterEmail}>` : c.requesterEmail}`,
    `  Zone           ${c.zoneId}`,
    ``,
    `TIMING`,
    `  Received       ${new Date(c.createdAt).toLocaleString()}`,
    `  Response due   ${due ? due.toLocaleString() : 'Not set'}${
      daysLeft === null ? '' : daysLeft < 0 ? `  (overdue by ${Math.abs(daysLeft)} days)` : `  (${daysLeft} days remaining)`
    }`,
    `  Current status ${titleCase(c.status)}`,
    ``,
    `WHAT I NEED`,
    `  Please reply to this email with the information requested above.`,
    `  This is a statutory deadline, so a reply before ${due ? due.toLocaleDateString() : 'the due date'} is required`,
    `  even if the answer is that you hold nothing.`,
    ``,
    `The full case record is attached as a PDF.`,
    `The case is also available here: ${window.location.origin}/admin/#/cases/${c.id}`,
    ``,
    `Thank you.`,
  ]
    .filter((line) => line !== null)
    .join('\r\n')

  /**
   * Mark the case as waiting on whoever this was addressed to.
   *
   * The mail leaves through the user's own client, so the server never sees it
   * — without this the case would show as waiting on nobody despite an email
   * having gone out.
   */
  const recordPending = async () => {
    try {
      await api.post(`/internal/cases/${c.id}/pending`, { to: recipients })
      onSent?.()
    } catch {
      // Advisory only: failing to record must not block the compose window.
    }
  }

  const openMail = async () => {
    setBusy(true)
    try {
      // Download first: the compose window should already have the file waiting
      // in the downloads bar when it appears.
      saveBlob(await fetchPdf())
      await recordPending()
      window.location.href = `mailto:${encodeURIComponent(recipients.join(','))}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
      setOpen(false)
      setShowHint(true)
    } catch (e) {
      toast.error('Could not prepare the email', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const openOutlookWeb = async () => {
    setBusy(true)
    try {
      saveBlob(await fetchPdf())
      await recordPending()
      window.open(
        `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(recipients.join(';'))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
        '_blank',
        'noopener',
      )
      setOpen(false)
      setShowHint(true)
    } catch (e) {
      toast.error('Could not prepare the email', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button variant="secondary" icon="download" loading={busy} onClick={download}>
        PDF
      </Button>
      <Button variant="secondary" icon="mail" onClick={() => setOpen(true)}>
        Email
      </Button>

      {open && (
        <Modal title="Email this case" onClose={() => setOpen(false)}>
          <div className="space-y-4">
            <Field
              label="To"
              required
              hint="Separate several addresses with a comma. The case will show as pending on them."
              error={to.length > 0 && !valid ? 'Enter valid email addresses.' : undefined}
              htmlFor="share-to"
            >
              <TextInput
                id="share-to"
                type="email"
                value={to}
                autoFocus
                placeholder="legal@company.com, records@company.com"
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>

            <Field label="Add a line of context" hint="Optional. Appears near the top of the message." htmlFor="share-note">
              <TextInput
                id="share-note"
                value={note}
                placeholder="We need the account records for this requester by Friday."
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>

            <div className="rounded-lg border border-line bg-sunken/40 p-3">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">Subject</p>
              <p className="text-[12.5px] text-ink">{subject}</p>
            </div>

            <Alert tone="info" title="The PDF downloads, then your mail app opens">
              No mail client can be opened with a file already attached, so drag the downloaded
              PDF into the message. Everything else is filled in.
            </Alert>

            <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="secondary" icon="globe" loading={busy} disabled={!valid} onClick={openOutlookWeb}>
                Outlook on the web
              </Button>
              <Button variant="primary" icon="mail" loading={busy} disabled={!valid} onClick={openMail}>
                Open mail app
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {showHint && (
        <Modal title="Attach the PDF" onClose={() => setShowHint(false)}>
          <div className="space-y-4">
            <Alert tone="info" title="The PDF has been downloaded">
              Your mail app has opened with the subject and details filled in. Drag{' '}
              <strong>{filename}</strong> from your downloads into the message to attach it.
            </Alert>

            <p className="text-[12.5px] leading-relaxed text-muted">
              Mail clients cannot be opened with a file already attached — no browser allows a web
              page to place a local file into a message. Everything else is filled in for you.
            </p>

            <div className="rounded-lg border border-line bg-sunken/40 p-3">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">Subject</p>
              <p className="text-[12.5px] text-ink">{subject}</p>
            </div>

            <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
              <Button variant="ghost" onClick={openOutlookWeb}>
                <Icon name="globe" size={13} className="mr-1.5" />
                Open Outlook on the web instead
              </Button>
              <Button variant="primary" onClick={() => setShowHint(false)}>Done</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

function titleCase(text: string): string {
  const spaced = text.replace(/[_-]+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
