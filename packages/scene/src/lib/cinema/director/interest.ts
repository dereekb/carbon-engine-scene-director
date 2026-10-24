/**
 * Interest: how much each candidate subject is worth framing at this boundary.
 *
 *   I(s) = (E(s) + C(s) + base(s)) × R(s)
 *
 * - E: decayed event interest, kept in memory per (subject, kind): w × 2^(−age / halfLife), dropped under
 *   DIRECTOR_INTEREST_FLOOR. From the page's events (kill, primary, warp, prop-mod) and the ones derived here (engage,
 *   the arrival lead, a fleet's MWD bloom, close passes).
 * - C: continuous terms from this boundary's picture: doom, heat, logi, motion (groups and the engagement sum their
 *   members'; the engagement adds intensity and closing; a landmark its own).
 * - base: what rotates a calm or movement-only scene.
 * - R: recognisability: the acting FC, the followed subject, a live called primary, a named ship, hull size.
 *
 * The memory is plain JSON (records and arrays), so it clones and replays.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneVector } from '../../scene';
import { addVec, distanceVec, dotVec, normalizeVec, scaleVec, subVec } from '../vectors';
import type { CameraDirectorSettings } from './command';
import { compareDirectorKeys, DIRECTOR_EVENT_WEIGHTS, DIRECTOR_INTEREST_FLOOR, type CameraDirectorEvent, type DirectorEventWeight } from './events';
import type { CameraDirectorPicture, DirectorArrival, DirectorShip } from './picture';

/**
 * A team pair opening fire after this many quiet seconds is an `engage` event.
 */
export const ENGAGE_QUIET_SECONDS = 15;
/**
 * A group's arrival lead fires this many seconds before its first landing.
 */
export const ARRIVAL_LEAD_SECONDS = 5;
/**
 * A ship with less time to live than this, seconds (and under DOOM_HEALTH), is doomed.
 */
export const DOOM_SECONDS = 10;
export const DOOM_HEALTH = 0.6;
/**
 * A warp landing this close to the action, metres, is near it.
 */
export const WARP_NEAR_METRES = 300_000;
/**
 * A Destiny warp's lead is kept this long past its landing (so the next warp of the group leads again), seconds.
 */
export const WARP_LEAD_KEEP_SECONDS = 60;
/**
 * Close passes: the closest approach within PASS_LOOKAHEAD_SECONDS, a miss under max(PASS_MIN_MISS, 4 (r₁ + r₂)), a
 * relative speed over PASS_MIN_SPEED; once per pair per PASS_REPEAT_SECONDS.
 */
export const PASS_LOOKAHEAD_SECONDS = 3;
export const PASS_MIN_MISS = 1000;
export const PASS_MIN_SPEED = 100;
export const PASS_REPEAT_SECONDS = 20;
/**
 * A fleet blooms when half its landed members switch a prop mod on within this many ticks.
 */
export const BLOOM_TICKS = 3;
/**
 * Landmarks within this of the action are candidates (stations, gates, scene objects), metres.
 */
export const LANDMARK_NEAR_METRES = 250_000;
/**
 * A landmark is interesting again this long after the last landmark shot, seconds.
 */
export const LANDMARK_REPEAT_SECONDS = 120;
/**
 * Candidate caps: ships, wings and squads, pairs, landmarks.
 */
export const DIRECTOR_SHIP_CAP = 12;
export const DIRECTOR_GROUP_CAP = 6;
export const DIRECTOR_PAIR_CAP = 6;
export const DIRECTOR_LANDMARK_CAP = 2;

/**
 * Which event an interest came from, for the report.
 */
export interface DirectorEventRef {
  readonly kind: string;
  readonly tick: number;
  readonly ship?: string;
  readonly group?: string;
}

export interface DirectorInterestEntry {
  /**
   * The subject's key.
   */
  readonly subject: string;
  readonly kind: string;
  readonly weight: number;
  readonly halfLife: number;
  /**
   * Scene seconds the decay starts at (an arrival's: its first landing).
   */
  readonly time: number;
  readonly why: string;
  readonly event: DirectorEventRef;
}

/**
 * The interest half of the director's memory.
 */
export interface DirectorInterestMemory {
  readonly interest: readonly DirectorInterestEntry[];
  /**
   * Team pair ("a|b") → the last scene second it was firing.
   */
  readonly firing: Readonly<Record<string, number>>;
  /**
   * Ship pair ("a|b") → the scene second of its last close pass.
   */
  readonly passes: Readonly<Record<string, number>>;
  /**
   * Arrival group → the scene second of its first landing (once its lead fired).
   */
  readonly arrivals: Readonly<Record<string, number>>;
  /**
   * The prop mods switched on in the last BLOOM_TICKS ticks.
   */
  readonly propMods: readonly { readonly tick: number; readonly ship: string }[];
  /**
   * Fleet → its acting commander at the last step.
   */
  readonly commanders: Readonly<Record<string, string>>;
}

export const EMPTY_DIRECTOR_INTEREST: DirectorInterestMemory = { interest: [], firing: {}, passes: {}, arrivals: {}, propMods: [], commanders: {} };

export type DirectorSubjectKind = 'ship' | 'group' | 'pair' | 'engagement' | 'landmark';

export interface DirectorShipSubject {
  readonly kind: 'ship';
  readonly key: string;
  readonly ship: string;
}

export interface DirectorGroupSubject {
  readonly kind: 'group';
  readonly key: string;
  readonly fleet?: string;
  readonly wing?: string;
  readonly squad?: string;
  /**
   * An explicit selection (an arrival or a lone ship with no fleet).
   */
  readonly ships?: readonly string[];
  /**
   * Every member (landed or not), and its leader.
   */
  readonly members: readonly string[];
  readonly leader?: string;
  /**
   * A whole fleet (wide) rather than a wing, squad or handful (medium).
   */
  readonly whole: boolean;
  /**
   * In warp or arriving by warp: warp-in frames it.
   */
  readonly warping?: boolean;
  /**
   * The arrival group it is, when one.
   */
  readonly arrival?: string;
}

export interface DirectorPairSubject {
  readonly kind: 'pair';
  readonly key: string;
  readonly ship: string;
  readonly target: string;
  /**
   * shooter → its target, logi → the ship it reps, attacker → the doomed ship.
   */
  readonly relation: 'shooter' | 'logi' | 'doom';
}

export interface DirectorEngagementSubject {
  readonly kind: 'engagement';
  readonly key: 'engagement';
  readonly teams?: readonly [string, string];
}

export interface DirectorLandmarkSubject {
  readonly kind: 'landmark';
  readonly key: string;
  readonly object?: string;
  readonly celestial?: number;
  readonly name: string;
  readonly position: SceneVector;
}

export type DirectorSubject = DirectorShipSubject | DirectorGroupSubject | DirectorPairSubject | DirectorEngagementSubject | DirectorLandmarkSubject;

/**
 * One contribution to a subject's interest, for the report's why.
 */
export interface DirectorTerm {
  readonly name: string;
  readonly value: number;
  readonly why: string;
  readonly event?: DirectorEventRef;
}

export interface ScoredDirectorSubject {
  readonly subject: DirectorSubject;
  /**
   * I(s).
   */
  readonly interest: number;
  /**
   * E(s): the decayed event interest.
   */
  readonly events: number;
  readonly continuous: number;
  readonly base: number;
  readonly recognisability: number;
  /**
   * The contributions, the largest first.
   */
  readonly terms: readonly DirectorTerm[];
  /**
   * The ship subject (or a pair's target) is doomed, or was just killed.
   */
  readonly doomed?: boolean;
  readonly killed?: boolean;
}

/**
 * What the picture says about one ship this boundary.
 */
export interface DirectorShipFacts {
  readonly ship: DirectorShip;
  readonly fleet?: string;
  readonly commander: boolean;
  readonly primary: boolean;
  readonly followed: boolean;
  readonly followedFleet: boolean;
  /**
   * Seconds to live at its pressure net of reps, when it takes damage.
   */
  readonly ttl?: number;
  readonly doom: number;
  readonly heat: number;
  readonly logi: number;
  readonly motion: number;
  /**
   * C(s).
   */
  readonly continuous: number;
  readonly recognisability: number;
}

/**
 * The picture's derived facts, shared by interest and the shot choice.
 */
export interface DirectorPictureFacts {
  readonly ships: ReadonlyMap<string, DirectorShipFacts>;
  /**
   * The landed, living ships (in a scene; neither arriving nor destroyed).
   */
  readonly landed: readonly DirectorShip[];
  /**
   * Ship → its fleet.
   */
  readonly fleetOf: ReadonlyMap<string, string>;
  /**
   * The axis teams (settings.teams, else the two biggest with landed ships, in id order), or null.
   */
  readonly teams: Maybe<readonly [string, string]>;
  /**
   * The action's centre: the axis teams' landed ships, else every landed ship.
   */
  readonly focus: Maybe<SceneVector>;
  /**
   * Any landed ship deals damage.
   */
  readonly firing: boolean;
  /**
   * Σ dealt ÷ max(1, 1 % of Σ total) over the teams, capped at 1.
   */
  readonly intensity: number;
  /**
   * The scene second of the last engage event, when one is in memory.
   */
  readonly engagedAt?: number;
  readonly followedShip?: string;
}

export interface DirectorInterestInput {
  readonly picture: CameraDirectorPicture;
  /**
   * This boundary's page events, sorted.
   */
  readonly events: readonly CameraDirectorEvent[];
  readonly settings: CameraDirectorSettings;
  readonly memory: DirectorInterestMemory;
  /**
   * The first pick after on, a hand-back or a load (a landmark is worth an establishing shot).
   */
  readonly first: boolean;
  /**
   * The scene second of the last landmark shot (or the director's start).
   */
  readonly lastLandmark: number;
  /**
   * Subject keys always kept as candidates (the current shot's).
   */
  readonly keep?: readonly string[];
}

export interface DirectorInterestResult {
  readonly memory: DirectorInterestMemory;
  readonly subjects: readonly ScoredDirectorSubject[];
  readonly facts: DirectorPictureFacts;
}

export function shipSubjectKey(id: string): string {
  return `ship:${id}`;
}

export function fleetSubjectKey(fleet: string): string {
  return `fleet:${fleet}`;
}

export function pairKey(a: string, b: string): string {
  return compareDirectorKeys(a, b) <= 0 ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * An entry's interest at `time`: full weight until its decay starts, then halving every half-life.
 */
export function decayedInterest(entry: Pick<DirectorInterestEntry, 'weight' | 'halfLife' | 'time'>, time: number): number {
  const age = Math.max(0, time - entry.time);
  return entry.weight * 2 ** (-age / entry.halfLife);
}

/**
 * Runs one boundary of interest: decays memory, adds the page's events and the derived ones, and scores the capped
 * candidate subjects.
 *
 * @param input - The picture, events, settings and memory.
 * @returns The memory after, the scored subjects (best first) and the picture's facts.
 */
export function stepDirectorInterest(input: DirectorInterestInput): DirectorInterestResult {
  const { picture, events, settings } = input;
  const time = picture.time;
  const fleetOf = fleetMemberships(picture);
  const names = new Map(picture.ships.map((ship) => [ship.id, ship.name ?? ship.id]));
  const label = (id: string): string => names.get(id) ?? id;
  const byId = new Map(picture.ships.map((ship) => [ship.id, ship]));
  const landed = picture.ships.filter((ship) => !ship.arriving && !ship.destroyed);
  const teams = axisTeams(picture, settings, landed);
  const focus = actionFocus(landed, teams);
  let interest = input.memory.interest.filter((entry) => decayedInterest(entry, time) >= DIRECTOR_INTEREST_FLOOR).map((entry) => ({ ...entry }));
  const add = (subject: string, kind: string, weight: DirectorEventWeight, why: string, event: DirectorEventRef, start = time, factor = 1): void => {
    const fresh: DirectorInterestEntry = { subject, kind, weight: weight.weight * factor, halfLife: weight.halfLife, time: start, why, event };
    const index = interest.findIndex((entry) => entry.subject === subject && entry.kind === kind);
    if (index < 0) interest.push(fresh);
    else if (decayedInterest(interest[index], time) <= decayedInterest(fresh, time)) interest[index] = fresh;
  };
  const W = DIRECTOR_EVENT_WEIGHTS;
  const commanders = new Map(picture.fleets.map((fleet) => [fleet.id, fleet.commander]));
  const groupOfShip = (id: string): string => {
    const fleet = fleetOf.get(id);
    return fleet ? fleetSubjectKey(fleet) : `ships:${id}`;
  };
  const near = (point: Maybe<SceneVector>): boolean => !focus || !point || distanceVec(point, focus) <= WARP_NEAR_METRES;
  let propMods = input.memory.propMods.filter((entry) => entry.tick >= picture.tick - BLOOM_TICKS);
  // The page's events.
  for (const event of events) {
    const ref: DirectorEventRef = { kind: event.kind, tick: event.tick, ...(event.kind === 'primary' ? { group: event.group ?? event.fleet, ...(event.primary ? { ship: event.primary } : {}) } : { ship: event.ship }) };
    if (event.kind === 'kill') {
      add(shipSubjectKey(event.ship), 'kill', W.kill.victim, [`${label(event.ship)} exploded`, ...(event.by ? [`(killed by ${label(event.by)})`] : [])].join(' '), ref, time, picture.death === 'flag' ? W.kill.flagFactor : 1);
      if (event.by) add(shipSubjectKey(event.by), 'killer', W.kill.killer, `${label(event.by)} got the kill on ${label(event.ship)}`, ref);
      const fleet = fleetOf.get(event.ship);
      if (fleet && input.memory.commanders[fleet] === event.ship) add(fleetSubjectKey(fleet), 'fc-down', W.kill.fleet, `fleet ${fleet} lost its FC ${label(event.ship)}`, ref);
    } else if (event.kind === 'primary' && event.primary) {
      add(shipSubjectKey(event.primary), 'primary', W.primary.primary, [`${label(event.primary)} called primary`, ...(event.previous ? [`(after ${label(event.previous)})`] : [])].join(' '), ref);
      const caller = commanders.get(event.fleet);
      if (caller && caller !== event.primary) add(`pair:${caller}>${event.primary}`, 'call', W.primary.pair, `${label(caller)} calls ${label(event.primary)}`, ref);
    } else if (event.kind === 'warp' && !event.arrival) {
      const ship = byId.get(event.ship);
      if (event.phase === 'exit' && near(ship?.position)) add(groupOfShip(event.ship), 'warp-exit', W.warpExit.group, `${groupLabel(groupOfShip(event.ship))} drops out of warp near the action`, ref);
      else if (event.phase === 'enter') add(groupOfShip(event.ship), 'warp-enter', W.warpEnter.group, `${groupLabel(groupOfShip(event.ship))} warps`, ref);
    } else if (event.kind === 'prop-mod') {
      const kind = byId.get(event.ship)?.propMod?.kind === 'ab' ? 'afterburner' : 'MWD';
      add(shipSubjectKey(event.ship), 'prop-mod', W.propMod.ship, `${label(event.ship)} lights its ${kind}`, ref);
      propMods = [...propMods, { tick: event.tick, ship: event.ship }];
    }
  }
  // A fleet's MWD bloom: half its landed members switched on within BLOOM_TICKS.
  for (const fleet of picture.fleets) {
    const members = landed.filter((ship) => fleetOf.get(ship.id) === fleet.id);
    const switched = new Set(propMods.filter((entry) => fleetOf.get(entry.ship) === fleet.id).map((entry) => entry.ship));
    const fresh = interest.some((entry) => entry.subject === fleetSubjectKey(fleet.id) && entry.kind === 'bloom' && time - entry.time < W.propMod.fleet.halfLife);
    if (members.length >= 2 && switched.size * 2 >= members.length && !fresh) add(fleetSubjectKey(fleet.id), 'bloom', W.propMod.fleet, `fleet ${fleet.id} lights its prop mods`, { kind: 'prop-mod', tick: picture.tick, group: fleet.id });
  }
  // Engage: a team pair opening fire after ENGAGE_QUIET_SECONDS of quiet.
  const firing = { ...input.memory.firing };
  const teamOf = new Map(picture.ships.map((ship) => [ship.id, ship.team]));
  const firingPairs = new Set<string>();
  for (const ship of landed) {
    const target = ship.target == null ? null : teamOf.get(ship.target);
    if ((ship.dealt ?? 0) > 0 && ship.team != null && target != null && target !== ship.team) firingPairs.add(pairKey(ship.team, target));
  }
  for (const pair of [...firingPairs].sort(compareDirectorKeys)) {
    const last = firing[pair];
    if (last == null || time - last >= ENGAGE_QUIET_SECONDS) {
      const [a, b] = pair.split('|');
      const ref: DirectorEventRef = { kind: 'engage', tick: picture.tick, group: pair };
      add('engagement', 'engage', W.engage.engagement, `teams ${a} and ${b} open fire`, ref);
      for (const fleet of picture.fleets) {
        const team = teamOf.get(fleet.commander);
        if (team === a || team === b) add(fleetSubjectKey(fleet.id), 'engage', W.engage.fleet, `fleet ${fleet.id} opens fire`, ref);
      }
    }
    firing[pair] = time;
  }
  // The arrival lead: a group's first landing within ARRIVAL_LEAD_SECONDS.
  const arrivals = { ...input.memory.arrivals };
  for (const arrival of picture.arrivals ?? []) {
    if (arrival.lands == null || arrivals[arrival.group] != null || arrival.lands > ARRIVAL_LEAD_SECONDS || arrival.lands < -ARRIVAL_LEAD_SECONDS) continue;
    const landing = time + Math.max(0, arrival.lands);
    arrivals[arrival.group] = time + arrival.lands;
    const key = arrivalSubjectKey(arrival);
    const when = arrival.lands > 0.5 ? `lands from warp in ${Math.round(arrival.lands)} s` : 'lands from warp';
    add(key, 'arrival', W.arrival.group, `${groupLabel(key)} ${when}`, { kind: 'arrival', tick: picture.tick, group: arrival.group }, landing);
  }
  // A Destiny warp landing near the action soon: its group's lead (keyed `warp:<group>`).
  for (const ship of picture.ships) {
    const warp = ship.warp;
    if (!warp || warp.phase === 'landed' || warp.landsIn == null || warp.landsIn > ARRIVAL_LEAD_SECONDS || !near(warp.landing)) continue;
    const key = groupOfShip(ship.id);
    if (arrivals[`warp:${key}`] != null) continue;
    arrivals[`warp:${key}`] = time + warp.landsIn;
    add(key, 'warp-lead', W.warpExit.group, `${groupLabel(key)} lands from warp near the action in ${Math.max(0, Math.round(warp.landsIn))} s`, { kind: 'warp', tick: picture.tick, ship: ship.id, group: key }, time + Math.max(0, warp.landsIn));
  }
  // Close passes.
  const passes = { ...input.memory.passes };
  for (const pass of closePasses(landed)) {
    const pair = pairKey(pass.a.id, pass.b.id);
    if (passes[pair] != null && time - passes[pair] < PASS_REPEAT_SECONDS) continue;
    passes[pair] = time;
    const faster = pass.a.speed >= pass.b.speed ? pass.a : pass.b;
    const other = faster === pass.a ? pass.b : pass.a;
    const ref: DirectorEventRef = { kind: 'pass', tick: picture.tick, ship: faster.id };
    const why = `${label(faster.id)} passes ${label(other.id)} at ${Math.round(pass.speed)} m/s`;
    add(shipSubjectKey(faster.id), 'pass', W.pass.ship, why, ref);
    add(`pair:${faster.id}>${other.id}`, 'pass', W.pass.pair, why, ref);
  }
  interest = interest.sort((a, b) => compareDirectorKeys(a.subject, b.subject) || compareDirectorKeys(a.kind, b.kind));
  const memory: DirectorInterestMemory = {
    interest,
    firing: pruneRecord(firing, (at) => time - at < 4 * ENGAGE_QUIET_SECONDS),
    passes: pruneRecord(passes, (at) => time - at < PASS_REPEAT_SECONDS),
    arrivals: Object.fromEntries(Object.entries(arrivals).filter(([key, at]) => !key.startsWith('warp:') || time - at < WARP_LEAD_KEEP_SECONDS)),
    propMods,
    commanders: Object.fromEntries(picture.fleets.map((fleet) => [fleet.id, fleet.commander]))
  };
  const facts = pictureFacts(picture, settings, { landed, fleetOf, teams, focus, interest });
  const subjects = scoreSubjects(picture, settings, memory, facts, input, label);
  return { memory, subjects, facts };
}

function pruneRecord(record: Readonly<Record<string, number>>, keep: (value: number) => boolean): Record<string, number> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => keep(value)));
}

/**
 * Each ship's fleet: its commander and its squads' members.
 */
export function fleetMemberships(picture: Pick<CameraDirectorPicture, 'fleets'>): Map<string, string> {
  const fleetOf = new Map<string, string>();
  for (const fleet of picture.fleets) {
    fleetOf.set(fleet.commander, fleet.id);
    for (const wing of fleet.wings) {
      if (wing.commander) fleetOf.set(wing.commander, fleet.id);
      for (const squad of wing.squads) for (const member of squad.members) fleetOf.set(member, fleet.id);
    }
  }
  return fleetOf;
}

/**
 * The axis of action's teams: the bias, else the two biggest teams with landed ships (ties in document order), in id
 * order so a kill that reorders their sizes never flips the axis.
 */
function axisTeams(picture: CameraDirectorPicture, settings: CameraDirectorSettings, landed: readonly DirectorShip[]): Maybe<readonly [string, string]> {
  let teams: Maybe<readonly [string, string]> = null;
  if (settings.teams) teams = settings.teams;
  else {
    const counts = new Map<string, number>();
    for (const ship of landed) if (ship.team != null) counts.set(ship.team, (counts.get(ship.team) ?? 0) + 1);
    const biggest = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
    if (biggest.length === 2) teams = [biggest[0][0], biggest[1][0]].sort(compareDirectorKeys) as [string, string];
  }
  return teams;
}

function centroid(ships: readonly DirectorShip[]): Maybe<SceneVector> {
  return ships.length
    ? scaleVec(
        ships.reduce<SceneVector>((sum, ship) => addVec(sum, ship.position), [0, 0, 0]),
        1 / ships.length
      )
    : null;
}

function actionFocus(landed: readonly DirectorShip[], teams: Maybe<readonly [string, string]>): Maybe<SceneVector> {
  const sides = teams ? landed.filter((ship) => ship.team === teams[0] || ship.team === teams[1]) : [];
  return centroid(sides.length ? sides : landed);
}

/**
 * The arrival's subject: its fleet (warp-in frames the fleet's arriving ships), else its ships.
 */
export function arrivalSubjectKey(arrival: Pick<DirectorArrival, 'group' | 'fleet'>): string {
  return arrival.fleet ? fleetSubjectKey(arrival.fleet) : `arrival:${arrival.group}`;
}

function groupLabel(key: string): string {
  let text = key;
  if (key.startsWith('fleet:')) text = `fleet ${key.slice(6)}`;
  else if (key.startsWith('ships:')) text = key.slice(6);
  else if (key.startsWith('arrival:')) text = `arrival ${key.slice(8)}`;
  return text;
}

/**
 * Pairs of landed ships about to pass close and fast.
 */
function closePasses(ships: readonly DirectorShip[]): { a: DirectorShip; b: DirectorShip; speed: number }[] {
  const passes: { a: DirectorShip; b: DirectorShip; speed: number }[] = [];
  // A relative speed over PASS_MIN_SPEED needs one of the two over half of it: each mover against every other ship once.
  const movers = ships.filter((ship) => ship.speed > PASS_MIN_SPEED / 2);
  const moving = new Set(movers);
  for (const a of movers) {
    for (const b of ships) {
      if (b === a || (moving.has(b) && compareDirectorKeys(a.id, b.id) >= 0)) continue;
      const px = b.position[0] - a.position[0];
      const py = b.position[1] - a.position[1];
      const pz = b.position[2] - a.position[2];
      const vx = b.velocity[0] - a.velocity[0];
      const vy = b.velocity[1] - a.velocity[1];
      const vz = b.velocity[2] - a.velocity[2];
      const speed2 = vx * vx + vy * vy + vz * vz;
      if (speed2 <= PASS_MIN_SPEED * PASS_MIN_SPEED) continue;
      const speed = Math.sqrt(speed2);
      const miss = Math.max(PASS_MIN_MISS, 4 * (a.radius + b.radius));
      const reach = speed * PASS_LOOKAHEAD_SECONDS + miss;
      if (px * px + py * py + pz * pz > reach * reach) continue;
      const t = -(px * vx + py * vy + pz * vz) / speed2;
      if (t < 0 || t > PASS_LOOKAHEAD_SECONDS) continue;
      const cx = px + vx * t;
      const cy = py + vy * t;
      const cz = pz + vz * t;
      if (cx * cx + cy * cy + cz * cz < miss * miss) passes.push(compareDirectorKeys(a.id, b.id) <= 0 ? { a, b, speed } : { a: b, b: a, speed });
    }
  }
  return passes.sort((x, y) => compareDirectorKeys(pairKey(x.a.id, x.b.id), pairKey(y.a.id, y.b.id)));
}

interface FactsContext {
  readonly landed: readonly DirectorShip[];
  readonly fleetOf: ReadonlyMap<string, string>;
  readonly teams: Maybe<readonly [string, string]>;
  readonly focus: Maybe<SceneVector>;
  readonly interest: readonly DirectorInterestEntry[];
}

function pictureFacts(picture: CameraDirectorPicture, settings: CameraDirectorSettings, context: FactsContext): DirectorPictureFacts {
  const { landed, fleetOf, teams, focus } = context;
  const commanders = new Set(picture.fleets.map((fleet) => fleet.commander));
  const primaries = new Set(Object.values(picture.primaries ?? {}).flat());
  const follow = settings.follow;
  const followedFleet = follow && 'fleet' in follow ? follow.fleet : null;
  const followedShip = follow && 'ship' in follow ? follow.ship : followedFleet ? picture.fleets.find((fleet) => fleet.id === followedFleet)?.commander : undefined;
  const repairedBy = new Map<string, DirectorShip[]>();
  for (const ship of landed) if (ship.repairing) repairedBy.set(ship.repairing, [...(repairedBy.get(ship.repairing) ?? []), ship]);
  const byId = new Map(picture.ships.map((ship) => [ship.id, ship]));
  const ships = new Map<string, DirectorShipFacts>();
  for (const ship of picture.ships) {
    const fleet = fleetOf.get(ship.id);
    const alive = !ship.destroyed && !ship.arriving;
    const pressure = ship.pressure ?? 0;
    const repaired = ship.repaired ?? 0;
    const health = ship.health ?? 1;
    const net = pressure - repaired;
    const ttl = alive && pressure > 0 && ship.remaining != null ? ship.remaining / Math.max(1, net) : undefined;
    const doom = ttl != null && health < DOOM_HEALTH && ttl < DOOM_SECONDS ? 8 * (1 - ttl / DOOM_SECONDS) * (1 - health) : 0;
    const heat = alive ? 2 * Math.min(1, pressure / Math.max(50, 0.05 * (ship.total ?? 0))) : 0;
    const held = (target: DirectorShip): number => ((target.pressure ?? 0) > 0 ? Math.min(1, (target.repaired ?? 0) / Math.max(1, target.pressure ?? 0)) : 0);
    let logi = alive ? 1.5 * held(ship) : 0;
    const repairing = ship.repairing ? byId.get(ship.repairing) : null;
    if (alive && repairing) logi += 1.0 * held(repairing);
    const motion = alive ? 0.5 * Math.min(1, ship.speed / 300) + (ship.speed > 1000 ? 0.5 : 0) : 0;
    const commander = commanders.has(ship.id);
    const primary = primaries.has(ship.id);
    const followed = followedShip === ship.id;
    const inFollowedFleet = followedFleet != null && fleet === followedFleet;
    let recognisability = 1 + 0.15 * Math.log2(Math.max(1, ship.radius / 50));
    if (commander) recognisability *= 1.6;
    if (followed) recognisability *= 2.5;
    else if (inFollowedFleet) recognisability *= 1.4;
    if (primary) recognisability *= 1.5;
    if (ship.name) recognisability *= 1.1;
    ships.set(ship.id, { ship, ...(fleet ? { fleet } : {}), commander, primary, followed, followedFleet: inFollowedFleet, ...(ttl == null ? {} : { ttl }), doom, heat, logi, motion, continuous: doom + heat + logi + motion, recognisability });
  }
  const sides = teams ? landed.filter((ship) => ship.team === teams[0] || ship.team === teams[1]) : landed;
  const dealt = sides.reduce((sum, ship) => sum + (ship.dealt ?? 0), 0);
  const total = sides.reduce((sum, ship) => sum + (ship.total ?? 0), 0);
  const engaged = context.interest.filter((entry) => entry.kind === 'engage' && entry.subject === 'engagement').map((entry) => entry.time);
  return {
    ships,
    landed,
    fleetOf,
    teams,
    focus,
    firing: landed.some((ship) => (ship.dealt ?? 0) > 0),
    intensity: Math.min(1, dealt / Math.max(1, 0.01 * total)),
    ...(engaged.length ? { engagedAt: Math.max(...engaged) } : {}),
    ...(followedShip ? { followedShip } : {})
  };
}

/**
 * The capped candidate subjects, scored, best first (ties by key).
 */
function scoreSubjects(picture: CameraDirectorPicture, settings: CameraDirectorSettings, memory: DirectorInterestMemory, facts: DirectorPictureFacts, input: DirectorInterestInput, label: (id: string) => string): ScoredDirectorSubject[] {
  const time = picture.time;
  const entriesBy = new Map<string, DirectorInterestEntry[]>();
  for (const entry of memory.interest) entriesBy.set(entry.subject, [...(entriesBy.get(entry.subject) ?? []), entry]);
  const eventTerms = (key: string): DirectorTerm[] => (entriesBy.get(key) ?? []).map((entry) => ({ name: entry.kind, value: decayedInterest(entry, time), why: entry.why, event: entry.event }));
  const score = (subject: DirectorSubject, continuous: DirectorTerm[], base: DirectorTerm, recognisability: number, flags: { doomed?: boolean; killed?: boolean } = {}): ScoredDirectorSubject => {
    const fromEvents = eventTerms(subject.key);
    const events = fromEvents.reduce((sum, term) => sum + term.value, 0);
    const c = continuous.reduce((sum, term) => sum + term.value, 0);
    const terms = [...fromEvents, ...continuous.filter((term) => term.value > 0), base].sort((a, b) => b.value - a.value || compareDirectorKeys(a.name, b.name));
    return { subject, interest: (events + c + base.value) * recognisability, events, continuous: c, base: base.value, recognisability, terms, ...flags };
  };
  const shipTerms = (id: string): DirectorTerm[] => {
    const fact = facts.ships.get(id);
    const terms: DirectorTerm[] = [];
    if (!fact) return terms;
    const name = label(id);
    const health = Math.round(100 * (fact.ship.health ?? 1));
    if (fact.doom > 0) terms.push({ name: 'doom', value: fact.doom, why: `${name} is about to die: ${health} % HP, ~${Math.max(1, Math.round(fact.ttl ?? 0))} s to live` });
    if (fact.heat > 0) terms.push({ name: 'heat', value: fact.heat, why: `${name} under fire (${Math.round(fact.ship.pressure ?? 0)} HP/s)` });
    if (fact.logi > 0) terms.push({ name: 'logi', value: fact.logi, why: fact.ship.repairing ? `${name} reps ${label(fact.ship.repairing)}` : `reps holding ${name}` });
    if (fact.motion > 0) terms.push({ name: 'motion', value: fact.motion, why: `${name} at ${Math.round(fact.ship.speed)} m/s` });
    return terms;
  };
  const sum = (terms: readonly DirectorTerm[]): number => terms.reduce((total, term) => total + term.value, 0);
  const subjects: ScoredDirectorSubject[] = [];
  const keep = new Set(input.keep ?? []);
  const landedIds = new Set(facts.landed.map((ship) => ship.id));
  // Ships: the top DIRECTOR_SHIP_CAP, always with acting FCs, live primaries, the followed ship and the doomed.
  const shipScores: ScoredDirectorSubject[] = [];
  for (const ship of picture.ships) {
    if (ship.arriving) continue;
    const fact = facts.ships.get(ship.id);
    if (!fact) continue;
    const killed = (entriesBy.get(shipSubjectKey(ship.id)) ?? []).some((entry) => entry.kind === 'kill');
    if (ship.destroyed && !killed) continue;
    const baseValue = fact.commander || fact.followed ? 0.5 : 0.3;
    const why = fact.followed ? `${label(ship.id)} (followed)` : fact.commander ? `${label(ship.id)} (FC)` : label(ship.id);
    shipScores.push(score({ kind: 'ship', key: shipSubjectKey(ship.id), ship: ship.id }, shipTerms(ship.id), { name: 'base', value: baseValue, why }, fact.recognisability, { ...(fact.doom > 0 ? { doomed: true } : {}), ...(killed ? { killed: true } : {}) }));
  }
  shipScores.sort(bestFirst);
  const always = (entry: ScoredDirectorSubject): boolean => {
    const fact = entry.subject.kind === 'ship' ? facts.ships.get(entry.subject.ship) : null;
    return keep.has(entry.subject.key) || Boolean(fact && (fact.commander || fact.primary || fact.followed)) || Boolean(entry.doomed) || Boolean(entry.killed);
  };
  subjects.push(...shipScores.filter((entry, index) => index < DIRECTOR_SHIP_CAP || always(entry)));
  const shipInterest = new Map(shipScores.map((entry) => [(entry.subject as DirectorShipSubject).ship, entry]));
  // Groups: whole fleets with two or more landed members, then up to DIRECTOR_GROUP_CAP wings and squads (the followed
  // fleet's first); warping and arriving groups.
  const followedFleet = settings.follow && 'fleet' in settings.follow ? settings.follow.fleet : null;
  const arrivalsByKey = new Map((picture.arrivals ?? []).filter((arrival) => arrival.lands != null && arrival.lands > -30).map((arrival) => [arrivalSubjectKey(arrival), arrival]));
  const groupScore = (subject: DirectorGroupSubject, recognisability: number): ScoredDirectorSubject => {
    const members = subject.members.flatMap((id) => (landedIds.has(id) ? [facts.ships.get(id)?.continuous ?? 0] : [])).sort((a, b) => b - a);
    const c = 0.4 * members.slice(0, 5).reduce((total, value) => total + value, 0);
    return score(subject, c > 0 ? [{ name: 'members', value: c, why: `${groupLabel(subject.key)} in action` }] : [], { name: 'base', value: 0.4, why: subjectLabel(subject) }, recognisability);
  };
  const fleetGroups: ScoredDirectorSubject[] = [];
  const minorGroups: ScoredDirectorSubject[] = [];
  const ordered = [...picture.fleets].sort((a, b) => Number(b.id === followedFleet) - Number(a.id === followedFleet));
  for (const fleet of ordered) {
    const all = [...new Set([fleet.commander, ...fleet.wings.flatMap((wing) => [...(wing.commander ? [wing.commander] : []), ...wing.squads.flatMap((squad) => squad.members)])])];
    const landedCount = all.filter((id) => landedIds.has(id)).length;
    const key = fleetSubjectKey(fleet.id);
    const arrival = arrivalsByKey.get(key);
    const warping =
      Boolean(arrival) ||
      all.some((id) => {
        const ship = facts.ships.get(id)?.ship;
        return Boolean(ship?.arriving) || (ship?.warp != null && ship.warp.phase !== 'landed');
      });
    if (landedCount >= 2 || warping || keep.has(key)) {
      const subject: DirectorGroupSubject = { kind: 'group', key, fleet: fleet.id, members: all, leader: fleet.commander, whole: all.length > 4, ...(warping ? { warping: true } : {}), ...(arrival ? { arrival: arrival.group } : {}) };
      fleetGroups.push(groupScore(subject, fleet.id === followedFleet ? 2.5 : 1));
    }
    for (const wing of fleet.wings) {
      const wingMembers = [...new Set([...(wing.commander ? [wing.commander] : []), ...wing.squads.flatMap((squad) => squad.members)])];
      const wingKey = `wing:${fleet.id}/${wing.id}`;
      if (fleet.wings.length > 1 && (wingMembers.filter((id) => landedIds.has(id)).length >= 2 || keep.has(wingKey))) {
        minorGroups.push(groupScore({ kind: 'group', key: wingKey, fleet: fleet.id, wing: wing.id, members: wingMembers, ...(wing.commander ? { leader: wing.commander } : {}), whole: false }, fleet.id === followedFleet ? 1.4 : 1));
      }
      for (const squad of wing.squads) {
        const squadKey = `squad:${fleet.id}/${squad.id}`;
        if (squad.members.filter((id) => landedIds.has(id)).length >= 2 || keep.has(squadKey)) {
          minorGroups.push(groupScore({ kind: 'group', key: squadKey, fleet: fleet.id, squad: squad.id, members: squad.members, ...(squad.commander ? { leader: squad.commander } : {}), whole: false }, fleet.id === followedFleet ? 1.4 : 1));
        }
      }
    }
  }
  subjects.push(...fleetGroups);
  subjects.push(...minorGroups.filter((entry, index) => index < DIRECTOR_GROUP_CAP || keep.has(entry.subject.key)));
  // Arrivals with no fleet, and lone ships in warp.
  for (const [key, arrival] of arrivalsByKey) {
    if (key.startsWith('fleet:')) continue;
    subjects.push(groupScore({ kind: 'group', key, ships: arrival.ships, members: arrival.ships, ...(arrival.ships[0] ? { leader: arrival.ships[0] } : {}), whole: arrival.ships.length > 4, warping: true, arrival: arrival.group }, 1));
  }
  for (const ship of picture.ships) {
    if (facts.fleetOf.has(ship.id) || !ship.warp || ship.warp.phase === 'landed' || ship.arriving) continue;
    subjects.push(groupScore({ kind: 'group', key: `ships:${ship.id}`, ships: [ship.id], members: [ship.id], leader: ship.id, whole: false, warping: true }, facts.ships.get(ship.id)?.recognisability ?? 1));
  }
  // Pairs: shooters on their targets, logi on theirs, attackers on the doomed (and any pair an event named).
  const pairs = new Map<string, DirectorPairSubject>();
  const addPair = (ship: string, target: string, relation: DirectorPairSubject['relation']): void => {
    const key = `pair:${ship}>${target}`;
    if (ship !== target && landedIds.has(ship) && facts.ships.has(target) && !pairs.has(key)) pairs.set(key, { kind: 'pair', key, ship, target, relation });
  };
  for (const ship of facts.landed) {
    const doomed = facts.ships.get(ship.id)?.doom ?? 0;
    if (doomed > 0) for (const attacker of ship.attackedBy ?? []) addPair(attacker, ship.id, 'doom');
    if (ship.repairing) addPair(ship.id, ship.repairing, 'logi');
    if (ship.target && (ship.dealt ?? 0) > 0) addPair(ship.id, ship.target, 'shooter');
  }
  for (const key of entriesBy.keys()) {
    if (!key.startsWith('pair:')) continue;
    const [ship, target] = key.slice(5).split('>');
    addPair(ship, target, 'shooter');
  }
  const pairScores = [...pairs.values()].map((subject) => {
    const a = shipInterest.get(subject.ship);
    const b = shipInterest.get(subject.target);
    const c = 0.5 * ((a?.continuous ?? 0) + (b?.continuous ?? 0));
    const relation = subject.relation === 'logi' ? 'reps' : subject.relation === 'doom' ? 'finishes' : 'shoots';
    return score(subject, c > 0 ? [{ name: 'pair', value: c, why: `${label(subject.ship)} ${relation} ${label(subject.target)}` }] : [], { name: 'base', value: 0.3, why: `${label(subject.ship)} → ${label(subject.target)}` }, Math.max(a?.recognisability ?? 1, b?.recognisability ?? 1));
  });
  pairScores.sort(bestFirst);
  subjects.push(...pairScores.filter((entry, index) => index < DIRECTOR_PAIR_CAP || keep.has(entry.subject.key)));
  // The engagement.
  if (facts.landed.length) {
    const top = [...facts.landed].map((ship) => facts.ships.get(ship.id)?.continuous ?? 0).sort((a, b) => b - a);
    const continuous: DirectorTerm[] = [];
    const members = 0.3 * top.slice(0, 10).reduce((total, value) => total + value, 0);
    if (members > 0) continuous.push({ name: 'members', value: members, why: 'the fight' });
    if (facts.intensity > 0) continuous.push({ name: 'intensity', value: 3 * facts.intensity, why: `the fight at ${Math.round(100 * facts.intensity)} % intensity` });
    const closing = closingSpeed(facts);
    if (closing != null && closing.distance <= 150_000 && !facts.firing && closing.speed > 0) continuous.push({ name: 'closing', value: 2 * Math.min(1, closing.speed / 500), why: `the fleets close at ${Math.round(closing.speed)} m/s, ${Math.round(closing.distance / 1000)} km apart` });
    const two = facts.teams != null;
    subjects.push(score({ kind: 'engagement', key: 'engagement', ...(settings.teams ? { teams: settings.teams } : {}) }, continuous, { name: 'base', value: two ? 0.6 : 0.4, why: two ? `teams ${facts.teams?.[0]} and ${facts.teams?.[1]}` : 'the scene' }, 1));
  }
  // Landmarks: the nearest scene objects and location stations or gates within LANDMARK_NEAR_METRES of the action.
  const landmarkValue = input.first ? 1 : time - input.lastLandmark >= LANDMARK_REPEAT_SECONDS ? 0.3 : 0;
  for (const landmark of nearLandmarks(picture, facts.focus)) {
    subjects.push(score(landmark, landmarkValue > 0 ? [{ name: 'landmark', value: landmarkValue, why: input.first ? `${landmark.name} sets the scene` : `${landmark.name} again after ${LANDMARK_REPEAT_SECONDS} s` }] : [], { name: 'base', value: 0, why: landmark.name }, 1));
  }
  return subjects.sort(bestFirst);
}

function bestFirst(a: ScoredDirectorSubject, b: ScoredDirectorSubject): number {
  return b.interest - a.interest || compareDirectorKeys(a.subject.key, b.subject.key);
}

/**
 * The teams' closing speed along the line between their centroids, and how far apart they are.
 */
function closingSpeed(facts: DirectorPictureFacts): Maybe<{ speed: number; distance: number }> {
  const teams = facts.teams;
  if (!teams) return null;
  const a = facts.landed.filter((ship) => ship.team === teams[0]);
  const b = facts.landed.filter((ship) => ship.team === teams[1]);
  const ca = centroid(a);
  const cb = centroid(b);
  if (!ca || !cb) return null;
  const meanVelocity = (ships: readonly DirectorShip[]): SceneVector =>
    scaleVec(
      ships.reduce<SceneVector>((total, ship) => addVec(total, ship.velocity), [0, 0, 0]),
      1 / ships.length
    );
  const line = normalizeVec(subVec(cb, ca));
  const relative = subVec(meanVelocity(b), meanVelocity(a));
  return line ? { speed: -dotVec(relative, line), distance: distanceVec(ca, cb) } : null;
}

const LANDMARK_KINDS = /station|gate|structure/iu;

function nearLandmarks(picture: CameraDirectorPicture, focus: Maybe<SceneVector>): DirectorLandmarkSubject[] {
  const centre = focus ?? [0, 0, 0];
  const found: DirectorLandmarkSubject[] = [];
  for (const object of picture.objects ?? []) found.push({ kind: 'landmark', key: `object:${object.id}`, object: object.id, name: object.id, position: object.centre });
  for (const celestial of picture.celestials ?? []) {
    if (LANDMARK_KINDS.test(celestial.kind)) found.push({ kind: 'landmark', key: `celestial:${celestial.id}`, celestial: celestial.id, name: celestial.name, position: celestial.position });
  }
  return found
    .filter((landmark) => distanceVec(landmark.position, centre) <= LANDMARK_NEAR_METRES)
    .sort((a, b) => distanceVec(a.position, centre) - distanceVec(b.position, centre) || compareDirectorKeys(a.key, b.key))
    .slice(0, DIRECTOR_LANDMARK_CAP);
}

/**
 * A subject for messages: "tfis-fc", "fleet tfis", "squad dps of fleet tfis", "tfis-fc → red-01", "the engagement".
 */
export function subjectLabel(subject: DirectorSubject, label: (id: string) => string = (id) => id): string {
  let text: string;
  if (subject.kind === 'ship') text = label(subject.ship);
  else if (subject.kind === 'pair') text = `${label(subject.ship)} → ${label(subject.target)}`;
  else if (subject.kind === 'engagement') text = subject.teams ? `teams ${subject.teams[0]} and ${subject.teams[1]}` : 'the engagement';
  else if (subject.kind === 'landmark') text = subject.name;
  else if (subject.wing != null) text = `wing ${subject.wing} of fleet ${subject.fleet}`;
  else if (subject.squad != null) text = `squad ${subject.squad} of fleet ${subject.fleet}`;
  else if (subject.fleet != null) text = `fleet ${subject.fleet}`;
  else text = subject.members.length === 1 ? label(subject.members[0]) : `${subject.members.length} ships`;
  return text;
}
