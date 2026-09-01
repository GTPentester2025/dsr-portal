import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiError, ZONES, api,
  type ColumnProposal, type CommitResult, type ImportAnalysis, type ImportRecord,
  type Me, type RowIssue,
} from '../lib/api'
import {
  Alert, Button, Card, Chip, EmptyState, Field, PageHeader, Select, Skeleton,
  Table, Td, Th, Tr,
} from '../components/ui'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toast'
import type { FormSummary } from './FormsPage'

/**
 * Bringing case history over from another DSR tool.
 *
 * Three steps, in the order that stops an import going wrong quietly: choose
 * where the cases belong, check what each column was read as, then write them.
 * The middle step is the one that matters — a mis-read date column or a
 * silently dropped answer is invisible once the rows are in.
 */

type Step = 'upload' | 'review' | 'done'

const DATE_ORDERS = [
  { value: 'dmy', label: 'Day first — 03-04-2026 is 3 April' },
  { value: 'mdy', label: 'Month first — 03-04-2026 is 4 March' },
  { value: 'iso', label: 'ISO — 2026-04-03' },
] as const

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  const s = String(value)
  // ISO timestamps are what the coercion produces; show them as dates.
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 16).replace('T', ' ') : s
}

function IssueList({ issues, limit = 50 }: { issues: RowIssue[]; limit?: number }) {
  if (issues.length === 0) return null
  return (
    <ul className="space-y-1">
      {issues.slice(0, limit).map((i, n) => (
        <li key={n} className="flex items-start gap-2 text-[12px]">
          <Icon
            name={i.severity === 'error' ? 'alert' : 'info'}
            size={12}
            className={`mt-0.5 shrink-0 ${i.severity === 'error' ? 'text-danger' : 'text-warning'}`}
          />
          <span className="text-muted">
            <span className="mono text-faint">row {i.row}</span>
            {i.column ? <span className="text-faint"> · {i.column}</span> : null} — {i.message}
          </span>
        </li>
      ))}
      {issues.length > limit && (
        <li className="text-[12px] text-faint">…and {issues.length - limit} more</li>
      )}
    </ul>
  )
}

export function MigrationPage({ me }: { me: Me }) {
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement>(null)

  const [forms, setForms] = useState<FormSummary[] | null>(null)
  const [history, setHistory] = useState<ImportRecord[] | null>(null)
  const [zoneId, setZoneId] = useState(me.zoneId ?? 'EUR')
  const [formKey, setFormKey] = useState('')
  const [file, setFile] = useState<File | null>(null)

  const [step, setStep] = useState<Step>('upload')
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [dateOrder, setDateOrder] = useState<'dmy' | 'mdy' | 'iso'>('dmy')
  const [result, setResult] = useState<CommitResult | null>(null)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadHistory = useCallback(() => {
    api.get<ImportRecord[]>('/internal/migration/imports').then(setHistory).catch(() => setHistory([]))
  }, [])

  useEffect(() => {
    api.get<FormSummary[]>('/internal/forms').then(setForms).catch((e) => setError(String(e)))
    loadHistory()
  }, [loadHistory])

  // A zone manager has exactly one zone; nobody else should be able to pick a
  // form that belongs somewhere other than the zone they chose.
  const zonesAvailable = me.role === 'zone_manager' && me.zoneId ? [me.zoneId] : [...ZONES]
  const formsInZone = useMemo(
    () => (forms ?? []).filter((f) => f.zone === zoneId),
    [forms, zoneId],
  )
  useEffect(() => {
    if (formsInZone.length && !formsInZone.some((f) => f.key === formKey)) {
      setFormKey(formsInZone[0].key)
    }
  }, [formsInZone, formKey])

  async function analyse() {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('zoneId', zoneId)
      form.append('formKey', formKey)
      const res = await api.upload<ImportAnalysis>('/internal/migration/analyse', form)
      setAnalysis(res)
      setMapping(Object.fromEntries(res.columns.map((c) => [c.header, c.target])))
      setDateOrder(res.dateOrder)
      setStep('review')
      loadHistory()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** Re-run the preview server-side so what is shown is what would be written. */
  async function refreshPreview(next: Record<string, string>, order: typeof dateOrder) {
    if (!analysis) return
    setBusy(true)
    try {
      const res = await api.post<Pick<ImportAnalysis, 'sampleRows' | 'issues' | 'errorRows' | 'duplicates'>>(
        `/internal/migration/imports/${analysis.id}/preview`,
        { mapping: next, dateOrder: order },
      )
      setAnalysis({ ...analysis, ...res })
    } catch (e) {
      toast.error('Could not refresh the preview', e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function retarget(header: string, target: string) {
    const next = { ...mapping, [header]: target }
    setMapping(next)
    void refreshPreview(next, dateOrder)
  }

  async function commit() {
    if (!analysis) return
    setBusy(true)
    setError('')
    try {
      const res = await api.post<CommitResult>(
        `/internal/migration/imports/${analysis.id}/commit`,
        { mapping, dateOrder },
      )
      setResult(res)
      setStep('done')
      loadHistory()
      toast.success(`Imported ${res.imported} case${res.imported === 1 ? '' : 's'}`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function discard() {
    if (!analysis) return
    try {
      await api.del(`/internal/migration/imports/${analysis.id}`)
    } catch {
      /* already gone is fine */
    }
    reset()
  }

  function reset() {
    setAnalysis(null)
    setResult(null)
    setMapping({})
    setFile(null)
    setStep('upload')
    setError('')
    if (fileInput.current) fileInput.current.value = ''
    loadHistory()
  }

  const mappedFields = Object.values(mapping).filter((t) => t.startsWith('field:')).length
  const ignored = Object.values(mapping).filter((t) => t === 'ignore').length

  return (
    <>
      <PageHeader
        title="Migration"
        subtitle="Bring case history over from another DSR tool. Nothing is written until you confirm the column mapping."
        actions={
          step !== 'upload' ? (
            <Button icon="refresh" onClick={step === 'done' ? reset : discard}>
              {step === 'done' ? 'Import another file' : 'Start over'}
            </Button>
          ) : undefined
        }
      />

      {error && (
        <div className="mb-5">
          <Alert tone="error" title="That did not work">{error}</Alert>
        </div>
      )}

      {/* ------------------------------ step 1 ------------------------------ */}
      {step === 'upload' && (
        <div className="space-y-5">
          <Card
            title="Upload an export"
            subtitle="A CSV of cases. Save an .xlsx as CSV first — the importer reads text, not the compressed spreadsheet format."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Zone"
                hint="Which zone these cases belong to. Their references are issued in this zone's sequence."
              >
                <Select
                  value={zoneId}
                  onChange={(e) => setZoneId(e.target.value)}
                  disabled={zonesAvailable.length === 1}
                >
                  {zonesAvailable.map((z) => <option key={z} value={z}>{z}</option>)}
                </Select>
              </Field>

              <Field
                label="Form"
                hint="Used to match column headings to fields and request-type wording to codes."
              >
                <Select value={formKey} onChange={(e) => setFormKey(e.target.value)}>
                  {formsInZone.length === 0 && <option value="">No forms in this zone</option>}
                  {formsInZone.map((f) => (
                    <option key={f.key} value={f.key}>{f.name} (v{f.version})</option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="mt-4">
              <label
                htmlFor="import-file"
                className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong bg-sunken/50 px-6 py-8 text-center transition-colors hover:border-brand-ink"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface text-faint">
                  <Icon name="upload" size={18} />
                </span>
                <span className="text-[13px] font-medium text-ink">
                  {file ? file.name : 'Choose a CSV file'}
                </span>
                <span className="text-[11px] text-faint">
                  {file
                    ? `${(file.size / 1024).toFixed(0)} KB — click to choose a different file`
                    : 'Up to 25 MB and 20,000 rows per import'}
                </span>
              </label>
              <input
                id="import-file"
                ref={fileInput}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/plain"
                className="sr-only"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>

            <div className="mt-4 flex justify-end">
              <Button
                variant="primary"
                icon="arrowUpRight"
                loading={busy}
                disabled={!file || !formKey}
                onClick={analyse}
              >
                Read the file
              </Button>
            </div>
          </Card>

          <ImportHistory rows={history} />
        </div>
      )}

      {/* ------------------------------ step 2 ------------------------------ */}
      {step === 'review' && analysis && (
        <div className="space-y-5">
          <Card title="What was read" subtitle={analysis.filename}>
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Rows" value={String(analysis.totalRows)} />
              <Stat label="Columns" value={String(analysis.columns.length)} />
              <Stat
                label="Mapped to fields"
                value={String(mappedFields)}
                hint={ignored ? `${ignored} ignored` : undefined}
              />
              <Stat
                label="Already imported"
                value={String(analysis.duplicates.count)}
                hint={analysis.duplicates.count ? 'will be skipped' : undefined}
              />
            </div>
            <p className="mt-3 text-[11px] text-faint">
              Read as {analysis.encoding}, delimiter{' '}
              <span className="mono">{analysis.delimiter === '\t' ? 'tab' : analysis.delimiter}</span>.
              Cases will be created on <span className="mono">{analysis.formKey}</span> v
              {analysis.formVersion} in {analysis.zoneId}.
            </p>
          </Card>

          <Card
            title="Dates"
            subtitle="Getting this wrong shifts every deadline by months, so it is asked rather than assumed."
          >
            {!analysis.dateOrderConfident && (
              <div className="mb-3">
                <Alert tone="warning" title="No day above 12 anywhere in the file">
                  Nothing in the data distinguishes day-first from month-first. Day-first is
                  assumed — check a row below against the source before continuing.
                </Alert>
              </div>
            )}
            <Field label="Date order in this file">
              <Select
                value={dateOrder}
                onChange={(e) => {
                  const next = e.target.value as typeof dateOrder
                  setDateOrder(next)
                  void refreshPreview(mapping, next)
                }}
              >
                {DATE_ORDERS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </Select>
            </Field>
          </Card>

          <Card
            title="Columns"
            subtitle="Every column has a destination. Nothing is dropped unless you choose to ignore it."
            bleed
          >
            <Table
              caption="Columns in the uploaded file and where each will be stored"
              head={<><Th>Column</Th><Th>Sample values</Th><Th>Goes to</Th></>}
            >
              {analysis.columns.map((c) => (
                <ColumnRow
                  key={c.header}
                  column={c}
                  value={mapping[c.header] ?? 'ignore'}
                  targets={analysis.targets}
                  onChange={(t) => retarget(c.header, t)}
                />
              ))}
            </Table>
          </Card>

          <Card
            title="Preview"
            subtitle="The first rows exactly as they would be written."
            bleed
          >
            <div className="divide-y divide-line">
              {analysis.sampleRows.map((r) => (
                <div key={r.row} className="p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="mono text-[11px] text-faint">row {r.row}</span>
                    {r.reportPublished && <Chip tone="brand" icon="send">Report published</Chip>}
                    {r.reportAccessed && <Chip tone="positive" icon="eye">Read by subject</Chip>}
                    {r.issues.some((i) => i.severity === 'error') && (
                      <Chip tone="danger" icon="alert">Will be skipped</Chip>
                    )}
                  </div>
                  <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {Object.entries({ ...r.caseProps, ...r.fields }).map(([k, v]) => (
                      <div key={k} className="min-w-0">
                        <dt className="truncate text-[10px] uppercase tracking-wider text-faint">{k}</dt>
                        <dd className="truncate text-[12px] text-ink" title={fmt(v)}>{fmt(v)}</dd>
                      </div>
                    ))}
                  </dl>
                  {r.issues.length > 0 && (
                    <div className="mt-2"><IssueList issues={r.issues} limit={5} /></div>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {analysis.issues.length > 0 && (
            <Card
              title={`${analysis.issues.length} thing${analysis.issues.length === 1 ? '' : 's'} to look at`}
              subtitle={
                analysis.errorRows
                  ? `${analysis.errorRows} row(s) cannot be imported and will be skipped; the rest will go in.`
                  : 'Warnings only — every row can be imported.'
              }
            >
              <IssueList issues={analysis.issues} />
            </Card>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button onClick={discard}>Discard</Button>
            <Button variant="primary" icon="database" loading={busy} onClick={commit}>
              Import {analysis.totalRows - analysis.errorRows - analysis.duplicates.count} case
              {analysis.totalRows - analysis.errorRows - analysis.duplicates.count === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      )}

      {/* ------------------------------ step 3 ------------------------------ */}
      {step === 'done' && result && (
        <div className="space-y-5">
          <Card title="Import finished">
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Imported" value={String(result.imported)} />
              <Stat label="Skipped" value={String(result.skipped)} hint="already present" />
              <Stat label="Failed" value={String(result.failed)} />
              <Stat label="No email address" value={String(result.placeholderEmails)} />
            </div>
            {result.placeholderEmails > 0 && (
              <div className="mt-4">
                <Alert tone="warning" title="Some rows had no email address">
                  {result.placeholderEmails} case(s) were imported against a placeholder address on
                  the reserved <span className="mono">import.invalid</span> domain. They are intact
                  and searchable, but nothing can be sent to them until a real address is recorded.
                </Alert>
              </div>
            )}
            <div className="mt-4">
              <a href="#/cases" className="text-[13px] font-medium text-brand-ink hover:underline">
                Go to cases →
              </a>
            </div>
          </Card>

          {result.issues.length > 0 && (
            <Card title="What was reported" subtitle="Row numbers refer to the uploaded file.">
              <IssueList issues={result.issues} limit={200} />
            </Card>
          )}

          <ImportHistory rows={history} />
        </div>
      )}
    </>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-sunken/60 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-faint">{label}</p>
      <p className="text-[19px] font-semibold tracking-[-0.01em] text-ink">{value}</p>
      {hint && <p className="text-[11px] text-faint">{hint}</p>}
    </div>
  )
}

function ColumnRow({
  column,
  value,
  targets,
  onChange,
}: {
  column: ColumnProposal
  value: string
  targets: ImportAnalysis['targets']
  onChange: (target: string) => void
}) {
  // A column the form has no field for is still offered as a new custom field,
  // but is flagged: storing an answer under a key nothing renders is a choice,
  // not something that should happen because nobody looked.
  const novelOption = column.novel ? column.target : null
  return (
    <Tr>
      <Td className="align-top">
        <p className="font-medium text-ink">{column.header || <span className="text-faint">(no heading)</span>}</p>
        <p className="mt-0.5 text-[11px] text-faint">{column.reason}</p>
      </Td>
      <Td className="align-top">
        {column.samples.length ? (
          <ul className="space-y-0.5">
            {column.samples.map((s, i) => (
              <li key={i} className="max-w-[26ch] truncate text-[12px] text-muted" title={s}>{s}</li>
            ))}
          </ul>
        ) : (
          <span className="text-[12px] text-faint">empty in every row</span>
        )}
      </Td>
      <Td className="align-top">
        <div className="min-w-[15rem]">
          <Select value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="ignore">Ignore this column</option>
            {novelOption && (
              <option value={novelOption}>New field — {novelOption.slice(6)}</option>
            )}
            <optgroup label="Case record">
              {targets.case.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </optgroup>
            <optgroup label="Form fields">
              {targets.field.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </optgroup>
          </Select>
          {column.novel && value === novelOption && (
            <p className="mt-1.5 text-[11px] text-warning">
              Stored under a key this form does not define.
            </p>
          )}
        </div>
      </Td>
    </Tr>
  )
}

function ImportHistory({ rows }: { rows: ImportRecord[] | null }) {
  if (!rows) {
    return (
      <Card bleed>
        <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
      </Card>
    )
  }
  if (rows.length === 0) {
    return (
      <Card title="Previous imports" bleed>
        <EmptyState
          icon="upload"
          title="Nothing imported yet"
          hint="Files you upload here are listed with what they brought in, so an import can be explained later."
        />
      </Card>
    )
  }
  return (
    <Card title="Previous imports" bleed>
      <Table
        caption="Files previously uploaded and what each imported"
        head={<><Th>File</Th><Th>Zone</Th><Th>Status</Th><Th>Rows</Th><Th>By</Th><Th>When</Th></>}
      >
        {rows.map((r) => (
          <Tr key={r.id}>
            <Td><span className="font-medium text-ink">{r.filename}</span></Td>
            <Td>{r.zone_id}</Td>
            <Td>
              <Chip tone={r.status === 'committed' ? 'positive' : r.status === 'discarded' ? 'neutral' : 'brand'}>
                {r.status}
              </Chip>
            </Td>
            <Td className="text-muted">
              {r.status === 'committed'
                ? `${r.imported} in · ${r.skipped} skipped · ${r.failed} failed`
                : `${r.total_rows} read`}
            </Td>
            <Td className="text-muted">{r.uploaded_by_name ?? '—'}</Td>
            <Td className="text-faint">{String(r.created_at).slice(0, 16).replace('T', ' ')}</Td>
          </Tr>
        ))}
      </Table>
    </Card>
  )
}
