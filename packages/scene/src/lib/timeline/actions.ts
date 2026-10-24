/**
 * The cue actions: one registry entry per lever. Each entry reads the tool's arguments with that tool's own normalizer,
 * lists the ids they name (references, checked against the scene as it will be when the cue fires, and used to prune
 * a cue when what it names is removed), and may advise on what live state could still refuse. A new lever is one entry.
 */

import type { Maybe } from '@dereekb/util';
import { ID_PATTERN, isPlainObject, type JsonObject } from '../json';
import { normalizeShipOrderRequest } from '../orders';
import { isFleetStructureOrder, normalizeFleetOrderRequest, resolveFleetOrderRequest, type FleetOrderRequest } from '../fleets/orders';
import { normalizePropModSwitch } from '../prop-mods/switch';
import { normalizeModuleSwitch } from '../fitting/switch';
import { normalizeTargetCommand } from '../weapons/target';
import { normalizeCeaseFireCommand, normalizeEngageCommand } from '../combat/commands';
import { normalizeAutoRepairCommand } from '../logi/auto-repair';
import { cameraPathAnchors, cameraShotSubjects, type CameraShot, normalizeCameraSequence, normalizeCameraShot } from '../cinema/shot';
import { autoCameraReferences, normalizeAutoCameraCommand, type AutoCameraCommand } from '../cinema/director/command';
import type { FleetSelection } from '../fleets/selection';
import { type SceneDocument, SceneError } from '../scene';
import { MAX_CUE_OPERATIONS, TIMELINE_ACTION_NAMES, TIMELINE_OPERATION_NAMES, type TimelineActionKind, type TimelineActionName } from './timeline';

/**
 * What a referenced id must be when the cue fires:
 *
 * - `ship`: a ship id; `object`: an object id; `target`: a ship or object id.
 * - `place`: a movement or warp target: a ship or object id, `celestial:<id>`, or else a name resolved when the cue
 *   fires (a warning, not a problem).
 * - `fleet`, `wing`, `squad` (the last two within `fleet`); `team`: a team some ship is on.
 */
export const CUE_REFERENCE_KINDS = ['ship', 'object', 'target', 'place', 'fleet', 'wing', 'squad', 'team'] as const;

export type CueReferenceKind = (typeof CUE_REFERENCE_KINDS)[number];

export interface CueReference {
  readonly kind: CueReferenceKind;
  readonly id: string;
  /**
   * The fleet a wing or squad is in.
   */
  readonly fleet?: string;
  /**
   * Where it sits in the action's arguments, for messages: `order.target`, `ships[1]`.
   */
  readonly path: string;
  /**
   * A list entry (a `ships` selection, a targets order's queue, set or drop): a removal drops the entry, not the cue.
   */
  readonly entry?: boolean;
}

export interface ReadCueAction {
  readonly args: Maybe<JsonObject>;
  readonly problems: string[];
  readonly warnings: string[];
}

export interface TimelineActionEntry {
  readonly name: TimelineActionName;
  /**
   * What the action touches when it fires.
   */
  readonly kind: (args: JsonObject) => TimelineActionKind;
  /**
   * Validates the tool's arguments as the tool does, without the scene: the value to store (normalized, or as written
   * for camera shots and patches).
   */
  readonly read: (input: unknown, where: string) => ReadCueAction;
  /**
   * The ids the stored value names.
   */
  readonly references: (args: JsonObject) => CueReference[];
  /**
   * Warnings about what may still refuse it when it fires, given the scene as it will be then.
   */
  readonly advise?: (args: JsonObject, scene: SceneDocument) => string[];
}

/**
 * The ids a scene holds, for checking references: the scene as projected to a cue's time.
 */
export interface TimelineScope {
  readonly scene: SceneDocument;
  readonly ships: ReadonlySet<string>;
  readonly objects: ReadonlySet<string>;
  /**
   * Each fleet's wing and squad ids.
   */
  readonly fleets: ReadonlyMap<string, { readonly wings: ReadonlySet<string>; readonly squads: ReadonlySet<string> }>;
  readonly teams: ReadonlySet<string>;
}

/**
 * The ids a scene holds.
 *
 * @param scene - A normalized document.
 * @returns Its ship, object, fleet (with wings and squads) and team ids.
 */
export function toTimelineScope(scene: SceneDocument): TimelineScope {
  const fleets = new Map<string, { wings: Set<string>; squads: Set<string> }>();
  for (const fleet of scene.fleets ?? []) {
    fleets.set(fleet.id, { wings: new Set(fleet.wings.map((wing) => wing.id)), squads: new Set(fleet.wings.flatMap((wing) => wing.squads.map((squad) => squad.id))) });
  }
  return {
    scene,
    ships: new Set(scene.ships.map((ship) => ship.id)),
    objects: new Set((scene.objects ?? []).map((object) => object.id)),
    fleets,
    teams: new Set(scene.ships.flatMap((ship) => (ship.team ? [ship.team] : [])))
  };
}

const CELESTIAL_ID_PATTERN = /^celestial:\d+$/u;

/**
 * Checks references against a scope: an unknown ship, object, fleet, wing, squad or team is a problem; a place that is
 * no id is a name resolved when the cue fires (a warning).
 *
 * @param references - The action's references.
 * @param scope - The ids known when the cue fires.
 * @param where - The action's message prefix.
 * @returns The problems and warnings.
 */
export function checkCueReferences(references: readonly CueReference[], scope: TimelineScope, where: string): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const isTarget = (id: string): boolean => scope.ships.has(id) || scope.objects.has(id);
  for (const reference of references) {
    const { kind, id, path } = reference;
    const at = `${where}.${path}`;
    const fleet = reference.fleet == null ? null : scope.fleets.get(reference.fleet);
    if (kind === 'ship' && !scope.ships.has(id)) problems.push(`${at}: no ship "${id}"`);
    else if (kind === 'object' && !scope.objects.has(id)) problems.push(`${at}: no object "${id}"`);
    else if (kind === 'target' && !isTarget(id)) problems.push(`${at} "${id}" is not a ship or object in the scene`);
    else if (kind === 'place' && !isTarget(id) && !CELESTIAL_ID_PATTERN.test(id)) warnings.push(`${at} "${id}" is no ship or object id: it is resolved as a name when the cue fires`);
    else if (kind === 'fleet' && !scope.fleets.has(id)) problems.push(`${at}: no fleet "${id}"`);
    else if (kind === 'wing' && fleet && !fleet.wings.has(id)) problems.push(`${at}: no wing "${id}" in fleet "${reference.fleet}"`);
    else if (kind === 'squad' && fleet && !fleet.squads.has(id)) problems.push(`${at}: no squad "${id}" in fleet "${reference.fleet}"`);
    else if (kind === 'team' && !scope.teams.has(id)) problems.push(`${at}: no ship is on team "${id}"`);
  }
  return { problems, warnings };
}

function readWith(read: () => unknown): ReadCueAction {
  let args: Maybe<JsonObject> = null;
  const problems: string[] = [];
  try {
    args = read() as JsonObject;
  } catch (error) {
    if (!(error instanceof SceneError)) throw error;
    problems.push(...error.problems);
  }
  return { args, problems, warnings: [] };
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function selectionReferences(args: FleetSelection | JsonObject): CueReference[] {
  const { ships, fleet, wing, squad } = args as JsonObject;
  const references: CueReference[] = stringsOf(ships).map((id, index) => ({ kind: 'ship', id, path: `ships[${index}]`, entry: true }));
  if (typeof fleet === 'string') {
    references.push({ kind: 'fleet', id: fleet, path: 'fleet' });
    if (typeof wing === 'string') references.push({ kind: 'wing', id: wing, fleet, path: 'wing' });
    if (typeof squad === 'string') references.push({ kind: 'squad', id: squad, fleet, path: 'squad' });
  }
  return references;
}

function targetReference(value: unknown, kind: CueReferenceKind, path: string): CueReference[] {
  return typeof value === 'string' && value ? [{ kind, id: value, path }] : [];
}

/**
 * The ids an order names. A stance's `on` names a ship, or a squad or wing of `fleet` (order_fleet's; order_ship's
 * group is the ship's fleet when the cue fires, unchecked here).
 */
function orderReferences(order: unknown, fleet?: unknown): CueReference[] {
  if (!isPlainObject(order)) return [];
  const references = targetReference(order['target'], 'place', 'order.target');
  const stance = order['type'] === 'stance' && isPlainObject(order['set']) ? order['set'] : null;
  const on = stance?.['on'];
  if (typeof on === 'string' && on !== 'focus') references.push(...targetReference(on, 'ship', 'order.set.on'));
  else if (isPlainObject(on) && typeof fleet === 'string') {
    if (typeof on['squad'] === 'string') references.push({ kind: 'squad', id: on['squad'], fleet, path: 'order.set.on.squad' });
    if (typeof on['wing'] === 'string') references.push({ kind: 'wing', id: on['wing'], fleet, path: 'order.set.on.wing' });
  }
  if (order['type'] === 'anchor' || order['type'] === 'break-off') references.push(...targetReference(order['ship'], 'ship', 'order.ship'));
  if (order['type'] === 'targets') {
    references.push(...targetReference(order['primary'], 'target', 'order.primary'));
    for (const key of ['queue', 'set', 'drop']) references.push(...stringsOf(order[key]).map((id, index): CueReference => ({ kind: 'target', id, path: `order.${key}[${index}]`, entry: true })));
  }
  return references;
}

function shotReferences(shot: Maybe<CameraShot>, prefix: string): CueReference[] {
  const references: CueReference[] = [];
  const ref = shot?.hardpoint;
  if (ref) {
    references.push(...targetReference(ref.ship, 'ship', `${prefix}ship`), ...targetReference(ref.object, 'object', `${prefix}object`), ...targetReference(ref.target, 'target', `${prefix}target`));
    references.push(...(ref.ships ?? []).map((id, index): CueReference => ({ kind: 'ship', id, path: `${prefix}ships[${index}]` })));
    if (ref.fleet) {
      references.push({ kind: 'fleet', id: ref.fleet, path: `${prefix}fleet` });
      if (ref.wing) references.push({ kind: 'wing', id: ref.wing, fleet: ref.fleet, path: `${prefix}wing` });
      if (ref.squad) references.push({ kind: 'squad', id: ref.squad, fleet: ref.fleet, path: `${prefix}squad` });
    }
    references.push(...(ref.teams ?? []).map((id, index): CueReference => ({ kind: 'team', id, path: `${prefix}teams[${index}]` })));
  }
  const named = new Set(references.map((reference) => reference.id));
  for (const id of [...cameraShotSubjects(shot), ...cameraPathAnchors(shot)]) {
    if (!named.has(id)) references.push({ kind: 'target', id, path: `${prefix}pose` });
    named.add(id);
  }
  return references;
}

function isLibraryShot(input: unknown): boolean {
  return isPlainObject(input) && input['shot'] != null;
}

const live = (): TimelineActionKind => 'live';
const camera = (): TimelineActionKind => 'camera';
const documentKind = (): TimelineActionKind => 'document';

function selectionEntry(name: TimelineActionName, normalize: (input: unknown, where: string) => unknown, targetKind?: CueReferenceKind): TimelineActionEntry {
  return {
    name,
    kind: live,
    read: (input, where) => readWith(() => normalize(input, where)),
    references: (args) => [...selectionReferences(args), ...(targetKind ? targetReference(args['target'], targetKind, 'target') : [])]
  };
}

const ORDER_SHIP_KEYS = new Set(['id', 'order']);
const STOP_SHOT_KEYS = ['pause', 'adopt', 'cut'];
const REFUSED_CUE_OPERATIONS: ReadonlySet<string> = new Set([...TIMELINE_OPERATION_NAMES, 'set_environment']);

function readOrderShip(input: unknown, where: string): ReadCueAction {
  const problems: string[] = [];
  let args: Maybe<JsonObject> = null;
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object { id, order }`);
  } else {
    for (const key of Object.keys(input)) if (!ORDER_SHIP_KEYS.has(key)) problems.push(`${where}.${key} is not an order_ship field`);
    const id = input['id'];
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) problems.push(`${where}.id must be a ship id`);
    const order = readWith(() => normalizeShipOrderRequest(input['order'], { self: typeof id === 'string' ? id : undefined, where: `${where}.order` }));
    problems.push(...order.problems);
    if (!problems.length) args = { id, order: order.args };
  }
  return { args, problems, warnings: [] };
}

function readStopShot(input: unknown, where: string): ReadCueAction {
  const problems: string[] = [];
  const args: JsonObject = {};
  if (!isPlainObject(input)) problems.push(`${where} must be an object { pause?, adopt?, cut? }`);
  else {
    for (const [key, value] of Object.entries(input)) {
      if (!STOP_SHOT_KEYS.includes(key)) problems.push(`${where}.${key} is not a stop_shot field`);
      else if (typeof value !== 'boolean') problems.push(`${where}.${key} must be true or false`);
      else args[key] = value;
    }
  }
  return { args: problems.length ? null : args, problems, warnings: [] };
}

function readPatch(input: unknown, where: string): ReadCueAction {
  const problems: string[] = [];
  const operations = isPlainObject(input) ? input['operations'] : undefined;
  if (!isPlainObject(input)) problems.push(`${where} must be an object { operations: [...] }`);
  else {
    for (const key of Object.keys(input)) if (key !== 'operations') problems.push(`${where}.${key} is not a patch_scene field`);
    if (!Array.isArray(operations) || !operations.length || operations.length > MAX_CUE_OPERATIONS) problems.push(`${where}.operations must be an array of 1 to ${MAX_CUE_OPERATIONS} operations`);
    else {
      for (const [index, operation] of operations.entries()) {
        const op = isPlainObject(operation) ? operation['op'] : undefined;
        if (typeof op !== 'string') problems.push(`${where}.operations[${index}] must be an object with an "op" string`);
        else if (op === 'set_environment') problems.push(`${where}.operations[${index}]: set_environment reloads the page; it cannot be cued`);
        else if (REFUSED_CUE_OPERATIONS.has(op)) problems.push(`${where}.operations[${index}]: a cue cannot edit the timeline (${op})`);
      }
    }
  }
  return { args: problems.length ? null : { operations: structuredClone(operations) as JsonObject[] }, problems, warnings: [] };
}

function adviseFleetOrder(args: JsonObject, scene: SceneDocument): string[] {
  const warnings: string[] = [];
  try {
    resolveFleetOrderRequest(scene, args as unknown as FleetOrderRequest);
  } catch (error) {
    if (!(error instanceof SceneError)) throw error;
    warnings.push(...error.problems.map((problem) => `may fail when it fires: ${problem}`));
  }
  return warnings;
}

/**
 * The cue actions by name.
 */
export const TIMELINE_ACTIONS: Readonly<Record<TimelineActionName, TimelineActionEntry>> = {
  order_ship: {
    name: 'order_ship',
    kind: live,
    read: readOrderShip,
    references: (args) => [...targetReference(args['id'], 'ship', 'id'), ...orderReferences(args['order'])]
  },
  order_fleet: {
    name: 'order_fleet',
    kind: (args) => (isPlainObject(args['order']) && isFleetStructureOrder(args['order'] as never) ? 'document' : 'live'),
    read: (input, where) => readWith(() => normalizeFleetOrderRequest(input, { where })),
    references: (args) => [...selectionReferences({ fleet: args['fleet'], wing: args['wing'], squad: args['squad'] }), ...targetReference(args['by'], 'ship', 'by'), ...orderReferences(args['order'], args['fleet'])],
    advise: adviseFleetOrder
  },
  switch_prop_mods: selectionEntry('switch_prop_mods', (input, where) => normalizePropModSwitch(input, where)),
  switch_modules: selectionEntry('switch_modules', (input, where) => normalizeModuleSwitch(input, where), 'target'),
  set_target: selectionEntry('set_target', (input, where) => normalizeTargetCommand(input, where), 'target'),
  engage: selectionEntry('engage', (input, where) => normalizeEngageCommand(input, where), 'target'),
  cease_fire: selectionEntry('cease_fire', (input, where) => normalizeCeaseFireCommand(input, where)),
  auto_repair: { ...selectionEntry('auto_repair', (input, where) => normalizeAutoRepairCommand(input, where)), kind: documentKind },
  play_shot: {
    name: 'play_shot',
    kind: camera,
    read: (input, where) => {
      const read = normalizeCameraShot(input, where);
      return { args: read.shot ? (structuredClone(input) as JsonObject) : null, problems: read.problems, warnings: read.warnings };
    },
    references: (args) => shotReferences(normalizeCameraShot(args).shot, isLibraryShot(args) ? '' : 'hardpoint.')
  },
  play_sequence: {
    name: 'play_sequence',
    kind: camera,
    read: (input, where) => {
      const read = normalizeCameraSequence(input, where);
      const shots = isPlainObject(input) ? input['shots'] : input;
      return { args: read.sequence ? { shots: structuredClone(shots) } : null, problems: read.problems, warnings: read.warnings };
    },
    references: (args) => stringsOrObjects(args['shots']).flatMap((shot, index) => shotReferences(normalizeCameraShot(shot).shot, isLibraryShot(shot) ? `shots[${index}].` : `shots[${index}].hardpoint.`))
  },
  stop_shot: { name: 'stop_shot', kind: camera, read: readStopShot, references: () => [] },
  auto_camera: {
    name: 'auto_camera',
    kind: camera,
    read: (input, where) => readWith(() => normalizeAutoCameraCommand(input, where)),
    // The followed fleet or ship is an entry: removing it drops `follow` and keeps the cue.
    references: (args) => autoCameraReferences(args as AutoCameraCommand).map((reference): CueReference => ({ ...reference, ...(reference.kind === 'team' ? {} : { entry: true }) }))
  },
  patch_scene: { name: 'patch_scene', kind: documentKind, read: readPatch, references: () => [] }
};

function stringsOrObjects(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Whether a key names a cue action.
 *
 * @param key - A cue key.
 * @returns True for a lever tool's name.
 */
export function isTimelineActionName(key: string): key is TimelineActionName {
  return (TIMELINE_ACTION_NAMES as readonly string[]).includes(key);
}
