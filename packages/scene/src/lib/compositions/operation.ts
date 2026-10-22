import { isPlainObject, type JsonObject, readId, readNumber, readString, readVector } from '../json';
import type { FleetOperationContext } from '../fleets';
import type { SceneVector } from '../scene';
import { expandFleetComposition } from './expand';
import { normalizeFleetComposition } from './normalize';

/**
 * The patch operations that add fleet compositions.
 */
export const FLEET_COMPOSITION_OPERATIONS: ReadonlySet<string> = new Set(['add_fleet_composition']);

/**
 * Applies `{ op: "add_fleet_composition", composition, position, heading?, facing?, fleet?, team? }`: expands the
 * composition (every ship line with its dna) at the FC's position and heading, and appends its ships and fleet to
 * the draft. Pure and synchronous, like every patch operation: it looks nothing up.
 *
 * @param operation - The operation.
 * @param context - The draft and where problems and warnings go.
 */
export function applyFleetCompositionOperation(operation: JsonObject, context: FleetOperationContext): void {
  const { draft, where, problems, warnings } = context;
  const before = problems.length;
  const normalized = normalizeFleetComposition({ input: operation['composition'], where: `${where}.composition` });
  problems.push(...normalized.problems);
  warnings.push(...normalized.warnings);

  const position = operation['position'] === undefined ? null : readVector(operation['position'], `${where}.position`, problems);
  if (!position) problems.push(`${where}.position is required: the FC's [x, y, z] in metres`);
  const heading = position ? readHeading(operation, { where, problems, position }) : 0;
  const fleet = operation['fleet'] == null ? null : readId(operation['fleet'], `${where}.fleet`, problems);
  const team = operation['team'] == null ? null : readString(operation['team'], `${where}.team`, problems);
  if (!normalized.composition || !position || problems.length > before) return;

  const expanded = expandFleetComposition({ composition: normalized.composition, position, heading, fleet, team, existing: readExisting(draft), where: `${where}.composition` });
  problems.push(...expanded.problems);
  warnings.push(...expanded.warnings);
  if (!expanded.fleet) return;

  if (!Array.isArray(draft['ships'])) draft['ships'] = [];
  (draft['ships'] as unknown[]).push(...structuredClone(expanded.ships));
  if (draft['fleets'] == null) draft['fleets'] = [];
  if (Array.isArray(draft['fleets'])) draft['fleets'].push(structuredClone(expanded.fleet));
  else problems.push(`${where}: the scene's fleets are not an array`);
}

/**
 * The heading: `heading` in yaw degrees, or the yaw facing the `facing` point; 0 when neither.
 *
 * @param operation - The operation.
 * @param context - Where it sits, where problems go, and the FC's position.
 * @param context.where - The operation's place in the patch.
 * @param context.problems - Receives the problems.
 * @param context.position - The FC's position.
 * @returns The heading in degrees.
 */
function readHeading(operation: JsonObject, context: { readonly where: string; readonly problems: string[]; readonly position: SceneVector }): number {
  const { where, problems, position } = context;
  let heading = 0;
  if (operation['heading'] != null && operation['facing'] != null) {
    problems.push(`${where}: give heading or facing, not both`);
  } else if (operation['heading'] != null) {
    heading = readNumber(operation['heading'], `${where}.heading`, problems);
  } else if (operation['facing'] != null) {
    const facing = readVector(operation['facing'], `${where}.facing`, problems);
    const dx = facing[0] - position[0];
    const dz = facing[2] - position[2];
    if (dx === 0 && dz === 0) problems.push(`${where}.facing is straight above or below the position; give a point off to the side, or a heading`);
    else heading = (Math.atan2(dx, dz) * 180) / Math.PI;
  }
  return heading;
}

/**
 * The draft's ship ids and positions and its fleet ids, tolerating malformed values (normalizeScene reports them):
 * a ship without a valid position counts at the origin, as normalizing defaults it.
 *
 * @param draft - The document mid-edit.
 * @returns What the scene already holds.
 */
function readExisting(draft: JsonObject): { readonly ships: Map<string, SceneVector>; readonly objects: Set<string>; readonly fleets: Set<string> } {
  const ships = new Map<string, SceneVector>();
  for (const ship of Array.isArray(draft['ships']) ? draft['ships'] : []) {
    if (!isPlainObject(ship) || typeof ship['id'] !== 'string') continue;
    ships.set(ship['id'], ship['position'] === undefined ? [0, 0, 0] : readVector(ship['position'], 'position', []));
  }
  const objects = new Set<string>();
  for (const object of Array.isArray(draft['objects']) ? draft['objects'] : []) {
    if (isPlainObject(object) && typeof object['id'] === 'string') objects.add(object['id']);
  }
  const fleets = new Set<string>();
  for (const fleet of Array.isArray(draft['fleets']) ? draft['fleets'] : []) {
    if (isPlainObject(fleet) && typeof fleet['id'] === 'string') fleets.add(fleet['id']);
  }
  return { ships, objects, fleets };
}
