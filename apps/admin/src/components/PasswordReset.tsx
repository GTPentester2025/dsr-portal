import { useState } from 'react'
import { api } from '../lib/api'
import { Alert, Button, Field, Modal, PasswordInput } from './ui'
import { Icon } from './Icon'
import { useToast } from './Toast'

/**
 * Administrative password reset.
 *
 * Passwords are stored as argon2id hashes, so there is nothing to display —
 * the hash cannot be turned back into the password, which is the point of
 * hashing it. What a super administrator can do is issue a one-time password.
 * It is shown here once, at the moment it is created, and cannot be retrieved
 * again; the user must replace it at next sign-in.
 */
export function ResetPasswordModal({
  user,
  onClose,
}: {
  user: { id: string; name: string; email: string }
  onClose: () => void
}) {
  const [issued, setIssued] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)

  const run = async () => {
    setBusy(true)
    setErr('')
    try {
      const res = await api.post<{ temporaryPassword: string }>(
        `/internal/admin/users/${user.id}/reset-password`,
      )
      setIssued(res.temporaryPassword)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!issued) return
    await navigator.clipboard.writeText(issued)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Modal
      title={issued ? 'One-time password created' : `Reset password for ${user.name}`}
      onClose={onClose}
    >
      {err && <div className="mb-4"><Alert tone="error">{err}</Alert></div>}

      {!issued ? (
        <div className="space-y-4">
          <Alert tone="info" title="Passwords cannot be displayed">
            They are stored as one-way hashes, so nobody — including a super
            administrator — can read an existing password. You can issue a replacement instead.
          </Alert>

          <div className="rounded-lg border border-line bg-sunken/40 p-3 text-[13px] leading-relaxed text-muted">
            <p className="mb-2 font-medium text-ink">Resetting will:</p>
            <ul className="space-y-1">
              <li className="flex gap-2"><Icon name="key" size={13} className="mt-0.5 shrink-0 text-brand-ink" />Generate a one-time password, shown to you once.</li>
              <li className="flex gap-2"><Icon name="logout" size={13} className="mt-0.5 shrink-0 text-brand-ink" />Sign <strong className="text-ink">{user.email}</strong> out of every active session.</li>
              <li className="flex gap-2"><Icon name="edit" size={13} className="mt-0.5 shrink-0 text-brand-ink" />Require them to choose a new password at next sign-in.</li>
              <li className="flex gap-2"><Icon name="shield" size={13} className="mt-0.5 shrink-0 text-brand-ink" />Be recorded in the audit log, without the password itself.</li>
            </ul>
          </div>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="danger" icon="key" loading={busy} onClick={run}>
              Reset password
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Alert tone="warning" title="Copy this now">
            This is the only time it will be shown. Close this dialog and it is gone —
            you would have to reset again.
          </Alert>

          <div className="rounded-lg border border-line bg-sunken p-4 text-center">
            <p className="mono select-all text-[19px] font-semibold tracking-wide text-ink">
              {issued}
            </p>
          </div>

          <Button variant={copied ? 'secondary' : 'primary'} icon={copied ? 'check' : 'file'} onClick={copy} className="w-full">
            {copied ? 'Copied' : 'Copy to clipboard'}
          </Button>

          <p className="text-[12px] leading-relaxed text-muted">
            Give it to <strong className="text-ink">{user.name}</strong> over a channel you
            trust. They will be asked to choose their own password when they sign in.
          </p>

          <div className="flex justify-end border-t border-line pt-4">
            <Button variant="secondary" onClick={onClose}>Done</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

/**
 * Blocking prompt shown when the signed-in account was reset by an
 * administrator. There is no dismiss: the point is that a password known to
 * somebody else does not stay in use.
 */
export function ForcePasswordChange({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const tooShort = next.length > 0 && next.length < 14
  const mismatch = confirm.length > 0 && next !== confirm

  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      await api.post('/internal/auth/change-password', { newPassword: next })
      toast.success('Password updated', 'Other sessions have been signed out.')
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Choose a new password" onClose={() => undefined}>
      <div className="space-y-4">
        <Alert tone="warning" title="Your password was reset by an administrator">
          Pick your own before continuing. Whoever issued the temporary password knows it.
        </Alert>

        <Field
          label="New password"
          required
          hint="At least 14 characters, mixing upper case, lower case and digits."
          error={tooShort ? 'Too short — 14 characters minimum.' : undefined}
          htmlFor="np"
        >
          <PasswordInput id="np" value={next} autoComplete="new-password" onChange={(e) => setNext(e.target.value)} />
        </Field>

        <Field
          label="Confirm new password"
          required
          error={mismatch ? 'These do not match.' : undefined}
          htmlFor="np2"
        >
          <PasswordInput id="np2" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
        </Field>

        {err && <Alert tone="error">{err}</Alert>}

        <div className="flex justify-end border-t border-line pt-4">
          <Button
            variant="primary"
            loading={busy}
            disabled={next.length < 14 || next !== confirm}
            onClick={submit}
          >
            Set password
          </Button>
        </div>
      </div>
    </Modal>
  )
}
