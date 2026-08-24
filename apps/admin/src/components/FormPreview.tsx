import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

/**
 * Live canvas for the form builder.
 *
 * Embeds the actual public form rather than re-implementing a preview, so the
 * editor sees the real renderer, the real stylesheets and the real conditional
 * logic. The working draft is pushed in over postMessage on every edit; clicks
 * come back out so selecting in the canvas selects in the editor.
 */

/** Widths chosen to match the breakpoints the public form is built against. */
const DEVICES = [
  { id: 'phone', label: 'Phone', width: 390, icon: 'smartphone' },
  { id: 'tablet', label: 'Tablet', width: 768, icon: 'tablet' },
  { id: 'desktop', label: 'Desktop', width: 0, icon: 'monitor' },
] as const

type DeviceId = (typeof DEVICES)[number]['id']

export function FormPreview({
  formKey,
  schema,
  selectedKey,
  onSelect,
}: {
  formKey: string
  /** The editor's working draft, sent as-is to the canvas. */
  schema: unknown
  selectedKey: string | null
  onSelect: (key: string) => void
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [ready, setReady] = useState(false)
  const [device, setDevice] = useState<DeviceId>('desktop')
  const [height, setHeight] = useState(900)

  const post = useCallback((msg: unknown) => {
    frameRef.current?.contentWindow?.postMessage(msg, window.location.origin)
  }, [])

  // Inbound: readiness, clicks, and the canvas's own rendered height.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const data = event.data as { type?: string; key?: string; height?: number }
      if (data?.type === 'dsr-preview:ready') setReady(true)
      else if (data?.type === 'dsr-preview:click' && data.key) onSelect(data.key)
      else if (data?.type === 'dsr-preview:height' && data.height) {
        // Clamped: an unbounded height would let a tall form push the editor
        // controls off screen entirely.
        setHeight(Math.min(Math.max(data.height, 400), 2400))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onSelect])

  // Outbound: the draft. Debounced so typing a label is not one message per
  // keystroke, but short enough to feel immediate.
  useEffect(() => {
    if (!ready) return
    const id = setTimeout(() => post({ type: 'dsr-preview:schema', schema }), 120)
    return () => clearTimeout(id)
  }, [ready, schema, post])

  useEffect(() => {
    if (!ready) return
    post({ type: 'dsr-preview:select', key: selectedKey })
  }, [ready, selectedKey, post])

  const width = DEVICES.find((d) => d.id === device)?.width ?? 0

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line bg-sunken/50 px-3 py-2">
        <span className="text-[12px] font-medium text-ink">Live preview</span>
        <span className="text-[11px] text-faint">
          {ready ? 'Click any field to edit it' : 'Connecting…'}
        </span>

        <div className="ml-auto flex items-center gap-1">
          {DEVICES.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDevice(d.id)}
              aria-label={d.label}
              aria-pressed={device === d.id}
              title={d.label}
              className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors duration-150 ${
                device === d.id
                  ? 'bg-brand-soft text-brand-ink'
                  : 'text-faint hover:bg-sunken hover:text-ink'
              }`}
            >
              <Icon name={d.icon} size={14} />
            </button>
          ))}
          <span className="mono ml-1 w-14 text-right text-[10.5px] text-faint">
            {width === 0 ? 'fluid' : `${width}px`}
          </span>
        </div>
      </div>

      <div className="flex justify-center bg-sunken/30 p-3">
        <iframe
          ref={frameRef}
          title="Form preview"
          // The canvas is same-origin so postMessage works; it performs no
          // writes, and top-navigation is blocked so a stray link inside a
          // form cannot navigate the console away.
          sandbox="allow-scripts allow-same-origin"
          src={`/#/preview/${formKey}`}
          onLoad={() => post({ type: 'dsr-preview:schema', schema })}
          style={{
            width: width === 0 ? '100%' : `${width}px`,
            height: `${height}px`,
            maxWidth: '100%',
            transition: 'width 200ms ease-out',
          }}
          className="rounded-lg border border-line bg-white"
        />
      </div>
    </div>
  )
}
