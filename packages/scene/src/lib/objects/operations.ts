import type { Maybe } from '@dereekb/util';
import { DNA_PATTERN, isPlainObject, type JsonObject, readId, readNumber, readShipType, readString, readVector, reportUnknownKeys } from '../json';
import { largeSceneWarning } from '../extent';
import type { FleetOperationContext } from '../fleets/operations';
import { removeCalledTarget } from '../fleets/targets';
import { removeTimelineReferences } from '../timeline/prune';
import type { SceneVector } from '../scene';
import { readStagingDraft, type StagingDraft, stagingTakenIds } from '../staging/draft';
import { readFacing, readStagingNear, readStagingPrefix, readStagingRadii, resolveStagingNear, stagingNearReference, type StagingReadContext } from '../staging/add-ships';
import { DEFAULT_SHIP_FORMATION, defaultShipSpacing, layoutShipFormation, readShipFormation, toFormationWorld } from '../staging/formations';
import { headingToward, normalizeHeading } from '../staging/placement';
import { numberShipIds, readPositiveMetres, toIdSlug } from '../staging/ships';
import { DEFAULT_OBJECT_RADIUS, MAX_OBJECTS_PER_OPERATION, type SceneObject } from './object';

/**
 * The patch operations on the document's objects.
 */
export const OBJECT_OPERATIONS: ReadonlySet<string> = new Set(['add_object', 'add_objects', 'update_object', 'move_object', 'remove_object']);

/**
 * How many examples an overlap warning names.
 */
const OVERLAP_EXAMPLES = 3;

const ADD_OBJECTS_KEYS = new Set<string>(['op', 'dna', 'type', 'radius', 'name', 'id', 'prefix', 'count', 'formation', 'spacing', 'position', 'near', 'heading', 'facing', 'rotation', 'radii']);
const MOVE_OBJECT_KEYS = new Set<string>(['op', 'id', 'position', 'near', 'heading', 'facing', 'rotation', 'radii']);
const UPDATE_OBJECT_CLEARABLE = ['type', 'name', 'radius'] as const;

/**
 * Applies one object operation (see OBJECT_OPERATIONS) to a draft. Pure and synchronous: the add_objects tool resolves
 * type names to dna and radius, and celestials to positions, first.
 *
 * Operations:
 *   { op: "add_object", object }   one document object as given
 *   { op: "add_objects", dna, type?, radius?, name?, id?, prefix?, count?, formation?, spacing?,
 *     position? | near?: { ship | object, range?, direction? }, heading? | facing? | rotation?, radii? }
 *                                       count objects of one type in a formation, the lead at the place
 *   { op: "update_object", id, set: { dna?, type?, name?, position?, rotation?, radius? } }   null clears type, name
 *                                       and radius
 *   { op: "move_object", id, position? | near?, heading? | facing? | rotation? }   what is not given is kept
 *   { op: "remove_object", id }   also clears camera.target when it named the object, and takes it off every fleet's,
 *                                  wing's and squad's called targets
 *
 * @param operation - The operation, with its "op".
 * @param context - The draft and where problems and warnings go.
 */
export function applyObjectOperation(operation: JsonObject, context: FleetOperationContext): void {
  const { draft, where, problems } = context;
  const objects = draftObjects(draft);
  switch (operation['op']) {
    case 'add_object': {
      const object = operation['object'];
      if (!isPlainObject(object)) problems.push(`${where}.object must be an object`);
      else if (objects.some((candidate) => isPlainObject(candidate) && candidate['id'] === object['id'])) problems.push(`${where}: object "${String(object['id'])}" already exists`);
      else if (draftShipIds(draft).has(String(object['id']))) problems.push(`${where}: "${String(object['id'])}" is a ship's id; ids are unique across ships and objects`);
      else objects.push(structuredClone(object));
      break;
    }
    case 'add_objects':
      applyAddObjects(operation, context);
      break;
    case 'update_object': {
      const object = findObject(objects, operation['id']);
      const set = operation['set'];
      if (!object) problems.push(`${where}: no object "${String(operation['id'])}"`);
      else if (!isPlainObject(set)) problems.push(`${where}.set must be an object`);
      else if ('id' in set) problems.push(`${where}: an object's id cannot be changed; remove and add it instead`);
      else {
        Object.assign(object, structuredClone(set));
        for (const key of UPDATE_OBJECT_CLEARABLE) if (set[key] === null) delete object[key];
        const position = set['position'];
        if (position != null) warnLarge([readVector(position, `${where}.set.position`, [])], context);
      }
      break;
    }
    case 'move_object':
      applyMoveObject(operation, context);
      break;
    case 'remove_object': {
      const index = objects.findIndex((object) => isPlainObject(object) && object['id'] === operation['id']);
      if (index < 0) {
        problems.push(`${where}: no object "${String(operation['id'])}"`);
      } else {
        objects.splice(index, 1);
        const camera = draft['camera'];
        if (isPlainObject(camera) && camera['target'] === operation['id']) camera['target'] = null;
        removeCalledTarget(String(operation['id']), context);
        removeTimelineReferences({ objects: [String(operation['id'])] }, context);
      }
      break;
    }
    default:
      problems.push(`${where}: unknown op "${String(operation['op'])}"`);
  }
}

export interface ObjectPlaceInput {
  readonly read: StagingReadContext;
  readonly radii: ReadonlyMap<string, number>;
  /**
   * The placed object's own radius (0 when unknown): `near` ranges are surface to surface.
   */
  readonly leadRadius: number;
  /**
   * Where `facing` turns from when neither position nor near is given: a moved object's current position.
   */
  readonly current?: SceneVector;
}

export interface ObjectPlace {
  /**
   * Null when neither position nor near was given.
   */
  readonly position: Maybe<SceneVector>;
  /**
   * Null when no rotation, heading, facing or near was given.
   */
  readonly rotation: Maybe<SceneVector>;
}

/**
 * Reads an object's place and rotation: `position` or `near` (a ship or object; a celestial is refused with the tool
 * hint), then `rotation`, `heading` (a yaw) or `facing` (a point, or a ship or object id; yaw only), else the near
 * reference's yaw.
 *
 * @param operation - The operation.
 * @param input - The read context, the radii and the object's own radius.
 * @returns The place, or null on a problem.
 */
export function readObjectPlace(operation: JsonObject, input: ObjectPlaceInput): Maybe<ObjectPlace> {
  const { read, radii, leadRadius, current = [0, 0, 0] } = input;
  const { where, draft, problems } = read;
  const before = problems.length;
  let position: Maybe<SceneVector> = null;
  let rotation: Maybe<SceneVector> = null;
  if (operation['position'] != null && operation['near'] != null) problems.push(`${where}: give position or near, not both`);
  else if (operation['position'] != null) position = readVector(operation['position'], `${where}.position`, problems);
  else if (operation['near'] != null) {
    const near = readStagingNear(operation['near'], { ...read, where: `${where}.near` });
    const resolved = near ? resolveStagingNear(near, { draft, radii, leadRadius, where: `${where}.near`, problems }) : null;
    if (near && resolved) {
      position = resolved.point;
      const reference = stagingNearReference(near, draft);
      rotation = [normalizeHeading(reference?.rotation[0] ?? 0), 0, 0];
    }
  }

  const turns = ['rotation', 'heading', 'facing'].filter((key) => operation[key] != null);
  if (turns.length > 1) problems.push(`${where}: give one of ${turns.join(', ')}, not several`);
  else if (operation['rotation'] != null) rotation = readVector(operation['rotation'], `${where}.rotation`, problems);
  else if (operation['heading'] != null) rotation = [normalizeHeading(readNumber(operation['heading'], `${where}.heading`, problems)), 0, 0];
  else if (operation['facing'] != null && problems.length === before) {
    const target = readFacing(operation['facing'], { where: `${where}.facing`, draft, problems, tool: read.tool });
    const from = position ?? current;
    const toward = target ? headingToward(from, target) : null;
    if (target && toward == null) problems.push(`${where}.facing is straight above or below the object; give a point off to the side, or a heading`);
    else if (toward != null) rotation = [toward, 0, 0];
  }
  return problems.length > before ? null : { position, rotation };
}

function applyAddObjects(operation: JsonObject, context: FleetOperationContext): void {
  const { draft: document, where, problems, warnings } = context;
  const before = problems.length;
  reportUnknownKeys(operation, ADD_OBJECTS_KEYS, where, warnings);
  const draft = readStagingDraft(document);
  const type = operation['type'] == null ? null : readShipType(operation['type'], `${where}.type`, problems);
  let dna = '';
  if (operation['dna'] == null) {
    const named = type == null ? '' : ` ${JSON.stringify(type)}`;
    problems.push(`${where}: type${named} has no dna. The add_objects tool resolves type names to DNA through tools-core; patch_scene needs dna.`);
  } else {
    dna = readString(operation['dna'], `${where}.dna`, problems);
    if (dna && !DNA_PATTERN.test(dna)) problems.push(`${where}.dna "${dna}" is not hull:faction:race[:commands]`);
  }
  const radius = operation['radius'] == null ? null : readPositiveMetres(operation['radius'], `${where}.radius`, problems);
  const name = operation['name'] == null ? null : readString(operation['name'], `${where}.name`, problems) || null;
  const id = operation['id'] == null ? null : readId(operation['id'], `${where}.id`, problems) || null;
  const prefix = readStagingPrefix(operation['prefix'], `${where}.prefix`, problems);
  const count = operation['count'] == null ? 1 : readNumber(operation['count'], `${where}.count`, problems, { min: 1, max: MAX_OBJECTS_PER_OPERATION });
  if (!Number.isInteger(count)) problems.push(`${where}.count must be a whole number from 1 to ${MAX_OBJECTS_PER_OPERATION}`);
  if (id && count > 1) problems.push(`${where}: id names one object; drop id or count (prefix numbers several)`);
  if (id && draft.ships.has(id)) problems.push(`${where}.id "${id}" is a ship's id; ids are unique across ships and objects`);
  else if (id && draft.objects.has(id)) problems.push(`${where}.id: object "${id}" already exists`);
  const formation = operation['formation'] == null ? DEFAULT_SHIP_FORMATION : readShipFormation(operation['formation'], `${where}.formation`, problems);
  const spacing = operation['spacing'] == null ? null : readPositiveMetres(operation['spacing'], `${where}.spacing`, problems);
  const radii = readStagingRadii(operation['radii'], `${where}.radii`, problems);
  const place = readObjectPlace(operation, { read: { where, tool: 'add_objects', draft, problems, warnings }, radii, leadRadius: radius ?? 0 });
  if (problems.length > before || !place) return;
  if (spacing != null && radius != null && count > 1 && spacing < 2 * radius) warnings.push(`${where}: spacing ${spacing} m is under two radii (${2 * radius} m), so the objects overlap`);

  const position = place.position ?? [0, 0, 0];
  const rotation = place.rotation ?? [0, 0, 0];
  const offsets = layoutShipFormation({ formation, count, spacing: spacing ?? defaultShipSpacing(radius ?? DEFAULT_OBJECT_RADIUS) });
  const positions = toFormationWorld({ offsets, position, heading: rotation[0] });
  const hull = dna.split(':')[0] || 'object';
  const typeName = typeof type === 'string' ? type : null;
  const slug = prefix ?? toIdSlug(name ?? typeName ?? hull, 'object');
  const numbered = id ? { ids: [id], numbers: [1] } : numberShipIds({ prefix: slug, count, ids: stagingTakenIds(draft), where, problems });
  if (problems.length > before) return;
  let label = name ?? typeName ?? hull;
  if (name == null && typeName == null && typeof type === 'number') label = `type ${type}`;

  const added = numbered.ids.map((objectId, index): SceneObject => ({
    id: objectId,
    dna,
    ...(type == null ? {} : { type }),
    name: id ? label : `${label} ${numbered.numbers[index]}`,
    position: positions[index],
    rotation: [...rotation],
    ...(radius == null ? {} : { radius })
  }));
  draftObjects(document).push(...structuredClone(added));
  if (radius == null) warnings.push(`${where}: no radius; the page uses the SOF bounding radius once built (spacing assumed ${DEFAULT_OBJECT_RADIUS} m). The add_objects tool fills it from a type`);
  warnOverlaps(added, draft, context);
  warnLarge(
    added.map((object) => object.position),
    context
  );
}

function applyMoveObject(operation: JsonObject, context: FleetOperationContext): void {
  const { draft: document, where, problems, warnings } = context;
  const object = findObject(draftObjects(document), operation['id']);
  if (!object) {
    problems.push(`${where}: no object "${String(operation['id'])}"`);
    return;
  }
  reportUnknownKeys(operation, MOVE_OBJECT_KEYS, where, warnings);
  if (!['position', 'near', 'heading', 'facing', 'rotation'].some((key) => operation[key] != null)) {
    problems.push(`${where}: give position or near, and/or rotation, heading or facing`);
    return;
  }
  const draft = readStagingDraft(document);
  const placed = draft.objects.get(String(object['id']));
  if (isPlainObject(operation['near']) && operation['near']['object'] === object['id']) {
    problems.push(`${where}.near.object: an object cannot be placed off itself`);
    return;
  }
  const radii = readStagingRadii(operation['radii'], `${where}.radii`, problems);
  const before = problems.length;
  const place = readObjectPlace(operation, { read: { where, tool: 'add_objects', draft, problems, warnings }, radii, leadRadius: placed?.radius ?? 0, current: placed?.position });
  if (!place || problems.length > before) return;
  if (place.position) {
    object['position'] = place.position;
    warnLarge([place.position], context);
  }
  // A near reference's yaw is only the default for a new object: a move keeps its rotation unless one is given.
  const turned = ['rotation', 'heading', 'facing'].some((key) => operation[key] != null);
  if (turned && place.rotation) object['rotation'] = place.rotation;
}

function warnOverlaps(added: readonly SceneObject[], draft: StagingDraft, context: FleetOperationContext): void {
  const { where, warnings } = context;
  for (const object of added) {
    const reach = object.radius ?? DEFAULT_OBJECT_RADIUS;
    const ships = [...draft.ships].filter(([, ship]) => distance(ship.position, object.position) < reach).map(([id]) => id);
    const others = [...draft.objects].filter(([, other]) => distance(other.position, object.position) < reach + (other.radius ?? DEFAULT_OBJECT_RADIUS)).map(([id]) => id);
    const named = (ids: readonly string[]): string =>
      ids
        .slice(0, OVERLAP_EXAMPLES)
        .map((id) => `"${id}"`)
        .join(', ') + (ids.length > OVERLAP_EXAMPLES ? ', ...' : '');
    const parts = [ships.length ? `ships ${named(ships)}` : '', others.length ? `objects ${named(others)}` : ''].filter(Boolean);
    if (parts.length) warnings.push(`${where}: ${object.id} overlaps ${parts.join(' and ')} (inside its ${Math.round(reach).toLocaleString('en-US')} m radius); place it elsewhere`);
  }
}

function warnLarge(positions: readonly SceneVector[], context: FleetOperationContext): void {
  const warning = largeSceneWarning({ positions, noun: 'object', where: context.where });
  if (warning) context.warnings.push(warning);
}

function distance(a: SceneVector, b: SceneVector): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function draftObjects(draft: JsonObject): unknown[] {
  if (!Array.isArray(draft['objects'])) draft['objects'] = [];
  return draft['objects'] as unknown[];
}

function draftShipIds(draft: JsonObject): Set<string> {
  return new Set((Array.isArray(draft['ships']) ? draft['ships'] : []).flatMap((ship) => (isPlainObject(ship) && typeof ship['id'] === 'string' ? [ship['id']] : [])));
}

function findObject(objects: readonly unknown[], id: unknown): Maybe<JsonObject> {
  return objects.find((object): object is JsonObject => isPlainObject(object) && object['id'] === id) ?? null;
}
