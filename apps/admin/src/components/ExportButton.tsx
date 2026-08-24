import { useState } from 'react'
import { Button } from './ui'
import { useToast } from './Toast'

/**
 * Downloads a CSV from an authenticated endpoint.
 *
 * A plain <a download> would work for a public file, but these endpoints sit
 * behind the session cookie and can fail with a real error the user needs to
 * see. Fetching lets a 403 or a server error surface as a toast instead of the
 * browser silently saving an error page as a .csv.
 */
export function ExportButton({
  href,
  label = 'Export CSV',
  variant = 'secondary',
}: {
  href: string
  label?: string
  variant?: 'primary' | 'secondary' | 'ghost'
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const download = async () => {
    setBusy(true)
    try {
      const res = await fetch(href, { credentials: 'same-origin' })
      if (!res.ok) {
        const detail = await res.json().catch(() => null)
        throw new Error(detail?.message ?? `Export failed (${res.status})`)
      }
      // Filename comes from the server so it carries a consistent timestamp.
      const disposition = res.headers.get('content-disposition') ?? ''
      const named = /filename="([^"]+)"/.exec(disposition)?.[1]
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = named ?? 'export.csv'
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoking immediately can cancel the save in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (e) {
      toast.error('Could not export', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button variant={variant} icon="download" loading={busy} onClick={download}>
      {label}
    </Button>
  )
}
