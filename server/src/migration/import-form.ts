/**
 * The schema imported cases are recorded against.
 *
 * A case carries the form it came from, and that form is what the case screen
 * renders its answers against afterwards. Cases arriving from another tool did
 * not come from any of these forms, and the export they arrive in cannot say
 * which country form they would have matched — within a zone the forms are
 * field-identical, down to the wording of the request types, so nothing in a
 * CSV distinguishes Brazil from Argentina.
 *
 * Rather than pick one at random and have every imported case claim a country
 * it may not be from, each zone gets one form of its own for imports: the
 * union of every field its country forms collect. Honest about where the
 * cases came from, and — because the fields are the same either way — it
 * renders identically to the form the requester actually filled in.
 *
 * Pure: schemas in, schema out. The service decides when to store it.
 */

import type { Component } from '../public/form-validation';

/** `saz-import`, `eur-import`, `maz-import`. */
export function importFormKey(zoneId: string): string {
  return `${zoneId.toLowerCase()}-import`;
}

interface SourceForm {
  formKey: string;
  schema: { name?: string; components?: Component[] };
}

export interface ZoneImportSchema {
  key: string;
  zone: string;
  name: string;
  /** Flat list of every input the zone collects, in first-seen order. */
  components: Component[];
  /** Marks this as not a public intake form. */
  importOnly: true;
  /** Which forms it was built from, so it can be explained and rebuilt. */
  builtFrom: string[];
}

/**
 * Build the union of a zone's forms.
 *
 * Two rules, both about not asserting something the sources disagree on:
 *
 * - A field present in several forms keeps the label they agree on. Where they
 *   disagree — MAZ labels `requestDetails` three different ways — the key is
 *   used instead. Unlovely, but a column headed with one country's wording on
 *   another country's case is quietly wrong, which is worse.
 * - Select options are unioned by value, so an answer from any of the zone's
 *   forms resolves to a code rather than being left as raw text.
 */
export function buildZoneImportSchema(
  zoneId: string,
  forms: SourceForm[],
  collect: (components: Component[]) => Map<string, Component>,
): ZoneImportSchema {
  const merged = new Map<string, Component>();
  const labelsSeen = new Map<string, Set<string>>();
  const optionsSeen = new Map<string, Map<string, { label?: string; value: string }>>();

  // Sorted so the result does not depend on the order rows came back in: this
  // schema is compared against the stored one to decide whether to publish a
  // new version, and a set that reshuffles would republish on every import.
  for (const form of [...forms].sort((a, b) => a.formKey.localeCompare(b.formKey))) {
    for (const [key, component] of collect(form.schema.components ?? [])) {
      const label = component.label?.trim() || key;
      const labels = labelsSeen.get(key) ?? new Set<string>();
      labels.add(label);
      labelsSeen.set(key, labels);

      const options = optionsSeen.get(key) ?? new Map<string, { label?: string; value: string }>();
      for (const o of (component.data?.values ?? component.values ?? []) as {
        label?: string;
        value: string;
      }[]) {
        if (!options.has(o.value)) options.set(o.value, o);
      }
      optionsSeen.set(key, options);

      if (!merged.has(key)) merged.set(key, component);
    }
  }

  const components: Component[] = [];
  for (const [key, component] of merged) {
    const labels = labelsSeen.get(key)!;
    const options = [...(optionsSeen.get(key) ?? new Map()).values()];
    components.push({
      ...component,
      key,
      label: labels.size === 1 ? [...labels][0] : key,
      // Conditionals reference a layout this flat list does not have, and an
      // unsatisfiable condition would hide the field from the case screen.
      conditional: undefined,
      hidden: false,
      ...(options.length ? { values: options, data: { values: options } } : {}),
    });
  }

  return {
    key: importFormKey(zoneId),
    zone: zoneId,
    name: `${zoneId} (imported)`,
    components,
    importOnly: true,
    builtFrom: forms.map((f) => f.formKey).sort(),
  };
}

/** True for a schema that exists only to hold imported cases. */
export function isImportForm(key: string): boolean {
  return /-import$/.test(key);
}

/**
 * Key-sorted JSON, for comparing a freshly built schema against the stored one.
 *
 * `jsonb` does not keep the key order it was given, so a plain
 * `JSON.stringify` comparison never matches and every import publishes another
 * version of a schema that has not changed. Sorting both sides makes the
 * comparison about content, which is the only thing that should decide it.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(walk(value));
}
