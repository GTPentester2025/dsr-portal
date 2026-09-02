import { useCallback, useEffect, useState } from 'react'
import { ApiError, api, type SchemaStatus, type MigrateResult } from '../lib/api'
import { Alert, Button, Card, Chip, PageHeader, Skeleton } from '../components/ui'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toast'

/**
 * The database schema, and applying what is pending.
 *
 * Named "System" rather than "Migration" because that name is taken by the
 * page that imports cases from another tool, and confusing a case import with
 * a schema change would be an expensive mistake to make at speed.
 *
 * Deploying already applies migrations before restarting the service, so most
 * of the time this page exists to answer a question rather than to do
 * anything: is the schema behind the code? The button is for the case where
 * the answer is yes and a redeploy is not what you want to do about it.
 */
export function SystemPage() {
  const toast = useToast()
  const [status, setStatus] = useState<SchemaStatus | null>(null)
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .get<SchemaStatus>('/internal/admin/schema')
      .then((s) => {
        setStatus(s)
        setError('')
      })
      .catch((e) => {
        // Clear the skeleton: a page stuck loading forever tells the reader
        // less than an error does.
        setStatus({ applied: [], pending: [], upToDate: false })
        setError(e instanceof ApiError ? e.message : String(e))
      })
  }, [])
  useEffect(load, [load])

  const migrate = async () => {
    setRunning(true)
    setOutput(null)
    try {
      const result = await api.post<MigrateResult>('/internal/admin/schema/migrate')
      setOutput(result.output)
      toast.success(
        result.applied.length
          ? `Applied ${result.applied.length} migration${result.applied.length === 1 ? '' : 's'}`
          : 'The schema was already up to date',
      )
      load()
    } catch (e) {
      const message = e instanceof ApiError ? e.message : String(e)
      setOutput(message)
      toast.error('The migration did not finish', message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <PageHeader
        title="System"
        subtitle="The state of the database schema, and applying anything the code is waiting on."
        actions={
          <Button icon="refresh" onClick={load} disabled={running}>
            Refresh
          </Button>
        }
      />

      {error && (
        <div className="mb-5">
          <Alert tone="error" title="Could not read the schema state">{error}</Alert>
        </div>
      )}

      {!status ? (
        <Card><Skeleton className="h-24" /></Card>
      ) : (
        <div className="grid gap-4">
          <Card
            title="Schema"
            subtitle={
              status.upToDate
                ? 'Every migration in this build has been applied.'
                : 'The code expects tables or columns the database does not have yet.'
            }
            actions={
              status.upToDate ? (
                <Chip tone="positive" icon="checkCircle">Up to date</Chip>
              ) : (
                <Chip tone="warning" icon="alert">
                  {status.pending.length} pending
                </Chip>
              )
            }
          >
            {status.pending.length > 0 ? (
              <>
                <p className="mb-3 text-[13px] text-muted">
                  Until these are applied, anything relying on them will fail — usually as an
                  error naming a column that does not exist. Applying them is safe to repeat:
                  each runs once, inside its own transaction, and one that fails rolls back
                  rather than leaving the schema half-changed.
                </p>
                <ul className="mb-4 space-y-1">
                  {status.pending.map((name) => (
                    <li key={name} className="mono flex items-center gap-2 text-[12px] text-ink">
                      <Icon name="alert" size={12} className="text-warning" />
                      {name}
                    </li>
                  ))}
                </ul>
                <Button variant="primary" icon="database" loading={running} onClick={migrate}>
                  Apply {status.pending.length} migration{status.pending.length === 1 ? '' : 's'}
                </Button>
              </>
            ) : (
              <p className="text-[13px] text-muted">
                Nothing to apply. Deploying runs migrations before restarting the service, so
                this is the usual state.
              </p>
            )}
          </Card>

          {output && (
            <Card title="Output" subtitle="What the migration reported, verbatim.">
              <pre className="mono max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-sunken p-3 text-[12px] text-ink">
                {output}
              </pre>
            </Card>
          )}

          <Card
            title="Applied"
            subtitle={`${status.applied.length} migration${status.applied.length === 1 ? '' : 's'} on this database`}
            bleed
          >
            <ul className="divide-y divide-line">
              {status.applied.map((m) => (
                <li key={m.name} className="flex items-center justify-between gap-3 px-4 py-2">
                  <span className="mono truncate text-[12px] text-ink">{m.name}</span>
                  <span className="shrink-0 text-[11px] text-faint">
                    {m.appliedAt.slice(0, 16).replace('T', ' ')}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  )
}
