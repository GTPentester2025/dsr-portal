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

async function backend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as T & { message?: string; issues?: unknown }
  if (!res.ok) {
    const err = new Error((data as { message?: string })?.message || `HTTP ${res.status}`) as Error & {
      issues?: unknown
    }
    err.issues = (data as { issues?: unknown })?.issues
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
