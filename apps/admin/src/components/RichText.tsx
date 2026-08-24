import { useEffect, useRef, useState } from 'react'
import { fieldCls } from './ui'

/**
 * A small rich text editor for message bodies.
 *
 * These fields hold the HTML that is actually emailed, and they were plain
 * textareas — so composing a reply meant typing around `<p>` and `<div
 * style="…">`. Here the formatting is applied through the toolbar and the
 * markup stays out of the way, with an HTML tab kept for the cases where
 * someone genuinely needs it (pasting a signature block, checking a template).
 *
 * `document.execCommand` is formally deprecated but is still the only
 * cross-browser way to drive contentEditable, and every current engine
 * implements it. The alternative is a third-party editor an order of magnitude
 * larger than this screen.
 */
export function RichTextEditor({
  value,
  onChange,
  id,
  minHeight = 220,
  ariaLabel = 'Message body',
}: {
  value: string
  onChange: (html: string) => void
  id?: string
  minHeight?: number
  ariaLabel?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<'rich' | 'html'>('rich')

  // Only write into the DOM when the value genuinely differs, otherwise every
  // keystroke would re-render the node and drop the caret to the start.
  useEffect(() => {
    const el = ref.current
    if (!el || mode !== 'rich') return
    if (el.innerHTML !== value) el.innerHTML = value ?? ''
  }, [value, mode])

  const push = () => {
    const el = ref.current
    if (el) onChange(el.innerHTML)
  }

  const exec = (command: string, arg?: string) => {
    ref.current?.focus()
    document.execCommand(command, false, arg)
    push()
  }

  const addLink = () => {
    const url = window.prompt('Link address', 'https://')
    if (url) exec('createLink', url)
  }

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-1">
        <ToolButton label="Bold" onClick={() => exec('bold')}>
          <span className="font-bold">B</span>
        </ToolButton>
        <ToolButton label="Italic" onClick={() => exec('italic')}>
          <span className="italic">I</span>
        </ToolButton>
        <ToolButton label="Bulleted list" onClick={() => exec('insertUnorderedList')}>
          • List
        </ToolButton>
        <ToolButton label="Numbered list" onClick={() => exec('insertOrderedList')}>
          1. List
        </ToolButton>
        <ToolButton label="Insert link" onClick={addLink}>
          Link
        </ToolButton>
        <ToolButton label="Remove formatting" onClick={() => exec('removeFormat')}>
          Clear
        </ToolButton>

        <div className="ml-auto flex items-center gap-1">
          <ToolButton
            label="Rich text view"
            active={mode === 'rich'}
            onClick={() => setMode('rich')}
          >
            Text
          </ToolButton>
          <ToolButton
            label="HTML source view"
            active={mode === 'html'}
            onClick={() => setMode('html')}
          >
            HTML
          </ToolButton>
        </div>
      </div>

      {mode === 'rich' ? (
        <div
          id={id}
          ref={ref}
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          contentEditable
          suppressContentEditableWarning
          onInput={push}
          onBlur={push}
          // Word and Outlook paste a wall of markup; plain text keeps the
          // stored body clean. The HTML tab is there when markup is intended.
          onPaste={(e) => {
            e.preventDefault()
            const text = e.clipboardData.getData('text/plain')
            document.execCommand('insertText', false, text)
            push()
          }}
          // A paper surface in both themes. Stored bodies carry inline
          // colours meant for an inbox (#1a1a1a on white), which on the dark
          // theme render as near-black on near-black; and an email is going to
          // be read on white anyway, so this is the honest preview.
          className="w-full overflow-auto rounded-lg border border-line px-3 py-2 leading-relaxed transition-colors duration-150 hover:border-line-strong focus:border-brand-ink [&_a]:underline [&_li]:ml-5 [&_ol]:list-decimal [&_p]:mb-2 [&_ul]:list-disc"
          style={{ minHeight, background: '#ffffff', color: '#1a1a1a' }}
        />
      ) : (
        <textarea
          id={id}
          aria-label={`${ariaLabel} (HTML source)`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${fieldCls} mono py-2 text-[12px] leading-relaxed`}
          style={{ minHeight }}
        />
      )}
    </div>
  )
}

function ToolButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      // Keeps the selection in the editor: a mousedown elsewhere would collapse
      // it before the command runs.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`min-h-7 cursor-pointer rounded-md px-2 text-[11.5px] font-medium transition-colors duration-150 ${
        active ? 'bg-brand-soft text-brand-ink' : 'text-muted hover:bg-sunken hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * Read-only rendering of a stored body, for previews.
 *
 * The HTML is ours — rendered templates and messages the portal composed — not
 * requester input.
 */
export function RichTextPreview({ html, className = '' }: { html: string; className?: string }) {
  return (
    <div
      className={`overflow-auto rounded-lg border border-line p-3 text-[13px] leading-relaxed [&_a]:underline [&_li]:ml-5 [&_ol]:list-decimal [&_p]:mb-2 [&_ul]:list-disc ${className}`}
      style={{ background: '#ffffff', color: '#1a1a1a' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
