/** Subset of the form.io component model used by the 12 source forms. */
export interface OptionValue {
  label: string
  value: string
}

export interface Conditional {
  show?: string | boolean
  when?: string
  eq?: string
}

export interface Validation {
  required?: boolean
  maxLength?: number | string
  minLength?: number | string
  pattern?: string
  customMessage?: string
}

export interface Component {
  id?: string
  key: string
  type: string
  label?: string
  hideLabel?: boolean
  hidden?: boolean
  input?: boolean
  placeholder?: string
  description?: string
  tooltip?: string
  defaultValue?: unknown
  multiple?: boolean
  validate?: Validation
  conditional?: Conditional
  clearOnHide?: boolean
  disabled?: boolean
  // select
  dataSrc?: string
  data?: { values?: OptionValue[]; url?: string }
  // selectboxes / radio
  values?: OptionValue[]
  inline?: boolean
  // textarea
  rows?: number
  showCharCount?: boolean
  customClass?: string
  inputMask?: string
  format?: string
  // htmlelement
  tag?: string
  content?: string
  className?: string
  attrs?: { attr: string; value: string }[]
  // columns
  columns?: ColumnDef[]
  // containers
  components?: Component[]
  // file
  filePattern?: string
  fileMaxSize?: string
  maxFiles?: number
  // datagrid
  addAnother?: string
  // button
  action?: string
}

export interface ColumnDef {
  width?: number
  offset?: number
  components?: Component[]
}

export interface FormSchema {
  schemaVersion: number
  key: string
  zone: 'EUR' | 'SAZ' | 'MAZ'
  country: string | null
  name: string
  source: {
    tenantFormId: string
    formId: string
    version: number
    publishedOn: string
    title: string
  }
  orgName: string | null
  orgLogo: string | null
  defaultLanguage: string
  langIntelligence?: boolean
  languages: string[]
  emailVerification: { enabled: boolean }
  requestTypes: Record<string, string>
  settings: Record<string, string>
  display: {
    body?: string
    header?: string
    footer?: string
    bgColor?: string
    textColor?: string
    formTextColor?: string
    headingFormContent?: string
    restrictionsText?: string
    restrictionsTextHeading?: string
  }
  components: Component[]
  i18n: Record<string, Record<string, string>>
}

export interface ManifestEntry {
  key: string
  name: string
  country: string | null
  languages: string[]
  fieldCount: number
  sourceVersion: number
}

export interface Manifest {
  zones: Record<string, ManifestEntry[]>
}

export interface Country {
  cn: string
  code: string
}

/** Flat form value state; datagrid values are arrays of row records. */
export type FormValues = Record<string, unknown>
