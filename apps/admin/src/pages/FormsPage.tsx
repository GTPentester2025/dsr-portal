import { useCallback, useEffect, useState } from 'react'
import { api, type Me } from '../lib/api'
import {
  Card, Chip, EmptyState, PageHeader, Skeleton, Table, Tabs, Td, Th, Tr,
} from '../components/ui'
import { Icon } from '../components/Icon'
import { SlaPolicies } from './SlaPolicies'

export interface FormSummary {
  key: string
  zone: string
  name: string
  version: number
  fieldCount: number
  languages: string[]
  country: string | null
  updatedAt: string
}

export function FormsPage({ me }: { me: Me }) {
  const [tab, setTab] = useState<'forms' | 'sla'>('forms')
  const [forms, setForms] = useState<FormSummary[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.get<FormSummary[]>('/internal/forms').then(setForms).catch((e) => setError(String(e)))
  }, [])
  useEffect(load, [load])

  return (
    <>
      <PageHeader
        title="Forms & SLAs"
        subtitle="Edit the public request forms and the response deadlines they run on."
      />

      <div className="mb-5">
        <Tabs
          tabs={[
            { id: 'forms', label: 'Public forms', icon: 'file', badge: forms?.length },
            { id: 'sla', label: 'SLA policies', icon: 'clock' },
          ]}
          active={tab}
          onChange={(t) => setTab(t as 'forms' | 'sla')}
        />
      </div>

      {tab === 'sla' ? (
        <SlaPolicies me={me} />
      ) : error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !forms ? (
        <Card bleed>
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10" />)}
          </div>
        </Card>
      ) : forms.length === 0 ? (
        <Card bleed>
          <EmptyState icon="file" title="No forms available" hint="Import the form schemas on the server first." />
        </Card>
      ) : (
        <Card bleed>
          <Table
            head={<><Th>Form</Th><Th>Zone</Th><Th>Fields</Th><Th>Languages</Th><Th>Version</Th><Th /></>}
          >
            {forms.map((f) => (
              <Tr key={f.key} onClick={() => { window.location.hash = `#/forms/${f.key}` }}>
                <Td>
                  <p className="font-medium text-ink">{f.name}</p>
                  <p className="mono text-[11px] text-faint">{f.key}</p>
                </Td>
                <Td><Chip>{f.zone}</Chip></Td>
                <Td><span className="mono text-[12px] text-muted">{f.fieldCount}</span></Td>
                <Td className="text-[12px] text-muted">{f.languages.length}</Td>
                <Td><span className="mono text-[12px] text-muted">v{f.version}</span></Td>
                <Td className="text-right">
                  <span className="inline-flex items-center gap-1 text-[12px] font-medium text-brand-ink">
                    Edit <Icon name="chevronRight" size={13} />
                  </span>
                </Td>
              </Tr>
            ))}
          </Table>
          <p className="flex items-center gap-1.5 border-t border-line px-4 py-3 text-[11px] text-faint">
            <Icon name="info" size={12} />
            Publishing creates a new version. Cases already submitted keep rendering against the version they were filed under.
          </p>
        </Card>
      )}
    </>
  )
}
