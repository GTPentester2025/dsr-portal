import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Component, FormSchema, FormValues } from './types'
import {
  createDraft,
  getDraftStatus,
  loadForm,
  sendVerification,
  submitForm,
} from './lib/api'
import { I18nProvider, LANGUAGE_NAMES, makeTranslator } from './lib/i18n'
import { validateForm, type FieldError } from './lib/validation'
import type { VerifyState } from './components/VerifyEmail'
import { FieldTree } from './components/FieldRenderer'
import { DraftContext } from './lib/draft'
import { VerifyEmail } from './components/VerifyEmail'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function findSubmitButton(components: Component[]): Component | null {
  for (const c of components) {
    if (c.type === 'button' && (c.action === 'submit' || c.key === 'submit')) return c
    for (const sub of c.components ?? []) {
      if (sub.type === 'button') return sub
    }
    for (const col of c.columns ?? []) {
      const hit = findSubmitButton(col.components ?? [])
      if (hit) return hit
    }
  }
  return null
}

export function FormPage({ formKey, lang, onLangChange }: {
  formKey: string
  lang: string | null
  onLangChange: (lang: string) => void
}) {
  const [schema, setSchema] = useState<FormSchema | null>(null)
  const [loadError, setLoadError] = useState('')
  const [values, setValues] = useState<FormValues>({})
  const [errors, setErrors] = useState<FieldError[]>([])
  const [draftId, setDraftId] = useState<string | null>(null)
  const [verify, setVerify] = useState<VerifyState>('idle')
  const [verifiedEmail, setVerifiedEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [caseRef, setCaseRef] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    setSchema(null)
    loadForm(formKey)
      .then((s) => {
        setSchema(s)
        // apply schema defaults (e.g. eur "I am a..." preselects Consumer)
        const defaults: FormValues = {}
        const walk = (cs: Component[]) => {
          for (const c of cs) {
            if (c.defaultValue !== undefined && c.defaultValue !== null && c.defaultValue !== '' && c.key) {
              defaults[c.key] = c.defaultValue
            }
            walk(c.components ?? [])
            for (const col of c.columns ?? []) walk(col.components ?? [])
          }
        }
        walk(s.components)
        setValues(defaults)
      })
      .catch((e) => setLoadError(String(e)))
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [formKey])

  // Mirrors the live form's language intelligence: explicit choice first,
  // then browser language when the form enables it, then the form default.
  const activeLang = (() => {
    if (lang && schema?.languages.includes(lang)) return lang
    if (schema?.langIntelligence) {
      for (const bl of (navigator.languages ?? [navigator.language]).map((l) => l.toLowerCase())) {
        if (schema.languages.includes(bl)) return bl
        const short = bl.split('-')[0]
        const hit = schema.languages.find((l2) => l2 === short || l2.startsWith(short + '-'))
        if (hit) return hit
      }
    }
    return schema?.defaultLanguage ?? 'en'
  })()
  const t = useMemo(() => makeTranslator(schema?.i18n ?? {}, activeLang), [schema, activeLang])

  const email = String(values['email'] ?? '').trim().toLowerCase()
  const emailVerified = verify === 'verified' && email === verifiedEmail

  const startVerification = useCallback(async () => {
    if (!EMAIL_RE.test(email)) {
      setErrors([{ key: 'email', label: 'Email', message: t('Enter a valid email address first') }])
      return
    }
    setErrors([])
    setVerify('sending')
    try {
      let id = draftId
      if (!id) {
        id = (await createDraft(formKey)).draftId
        setDraftId(id)
      }
      await sendVerification(id, email)
      setVerify('pending')
      const target = email
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        try {
          const st = await getDraftStatus(id!)
          if (st.verified) {
            setVerify('verified')
            setVerifiedEmail(target)
            if (pollRef.current) clearInterval(pollRef.current)
          }
        } catch { /* transient */ }
      }, 2500)
    } catch {
      setVerify('idle')
      setSubmitError(t('Could not send the verification email. Please try again.'))
    }
  }, [draftId, email, formKey, t])

  if (loadError) return <div style={{ padding: 40, color: '#b00' }}>{loadError}</div>
  if (!schema) return <div style={{ padding: 40, color: '#888' }}>Loading…</div>

  const errorMap: Record<string, string> = {}
  for (const e of errors) errorMap[e.key] = e.message

  const submitBtn = findSubmitButton(schema.components)
  const submitLabel = t(submitBtn?.label) || t('Submit Request')

  const submit = async () => {
    setSubmitError('')
    const errs = validateForm(schema.components, values, t)
    if (schema.emailVerification.enabled && !emailVerified) {
      errs.push({ key: 'email', label: 'Email', message: t('Please verify your email address before submitting') })
    }
    setErrors(errs)
    if (errs.length > 0) {
      document.querySelector('[data-error-summary]')?.scrollIntoView({ behavior: 'smooth' })
      return
    }
    setSubmitting(true)
    try {
      let id = draftId
      if (!id) {
        id = (await createDraft(formKey)).draftId
        setDraftId(id)
      }
      const res = await submitForm(id, formKey, values)
      setCaseRef(res.caseRef)
      window.scrollTo({ top: 0 })
    } catch (err) {
      const e = err as Error & { issues?: { field: string; message: string }[] }
      setSubmitError(e.message)
      if (Array.isArray(e.issues)) {
        setErrors(e.issues.map((i) => ({ key: i.field, label: i.field, message: `${i.field}: ${i.message}` })))
      }
    } finally {
      setSubmitting(false)
    }
  }

  // Our addition on top of the original form (spec §3): inline verify action.
  const verifyPanel = schema.emailVerification.enabled ? (
    <VerifyEmail
      state={emailVerified ? 'verified' : verify}
      email={emailVerified ? verifiedEmail : ''}
      buttonBg={schema.display.bgColor || '#D3A238'}
      buttonFg={schema.display.textColor || '#0A0A0A'}
      t={t}
      onVerify={() => void startVerification()}
    />
  ) : null

  if (caseRef) {
    return (
      <div className="application theme--light" style={{ background: '#fff', minHeight: '100vh' }}>
        <div className="container c-dsp-form-page f-page pa-0">
          <div className="layout f-dsp-content justify-center">
            <div className="flex px-5 py-4 xs12 sm9 lg8" style={{ textAlign: 'center', paddingTop: 80 }}>
              {schema.orgLogo && <img className="f-org-logo" src={schema.orgLogo} alt={schema.orgName ?? ''} style={{ maxHeight: 96, width: 172, height: 'auto' }} />}
              <h1 className="f-request-header f-text-heading" style={{ paddingLeft: 0 }}>{t('Request received')}</h1>
              <p style={{ fontSize: 18 }}>
                {t('Your reference number is')} <strong>{caseRef}</strong>.<br />
                {t('A confirmation email has been sent to')} {verifiedEmail || email}.
              </p>
              <p><a href="#/">← {t('Back to all forms')}</a></p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <I18nProvider value={t}>
      <DraftContext.Provider value={draftId}>
      <div className="application theme--light" style={{ background: '#fff', minHeight: '100vh' }}>
        <div className="application--wrap">
          <main className="v-content" style={{ padding: 0 }}>
            <div className="v-content__wrap">
              <div className="container c-dsp-form-page f-page pa-0">
                <div className="layout column">

                  <div className="layout f-dsr-form-header-b py-4 wrap align-center justify-start">
                    <div className="flex f-logo-wrapper xs12 md2" style={{ textAlign: 'right' }}>
                      {schema.orgLogo && (
                        <img className="f-org-logo" src={schema.orgLogo} alt={schema.orgName ?? ''} />
                      )}
                    </div>
                    <div className="flex f-content-wrapper xs12 md10 lg8">
                      {/* live DOM nests <p> inside <p>; a div keeps the same
                          class selectors matching without innerHTML breakout */}
                      {schema.display.header && (
                        <div
                          className="f-request-header f-text-heading f-color-dark-black-s100 mb-4"
                          dangerouslySetInnerHTML={{ __html: t(schema.display.header) }}
                        />
                      )}
                      {schema.display.body && (
                        <div
                          className="f-request-sub-header f-text-title f-color-dark-black-s100"
                          dangerouslySetInnerHTML={{ __html: t(schema.display.body) }}
                        />
                      )}
                    </div>
                  </div>

                  <div className="layout f-dsp-content justify-center">
                    <div className="flex px-5 py-4 xs12 sm9 lg8">
                      <div className="f-dsp-form-wrapper">
                        <div className="c-formio-renderer">

                          {schema.languages.length > 1 && (
                            <div className="f-form-translations-select" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
                              <select
                                value={activeLang}
                                onChange={(e) => onLangChange(e.target.value)}
                                style={{
                                  border: 'none', borderBottom: '2px solid #D3A238',
                                  color: '#0A0A0A', fontSize: 16, padding: '4px 8px',
                                  background: 'transparent', fontFamily: 'inherit', cursor: 'pointer',
                                }}
                              >
                                {schema.languages.map((l) => (
                                  <option key={l} value={l}>{LANGUAGE_NAMES[l] ?? l}</option>
                                ))}
                              </select>
                            </div>
                          )}

                          {(errors.length > 0 || submitError) && (
                            <div data-error-summary className="alert alert-danger" role="alert">
                              <p style={{ fontWeight: 500, marginBottom: errors.length ? 8 : 0 }}>
                                {submitError || t('Please fix the following errors before submitting.')}
                              </p>
                              {errors.length > 0 && (
                                <ul style={{ marginBottom: 0 }}>
                                  {errors.map((e, i) => <li key={`${e.key}-${i}`}>{e.message}</li>)}
                                </ul>
                              )}
                            </div>
                          )}

                          <div className="null formio-form">
                            <form onSubmit={(e) => { e.preventDefault(); void submit() }} noValidate>
                              <FieldTree
                                components={schema.components}
                                values={values}
                                errors={errorMap}
                                onChange={(k, v) => setValues((prev) => ({ ...prev, [k]: v }))}
                                afterField={{ email: verifyPanel }}
                                submitButton={
                                  <div className="form-group has-feedback formio-component formio-component-button formio-component-submit mt-4 form-group">
                                    <button
                                      type="submit"
                                      className="btn btn-primary btn-md mt-4"
                                      disabled={submitting}
                                      style={{
                                        background: schema.display.bgColor || '#D3A238',
                                        color: schema.display.textColor || '#0A0A0A',
                                      }}
                                    >
                                      {submitting ? t('Submitting…') : submitLabel}
                                    </button>
                                    {schema.emailVerification.enabled && !emailVerified && (
                                      <div className="help-block" style={{ marginTop: 8, textAlign: 'center' }}>
                                        {t('Submit unlocks after you verify your email address.')}
                                      </div>
                                    )}
                                  </div>
                                }
                              />
                            </form>
                          </div>

                          {/* restrictionsText renders only when the duplicate-
                              request limit fires, mirroring the live form */}
                          {schema.orgName && (
                            <div style={{ textAlign: 'center', marginTop: 32, color: 'rgb(10 10 10 / 0.6)', fontSize: 14 }}>
                              {t('Privacy request portal')}<br />
                              <strong style={{ fontSize: 16 }}>{schema.orgName}</strong>
                            </div>
                          )}

                        </div>
                      </div>
                    </div>
                  </div>

                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
      </DraftContext.Provider>
    </I18nProvider>
  )
}
