export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new ApiError(res.status, (data as { message?: string })?.message ?? `HTTP ${res.status}`)
  }
  return data as T
}

/**
 * Multipart POST. Kept separate from `call` because a file upload must not set
 * a JSON content type — the browser has to write its own boundary, and setting
 * it by hand is the classic way to get a 400 with no useful message.
 */
async function upload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', body: form })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new ApiError(res.status, (data as { message?: string })?.message ?? `HTTP ${res.status}`)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => call<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => call<T>('PATCH', path, body),
  del: <T>(path: string) => call<T>('DELETE', path),
  upload,
}

export interface Me {
  id: string
  name: string
  email: string
  role: 'super_admin' | 'admin' | 'zone_manager' | 'approver' | 'auditor'
  zoneId: string | null
  /** Set after an administrative reset; blocks the console until cleared. */
  mustChangePassword?: boolean
}

export interface CaseListItem {
  id: string
  caseRef: string
  zoneId: string
  formKey: string
  requestTypes: string[]
  status: string
  assigneeId: string | null
  dueAt: string | null
  createdAt: string
  requesterEmail: string
  /** From the submitted form, when the form collects it. */
  country: string | null
  /** Active approvers in the case's zone, comma separated. */
  approvers: string
  /** Who the case is waiting on: 'customer' | 'internal' | null. */
  pendingParty: string | null
  pendingOn: string | null

  // -- lifecycle beyond the status ------------------------------------------
  /** One label spanning status, report delivery and appeal state. */
  progress?: string
  closedAt?: string | null
  residency?: string | null
  /** Null while the case is open: it has no answer yet. */
  completedAfterDeadline?: boolean | null
  autoExtended?: boolean
  skipCompletionNotification?: boolean
  reportPublishedAt?: string | null
  reportAccessedAt?: string | null
  canBeAppealed?: boolean
  canAppealUntil?: string | null
  isAppeal?: boolean
  appealStatus?: string | null
  /** 'portal' | 'import' */
  source?: string
  externalId?: string | null
  externalRequestId?: string | null
  assigneeName?: string | null
}

export interface CaseDetail extends CaseListItem {
  requesterName: string | null
  /** Addresses of the zone's active approvers; the reply composer copies them. */
  approverEmails?: string[]
  outcomeCode: string | null
  closureNote: string | null
  fields: { key: string; value: unknown; encrypted: boolean }[]
  history: {
    id: number; actorId: string | null; fromStatus: string | null
    toStatus: string; note: string | null; createdAt: string
    actorName: string | null; actorEmail: string | null; actorRole: string | null
  }[]
  /** Everything recorded against the case, including non-status actions. */
  activity?: {
    id: number; action: string; created_at: string
    before: unknown; after: unknown; source_ip: string | null
    actor_type: string; actor_name: string | null
    actor_email: string | null; actor_role: string | null
  }[]
  slaClock: {
    state: string; dueAt: string; startedAt: string
    pausedTotalSecs: number; extensionJustification: string | null
  } | null
  emails: {
    id: string; subject: string; toAddrs: string[]; status: string
    templateId: string | null; createdAt: string
    ccAddrs?: string[] | null; bccAddrs?: string[] | null
    fromAddr?: string | null; bodyHtml?: string | null; error?: string | null
  }[]
}

export interface UserRow {
  id: string
  email: string
  name: string
  role: string
  zone_id: string | null
  active: boolean
  /** False when the account has no password yet — assignable but locked out. */
  has_password?: boolean
  capacity_weight: number
  ooo_from: string | null
  ooo_to: string | null
}

export interface Template {
  id: string
  zone_id: string | null
  request_type: string | null
  name: string
  subject: string
  body: string
  version: number
  /** 'acknowledgement' | 'follow-up' | 'outcome' | 'custom' */
  category: string
}

/** A message the portal sends on its own behalf, overridable per deployment. */
export interface SystemTemplate {
  key: string
  label: string
  description: string
  variables: string[]
  subject: string
  html: string
  defaultSubject: string
  defaultHtml: string
  customised: boolean
  updatedAt: string | null
}

export interface Dashboard {
  byStatus: { status: string; n: number }[]
  slaHealth: { closed: number; on_track: number; at_risk: number; overdue: number }
  ageing: { bucket: number; n: number }[]
  volumeTrend: { week: string; n: number }[]
  /** Requests received per day, gap-filled, last 30 days. */
  dailyVolume?: { day: string; n: number }[]
  monthlyByZone?: { month: string; zone_id: string; n: number }[]
  months?: string[]
  byRequestType: { request_type: string; n: number }[]
  byAssignee: { name: string; n: number }[]
  upcomingDue: { id: string; case_ref: string; zone_id: string; status: string; due_at: string }[]
}

/**
 * Mirrors the privilege ladder in the server's auth.guard.ts, so the console
 * shows exactly the controls the API would accept.
 *
 * Checking `me.role === 'admin'` is the bug this replaces: it hides admin
 * controls from a super administrator, who outranks them. `auditor` is
 * deliberately off the ladder — read-only, inherits nothing, grants nothing.
 */
const ROLE_RANK: Record<string, number> = {
  approver: 1,
  zone_manager: 2,
  admin: 3,
  super_admin: 4,
}

export function atLeast(role: string | undefined, minimum: keyof typeof ROLE_RANK): boolean {
  if (!role || role === 'auditor') return false
  return (ROLE_RANK[role] ?? 0) >= ROLE_RANK[minimum]
}

export const ZONES = ['EUR', 'SAZ', 'MAZ'] as const
export const STATUS_LABELS: Record<string, string> = {
  new: 'New', open: 'Open', pending: 'Pending', pending_approver: 'Pending Approver',
  extended: 'Extended', overdue: 'Overdue', closed: 'Closed',
}
/** Resolved from CSS custom properties so both themes stay legible. */
export const STATUS_COLORS: Record<string, string> = {
  new: 'var(--st-new)',
  open: 'var(--st-open)',
  pending: 'var(--st-pending)',
  pending_approver: 'var(--st-approver)',
  extended: 'var(--st-extended)',
  overdue: 'var(--st-overdue)',
  closed: 'var(--st-closed)',
}

// ---------------------------------------------------------------- settings --

export interface SettingDef {
  key: string
  label: string
  group: string
  type: 'text' | 'password' | 'email' | 'select' | 'number' | 'boolean' | 'url'
  secret?: boolean
  help?: string
  placeholder?: string
  options?: { value: string; label: string }[]
  visibleWhen?: { key: string; equals: string[] }[]
  min?: number
  max?: number
  default?: string
  /** Resolved from the server's environment file; not editable here. */
  envOnly?: boolean
}

export interface SettingGroup {
  id: string
  label: string
  description: string
  icon: string
}

export interface SettingValue {
  key: string
  value: string
  isSet: boolean
  source: 'database' | 'environment' | 'default' | 'unset'
  secret: boolean
}

export interface SettingsPayload {
  groups: SettingGroup[]
  fields: SettingDef[]
  values: SettingValue[]
}

export interface ConnectionStatus {
  ok: boolean
  provider: string
  detail: string
}

export interface DiagnosticStep {
  step: string
  ok: boolean
  detail: string
  hint?: string
  ms: number
}

export interface DiagnosticReport {
  applicable: boolean
  reason?: string
  ok?: boolean
  steps: DiagnosticStep[]
}
export const OUTCOME_CODES = [
  'fulfilled', 'partially_fulfilled', 'refused', 'withdrawn',
  'identity_not_verified', 'out_of_scope',
]


// --------------------------------------------------------------- migration --

/** One column of an uploaded file and where it is proposed to go. */
export interface ColumnProposal {
  header: string
  /** 'case:<id>' | 'field:<key>' | 'ignore' */
  target: string
  reason: string
  /** True when the field key does not exist on the chosen form. */
  novel: boolean
  samples: string[]
}

export interface RowIssue {
  row: number
  column?: string
  message: string
  severity: 'error' | 'warning'
}

export interface ImportAnalysis {
  id: string
  filename: string
  zoneId: string
  formKey: string
  formVersion: number
  encoding: string
  delimiter: string
  totalRows: number
  dateOrder: 'dmy' | 'mdy' | 'iso'
  /** False when the file gave no evidence either way and a default was taken. */
  dateOrderConfident: boolean
  columns: ColumnProposal[]
  targets: {
    case: { id: string; label: string; help?: string }[]
    field: { id: string; label: string; key: string }[]
  }
  sampleRows: {
    row: number
    caseProps: Record<string, unknown>
    fields: Record<string, unknown>
    reportPublished: boolean
    reportAccessed: boolean
    issues: RowIssue[]
  }[]
  issues: RowIssue[]
  errorRows: number
  duplicates: { count: number; sample: string[] }
}

export interface ImportRecord {
  id: string
  filename: string
  zone_id: string
  form_key: string
  status: string
  total_rows: number
  imported: number
  skipped: number
  failed: number
  created_at: string
  committed_at: string | null
  uploaded_by_name: string | null
}

export interface CommitResult {
  ok: true
  imported: number
  skipped: number
  failed: number
  /** Rows imported against a placeholder address because the file had none. */
  placeholderEmails: number
  issues: RowIssue[]
}

/** A recipient or provider that sending is currently backed off for. */
export interface EmailHealthRow {
  scope: string
  consecutive_failures: number
  total_failures: number
  last_error: string | null
  last_failed_at: string | null
  last_succeeded_at: string | null
  blocked_until: string | null
}
