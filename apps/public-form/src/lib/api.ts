import type { Country, FormSchema, Manifest } from '../types'

const cache = new Map<string, unknown>()

async function getJson<T>(path: string): Promise<T> {
  if (cache.has(path)) return cache.get(path) as T
  const res = await fetch(path)
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`)
  const data = (await res.json()) as T
  cache.set(path, data)
  return data
}

export const loadManifest = () => getJson<Manifest>('/public/forms')

export const loadForm = (key: string) => {
  if (!/^[a-z0-9-]+$/.test(key)) throw new Error('bad form key')
  // Served from the database so changes published in the builder appear here
  // without a redeploy; the static files remain the import seed.
  return getJson<FormSchema>(`/public/forms/${key}`)
}

export const loadCountries = async (): Promise<Country[]> => {
  const raw = await getJson<{ data: Country[] }>('/form-schema/countries.json')
  return raw.data
}

// ---- backend intake API -----------------------------------------------------

/** Attached to errors thrown by `backend`/`uploadFile` so callers can tell a
 *  missing resource (bad or expired link) apart from a rejected request. */
export type BackendError = Error & { status?: number; issues?: unknown }

async function backend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as T & { message?: string; issues?: unknown }
  if (!res.ok) {
    const err = new Error((data as { message?: string })?.message || `HTTP ${res.status}`) as BackendError
    err.status = res.status
    err.issues = (data as { issues?: unknown })?.issues
    throw err
  }
  return data
}

/** Same contract as `backend`, but posts a `FormData` body — used for the one
 *  upload this app makes, where the payload is a file rather than JSON. */
async function backendUpload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', body: form })
  const data = (await res.json().catch(() => null)) as T & { message?: string }
  if (!res.ok) {
    const err = new Error((data as { message?: string })?.message || `HTTP ${res.status}`) as BackendError
    err.status = res.status
    throw err
  }
  return data
}

export const createDraft = (formKey: string) =>
  backend<{ draftId: string }>('POST', '/public/drafts', { formKey })

export const sendVerification = (draftId: string, email: string) =>
  backend<{ status: string }>('POST', '/public/verification/send', { draftId, email })

export const getDraftStatus = (draftId: string) =>
  backend<{ verified: boolean }>('GET', `/public/drafts/${draftId}/status`)

export const submitForm = (draftId: string, formKey: string, values: Record<string, unknown>) =>
  backend<{ caseRef: string }>('POST', '/public/submissions', { draftId, formKey, values })

// ---- delegation link ---------------------------------------------------------
//
// What the emailed link opens: no login, no draft, just a token that resolves
// to a bounded view of one case. See PublicDelegationView on the server for
// exactly what's included -- deliberately nothing about the requester.

export type DelegationStage = 'sent' | 'accepted' | 'closed'

export interface DelegationView {
  caseRef: string
  requestType: string
  dueDate: string | null
  note: string
  /** The case owner's name -- who is asking. Never the requester. */
  sentBy: string
  /** The group the link was sent to -- who was asked. */
  groupName: string
  stage: DelegationStage
  acceptedBy: string | null
  members: { id: string; name: string }[]
  files: { filename: string; uploadedAt: string }[]
}

export const getDelegation = (token: string) =>
  backend<DelegationView>('GET', `/public/delegation/${token}`)

export const acceptDelegation = (token: string, memberId: string) =>
  backend<DelegationView>('POST', `/public/delegation/${token}/accept`, { memberId })

export const uploadDelegationFile = (token: string, file: File) => {
  const form = new FormData()
  form.append('file', file)
  return backendUpload<DelegationView>(`/public/delegation/${token}/upload`, form)
}
