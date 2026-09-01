import { useCallback, useEffect, useRef, useState } from 'react'
import type { BackendError, DelegationView } from './lib/api'
import { acceptDelegation, getDelegation, uploadDelegationFile } from './lib/api'

/**
 * The page the emailed link opens.
 *
 * The reader has no account here and never will -- a colleague in another
 * department doing someone a favour, on a phone, under time pressure. So this
 * is one screen with no navigation: what's being asked, who's asking, a
 * choice to accept, then a place to send documents. Nothing here is ever a
 * dead end without an explanation, because there's no one to ask for help.
 *
 * The payload (`PublicDelegationView`) is deliberately thin -- no name, email
 * or answers belonging to whoever made the privacy request, since the link
 * is a bearer token anyone it's forwarded to can open. This page renders
 * exactly what it's given and adds nothing.
 */

type Load = { kind: 'loading' } | { kind: 'not-found' } | { kind: 'error'; message: string } | { kind: 'ready' }

export function DelegationPage({ token }: { token: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [view, setView] = useState<DelegationView | null>(null)
  const [selectedMember, setSelectedMember] = useState('')
  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => {
    getDelegation(token)
      .then((v) => {
        setView(v)
        setLoad({ kind: 'ready' })
      })
      .catch((err: BackendError) => {
        setLoad(
          err.status === 404
            ? { kind: 'not-found' }
            : { kind: 'error', message: err.message || 'Something went wrong.' },
        )
      })
  }, [token])

  useEffect(() => { refresh() }, [refresh])

  const accept = async () => {
    if (!selectedMember) {
      setAcceptError('Choose which of you this is first.')
      return
    }
    setAcceptError('')
    setAccepting(true)
    try {
      setView(await acceptDelegation(token, selectedMember))
    } catch (err) {
      setAcceptError((err as BackendError).message)
      // Most likely cause: someone else in the group accepted first. Re-sync
      // to whatever the server now says instead of leaving the page stuck on
      // a stage that no longer applies -- this reader has no account and no
      // other way back in than the link they already used.
      refresh()
    } finally {
      setAccepting(false)
    }
  }

  const upload = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) {
      setUploadError('Choose a file first.')
      return
    }
    setUploadError('')
    setUploading(true)
    try {
      const v = await uploadDelegationFile(token, file)
      setView(v)
      if (fileRef.current) fileRef.current.value = ''
    } catch (err) {
      setUploadError((err as BackendError).message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="dsr-delegation-page">
      <style>{CSS}</style>
      <div className="dsr-delegation">
        <span className="dsr-delegation-rule" aria-hidden="true" />

        {load.kind === 'loading' && <p className="dsr-delegation-status">Loading…</p>}

        {load.kind === 'not-found' && (
          <>
            <h1 className="dsr-delegation-title">This link isn't valid</h1>
            <p className="dsr-delegation-sub">
              Check that you copied the whole link from the email. If it still doesn't work,
              ask whoever sent it to send it again.
            </p>
          </>
        )}

        {load.kind === 'error' && (
          <>
            <h1 className="dsr-delegation-title">Something went wrong</h1>
            <p className="dsr-delegation-sub">{load.message} Please try again in a moment.</p>
          </>
        )}

        {load.kind === 'ready' && view && (
          <DelegationBody
            view={view}
            selectedMember={selectedMember}
            onSelectMember={setSelectedMember}
            accepting={accepting}
            acceptError={acceptError}
            onAccept={() => void accept()}
            uploading={uploading}
            uploadError={uploadError}
            onUpload={() => void upload()}
            fileRef={fileRef}
          />
        )}
      </div>
    </div>
  )
}

function DelegationBody({
  view, selectedMember, onSelectMember, accepting, acceptError, onAccept,
  uploading, uploadError, onUpload, fileRef,
}: {
  view: DelegationView
  selectedMember: string
  onSelectMember: (id: string) => void
  accepting: boolean
  acceptError: string
  onAccept: () => void
  uploading: boolean
  uploadError: string
  onUpload: () => void
  fileRef: React.RefObject<HTMLInputElement | null>
}) {
  const title =
    view.stage === 'sent' ? 'Help needed on a privacy request'
    : view.stage === 'accepted' ? 'Sending documents'
    : 'Privacy request'

  return (
    <>
      <h1 className="dsr-delegation-title">{title}</h1>

      <dl className="dsr-delegation-meta">
        <div>
          <dt>Reference</dt>
          <dd>{view.caseRef}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{view.requestType}</dd>
        </div>
        {/* Two different people, and the labels used to be swapped: the group
            is who was asked, not who is asking. Priya in HR opened her link
            and read "Asked by: HR". Section 8 wants this page to say who is
            asking, and sentBy is the only field that does. */}
        <div>
          <dt>Asked by</dt>
          <dd>{view.sentBy}</dd>
        </div>
        <div>
          <dt>Sent to</dt>
          <dd>{view.groupName}</dd>
        </div>
        <div>
          <dt>Needed by</dt>
          <dd>{view.dueDate ?? 'No deadline set'}</dd>
        </div>
      </dl>

      {view.note && <p className="dsr-delegation-note">{view.note}</p>}

      {/* Covers the case that sent us here: an accept that lost a race
          against another group member moves the page off the "sent" stage,
          and the fieldset below (which normally carries this message) no
          longer renders once that happens. Shown here so the explanation
          survives the re-sync instead of the screen just changing under
          them with no reason given. */}
      {acceptError && view.stage !== 'sent' && (
        <p className="dsr-delegation-error" role="alert">{acceptError}</p>
      )}

      {view.stage === 'sent' && (
        <fieldset className="dsr-delegation-section">
          <legend className="dsr-delegation-h2">Which of you are you?</legend>
          {view.members.length === 0 ? (
            <p className="dsr-delegation-sub">
              No one is set up to accept this yet. Ask whoever sent the email for help.
            </p>
          ) : (
            <>
              <div className="dsr-delegation-choices">
                {view.members.map((m) => (
                  <label key={m.id} className="dsr-delegation-choice">
                    <input
                      type="radio"
                      name="member"
                      value={m.id}
                      checked={selectedMember === m.id}
                      onChange={() => onSelectMember(m.id)}
                    />
                    {m.name}
                  </label>
                ))}
              </div>
              {acceptError && <p className="dsr-delegation-error" role="alert">{acceptError}</p>}
              <button type="button" className="dsr-delegation-btn" disabled={accepting} onClick={onAccept}>
                {accepting ? 'Accepting…' : 'Accept'}
              </button>
            </>
          )}
        </fieldset>
      )}

      {view.stage === 'accepted' && (
        <div className="dsr-delegation-section">
          <p className="dsr-delegation-accepted">Thank you, {view.acceptedBy}.</p>
          <h2 className="dsr-delegation-h2">Send documents</h2>
          <p className="dsr-delegation-sub">PDF files only.</p>
          <input ref={fileRef} type="file" accept="application/pdf" className="dsr-delegation-file" />
          {uploadError && <p className="dsr-delegation-error" role="alert">{uploadError}</p>}
          <button type="button" className="dsr-delegation-btn" disabled={uploading} onClick={onUpload}>
            {uploading ? 'Sending…' : 'Send'}
          </button>

          {view.files.length > 0 && (
            <div className="dsr-delegation-files">
              <h3 className="dsr-delegation-h3">Already sent</h3>
              <ul>
                {view.files.map((f) => (
                  <li key={`${f.filename}-${f.uploadedAt}`}>
                    {f.filename}
                    <span className="dsr-delegation-file-date">{f.uploadedAt}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {view.stage === 'closed' && (
        <p className="dsr-delegation-closed">This request has been closed. Thank you for your help.</p>
      )}
    </>
  )
}

const CSS = `
.dsr-delegation-page {
  min-height: 100vh;
  background: #f4f4f2;
  font-family: 'Archivo', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  color: #0a0a0a;
}
.dsr-delegation {
  margin: 0 auto;
  max-width: 34rem;
  padding: 40px 20px 64px;
}
.dsr-delegation-rule {
  display: block;
  width: 44px;
  height: 5px;
  margin-bottom: 16px;
  background: #d3a238;
}
.dsr-delegation-status { color: #555; font-size: 15px; }
.dsr-delegation-title {
  margin: 0 0 16px;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.015em;
  line-height: 1.2;
}
.dsr-delegation-sub { margin: 0 0 8px; font-size: 15px; line-height: 1.5; color: #444; }

.dsr-delegation-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 20px;
  margin: 0 0 20px;
  padding: 16px;
  background: #fff;
  border: 1px solid rgb(10 10 10 / 0.1);
  border-left: 4px solid #d3a238;
  border-radius: 2px;
}
.dsr-delegation-meta dt {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #6f5900;
}
.dsr-delegation-meta dd { margin: 2px 0 0; font-size: 15px; }

.dsr-delegation-note {
  margin: 0 0 24px;
  padding: 12px 14px;
  background: #fdf8ec;
  border-radius: 2px;
  font-size: 14.5px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.dsr-delegation-section {
  margin: 0 0 8px;
  padding: 0;
  border: 0;
}
.dsr-delegation-h2 {
  margin: 0 0 12px;
  padding: 0;
  font-size: 17px;
  font-weight: 700;
}
.dsr-delegation-h3 { margin: 0 0 8px; font-size: 13px; font-weight: 700; color: #555; }

.dsr-delegation-choices { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.dsr-delegation-choice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: #fff;
  border: 1px solid rgb(10 10 10 / 0.15);
  border-radius: 2px;
  font-size: 15px;
  cursor: pointer;
}
.dsr-delegation-choice:has(input:checked) { border-color: #d3a238; background: #fdf8ec; }
.dsr-delegation-choice input { width: 18px; height: 18px; accent-color: #d3a238; }

.dsr-delegation-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 46px;
  padding: 0 24px;
  background: #d3a238;
  color: #0a0a0a;
  border: 0;
  border-radius: 2px;
  font-size: 15px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}
.dsr-delegation-btn:disabled { opacity: 0.55; cursor: default; }
.dsr-delegation-btn:not(:disabled):active { transform: scale(0.98); }

.dsr-delegation-accepted { margin: 0 0 24px; font-size: 15px; color: #0a7a0a; font-weight: 600; }

.dsr-delegation-file {
  display: block;
  width: 100%;
  margin: 4px 0 14px;
  font-size: 14px;
  font-family: inherit;
}

.dsr-delegation-error {
  margin: 0 0 14px;
  padding: 10px 12px;
  background: #fdecea;
  color: #9a1c1c;
  border-radius: 2px;
  font-size: 14px;
}

.dsr-delegation-files { margin-top: 28px; }
.dsr-delegation-files ul { list-style: none; margin: 0; padding: 0; }
.dsr-delegation-files li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid rgb(10 10 10 / 0.1);
  font-size: 14px;
}
.dsr-delegation-file-date { color: #888; font-size: 13px; white-space: nowrap; }

.dsr-delegation-closed { font-size: 16px; color: #444; }
`
