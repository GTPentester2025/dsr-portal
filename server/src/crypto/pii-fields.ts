/**
 * Form field keys whose answers are direct identifiers and are therefore held
 * envelope-encrypted at rest (spec §9).
 *
 * Lives on its own so intake and the case importer apply the same rule without
 * either having to load the other: a name that arrives in a spreadsheet is no
 * less identifying than one typed into the form.
 */
export const ENCRYPTED_FIELD_KEYS = new Set([
  'email', 'first_name', 'last_name', 'name', 'full_name', 'phone',
  'phone_number', 'telephone', 'id_number', 'document_number', 'dni',
  'address', 'address1', 'address2',
]);
