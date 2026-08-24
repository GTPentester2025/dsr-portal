import { createContext, useContext } from 'react'

export type Translator = (source: string | undefined) => string

const I18nContext = createContext<Translator>((s) => s ?? '')

export const I18nProvider = I18nContext.Provider

export function useT(): Translator {
  return useContext(I18nContext)
}

/** Build a translator for one language from the schema's i18n table. */
export function makeTranslator(
  i18n: Record<string, Record<string, string>>,
  lang: string,
): Translator {
  const table = i18n[lang] ?? {}
  return (source) => {
    if (!source) return ''
    const hit = table[source]
    return hit && hit.trim() !== '' ? hit : source
  }
}

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  nl: 'Nederlands',
  ar: 'العربية',
  'pt-pt': 'Português (PT)',
  'pt-br': 'Português (BR)',
}
