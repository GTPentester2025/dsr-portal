import { useEffect, useState } from 'react'
import type { Manifest } from './types'
import { loadManifest } from './lib/api'
import { FormPage } from './FormPage'
import { PreviewPage } from './PreviewPage'
import { isPreviewRoute } from './lib/preview'

const ZONE_LABELS: Record<string, string> = {
  EUR: 'Europe',
  SAZ: 'South America Zone',
  MAZ: 'Middle Americas Zone',
}

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

function Picker() {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  useEffect(() => { loadManifest().then(setManifest) }, [])
  if (!manifest) return <div className="dsr-picker"><p className="dsr-picker-sub">Loading…</p></div>
  return (
    <div className="dsr-picker">
      <span className="dsr-picker-rule" aria-hidden="true" />
      <h1 className="dsr-picker-title">Data Subject Request Forms</h1>
      <p className="dsr-picker-sub">Select your region to submit a privacy request.</p>
      {Object.entries(manifest.zones).map(([zone, forms]) => (
        <section key={zone} className="dsr-picker-zone">
          <h2 className="dsr-picker-zone-title">{ZONE_LABELS[zone] ?? zone}</h2>
          <div className="dsr-picker-grid">
            {forms.map((f) => (
              <a key={f.key} href={`#/form/${f.key}`} className="dsr-picker-card">
                <span className="dsr-picker-card-name">{f.name}</span>
                <span className="dsr-picker-card-meta">
                  {f.languages.length} language{f.languages.length > 1 ? 's' : ''}
                </span>
              </a>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export default function App() {
  const hash = useHashRoute()

  // The form builder embeds this route in an iframe. Checked before the
  // public route so a preview never falls through to a submittable form.
  const previewKey = isPreviewRoute(hash)
  if (previewKey) return <PreviewPage formKey={previewKey} />

  const m = /^#\/form\/([a-z0-9-]+)(?:\?lang=([a-z-]+))?$/.exec(hash)
  if (m) {
    return (
      <FormPage
        formKey={m[1]}
        lang={m[2] ?? null}
        onLangChange={(lang) => {
          window.location.hash = `#/form/${m[1]}?lang=${lang}`
        }}
      />
    )
  }
  return <div className="dsr-picker-page"><Picker /></div>
}
