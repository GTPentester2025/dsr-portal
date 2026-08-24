import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { Alert, Button, Field, Modal, TextInput } from './ui'
import { Icon } from './Icon'
import { useToast } from './Toast'

export interface Attachment {
  id: string
  filename: string
  mime_type: string
  size_bytes: number
  source: 'requester' | 'response' | 'internal'
  note: string | null
  created_at: string
  uploaded_by_name: string | null
}

const SOURCE_LABEL: Record<string, string> = {
  requester: 'Submitted with the request',
  response: 'Recorded reply',
  internal: 'Working document',
}

function icon(mime: string): string {
  if (mime.startsWith('image/')) return 'file'
  if (mime === 'application/pdf') return 'file'
  return 'mail'
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Files held against a case.
 *
 * Downloads go through the API rather than a direct link so a failure surfaces
 * as a message instead of the browser saving an error page as a PDF, and so the
 * read is recorded — opening a requester's identity document is a disclosure.
 */
export function Attachments({
  caseId,
  canUpload,
  onChanged,
}: {
  caseId: string
  canUpload: boolean
  onChanged?: () => void
}) {
  const toast = useToast()
  const [items, setItems] = useState<Attachment[] | null>(null)
  const [uploading, setUploading] = useState(false)

  const load = useCallback(() => {
    api
      .get<Attachment[]>(`/internal/cases/${caseId}/attachments`)
      .then(setItems)
      .catch(() => setItems([]))
  }, [caseId])
  useEffect(load, [load])

  const download = async (a: Attachment) => {
    try {
      const res = await fetch(`/internal/cases/${caseId}/attachments/${a.id}/download`, {
        credentials: 'same-origin',
      })
      if (!res.ok) throw new Error(`Download failed (${res.status})`)
      const url = URL.createObjectURL(await res.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = a.filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (e) {
      toast.error('Could not download', (e as Error).message)
    }
  }

  if (items === null) return <p className="text-[12px] text-faint">Loading files…</p>

  return (
    <>
      {items.length === 0 ? (
        <p className="text-[12px] text-faint">No files on this case.</p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-3 py-2">
              <Icon name={icon(a.mime_type)} size={15} className="shrink-0 text-faint" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{a.filename}</span>
                <span className="block text-[11px] text-faint">
                  {SOURCE_LABEL[a.source] ?? a.source} · {size(a.size_bytes)} ·{' '}
                  {new Date(a.created_at).toLocaleDateString()}
                  {a.uploaded_by_name && ` · ${a.uploaded_by_name}`}
                </span>
                {a.note && <span className="mt-0.5 block text-[11.5px] text-muted">{a.note}</span>}
              </span>
              <Button variant="ghost" icon="download" onClick={() => download(a)} aria-label={`Download ${a.filename}`}>
                Download
              </Button>
            </li>
          ))}
        </ul>
      )}

      {canUpload && (
        <div className="mt-3 border-t border-line pt-3">
          <RecordResponse
            caseId={caseId}
            busy={uploading}
            setBusy={setUploading}
            onDone={() => {
              load()
              onChanged?.()
            }}
          />
        </div>
      )}
    </>
  )
}

/**
 * Record a reply that arrived outside the portal.
 *
 * The portal sends mail but cannot receive it, so a requester's answer — or a
 * colleague's — only becomes part of the record if someone files it here.
 */
function RecordResponse({
  caseId,
  busy,
  setBusy,
  onDone,
}: {
  caseId: string
  busy: boolean
  setBusy: (b: boolean) => void
  onDone: () => void
}) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [source, setSource] = useState<'response' | 'internal'>('response')
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const submit = async () => {
    const file = inputRef.current?.files?.[0]
    if (!file) {
      setErr('Choose a file first.')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('note', note)
      form.append('source', source)
      const res = await fetch(`/internal/cases/${caseId}/attachments`, {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.message ?? `Upload failed (${res.status})`)
      toast.success('Response recorded', file.name)
      setOpen(false)
      setNote('')
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button variant="secondary" icon="plus" onClick={() => setOpen(true)}>
        Record a response
      </Button>

      {open && (
        <Modal title="Record a response" onClose={() => setOpen(false)}>
          <div className="space-y-4">
            <Alert tone="info" title="For replies that arrived by email">
              Save the reply as a PDF or .eml and attach it here. Recording a response also clears
              the “pending on” marker, since the case is no longer waiting.
            </Alert>

            <Field
              label="File"
              required
              hint="PDF, image, .eml, .msg or .txt — 15 MB maximum."
              htmlFor="resp-file"
            >
              <input
                id="resp-file"
                ref={inputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.eml,.msg,.txt,application/pdf,image/*,message/rfc822,text/plain"
                className="block w-full cursor-pointer rounded-lg border border-line bg-surface p-2 text-[13px] text-ink file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-[12px] file:font-medium file:text-brand-ink"
              />
            </Field>

            <Field label="Who sent it" htmlFor="resp-source">
              <div className="flex gap-2">
                {(['response', 'internal'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setSource(v)}
                    aria-pressed={source === v}
                    className={`cursor-pointer rounded-lg border px-3 py-1.5 text-[12.5px] transition-colors ${
                      source === v
                        ? 'border-brand-ink bg-brand-soft text-brand-ink'
                        : 'border-line text-muted hover:border-brand-ink/40'
                    }`}
                  >
                    {v === 'response' ? 'Reply to the case' : 'Internal working document'}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Note" hint="Optional. Appears on the timeline." htmlFor="resp-note">
              <TextInput
                id="resp-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Signed authority received from the requester"
              />
            </Field>

            {err && <Alert tone="error">{err}</Alert>}

            <div className="flex justify-end gap-2 border-t border-line pt-4">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" icon="check" loading={busy} onClick={submit}>
                Record
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
