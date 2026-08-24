/**
 * Server-side re-implementation of every client validation rule (spec §2):
 * client validation is UX only and assumed bypassed. This walks the stored
 * form schema, computes visibility, validates, and returns a canonicalised
 * payload. Unknown fields are rejected, not ignored (spec §9).
 */

interface Component {
  key: string;
  type: string;
  label?: string;
  input?: boolean;
  validate?: {
    required?: boolean;
    maxLength?: number | string;
    minLength?: number | string;
    pattern?: string;
    customMessage?: string;
  };
  conditional?: { show?: string | boolean; when?: string; eq?: string };
  hidden?: boolean;
  data?: { values?: { value: string }[]; url?: string };
  dataSrc?: string;
  values?: { value: string }[];
  components?: Component[];
  columns?: { components?: Component[] }[];
  maxFiles?: number;
  fileMaxSize?: string;
}

export interface FormSchemaDoc {
  key: string;
  zone: string;
  components: Component[];
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ValidatedSubmission {
  values: Record<string, unknown>;
  issues: ValidationIssue[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const INPUT_TYPES = new Set([
  'textfield', 'dsrtextfield', 'textarea', 'select', 'dsrselect',
  'dsrselectboxes', 'checkbox', 'radio', 'dsrradio', 'email', 'dsremail',
  'dsrphoneNumber', 'dsrdatetime', 'file', 'datagrid',
]);
const MAX_STRING_LEN = 10_000;
const MAX_GRID_ROWS = 50;

function isVisible(c: Component, values: Record<string, unknown>): boolean {
  if (c.hidden) return false;
  const cond = c.conditional;
  if (!cond?.when) return true;
  const show = String(cond.show) === 'true';
  const actual = values[cond.when];
  let matches: boolean;
  if (Array.isArray(actual)) matches = actual.map(String).includes(String(cond.eq));
  else if (actual !== null && typeof actual === 'object')
    matches = Boolean((actual as Record<string, unknown>)[String(cond.eq)]);
  else matches = String(actual ?? '') === String(cond.eq);
  return matches === show;
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return !Object.values(v as object).some(Boolean);
  return false;
}

function num(v: number | string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Collect every input component reachable in the schema, keyed. */
function collectInputs(components: Component[]): Map<string, Component> {
  const map = new Map<string, Component>();
  const walk = (list: Component[]) => {
    for (const c of list ?? []) {
      if (INPUT_TYPES.has(c.type) && c.key) map.set(c.key, c);
      // datagrid children are validated per-row, not at top level
      if (c.type !== 'datagrid' && c.components) walk(c.components);
      for (const col of c.columns ?? []) walk(col.components ?? []);
    }
  };
  walk(components);
  return map;
}

function canonicalise(c: Component, raw: unknown, issues: ValidationIssue[]): unknown {
  const fail = (message: string) => {
    issues.push({ field: c.key, message });
    return undefined;
  };
  switch (c.type) {
    case 'textfield':
    case 'dsrtextfield':
    case 'textarea':
    case 'dsrphoneNumber':
    case 'dsrdatetime':
    case 'email':
    case 'dsremail': {
      if (typeof raw !== 'string') return fail('must be a string');
      const v = raw.trim();
      if (v.length > MAX_STRING_LEN) return fail('too long');
      return v;
    }
    case 'select':
    case 'dsrselect':
    case 'radio':
    case 'dsrradio': {
      if (typeof raw !== 'string') return fail('must be a string');
      const allowed =
        c.dataSrc === 'url'
          ? null // remote datasource (countries) — length-checked only
          : (c.data?.values ?? c.values ?? []).map((o) => o.value);
      if (allowed && raw !== '' && !allowed.includes(raw)) return fail('not an allowed option');
      if (raw.length > MAX_STRING_LEN) return fail('too long');
      return raw;
    }
    case 'dsrselectboxes': {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return fail('must be an object of selections');
      }
      const allowed = new Set((c.values ?? []).map((o) => o.value));
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!allowed.has(k)) return fail(`unknown option: ${k}`);
        if (typeof v !== 'boolean') return fail('selections must be booleans');
        if (v) out[k] = true;
      }
      return out;
    }
    case 'checkbox':
      if (typeof raw !== 'boolean') return fail('must be a boolean');
      return raw;
    case 'file': {
      // Metadata only at this stage; binary upload handled separately with
      // magic-byte + MIME allow-list checks.
      if (!Array.isArray(raw)) return fail('must be an array');
      if (raw.length > (c.maxFiles ?? 10)) return fail('too many files');
      return raw;
    }
    case 'datagrid': {
      if (!Array.isArray(raw)) return fail('must be an array of rows');
      if (raw.length > MAX_GRID_ROWS) return fail('too many rows');
      const rowInputs = collectInputs(c.components ?? []);
      return raw.map((row, i) => {
        if (row === null || typeof row !== 'object') {
          issues.push({ field: c.key, message: `row ${i} must be an object` });
          return {};
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
          const rc = rowInputs.get(k);
          if (!rc) {
            issues.push({ field: `${c.key}[${i}].${k}`, message: 'unknown field' });
            continue;
          }
          const cv = canonicalise(rc, v, issues);
          if (cv !== undefined) out[k] = cv;
        }
        return out;
      });
    }
    default:
      return fail('unsupported field type');
  }
}

function validateRules(c: Component, v: unknown, issues: ValidationIssue[]) {
  const rules = c.validate ?? {};
  if (rules.required && isEmpty(v)) {
    issues.push({ field: c.key, message: 'required' });
    return;
  }
  if (isEmpty(v)) return;
  if (typeof v === 'string') {
    const max = num(rules.maxLength);
    const min = num(rules.minLength);
    if (max !== undefined && v.length > max) issues.push({ field: c.key, message: `max length ${max}` });
    if (min !== undefined && v.length < min) issues.push({ field: c.key, message: `min length ${min}` });
    if (rules.pattern) {
      try {
        if (!new RegExp(`^(?:${rules.pattern})$`).test(v)) {
          issues.push({ field: c.key, message: 'invalid format' });
        }
      } catch {
        /* invalid source pattern — cannot enforce */
      }
    }
    if ((c.type === 'email' || c.type === 'dsremail') && !EMAIL_RE.test(v)) {
      issues.push({ field: c.key, message: 'invalid email' });
    }
  }
}

export function validateSubmission(
  schema: FormSchemaDoc,
  payload: Record<string, unknown>,
): ValidatedSubmission {
  const issues: ValidationIssue[] = [];
  const inputs = collectInputs(schema.components);

  // 1. Reject unknown top-level fields outright.
  for (const key of Object.keys(payload)) {
    if (!inputs.has(key)) issues.push({ field: key, message: 'unknown field' });
  }
  if (issues.length) return { values: {}, issues };

  // 2. Canonicalise everything submitted.
  const values: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(payload)) {
    const c = inputs.get(key)!;
    const v = canonicalise(c, raw, issues);
    if (v !== undefined) values[key] = v;
  }
  if (issues.length) return { values: {}, issues };

  // 3. Visibility pass: hidden fields must not carry values; visible ones validate.
  for (const [key, c] of inputs) {
    const visible = isVisible(c, values);
    if (!visible) {
      delete values[key]; // clearOnHide semantics, enforced server-side
      continue;
    }
    validateRules(c, values[key], issues);

    // Datagrid rows: apply each row component's rules with row-scoped
    // visibility (conditionals may reference either row or top-level keys).
    if (c.type === 'datagrid' && Array.isArray(values[key])) {
      const rowInputs = collectInputs(c.components ?? []);
      (values[key] as Record<string, unknown>[]).forEach((row, i) => {
        const scope = { ...values, ...row };
        for (const [rk, rc] of rowInputs) {
          if (!isVisible(rc, scope)) {
            delete row[rk];
            continue;
          }
          const before = issues.length;
          validateRules(rc, row[rk], issues);
          for (let j = before; j < issues.length; j++) {
            issues[j].field = `${key}[${i}].${issues[j].field}`;
          }
        }
      });
    }
  }
  return { values, issues };
}
