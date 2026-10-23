import type { Maybe } from '@dereekb/util';
import { isPlainObject, type JsonObject, readId, readString, reportUnknownKeys } from '../json';
import { largeSceneWarning } from '../extent';
import type { FleetOperationContext } from '../fleets/operations';
import { readObjectPlace } from '../objects/operations';
import type { SceneVector } from '../scene';
import { readStagingDraft, type StagingDraft, stagingTakenIds } from '../staging/draft';
import { readStagingPrefix, readStagingRadii } from '../staging/add-ships';
import { numberShipIds, readPositiveMetres, toIdSlug } from '../staging/ships';
import { expandAsteroidField } from './expand';
import { DEFAULT_FIELD_RADIUS, normalizeAsteroidField, type SceneAsteroidField } from './field';

/**
 * The patch operations on the document's asteroid fields.
 */
export const ASTEROID_FIELD_OPERATIONS: ReadonlySet<string> = new Set(['add_asteroid_field', 'update_asteroid_field', 'remove_asteroid_field']);

/**
 * The field keys add_asteroid_field passes through as given.
 */
const FIELD_VALUE_KEYS = ['shape', 'radius', 'innerRadius', 'thickness', 'arc', 'count', 'size', 'seed'] as const;

const ADD_FIELD_KEYS = new Set<string>(['op', 'id', 'prefix', 'name', 'ores', ...FIELD_VALUE_KEYS, 'position', 'near', 'rotation', 'heading', 'facing', 'radii']);
const UPDATE_FIELD_KEYS = new Set<string>(['name', 'ores', ...FIELD_VALUE_KEYS, 'position', 'rotation']);
const UPDATE_FIELD_CLEARABLE = ['name', 'innerRadius', 'thickness', 'arc'] as const;

/**
 * The keys whose change re-places a field's rocks (not position, rotation or name).
 */
const GEOMETRY_KEYS = new Set<string>(['ores', ...FIELD_VALUE_KEYS]);

/**
 * How many examples a ships-inside warning names.
 */
const INSIDE_EXAMPLES = 3;

/**
 * Applies one asteroid field operation (see ASTEROID_FIELD_OPERATIONS) to a draft. Pure and synchronous: the
 * add_asteroid_field tool resolves ore names to rock DNAs, and celestials to positions, first.
 *
 * Operations:
 *   { op: "add_asteroid_field", ores, id?, prefix?, name?, shape?, radius?, innerRadius?, thickness?, arc?, count?,
 *     size?, seed?, position? | near?: { ship | object, range?, direction? }, rotation? | heading? | facing?, radii? }
 *                                       every ore needs rocks; near's range runs from the reference's surface to the
 *                                       field's edge
 *   { op: "update_asteroid_field", id, set: { name?, ores?, shape?, radius?, innerRadius?, thickness?, arc?, count?,
 *     size?, seed?, position?, rotation? } }   ores is replaced whole; null clears name, innerRadius, thickness and arc
 *   { op: "remove_asteroid_field", id }   also clears camera.target when it named the field
 *
 * @param operation - The operation, with its "op".
 * @param context - The draft and where problems and warnings go.
 */
export function applyAsteroidFieldOperation(operation: JsonObject, context: FleetOperationContext): void {
  const { draft, where, problems } = context;
  const fields = draftFields(draft);
  switch (operation['op']) {
    case 'add_asteroid_field':
      applyAddAsteroidField(operation, context);
      break;
    case 'update_asteroid_field': {
      const field = findField(fields, operation['id']);
      const set = operation['set'];
      if (!field) problems.push(`${where}: no asteroid field "${String(operation['id'])}"`);
      else if (!isPlainObject(set)) problems.push(`${where}.set must be an object`);
      else if ('id' in set) problems.push(`${where}: an asteroid field's id cannot be changed; remove and add it instead`);
      else {
        reportUnknownKeys(set, UPDATE_FIELD_KEYS, `${where}.set`, context.warnings);
        const known = Object.fromEntries(Object.entries(set).filter(([key]) => UPDATE_FIELD_KEYS.has(key)));
        Object.assign(field, structuredClone(known));
        for (const key of UPDATE_FIELD_CLEARABLE) if (set[key] === null) delete field[key];
        if (Object.keys(known).some((key) => GEOMETRY_KEYS.has(key) || key === 'position')) warnField(field, context);
      }
      break;
    }
    case 'remove_asteroid_field': {
      const index = fields.findIndex((field) => isPlainObject(field) && field['id'] === operation['id']);
      if (index < 0) {
        problems.push(`${where}: no asteroid field "${String(operation['id'])}"`);
      } else {
        fields.splice(index, 1);
        const camera = draft['camera'];
        if (isPlainObject(camera) && camera['target'] === operation['id']) camera['target'] = null;
      }
      break;
    }
    default:
      problems.push(`${where}: unknown op "${String(operation['op'])}"`);
  }
}

function applyAddAsteroidField(operation: JsonObject, context: FleetOperationContext): void {
  const { draft: document, where, problems, warnings } = context;
  const before = problems.length;
  reportUnknownKeys(operation, ADD_FIELD_KEYS, where, warnings);
  const draft = readStagingDraft(document);
  const ores = operation['ores'];
  if (Array.isArray(ores)) {
    for (const [index, ore] of ores.entries()) {
      if (isPlainObject(ore) && ore['rocks'] == null) {
        const named = typeof ore['ore'] === 'string' ? ` "${ore['ore']}"` : '';
        problems.push(`${where}.ores[${index}]${named} has no rocks. The add_asteroid_field tool resolves ore names to SOF rock models through tools-core; patch_scene needs rocks`);
      } else if (typeof ore === 'string') {
        problems.push(`${where}.ores[${index}] "${ore}" has no rocks. The add_asteroid_field tool resolves ore names to SOF rock models through tools-core; patch_scene needs { rocks }`);
      }
    }
  }
  const name = operation['name'] == null ? null : readString(operation['name'], `${where}.name`, problems) || null;
  const id = operation['id'] == null ? null : readId(operation['id'], `${where}.id`, problems) || null;
  const prefix = readStagingPrefix(operation['prefix'], `${where}.prefix`, problems);
  if (id && (draft.ships.has(id) || draft.objects.has(id))) problems.push(`${where}.id "${id}" is a ship's or object's id; ids are unique across ships, objects and asteroid fields`);
  else if (id && draft.fields.has(id)) problems.push(`${where}.id: asteroid field "${id}" already exists`);
  const radius = operation['radius'] == null ? DEFAULT_FIELD_RADIUS : (readPositiveMetres(operation['radius'], `${where}.radius`, problems) ?? DEFAULT_FIELD_RADIUS);
  const radii = readStagingRadii(operation['radii'], `${where}.radii`, problems);
  const place = readObjectPlace(operation, { read: { where, tool: 'add_asteroid_field', draft, problems, warnings }, radii, leadRadius: radius });
  if (problems.length > before || !place) return;

  const firstOre = Array.isArray(ores) && isPlainObject(ores[0]) && typeof ores[0]['ore'] === 'string' ? ores[0]['ore'] : null;
  const slug = prefix ?? toIdSlug(name ?? firstOre ?? 'asteroid-field', 'asteroid-field');
  const fieldId = id ?? numberShipIds({ prefix: slug, count: 1, ids: stagingTakenIds(draft), where, problems }).ids[0];
  if (problems.length > before || !fieldId) return;

  const field: JsonObject = { id: fieldId, name: name ?? defaultFieldName(Array.isArray(ores) ? ores : []), position: place.position ?? [0, 0, 0], rotation: place.rotation ?? [0, 0, 0] };
  for (const key of FIELD_VALUE_KEYS) if (operation[key] != null) field[key] = structuredClone(operation[key]);
  field['ores'] = structuredClone(ores ?? null);
  draftFields(document).push(field);
  warnField(field, context);
}

/**
 * The default name: "<ore A>, <ore B> and <ore C> field" from the ores' names, else "Asteroid field".
 *
 * @param ores - The op's ores.
 * @returns The name.
 */
function defaultFieldName(ores: readonly unknown[]): string {
  const names = [...new Set(ores.flatMap((ore) => (isPlainObject(ore) && typeof ore['ore'] === 'string' && ore['ore'] ? [ore['ore']] : [])))];
  let list = names.join(', ');
  if (names.length > 1) list = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return names.length ? `${list} field` : 'Asteroid field';
}

/**
 * The add and update warnings: a far centre, ships or objects inside the field, rocks too big for it, and a placement
 * shortfall. A field normalizeScene will refuse warns nothing here.
 */
function warnField(input: JsonObject, context: FleetOperationContext): void {
  const { where, warnings } = context;
  const problems: string[] = [];
  const field = normalizeAsteroidField(input, where, problems, []);
  if (!field || problems.length) return;
  const far = largeSceneWarning({ positions: [field.position], noun: 'asteroid field', where });
  if (far) warnings.push(far);
  if (field.size[1] > field.radius / 4) warnings.push(`${where}: the largest rock (${field.size[1]} m) is over a quarter of the field radius (${field.radius} m); the field will look like a few boulders`);
  const expansion = expandAsteroidField(field);
  if (expansion.placed < expansion.requested) {
    warnings.push(`${where}: placed ${expansion.placed.toLocaleString('en-US')} of ${expansion.requested.toLocaleString('en-US')} rocks without overlap; widen the field, shrink size or lower count`);
  }
  warnInside(field, expansion.envelope, readStagingDraft(context.draft), context);
}

function warnInside(field: SceneAsteroidField, envelope: number, draft: StagingDraft, context: FleetOperationContext): void {
  const inside = (position: SceneVector): boolean => distance(position, field.position) < envelope;
  const ships = [...draft.ships].filter(([, ship]) => inside(ship.position)).map(([id]) => id);
  const objects = [...draft.objects].filter(([, object]) => inside(object.position)).map(([id]) => id);
  const named = (ids: readonly string[]): string =>
    ids
      .slice(0, INSIDE_EXAMPLES)
      .map((id) => `"${id}"`)
      .join(', ') + (ids.length > INSIDE_EXAMPLES ? ', ...' : '');
  const parts = [ships.length ? `ships ${named(ships)}` : '', objects.length ? `objects ${named(objects)}` : ''].filter(Boolean);
  if (parts.length) context.warnings.push(`${context.where}: ${parts.join(' and ')} sit inside asteroid field "${field.id}" (${Math.round(envelope / 1000).toLocaleString('en-US')} km); its rocks draw through them`);
}

function distance(a: SceneVector, b: SceneVector): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function draftFields(draft: JsonObject): unknown[] {
  if (!Array.isArray(draft['asteroidFields'])) draft['asteroidFields'] = [];
  return draft['asteroidFields'] as unknown[];
}

function findField(fields: readonly unknown[], id: unknown): Maybe<JsonObject> {
  return fields.find((field): field is JsonObject => isPlainObject(field) && field['id'] === id) ?? null;
}
