import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { Icon } from './Icon'

type Tone = 'success' | 'error' | 'info'
interface Toast {
  id: number
  tone: Tone
  title: string
  detail?: string
}

const Ctx = createContext<{
  push: (t: Omit<Toast, 'id'>) => void
  success: (title: string, detail?: string) => void
  error: (title: string, detail?: string) => void
} | null>(null)

const TONE: Record<Tone, { color: string; icon: string }> = {
  success: { color: 'var(--t-positive)', icon: 'checkCircle' },
  error: { color: 'var(--t-danger)', icon: 'alert' },
  info: { color: 'var(--t-info)', icon: 'info' },
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = Date.now() + Math.random()
      setItems((prev) => [...prev.slice(-3), { ...t, id }])
      // Errors linger; confirmations get out of the way quickly.
      window.setTimeout(() => remove(id), t.tone === 'error' ? 7000 : 4000)
    },
    [remove],
  )

  const api = useMemo(
    () => ({
      push,
      success: (title: string, detail?: string) => push({ tone: 'success', title, detail }),
      error: (title: string, detail?: string) => push({ tone: 'error', title, detail }),
    }),
    [push],
  )

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* Announced politely so toasts never steal focus. */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {items.map((t) => {
          const tone = TONE[t.tone]
          return (
            <div
              key={t.id}
              className="anim-toast pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-raised px-3.5 py-3"
              style={{ boxShadow: 'var(--shadow-lg)' }}
            >
              <Icon name={tone.icon} size={16} className="mt-0.5 shrink-0" style={{ color: tone.color }} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink">{t.title}</p>
                {t.detail && <p className="mt-0.5 break-words text-xs text-muted">{t.detail}</p>}
              </div>
              <button
                onClick={() => remove(t.id)}
                aria-label="Dismiss notification"
                className="shrink-0 cursor-pointer rounded-md p-1 text-faint transition-colors hover:bg-sunken hover:text-ink"
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          )
        })}
      </div>
    </Ctx.Provider>
  )
}

export function useToast() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}
