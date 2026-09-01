import { buildZoneImportSchema, importFormKey, isImportForm } from './import-form';
import { collectInputs, type Component } from '../public/form-validation';

/**
 * Within a zone the country forms are field-identical -- SAZ's six agree down
 * to the wording of the request types -- so nothing in a CSV says which one a
 * case came from. These cover the union that stands in for them.
 */

const brazil = {
  formKey: 'saz-brazil',
  schema: {
    components: [
      {
        key: 'ticket_type',
        type: 'dsrradio',
        label: 'Select type of request',
        input: true,
        values: [{ label: 'Ter acesso', value: 'access' }],
      },
      { key: 'cpf_brazil', type: 'textfield', label: 'CPF', input: true },
      { key: 'requestDetails', type: 'textarea', label: 'Request Details (optional)', input: true },
    ] as Component[],
  },
};

const mexico = {
  formKey: 'maz-mexico',
  schema: {
    components: [
      {
        key: 'ticket_type',
        type: 'dsrradio',
        label: 'Select type of request',
        input: true,
        values: [{ label: 'Eliminar mis datos', value: 'erasure' }],
      },
      { key: 'curp', type: 'textfield', label: 'CURP', input: true },
      {
        key: 'requestDetails',
        type: 'textarea',
        label: 'Do you want to add something to your request?',
        input: true,
        conditional: { show: 'true', when: 'ticket_type', eq: 'erasure' },
      },
    ] as Component[],
  },
};

describe('buildZoneImportSchema', () => {
  const schema = buildZoneImportSchema('SAZ', [brazil, mexico], collectInputs);
  const byKey = new Map(schema.components.map((c) => [c.key, c]));

  it('names itself after the zone, not a country', () => {
    expect(schema.key).toBe('saz-import');
    expect(schema.name).toBe('SAZ (imported)');
    expect(isImportForm(schema.key)).toBe(true);
    expect(isImportForm('saz-brazil')).toBe(false);
  });

  it('collects every field any of the forms asks for', () => {
    expect([...byKey.keys()].sort()).toEqual(
      ['cpf_brazil', 'curp', 'requestDetails', 'ticket_type'].sort(),
    );
  });

  it('keeps a label the forms agree on', () => {
    expect(byKey.get('cpf_brazil')?.label).toBe('CPF');
  });

  it('falls back to the key where they disagree, rather than picking a side', () => {
    // One country's wording on another country's case is quietly wrong.
    expect(byKey.get('requestDetails')?.label).toBe('requestDetails');
  });

  it('unions the request types so any zone answer resolves to a code', () => {
    const values = (byKey.get('ticket_type')?.values ?? []).map((v) => v.value);
    expect(values.sort()).toEqual(['access', 'erasure']);
  });

  it('drops conditionals, which reference a layout the flat list does not have', () => {
    // An unsatisfiable condition would hide the field from the case screen.
    expect(byKey.get('requestDetails')?.conditional).toBeUndefined();
    expect(byKey.get('requestDetails')?.hidden).toBe(false);
  });

  it('records what it was built from', () => {
    expect(schema.builtFrom).toEqual(['maz-mexico', 'saz-brazil']);
  });

  it('is stable regardless of the order the forms came back in', () => {
    // It is compared against the stored copy to decide whether to publish a
    // new version; a reshuffling result would republish on every import.
    expect(JSON.stringify(buildZoneImportSchema('SAZ', [mexico, brazil], collectInputs)))
      .toBe(JSON.stringify(schema));
  });

  it('keys off the zone', () => {
    expect(importFormKey('EUR')).toBe('eur-import');
    expect(importFormKey('MAZ')).toBe('maz-import');
  });
});
