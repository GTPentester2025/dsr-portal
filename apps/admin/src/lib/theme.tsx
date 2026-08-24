import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

interface ThemeCtx {
  choice: ThemeChoice
  resolved: ResolvedTheme
  setChoice: (c: ThemeChoice) => void
  toggle: () => void
}

const Ctx = createContext<ThemeCtx | null>(null)
const STORAGE_KEY = 'dsr.theme'

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function apply(resolved: ResolvedTheme) {
  const root = document.documentElement
  root.dataset.theme = resolved
  root
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'dark' ? '#000000' : '#f4f4f2')
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(
    () => (localStorage.getItem(STORAGE_KEY) as ThemeChoice) ?? 'system',
  )
  const [systemPref, setSystemPref] = useState<ResolvedTheme>(systemTheme)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemPref(mq.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolved: ResolvedTheme = choice === 'system' ? systemPref : choice

  useEffect(() => {
    apply(resolved)
    // Enable colour transitions only after the first paint, so switching
    // themes animates but the initial render never flashes.
    const id = window.setTimeout(() => document.body.classList.add('theme-ready'), 60)
    return () => window.clearTimeout(id)
  }, [resolved])

  const setChoice = useCallback((c: ThemeChoice) => {
    setChoiceState(c)
    localStorage.setItem(STORAGE_KEY, c)
  }, [])

  const toggle = useCallback(() => {
    setChoice(resolved === 'dark' ? 'light' : 'dark')
  }, [resolved, setChoice])

  const value = useMemo(
    () => ({ choice, resolved, setChoice, toggle }),
    [choice, resolved, setChoice, toggle],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}

/**
 * Applies the stored theme before React mounts so there is no flash of the
 * wrong palette. Injected as a blocking inline script from index.html.
 */
export const themeBootScript = `
(function(){try{
  var c = localStorage.getItem('${STORAGE_KEY}') || 'system';
  var d = c === 'dark' || (c === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = d ? 'dark' : 'light';
}catch(e){}})();`
