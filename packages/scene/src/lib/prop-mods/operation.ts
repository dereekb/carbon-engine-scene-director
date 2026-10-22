import { isPlainObject, type JsonObject } from '../json';
import type { FleetOperationContext } from '../fleets/operations';
import { FLEET_SELECTION_KEYS, readFleetSelection, selectFleetShips } from '../fleets/selection';
import { PROP_MOD_MODULE_NONE, type PropModModule, readPropModModule } from '../stats/prop-mods';

export const PROP_MOD_OPERATIONS: ReadonlySet<string> = new Set(['set_prop_mods']);

const SET_PROP_MODS_KEYS = new Set<string>(['op', 'active', 'module', ...FLEET_SELECTION_KEYS]);

/**
 * Applies `{ op: "set_prop_mods", ships | fleet [, wing | squad], active?, module? }`: merges the values into each
 * selected ship's `propMod`. `module: null` removes the module (back to the hull-sized default), `active: false`
 * removes `active`, and an emptied `propMod` is deleted. Selecting ships that fit no prop mod with `active: true`
 * warns. Runs mid-patch, so it composes after an add_fleet_composition that names its fleet.
 *
 * @param operation - The operation.
 * @param context - The draft and where problems and warnings go.
 */
export function applyPropModOperation(operation: JsonObject, context: FleetOperationContext): void {
  const { draft, where, problems, warnings } = context;
  const before = problems.length;
  for (const key of Object.keys(operation)) if (!SET_PROP_MODS_KEYS.has(key)) warnings.push(`${where}.${key} is not a set_prop_mods field and was ignored`);
  const selection = readFleetSelection(operation, where, problems);
  const hasActive = operation['active'] !== undefined;
  const hasModule = operation['module'] !== undefined;
  if (!hasActive && !hasModule) problems.push(`${where} needs active (true or false) or module (a module, or null for the hull-sized default)`);
  if (hasActive && typeof operation['active'] !== 'boolean') problems.push(`${where}.active must be true or false`);
  const module: PropModModule | null | undefined = hasModule && operation['module'] !== null ? readPropModModule(operation['module'], `${where}.module`, problems) : (operation['module'] as null | undefined);
  if (problems.length > before) return;

  const selected = selectFleetShips(draft, selection, where);
  problems.push(...selected.problems);
  if (selected.problems.length) return;

  const ships = new Map((Array.isArray(draft['ships']) ? draft['ships'] : []).filter(isPlainObject).map((ship) => [ship['id'], ship]));
  const fitNone: string[] = [];
  for (const id of selected.ships) {
    const ship = ships.get(id) as JsonObject;
    const propMod = readDraftPropMod(ship['propMod']);
    if (module === null) delete propMod['module'];
    else if (module !== undefined) propMod['module'] = module;
    if (operation['active'] === true) propMod['active'] = true;
    else if (operation['active'] === false) delete propMod['active'];
    if (Object.keys(propMod).length) ship['propMod'] = propMod;
    else delete ship['propMod'];
    if (propMod['active'] === true && propMod['module'] === PROP_MOD_MODULE_NONE) fitNone.push(id);
  }
  const names = fitNone.map((id) => `"${id}"`).join(', ');
  if (fitNone.length) warnings.push(`${where}: ${names} fit no prop mod (propMod.module "none"), so they stay off`);
}

/**
 * A draft ship's prop mod as an object to edit: the shorthand becomes `{ module }`. A malformed value is kept for
 * normalizeScene to report, merged into an object when it is one.
 *
 * @param value - The ship's propMod.
 * @returns A fresh object.
 */
function readDraftPropMod(value: unknown): JsonObject {
  let propMod: JsonObject = {};
  if (typeof value === 'string' || typeof value === 'number') propMod = { module: value };
  else if (isPlainObject(value)) propMod = { ...value };
  return propMod;
}
