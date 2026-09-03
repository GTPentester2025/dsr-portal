import { forwardRef, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { STATUS_COLORS, STATUS_LABELS } from '../lib/api'

/* ------------------------------- surfaces -------------------------------- */

export function Card({
  children,
  className = '',
  title,
  subtitle,
  actions,
  bleed,
}: {
  children: React.ReactNode
  className?: string
  title?: React.ReactNode
  subtitle?: string
  actions?: React.ReactNode
  /** Removes body padding so tables can span the full card. */
  bleed?: boolean
}) {
  return (
    <section
      className={`min-w-0 max-w-full rounded-xl border border-line bg-surface ${className}`}
      style={{ boxShadow: 'var(--shadow-sm)' }}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[13px] font-semibold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 truncate text-xs text-faint">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bleed ? '' : 'p-4'}>{children}</div>
    </section>
  )
}

/* -------------------------------- button --------------------------------- */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-brand text-on-brand hover:bg-brand-hover shadow-[0_1px_2px_rgb(0_0_0/0.12)]',
  secondary: 'border border-line bg-surface text-ink hover:bg-sunken',
  ghost: 'text-muted hover:bg-sunken hover:text-ink',
  subtle: 'bg-sunken text-ink hover:bg-line',
  danger: 'bg-danger text-white hover:brightness-110',
}

export function Button({
  variant = 'secondary',
  icon,
  iconRight,
  loading,
  children,
  className = '',
  ...rest
}: {
  variant?: Variant
  icon?: string
  iconRight?: string
  loading?: boolean
  children?: React.ReactNode
  className?: string
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const iconOnly = !children
  return (
    <button
      className={`inline-flex min-h-9 shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium
        transition-[background-color,color,transform,opacity] duration-150 active:scale-[0.98]
        disabled:pointer-events-none disabled:opacity-45
        pointer-coarse:min-h-11 ${iconOnly ? 'w-9 pointer-coarse:w-11' : 'px-3'} ${VARIANT[variant]} ${className}`}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading ? (
        <Icon name="loader" size={15} className="anim-spin" />
      ) : (
        icon && <Icon name={icon} size={15} />
      )}
      {children}
      {iconRight && !loading && <Icon name={iconRight} size={15} />}
    </button>
  )
}

/* -------------------------------- inputs --------------------------------- */

export const fieldCls =
  'w-full min-h-9 pointer-coarse:min-h-11 rounded-lg border border-line bg-surface px-3 text-[13px] text-ink placeholder:text-faint ' +
  'transition-colors duration-150 hover:border-line-strong focus:border-brand-ink disabled:opacity-50'

export function Field({
  label,
  hint,
  error,
  required,
  children,
  htmlFor,
}: {
  label: string
  hint?: string
  error?: string
  required?: boolean
  children: React.ReactNode
  htmlFor?: string
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-muted">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </label>
      {children}
      {error ? (
        <p role="alert" className="mt-1.5 flex items-center gap-1 text-[11px] text-danger">
          <Icon name="alert" size={12} />
          {error}
        </p>
      ) : (
        hint && <p className="mt-1.5 text-[11px] leading-relaxed text-faint">{hint}</p>
      )}
    </div>
  )
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${fieldCls} ${props.className ?? ''}`} />
}

export function PasswordInput({
  isSet,
  ...props
}: { isSet?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <input
        {...props}
        type={shown ? 'text' : 'password'}
        autoComplete="off"
        placeholder={isSet ? '••••••••••••  (saved)' : props.placeholder}
        className={`${fieldCls} pr-16 ${props.className ?? ''}`}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide value' : 'Show value'}
        className="absolute inset-y-0 right-1 my-auto flex h-7 w-8 cursor-pointer items-center justify-center rounded-md text-faint transition-colors hover:bg-sunken hover:text-ink"
      >
        <Icon name={shown ? 'eyeOff' : 'eye'} size={14} />
      </button>
    </div>
  )
}

export function Select({
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...props}
        className={`${fieldCls} cursor-pointer appearance-none pr-9 ${props.className ?? ''}`}
      >
        {children}
      </select>
      <Icon
        name="chevronDown"
        size={14}
        className="pointer-events-none absolute inset-y-0 right-3 my-auto text-faint"
      />
    </div>
  )
}

/** Forwards a ref so callers can focus it — the reply composer does on open. */
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea(props, ref) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={`${fieldCls} py-2 leading-relaxed ${props.className ?? ''}`}
    />
  )
})

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${
        checked ? 'bg-brand' : 'bg-line-strong'
      }`}
    >
      <span
        className={`absolute left-0.5 h-[18px] w-[18px] rounded-full shadow transition-transform duration-200 ${
          checked ? 'bg-on-brand' : 'bg-white'
        }`}
        style={{ transform: checked ? 'translateX(16px)' : 'none' }}
      />
    </button>
  )
}

/* -------------------------------- badges --------------------------------- */

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? 'var(--t-faint)'
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium"
      style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {STATUS_LABELS[status] ?? status}
    </span>
  )
}

export function Chip({
  children,
  tone = 'neutral',
  icon,
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'brand' | 'positive' | 'warning' | 'danger'
  icon?: string
}) {
  const map = {
    neutral: 'bg-sunken text-muted',
    brand: 'bg-brand-soft text-brand-ink',
    positive: 'text-positive',
    warning: 'text-warning',
    danger: 'text-danger',
  }
  const tinted = tone === 'neutral' || tone === 'brand'
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium ${map[tone]}`}
      style={
        tinted
          ? undefined
          : { background: `color-mix(in srgb, currentColor 12%, transparent)` }
      }
    >
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  )
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mono rounded border border-line bg-sunken px-1.5 py-0.5 text-[10px] font-medium text-muted">
      {children}
    </kbd>
  )
}

/* --------------------------------- table --------------------------------- */

export function Table({
  head,
  children,
  caption,
}: {
  head: React.ReactNode
  children: React.ReactNode
  /** Announced to screen readers, which cannot infer a table's purpose from
      the surrounding card heading. Visually hidden. */
  caption?: string
}) {
  return (
    <div className="w-full max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-line text-left text-[11px] font-medium uppercase tracking-wider text-faint">
            {head}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export const Th = ({ children, className = '' }: { children?: React.ReactNode; className?: string }) => (
  <th className={`whitespace-nowrap px-4 py-2.5 font-medium ${className}`}>{children}</th>
)

export function Tr({
  children,
  onClick,
  className = '',
}: {
  children: React.ReactNode
  onClick?: () => void
  className?: string
}) {
  return (
    <tr
      onClick={onClick}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick() } : undefined}
      className={`border-b border-line/70 transition-colors duration-100 last:border-0 ${
        onClick ? 'cursor-pointer hover:bg-brand-soft' : 'hover:bg-sunken/60'
      } ${className}`}
    >
      {children}
    </tr>
  )
}

export const Td = ({ children, className = '' }: { children?: React.ReactNode; className?: string }) => (
  <td className={`px-4 py-2.5 align-middle ${className}`}>{children}</td>
)

/* ------------------------------- feedback -------------------------------- */

export function EmptyState({
  icon = 'inbox',
  title,
  hint,
  action,
}: {
  icon?: string
  title: string
  hint?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-sunken text-faint">
        <Icon name={icon} size={19} />
      </span>
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        {hint && <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-faint">{hint}</p>}
      </div>
      {action}
    </div>
  )
}

export function Alert({
  tone,
  title,
  children,
  action,
}: {
  tone: 'error' | 'success' | 'warning' | 'info'
  title?: string
  children?: React.ReactNode
  action?: React.ReactNode
}) {
  const map = {
    error: { color: 'var(--t-danger)', icon: 'alert' },
    success: { color: 'var(--t-positive)', icon: 'checkCircle' },
    warning: { color: 'var(--t-warning)', icon: 'alert' },
    info: { color: 'var(--t-info)', icon: 'info' },
  }[tone]
  return (
    <div
      role="alert"
      className="anim-fade flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-[13px]"
      style={{
        color: map.color,
        borderColor: `color-mix(in srgb, ${map.color} 28%, transparent)`,
        background: `color-mix(in srgb, ${map.color} 8%, transparent)`,
      }}
    >
      <Icon name={map.icon} size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? 'mt-0.5 opacity-90' : ''}>{children}</div>}
      </div>
      {action}
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />
}

/* --------------------------------- modal --------------------------------- */

export function Modal({
  title,
  description,
  onClose,
  children,
  size = 'md',
}: {
  title: string
  description?: string
  onClose: () => void
  children: React.ReactNode
  size?: 'md' | 'lg'
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Move focus into the dialog for keyboard and screen-reader users.
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus()
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  /*
   * Rendered into <body>. A `transform` on any ancestor becomes the containing
   * block for position:fixed, and the page-entry animation does exactly that —
   * so an in-tree dialog was positioned against the animated wrapper and hung
   * off the bottom of the screen on a phone.
   */
  return createPortal(
    <div
      className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 backdrop-blur-[2px] sm:p-4"
      onClick={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        /*
         * The dialog is capped to the viewport and scrolls its own body. It
         * used to size to its content, so a long form pushed the header and the
         * close button off screen and the only way to reach them was to zoom
         * out. dvh rather than vh so a mobile browser's collapsing toolbar does
         * not cut the footer off.
         */
        className={`anim-pop flex max-h-[calc(100dvh-1.5rem)] w-full flex-col overflow-hidden rounded-xl border border-line bg-raised sm:max-h-[calc(100dvh-2rem)] ${
          size === 'lg' ? 'max-w-2xl' : 'max-w-md'
        }`}
        style={{ boxShadow: 'var(--shadow-lg)' }}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h3 id={titleId} className="text-sm font-semibold text-ink">{title}</h3>
            {description && <p className="mt-0.5 text-xs text-faint">{description}</p>}
          </div>
          <Button variant="ghost" icon="x" onClick={onClose} aria-label="Close dialog" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

/* ---------------------------------- tabs --------------------------------- */

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string; icon?: string; badge?: number }[]
  active: string
  onChange: (id: string) => void
}) {
  return (
    <div role="tablist" className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-sunken p-1">
      {tabs.map((t) => {
        const on = t.id === active
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            className={`inline-flex min-h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-all duration-150 pointer-coarse:min-h-11 ${
              on ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
            }`}
          >
            {t.icon && <Icon name={t.icon} size={14} />}
            {t.label}
            {t.badge !== undefined && t.badge > 0 && (
              <span className="mono rounded bg-brand-soft px-1 text-[10px] text-brand-ink">{t.badge}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/* --------------------------------- misc ---------------------------------- */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
