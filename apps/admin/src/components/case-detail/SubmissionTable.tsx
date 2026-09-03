import type { CaseDetail } from '../../lib/api'
import { Table, Td, Th, Tr } from '../ui'
import { Icon } from '../Icon'
import { FieldValue, humaniseKey } from '../FieldValue'

/**
 * The submitted form, as a record rather than a prose block.
 *
 * A table is the honest shape here: every row is the same pair of things, the
 * reader scans down one column, and the storage column makes it visible which
 * answers are held encrypted without relying on an icon's colour alone.
 */
export function SubmissionTable({ c }: { c: CaseDetail }) {
  return (
    <Table
      caption={`Fields submitted on case ${c.caseRef}`}
      head={
        <>
          <Th className="w-[13rem]">Field</Th>
          <Th>Value</Th>
          <Th className="w-[7.5rem]">Storage</Th>
        </>
      }
    >
      <Tr>
        <Td className="align-top">
          <span className="text-[12.5px] text-muted">Requester</span>
        </Td>
        <Td className="align-top">
          <p className="font-medium text-ink">{c.requesterName || 'Not provided'}</p>
          <p className="break-all text-[12.5px] text-muted">{c.requesterEmail}</p>
        </Td>
        <Td className="align-top">
          <StorageTag encrypted />
        </Td>
      </Tr>

      {c.fields.map((f) => (
        <Tr key={f.key}>
          <Td className="align-top">
            <span className="block text-[12.5px] text-muted">{humaniseKey(f.key)}</span>
            {/* The raw key is what appears in exports and the form schema, so
                it is shown rather than hidden behind a tooltip. */}
            <span className="mono block text-[10.5px] text-faint">{f.key}</span>
          </Td>
          <Td className="min-w-0 break-words align-top text-ink">
            <FieldValue value={f.value} />
          </Td>
          <Td className="align-top">
            <StorageTag encrypted={f.encrypted} />
          </Td>
        </Tr>
      ))}
    </Table>
  )
}

/** Icon plus word: colour alone must not carry the distinction. */
function StorageTag({ encrypted }: { encrypted: boolean }) {
  if (!encrypted) return <span className="text-[11.5px] text-faint">Plain</span>
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-positive">
      <Icon name="key" size={11} className="shrink-0" />
      Encrypted
    </span>
  )
}
