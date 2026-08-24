/**
 * Preview bridge.
 *
 * The form builder embeds this very app in an iframe rather than
 * re-implementing a preview, so what an editor sees is what a requester gets —
 * same renderer, same vendored stylesheets, same conditional logic. The editor
 * pushes its working draft over postMessage on every keystroke; this module
 * receives it, and reports clicks back so selecting a field in the preview
 * selects it in the editor.
 *
 * Messages are same-origin only. Both bundles are served from one host, so a
 * strict origin check costs nothing and keeps an embedded page from being
 * driven by a third-party frame.
 */
import type { FormSchema } from '../types'

export const PREVIEW_HASH = /^#\/preview\/([a-z0-9-]+)/

/** Editor -> preview. */
export type InboundMessage =
  | { type: 'dsr-preview:schema'; schema: FormSchema }
  | { type: 'dsr-preview:select'; key: string | null }

/** Preview -> editor. */
export type OutboundMessage =
  | { type: 'dsr-preview:ready' }
  | { type: 'dsr-preview:click'; key: string }
  | { type: 'dsr-preview:height'; height: number }

export function isPreviewRoute(hash: string): string | null {
  const m = PREVIEW_HASH.exec(hash)
  return m ? m[1] : null
}

function sameOrigin(event: MessageEvent): boolean {
  // "null" shows up for sandboxed frames; treat anything but our own origin as
  // untrusted rather than trying to enumerate what might be safe.
  return event.origin === window.location.origin
}

export function onEditorMessage(handler: (msg: InboundMessage) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (!sameOrigin(event)) return
    const data = event.data as InboundMessage | undefined
    if (!data || typeof data !== 'object') return
    if (data.type === 'dsr-preview:schema' || data.type === 'dsr-preview:select') {
      handler(data)
    }
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

export function toEditor(msg: OutboundMessage): void {
  if (window.parent === window) return
  window.parent.postMessage(msg, window.location.origin)
}

/**
 * Report the rendered height so the editor can size the frame to its content
 * instead of leaving a scrollbar inside a scrollbar.
 */
export function reportHeight(): void {
  const height = Math.ceil(document.documentElement.scrollHeight)
  toEditor({ type: 'dsr-preview:height', height })
}

export function watchHeight(): () => void {
  reportHeight()
  const observer = new ResizeObserver(() => reportHeight())
  observer.observe(document.documentElement)
  return () => observer.disconnect()
}

/**
 * Walk up from a clicked node to the nearest element carrying a component key.
 * The renderer stamps `data-preview-key` on each field wrapper; clicks usually
 * land on an inner input or label.
 */
export function keyFromEventTarget(target: EventTarget | null): string | null {
  let node = target as HTMLElement | null
  while (node && node !== document.body) {
    const key = node.dataset?.previewKey
    if (key) return key
    node = node.parentElement
  }
  return null
}
