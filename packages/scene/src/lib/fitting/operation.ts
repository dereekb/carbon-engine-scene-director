import { isPlainObject, type JsonObject } from '../json';
import type { FleetOperationContext } from '../fleets/operations';
import { FIT_KEY_PATTERN, readFitText } from './fit';

/**
 * The patch operations that edit the document's fits.
 */
export const FIT_OPERATIONS: ReadonlySet<string> = new Set(['set_fits']);

const SET_FITS_KEYS = new Set<string>(['op', 'fits']);

/**
 * Applies `{ op: "set_fits", fits: { "<key>": "<EFT text>" | null } }`: merges the texts into the document's `fits`;
 * `null` deletes a key. Deleting a key a ship still uses is a problem, and an emptied map is removed. A ship's own
 * fit is set with update_ship `{ set: { fit } }`.
 *
 * @param operation - The operation.
 * @param context - The draft and where problems and warnings go.
 */
export function applyFitOperation(operation: JsonObject, context: FleetOperationContext): void {
  const { draft, where, problems, warnings } = context;
  for (const key of Object.keys(operation)) if (!SET_FITS_KEYS.has(key)) warnings.push(`${where}.${key} is not a set_fits field and was ignored`);
  const input = operation['fits'];
  if (!isPlainObject(input) || !Object.keys(input).length) {
    problems.push(`${where}.fits must be an object of EFT fit text (or null to delete) by key`);
    return;
  }
  const fits: Record<string, unknown> = isPlainObject(draft['fits']) ? draft['fits'] : {};
  const used = new Map<string, string>();
  for (const ship of Array.isArray(draft['ships']) ? draft['ships'] : []) {
    if (isPlainObject(ship) && typeof ship['fit'] === 'string' && !used.has(ship['fit'])) used.set(ship['fit'], String(ship['id']));
  }
  for (const [key, value] of Object.entries(input)) {
    if (!FIT_KEY_PATTERN.test(key)) {
      problems.push(`${where}.fits key "${key}" is not a fit key (1-64 letters, digits, "_", "-" or ".", optionally twice with one "/" between)`);
    } else if (value === null) {
      if (used.has(key)) problems.push(`${where}: fit "${key}" is used by ship "${used.get(key)}"; change or clear those ships' fit first`);
      else if (!(key in fits)) warnings.push(`${where}: the scene has no fit "${key}" to delete`);
      else delete fits[key];
    } else {
      const text = readFitText(value, `${where}.fits["${key}"]`, problems);
      if (text) fits[key] = text;
    }
  }
  if (Object.keys(fits).length) draft['fits'] = fits;
  else delete draft['fits'];
}
