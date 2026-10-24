/**
 * The location dressing's pure half (node-tested; no runtime import): the planet-file height map patch, the `?dress=`
 * switch, the reconcile of what is dressed against what a new plan wants, and get_state's dressing report and overlay
 * row. `location-dressing.ts` draws with them.
 */

import type { Maybe } from '@dereekb/util';
import {
  ALL_LOCATION_DRESSING_PARTS,
  DRESSED_KINDS,
  LOCATION_DRESSING_PARTS,
  type DressedKind,
  type DressedState,
  type LocationDressingCounts,
  type LocationDressingNebulaReport,
  type LocationDressingObjectReport,
  type LocationDressingPart,
  type LocationDressingParts,
  type LocationDressingPlan,
  type LocationDressingReport,
  type LocationDressingSunReport
} from '@scene-director/scene';

/**
 * The client bakes a planet's height map from heightMap1/2 into this placeholder; the page binds heightMap1 there.
 */
const HEIGHT_MAP_PLACEHOLDER = /\/texture\/global\/black\.dds$/iu;

/**
 * Binds a planet's height map where its template carries the client's bake placeholder: every
 * `TriTextureParameter` named `HeightMap` whose resourcePath is `res:/texture/global/black.dds`. Gas giants author their
 * own and moons have none. Mutates the values in place.
 *
 * @param values - The planet file's plain values.
 * @param heightMap - The celestial's heightMap1.
 * @returns How many parameters it bound.
 */
export function PatchHeightMap(values: unknown, heightMap: string): number {
  let patched = 0;
  WalkRecords(values, (record) => {
    if (record['_type'] === 'TriTextureParameter' && record['name'] === 'HeightMap' && typeof record['resourcePath'] === 'string' && HEIGHT_MAP_PLACEHOLDER.test(record['resourcePath'])) {
      record['resourcePath'] = heightMap;
      patched += 1;
    }
  });
  return patched;
}

/**
 * What a `dynamic:/` resource path becomes: the runtime registers no dynamic constructors (stations' in-space video
 * screens use `dynamic:/inspacevideos`), and an unknown one fails the whole hydration.
 */
export const DYNAMIC_RESOURCE_STANDIN = 'res:/texture/global/black.dds';

/**
 * Replaces every `dynamic:/<name>/...` string in plain values with DYNAMIC_RESOURCE_STANDIN, so a station hydrates
 * with blank video screens instead of failing. Mutates the values in place.
 *
 * @param values - SOF model values.
 * @returns The dynamic resource names it replaced, each once.
 */
export function PatchDynamicResources(values: unknown): string[] {
  const names = new Set<string>();
  WalkRecords(values, (record) => {
    for (const [key, value] of Object.entries(record)) {
      const match = typeof value === 'string' ? /^dynamic:\/+([^/]*)/iu.exec(value) : null;
      if (match) {
        names.add(match[1].toLowerCase());
        record[key] = DYNAMIC_RESOURCE_STANDIN;
      }
    }
  });
  return [...names];
}

/**
 * Visits every plain object (arrays included, as records of their indices) under values once.
 */
function WalkRecords(values: unknown, visit: (record: Record<string, unknown>) => void): void {
  const seen = new Set<object>();
  const pending: unknown[] = [values];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value != null && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      const record = value as Record<string, unknown>;
      visit(record);
      pending.push(...Object.values(record));
    }
  }
}

/**
 * Reads `?dress=`: absent or `all` dresses everything, `off` or `none` nothing, else a comma list of
 * nebula, sun, planets and objects. Unknown names warn (page_log) and are ignored.
 *
 * @param search - The page URL's query string.
 * @returns The parts to dress.
 */
export function ReadDressParts(search: string = globalThis.location?.search ?? ''): LocationDressingParts {
  const value = new URLSearchParams(search).get('dress')?.trim().toLowerCase();
  let parts: LocationDressingParts = ALL_LOCATION_DRESSING_PARTS;
  if (value === 'off' || value === 'none') parts = { nebula: false, sun: false, planets: false, objects: false };
  else if (value && value !== 'all') {
    const chosen: Record<LocationDressingPart, boolean> = { nebula: false, sun: false, planets: false, objects: false };
    for (const name of value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)) {
      if ((LOCATION_DRESSING_PARTS as readonly string[]).includes(name)) chosen[name as LocationDressingPart] = true;
      else console.warn(`?dress=${value}: ignoring "${name}" (expected off, all, or ${LOCATION_DRESSING_PARTS.join(', ')})`);
    }
    parts = chosen;
  }
  return parts;
}

/**
 * The slot a dressed thing holds: `sun:<id>`, `planet:<id>`, `moon:<id>`, `station:<id>` or `stargate:<id>`.
 */
export function DressingSlot(kind: DressedKind | 'sun', id: number): string {
  return `${kind}:${id}`;
}

export interface WantedDressing {
  readonly slot: string;
  /**
   * What it loads (a template path or SOF DNA): a changed key rebuilds the slot.
   */
  readonly key: string;
}

export interface DressingChanges {
  /**
   * Slots to keep and move in place (wanted order).
   */
  readonly keep: string[];
  /**
   * Slots to build (wanted order).
   */
  readonly build: string[];
  /**
   * Slots to take down (current order).
   */
  readonly retire: string[];
}

/**
 * Reconciles what is dressed with what a plan wants, by slot: a matching key is kept, a changed key is retired and
 * built, a new slot is built and an unwanted one retired.
 *
 * @param current - Slot → key of what is dressed.
 * @param wanted - The plan's slots and keys.
 * @returns The changes.
 */
export function PlanDressingChanges(current: ReadonlyMap<string, string>, wanted: readonly WantedDressing[]): DressingChanges {
  const keep: string[] = [];
  const build: string[] = [];
  const wantedKeys = new Map(wanted.map((entry) => [entry.slot, entry.key]));
  const retire = [...current].filter(([slot, key]) => wantedKeys.get(slot) !== key).map(([slot]) => slot);
  for (const { slot, key } of wanted) {
    if (current.get(slot) === key) keep.push(slot);
    else build.push(slot);
  }
  return { keep, build, retire };
}

export interface DressingEntryState {
  readonly state: DressedState;
  readonly error?: Maybe<string>;
  /**
   * Stations and stargates: the SOF bounding sphere.
   */
  readonly sofRadius?: Maybe<number>;
}

export interface DressingReportInput {
  readonly parts: LocationDressingParts;
  /**
   * Null while the answer is loading, or when the location failed.
   */
  readonly plan: Maybe<LocationDressingPlan>;
  /**
   * Slot → state of what was dressed for the plan.
   */
  readonly entries: ReadonlyMap<string, DressingEntryState>;
  readonly nebula?: Maybe<LocationDressingNebulaReport>;
  /**
   * The environment template and lens flare the scene dresser applied (or would apply without a renderer).
   */
  readonly sunDressing?: Maybe<{ readonly template?: Maybe<string>; readonly flare?: Maybe<string>; readonly error?: Maybe<string> }>;
  /**
   * The location could not be read.
   */
  readonly error?: Maybe<string>;
  readonly notes?: readonly string[];
  /**
   * No EVE data: why nothing is dressed (state off).
   */
  readonly offNote?: Maybe<string>;
}

/**
 * Get_state's `location.dressing`. State precedence: off (`?dress=off`, or no EVE data) > failed (the location) > loading (the answer or
 * a load in flight) > partial (something failed) > ready.
 *
 * @param input - The parts, the plan, the entries and the nebula and sun dressing.
 * @returns The report.
 */
export function DressingReport(input: DressingReportInput): LocationDressingReport {
  const { parts, plan, entries, error, notes, offNote } = input;
  const off = offNote != null || LOCATION_DRESSING_PARTS.every((part) => !parts[part]);
  const counts = {} as Record<DressedKind, { drawn: number; validated: number; loading: number; failed: number; skipped: number }>;
  for (const kind of DRESSED_KINDS) counts[kind] = { drawn: 0, validated: 0, loading: 0, failed: 0, skipped: 0 };
  const objects: LocationDressingObjectReport[] = [];
  let sun: Maybe<LocationDressingSunReport> = null;
  let nebula: Maybe<LocationDressingNebulaReport> = null;

  if (plan && !off && !error) {
    for (const kind of DRESSED_KINDS) {
      const skips = plan.skipped[kind];
      counts[kind].skipped = skips.tooSmall + skips.inside + skips.noGraphic + skips.overCap + skips.disabled;
    }
    for (const body of plan.bodies) {
      const entry = entries.get(DressingSlot(body.kind, body.id));
      const state = entry?.state ?? 'planned';
      CountState(counts[body.kind], state);
      objects.push({ id: body.id, kind: body.kind, name: body.name, state, distance: Math.round(body.distance), radius: Math.round(body.radius), drawnRadius: Math.round(body.drawnRadius), ...(body.scaled ? { scaled: true as const } : {}), ...(state === 'failed' && entry?.error ? { error: entry.error } : {}) });
    }
    for (const object of plan.objects) {
      const entry = entries.get(DressingSlot(object.kind, object.id));
      const state = entry?.state ?? 'planned';
      CountState(counts[object.kind], state);
      objects.push({ id: object.id, kind: object.kind, name: object.name, state, distance: Math.round(object.distance), radius: Math.round(object.radius), ...(entry?.sofRadius == null ? {} : { sofRadius: Math.round(entry.sofRadius) }), ...(state === 'failed' && entry?.error ? { error: entry.error } : {}) });
    }
    if (plan.sun) {
      const disc = entries.get(DressingSlot('sun', plan.sun.id));
      const sunError = disc?.error ?? input.sunDressing?.error;
      sun = {
        id: plan.sun.id,
        name: plan.sun.name,
        graphic: plan.sun.graphic,
        ...(input.sunDressing?.template ? { template: input.sunDressing.template } : {}),
        ...(input.sunDressing?.flare ? { flare: input.sunDressing.flare } : {}),
        distance: Math.round(plan.sun.distance),
        drawnDistance: Math.round(Math.hypot(...plan.sun.drawnPosition)),
        state: disc?.state ?? 'planned',
        ...(sunError ? { error: sunError } : {})
      };
    }
    nebula = input.nebula ?? null;
  }

  const states = [...objects.map((object) => object.state), ...(sun ? [sun.state] : []), ...(nebula ? [nebula.state] : [])];
  let state: LocationDressingReport['state'] = 'ready';
  if (off) state = 'off';
  else if (error) state = 'failed';
  else if (!plan || states.includes('loading')) state = 'loading';
  else if (states.includes('failed')) state = 'partial';

  return {
    state,
    ...(offNote ? { note: offNote } : {}),
    ...(error && !off ? { error } : {}),
    ...(notes && notes.length > 0 && !off ? { notes: [...notes] } : {}),
    parts,
    ...(nebula ? { nebula } : {}),
    ...(sun ? { sun } : {}),
    counts: counts as Record<DressedKind, LocationDressingCounts>,
    objects
  };
}

function CountState(counts: { drawn: number; validated: number; loading: number; failed: number }, state: DressedState): void {
  if (state === 'drawn') counts.drawn += 1;
  else if (state === 'validated') counts.validated += 1;
  else if (state === 'loading') counts.loading += 1;
  else if (state === 'failed') counts.failed += 1;
}

/**
 * The overlay's `dressing` row: `c02_cube · Jita - Star · 1 planet, 8 moons · 2 stations, 0 gates`, `loading (5 of 12)`
 * or `… · 1 failed`.
 *
 * @param report - The dressing report.
 * @returns The row's text, or null without a report.
 */
export function DressingText(report: Maybe<LocationDressingReport>): Maybe<string> {
  let text: Maybe<string> = null;
  if (report) {
    const total = (kind: DressedKind, key: 'drawn' | 'validated' | 'loading' | 'failed'): number => report.counts[kind][key];
    const shown = (kind: DressedKind): number => total(kind, 'drawn') + total(kind, 'validated');
    const failed = DRESSED_KINDS.reduce((sum, kind) => sum + total(kind, 'failed'), 0) + (report.sun?.state === 'failed' ? 1 : 0) + (report.nebula?.state === 'failed' ? 1 : 0);
    if (report.state === 'off') text = 'off';
    else if (report.state === 'failed') text = `failed: ${report.error ?? 'no answer'}`;
    else if (report.state === 'loading') {
      const planned = report.objects.length;
      const settled = report.objects.filter((object) => object.state !== 'loading' && object.state !== 'planned').length;
      text = planned > 0 ? `loading (${settled} of ${planned})` : 'loading';
    } else {
      const nebula = report.nebula?.path.replace(/^.*\//u, '').replace(/\.black$/iu, '');
      const pieces = [nebula, report.sun?.name, `${Plural(shown('planet'), 'planet')}, ${Plural(shown('moon'), 'moon')}`, `${Plural(shown('station'), 'station')}, ${Plural(shown('stargate'), 'gate')}`];
      if (failed > 0) pieces.push(`${failed} failed`);
      text = pieces.filter((piece): piece is string => Boolean(piece)).join(' · ');
    }
  }
  return text;
}

function Plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
