import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Kbd } from './ui'
import { CommandPalette } from './CommandPalette'
import { useTheme, type ThemeChoice } from '../lib/theme'
import { api, type Me } from '../lib/api'

const NAV = [
  { path: '#/', label: 'Dashboard', icon: 'grid' },
  { path: '#/cases', label: 'Cases', icon: 'inbox' },
  { path: '#/forms', label: 'Forms & SLAs', icon: 'panelLeft', roles: ['super_admin', 'admin', 'zone_manager'] },
  { path: '#/templates', label: 'Templates', icon: 'file' },
  { path: '#/team', label: 'Team', icon: 'users', roles: ['super_admin', 'admin', 'zone_manager'] },
  { path: '#/groups', label: 'Groups', icon: 'users', roles: ['super_admin', 'admin', 'zone_manager', 'approver'] },
  { path: '#/migration', label: 'Migration', icon: 'upload', roles: ['super_admin', 'admin', 'zone_manager'] },
  { path: '#/audit', label: 'Audit log', icon: 'shield', roles: ['super_admin', 'admin', 'auditor'] },
  { path: '#/settings', label: 'Settings', icon: 'settings', roles: ['super_admin'] },
] as const

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super administrator',
  admin: 'Administrator',
  zone_manager: 'Zone manager',
  approver: 'Approver',
  auditor: 'Auditor',
}

function ThemeToggle() {
  const { choice, setChoice } = useTheme()
  const options: { id: ThemeChoice; icon: string; label: string }[] = [
    { id: 'light', icon: 'sun', label: 'Light theme' },
    { id: 'system', icon: 'monitor', label: 'Match system theme' },
    { id: 'dark', icon: 'moon', label: 'Dark theme' },
  ]
  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-lg border border-line bg-sunken p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={choice === o.id}
          aria-label={o.label}
          title={o.label}
          onClick={() => setChoice(o.id)}
          className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors duration-150 ${
            choice === o.id ? 'bg-surface text-ink shadow-sm' : 'text-faint hover:text-muted'
          }`}
        >
          <Icon name={o.icon} size={14} />
        </button>
      ))}
    </div>
  )
}

function UserMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const initials = me.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-2 rounded-lg py-1 pl-1 pr-2 transition-colors hover:bg-sunken"
      >
        <span className="flex h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-on-brand">
          {initials}
        </span>
        <span className="hidden text-left leading-tight sm:block">
          <span className="block text-[12px] font-medium text-ink">{me.name}</span>
          <span className="block text-[10px] text-faint">
            {ROLE_LABEL[me.role] ?? me.role}
            {me.zoneId ? ` · ${me.zoneId}` : ''}
          </span>
        </span>
        <Icon name="chevronDown" size={13} className="text-faint" />
      </button>

      {open && (
        <div
          role="menu"
          className="anim-pop absolute right-0 top-full z-50 mt-1.5 w-56 overflow-hidden rounded-xl border border-line bg-raised p-1"
          style={{ boxShadow: 'var(--shadow-lg)' }}
        >
          <div className="border-b border-line px-3 py-2.5">
            <p className="truncate text-[13px] font-medium text-ink">{me.name}</p>
            <p className="truncate text-[11px] text-faint">{me.email}</p>
          </div>
          <button
            role="menuitem"
            onClick={async () => {
              await api.post('/internal/auth/logout')
              location.reload()
            }}
            className="mt-1 flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-danger transition-colors hover:bg-danger/10"
          >
            <Icon name="logout" size={14} />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

export function AppShell({
  me,
  hash,
  title,
  children,
}: {
  me: Me
  hash: string
  title: string
  children: React.ReactNode
}) {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('dsr.sidebar') === 'collapsed',
  )
  const [mobileNav, setMobileNav] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    localStorage.setItem('dsr.sidebar', collapsed ? 'collapsed' : 'expanded')
  }, [collapsed])

  // Global shortcuts: Cmd/Ctrl-K opens the palette, "/" focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => setMobileNav(false), [hash])

  const items = NAV.filter((n) => !('roles' in n) || (n.roles as readonly string[]).includes(me.role))
  const isActive = (p: string) => (p === '#/' ? hash === '#/' || hash === '' : hash.startsWith(p))

  const navList = (
    <nav className="flex flex-1 flex-col gap-0.5 p-2" aria-label="Primary">
      {items.map((n) => {
        const active = isActive(n.path)
        return (
          <a
            key={n.path}
            href={n.path}
            aria-current={active ? 'page' : undefined}
            title={collapsed ? n.label : undefined}
            className={`group relative flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors duration-150 ${
              active ? 'bg-brand-soft text-brand-ink' : 'text-muted hover:bg-sunken hover:text-ink'
            } ${collapsed ? 'justify-center px-0' : ''}`}
          >
            {active && (
              <span className="absolute left-0 h-4 w-0.5 rounded-r-full bg-brand-ink" aria-hidden="true" />
            )}
            <Icon name={n.icon} size={16} className="shrink-0" />
            {!collapsed && <span className="truncate">{n.label}</span>}
          </a>
        )
      })}
    </nav>
  )

  return (
    <div className="relative min-h-dvh">
      <div className="ambient" aria-hidden="true" />

      {/* ------------------------------ sidebar ----------------------------- */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-line bg-surface/80 backdrop-blur-xl transition-[width] duration-200 md:flex ${
          collapsed ? 'w-[60px]' : 'w-[228px]'
        }`}
        style={{ transitionTimingFunction: 'var(--ease-out-expo)' }}
      >
        <div className={`flex items-center gap-2.5 px-3 py-4 ${collapsed ? 'justify-center' : ''}`}>
          <span className="flex h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-[10px] bg-brand text-on-brand">
            <Icon name="shield" size={16} />
          </span>
          {!collapsed && (
            <div className="min-w-0 leading-tight">
              <p className="truncate text-[13px] font-semibold text-ink">DSR Portal</p>
              <p className="truncate text-[10px] text-faint">Privacy operations</p>
            </div>
          )}
        </div>

        {navList}

        <div className="border-t border-line p-2">
          <button
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={`flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-faint transition-colors hover:bg-sunken hover:text-ink ${
              collapsed ? 'justify-center px-0' : ''
            }`}
          >
            <Icon name="panelLeft" size={16} />
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      {/* --------------------------- mobile drawer -------------------------- */}
      {mobileNav && (
        <div className="anim-fade fixed inset-0 z-50 bg-black/50 md:hidden" onClick={() => setMobileNav(false)}>
          <aside
            className="anim-rise flex h-full w-64 flex-col border-r border-line bg-surface"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-4">
              <span className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 items-center justify-center rounded-[10px] bg-brand text-on-brand">
                  <Icon name="shield" size={16} />
                </span>
                <span className="text-[13px] font-semibold text-ink">DSR Portal</span>
              </span>
              <button
                onClick={() => setMobileNav(false)}
                aria-label="Close navigation"
                className="cursor-pointer rounded-lg p-2 text-faint hover:bg-sunken"
              >
                <Icon name="x" size={16} />
              </button>
            </div>
            {navList}
          </aside>
        </div>
      )}

      {/* ------------------------------- main ------------------------------- */}
      <div className={`relative z-10 transition-[padding] duration-200 ${collapsed ? 'md:pl-[60px]' : 'md:pl-[228px]'}`}>
        <header className="glass sticky top-0 z-30 border-b border-line">
          <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-4 md:px-7">
            <button
              onClick={() => setMobileNav(true)}
              aria-label="Open navigation"
              className="cursor-pointer rounded-lg p-2 text-muted hover:bg-sunken md:hidden"
            >
              <Icon name="menu" size={18} />
            </button>

            <h1 className="truncate text-[13px] font-semibold text-ink">{title}</h1>

            <button
              onClick={() => setPaletteOpen(true)}
              className="ml-auto hidden min-h-8 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-[12px] text-faint transition-colors hover:border-line-strong hover:text-muted sm:flex"
            >
              <Icon name="search" size={13} />
              <span className="pr-6">Search…</span>
              <Kbd>⌘K</Kbd>
            </button>

            <button
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              className="ml-auto cursor-pointer rounded-lg p-2 text-muted hover:bg-sunken sm:hidden"
            >
              <Icon name="search" size={17} />
            </button>

            <ThemeToggle />
            <UserMenu me={me} />
          </div>
        </header>

        <main id="main" className="mx-auto max-w-[1400px] px-4 py-6 md:px-7 md:py-8">
          <div key={hash} className="anim-rise">{children}</div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} me={me} />
    </div>
  )
}
