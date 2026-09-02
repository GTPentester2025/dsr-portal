import { useCallback, useEffect, useState } from 'react'
import { api, type Me } from './lib/api'
import { AppShell } from './components/AppShell'
import { ForcePasswordChange } from './components/PasswordReset'
import { Icon } from './components/Icon'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { CasesPage } from './pages/CasesPage'
import { CaseDetailPage } from './pages/CaseDetailPage'
import { TemplatesPage } from './pages/TemplatesPage'
import { TeamPage } from './pages/TeamPage'
import { GroupsPage } from './pages/GroupsPage'
import { AuditPage } from './pages/AuditPage'
import { SettingsPage } from './pages/SettingsPage'
import { FormsPage } from './pages/FormsPage'
import { FormEditorPage } from './pages/FormEditorPage'
import { MigrationPage } from './pages/MigrationPage'
import { SystemPage } from './pages/SystemPage'

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash || '#/')
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/')
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

/** Roles allowed on each route; anything else renders a friendly refusal. */
const GUARD: Record<string, string[]> = {
  '#/forms': ['super_admin', 'admin', 'zone_manager'],
  '#/team': ['super_admin', 'admin', 'zone_manager'],
  '#/groups': ['super_admin', 'admin', 'zone_manager', 'approver'],
  '#/migration': ['super_admin', 'admin', 'zone_manager'],
  '#/audit': ['super_admin', 'admin', 'auditor'],
  '#/system': ['super_admin', 'admin'],
  '#/settings': ['super_admin'],
}

export default function App() {
  const hash = useHashRoute()
  const [me, setMe] = useState<Me | null | 'loading'>('loading')

  const refresh = useCallback(() => {
    api.get<Me>('/internal/auth/me').then(setMe).catch(() => setMe(null))
  }, [])
  useEffect(refresh, [refresh])

  if (me === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas">
        <Icon name="loader" size={22} className="anim-spin text-faint" />
      </div>
    )
  }
  if (!me) return <LoginPage onLogin={refresh} />

  // An account whose password was reset by an administrator gets no further
  // than this until they choose their own. Rendered before the router so no
  // route can be reached around it.
  if (me.mustChangePassword) {
    return (
      <div className="min-h-dvh bg-canvas">
        <ForcePasswordChange onDone={refresh} />
      </div>
    )
  }

  const caseMatch = /^#\/cases\/([0-9a-f-]{36})$/.exec(hash)
  const formMatch = /^#\/forms\/([a-z0-9-]+)$/.exec(hash)
  const route = caseMatch ? '#/cases' : Object.keys(GUARD).find((k) => hash.startsWith(k)) ?? hash

  let page: React.ReactNode
  let title = 'Dashboard'

  if (GUARD[route] && !GUARD[route].includes(me.role)) {
    title = 'Not available'
    page = (
      <div className="mx-auto max-w-md py-20 text-center">
        <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-sunken text-faint">
          <Icon name="shield" size={19} />
        </span>
        <h2 className="text-sm font-medium text-ink">This area is restricted</h2>
        <p className="mt-1 text-xs text-muted">
          Your role ({me.role.replace('_', ' ')}) does not have access. Ask an administrator if you need it.
        </p>
        <a href="#/" className="mt-4 inline-block text-[13px] font-medium text-brand-ink hover:underline">
          Back to dashboard
        </a>
      </div>
    )
  } else if (formMatch) {
    title = 'Form editor'
    page = <FormEditorPage formKey={formMatch[1]} />
  } else if (hash.startsWith('#/forms')) {
    title = 'Forms & SLAs'
    page = <FormsPage me={me} />
  } else if (caseMatch) {
    title = 'Case detail'
    page = <CaseDetailPage me={me} caseId={caseMatch[1]} />
  } else if (hash.startsWith('#/cases')) {
    title = 'Cases'
    page = <CasesPage me={me} />
  } else if (hash.startsWith('#/templates')) {
    title = 'Templates'
    page = <TemplatesPage me={me} />
  } else if (hash.startsWith('#/migration')) {
    title = 'Migration'
    page = <MigrationPage me={me} />
  } else if (hash.startsWith('#/team')) {
    title = 'Team & assignment'
    page = <TeamPage me={me} />
  } else if (hash.startsWith('#/groups')) {
    title = 'Groups'
    page = <GroupsPage me={me} />
  } else if (hash.startsWith('#/audit')) {
    title = 'Audit log'
    page = <AuditPage />
  } else if (hash.startsWith('#/system')) {
    title = 'System'
    page = <SystemPage />
  } else if (hash.startsWith('#/settings')) {
    title = 'Settings'
    page = <SettingsPage />
  } else {
    page = <DashboardPage me={me} />
  }

  return (
    <AppShell me={me} hash={hash} title={title}>
      {page}
    </AppShell>
  )
}
