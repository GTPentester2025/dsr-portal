import { useEffect, useState } from 'react'

/**
 * Email verification control for the public form.
 *
 * The step is a dead end for a requester: they press a button, then wait for a
 * message with no sense of whether anything is happening. So each state says
 * what is going on and looks distinct at a glance — a spinner while sending, a
 * pulsing envelope while waiting, a checkmark that draws itself on success.
 *
 * Motion is transform/opacity only, so it cannot cause layout shift, and every
 * animation is disabled under prefers-reduced-motion, where the states remain
 * distinguishable by icon and text alone.
 */

export type VerifyState = 'idle' | 'sending' | 'pending' | 'verified'

/** Seconds before offering to send again; long enough not to invite double-sends. */
const RESEND_AFTER = 20

export function VerifyEmail({
  state,
  email,
  buttonBg,
  buttonFg,
  t,
  onVerify,
}: {
  state: VerifyState
  email: string
  buttonBg: string
  buttonFg: string
  t: (s: string) => string
  onVerify: () => void
}) {
  const [waited, setWaited] = useState(0)

  // Count only while genuinely waiting, and restart on each new send.
  useEffect(() => {
    if (state !== 'pending') {
      setWaited(0)
      return
    }
    const id = setInterval(() => setWaited((w) => w + 1), 1000)
    return () => clearInterval(id)
  }, [state])

  const canResend = state === 'pending' && waited >= RESEND_AFTER

  return (
    <div className="dsr-ev" style={{ marginTop: 10 }}>
      <style>{CSS}</style>

      {/* One live region for the whole control: a screen reader hears each
          transition once, rather than re-reading the button. */}
      <span className="dsr-ev-sr" role="status" aria-live="polite">
        {state === 'sending' && t('Sending verification email')}
        {state === 'pending' && t('Verification email sent. Waiting for you to confirm.')}
        {state === 'verified' && t('Email address verified')}
      </span>

      {state === 'verified' ? (
        <span className="dsr-ev-row dsr-ev-done">
          <span className="dsr-ev-badge dsr-ev-badge--ok" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path className="dsr-ev-tick" d="M20 6 9 17l-5-5" />
            </svg>
          </span>
          <span className="dsr-ev-text dsr-ev-text--ok">
            {t('Email verified')}
            {email && <span className="dsr-ev-addr">{email}</span>}
          </span>
        </span>
      ) : (
        <span className="dsr-ev-row">
          <button
            type="button"
            disabled={state === 'sending' || state === 'pending'}
            onClick={onVerify}
            className="btn btn-md dsr-ev-btn"
            style={{ background: buttonBg, color: buttonFg }}
          >
            {state === 'sending' ? (
              <>
                <span className="dsr-ev-spinner" aria-hidden="true" />
                {t('Sending…')}
              </>
            ) : state === 'pending' ? (
              t('Email sent')
            ) : (
              t('Verify email')
            )}
          </button>

          {state === 'pending' && (
            <span className="dsr-ev-row dsr-ev-wait">
              <span className="dsr-ev-badge dsr-ev-badge--wait" aria-hidden="true">
                <span className="dsr-ev-ring" />
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
                  <path d="m3.5 7 7.4 5a2 2 0 0 0 2.2 0L20.5 7" />
                </svg>
              </span>
              <span className="dsr-ev-text">
                {t('Check your inbox and click the confirmation link.')}
                {canResend && (
                  <button type="button" className="dsr-ev-resend" onClick={onVerify}>
                    {t('Send it again')}
                  </button>
                )}
              </span>
            </span>
          )}
        </span>
      )}
    </div>
  )
}

const CSS = `
.dsr-ev-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.dsr-ev-row {
  display: inline-flex; align-items: center; gap: 12px; flex-wrap: wrap;
}
.dsr-ev-btn {
  display: inline-flex; align-items: center; gap: 8px;
  min-height: 44px;
  transition: opacity 180ms ease-out, transform 180ms ease-out;
}
.dsr-ev-btn:disabled { opacity: .55; cursor: default; }
.dsr-ev-btn:not(:disabled):active { transform: scale(.98); }

.dsr-ev-spinner {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid currentColor; border-top-color: transparent;
  animation: dsr-ev-spin 700ms linear infinite;
}
@keyframes dsr-ev-spin { to { transform: rotate(360deg); } }

.dsr-ev-badge {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 50%; flex: 0 0 auto;
}
.dsr-ev-badge--wait { background: #fdf3e7; color: #8a6d1a; }
.dsr-ev-badge--ok   { background: #e8f5ea; color: #0a7a0a; }

/* A ring that breathes outward: motion that reads as "still waiting" rather
   than decoration. Scale/opacity only, so no reflow. */
.dsr-ev-ring {
  position: absolute; inset: 0; border-radius: 50%;
  border: 2px solid currentColor; opacity: 0;
  animation: dsr-ev-pulse 2s ease-out infinite;
}
@keyframes dsr-ev-pulse {
  0%   { transform: scale(1);    opacity: .55; }
  70%  { transform: scale(1.55); opacity: 0; }
  100% { transform: scale(1.55); opacity: 0; }
}

.dsr-ev-wait { animation: dsr-ev-in 220ms ease-out both; }
.dsr-ev-done { animation: dsr-ev-in 220ms ease-out both; }
@keyframes dsr-ev-in {
  from { opacity: 0; transform: translateY(3px); }
  to   { opacity: 1; transform: none; }
}

/* The tick draws itself, which reads as confirmation rather than a state that
   was always there. */
.dsr-ev-tick {
  stroke-dasharray: 26;
  stroke-dashoffset: 26;
  animation: dsr-ev-draw 320ms 60ms ease-out forwards;
}
@keyframes dsr-ev-draw { to { stroke-dashoffset: 0; } }

.dsr-ev-badge--ok { animation: dsr-ev-pop 260ms ease-out both; }
@keyframes dsr-ev-pop {
  0%   { transform: scale(.7); }
  60%  { transform: scale(1.08); }
  100% { transform: scale(1); }
}

.dsr-ev-text { font-size: 14px; color: #6b6478; line-height: 1.45; }
.dsr-ev-text--ok { color: #0a7a0a; font-weight: 500; }
.dsr-ev-addr { display: block; font-size: 12.5px; color: #6b6478; font-weight: 400; }

.dsr-ev-resend {
  background: none; border: 0; padding: 0 0 0 6px;
  font-size: 14px; color: inherit; text-decoration: underline;
  cursor: pointer; font-family: inherit;
}
.dsr-ev-resend:hover { opacity: .75; }

@media (prefers-reduced-motion: reduce) {
  .dsr-ev-spinner { animation-duration: 1.6s; }
  .dsr-ev-ring    { animation: none; opacity: .4; }
  .dsr-ev-tick    { animation: none; stroke-dashoffset: 0; }
  .dsr-ev-badge--ok, .dsr-ev-wait, .dsr-ev-done { animation: none; }
  .dsr-ev-btn { transition: none; }
}
`
