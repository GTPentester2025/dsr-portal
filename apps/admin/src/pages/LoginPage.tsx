import { useState } from 'react'
import { api } from '../lib/api'
import { Alert, Button, Field, PasswordInput, TextInput } from '../components/ui'
import { Icon } from '../components/Icon'
import { useTheme } from '../lib/theme'

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const { resolved, toggle } = useTheme()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.post('/internal/auth/login', { email, password })
      onLogin()
    } catch {
      setError('That email and password combination was not recognised. Check both and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-canvas px-4">
      <div className="ambient" aria-hidden="true" />

      <button
        onClick={toggle}
        aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        className="absolute right-4 top-4 z-10 cursor-pointer rounded-lg border border-line bg-surface p-2 text-muted transition-colors hover:text-ink"
      >
        <Icon name={resolved === 'dark' ? 'sun' : 'moon'} size={15} />
      </button>

      <div className="anim-rise relative z-10 w-full max-w-[380px]">
        <div className="mb-7 flex flex-col items-center text-center">
          <span
            className="mb-4 flex h-12 w-12 items-center justify-center rounded-[14px] bg-brand text-on-brand"
            style={{ boxShadow: '0 8px 24px -8px var(--t-brand)' }}
          >
            <Icon name="shield" size={22} />
          </span>
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">DSR Portal</h1>
          <p className="mt-1 text-[13px] text-muted">Privacy request operations</p>
        </div>

        <form
          onSubmit={submit}
          className="space-y-4 rounded-xl border border-line bg-surface p-6"
          style={{ boxShadow: 'var(--shadow-md)' }}
        >
          {error && <Alert tone="error">{error}</Alert>}

          <Field label="Email" htmlFor="email">
            <TextInput
              id="email"
              type="email"
              autoComplete="username"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </Field>

          <Field label="Password" htmlFor="password">
            <PasswordInput
              id="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <Button variant="primary" type="submit" loading={busy} className="w-full">
            {busy ? 'Signing in' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-5 flex items-center justify-center gap-1.5 text-[11px] text-faint">
          <Icon name="shield" size={12} />
          Authorised staff only. All activity is recorded.
        </p>
      </div>
    </div>
  )
}
