/**
 * One camera director step, at a Destiny tick boundary: a pure function of the picture, the boundary's events, the
 * settings, the memory and the seed. It scores every candidate (a framing of a subject, in a variant), applies the cut
 * rules to the shot on screen, and returns the shot to cut to (play_shot JSON), if any, with the memory after.
 *
 * Candidate score = I(subject) × framing weight × scale weight × rhythm × variety × axis × lighting × jitter.
 *
 * Cut rules, h the seconds held, the live score the current framing's score now with no variety penalty on itself ×
 * continuity (1.25 at min falling to 0.75 at max):
 *
 * 1. The current shot is invalid (its subject gone, removed in under 2 s, or unresolvable; ruled out by auto_camera's
 *    rules; or shrunk under SIZE_KEEP_FACTOR × the size floor): cut now.
 * 2. A kill of the current subject: blend 1 s to its kill framing (unless already on it) and hold KILL_HOLD more.
 * 3. h < min: keep, unless the best is urgent (event interest ≥ URGENT_INTEREST), h ≥ URGENT_MIN_HOLD and another subject.
 * 4. h ≥ max (warp-in: 2 × max, and 3 s past the landing): cut to the best other candidate.
 * 5. Otherwise cut when the best beats the live score × CUT_RATIO.
 *
 * The shot rules are hard: a candidate outside `scales` or `framings`, or in `exclude`, is never scored, and one whose
 * ships fall under `minShipSize` is tightened (group and engagement framings raise their fill) or skipped.
 *
 * With nothing on screen the opening pick (no cut since a load or a jump) goes urgent → the favoured scale's best →
 * establishing when calm → the best wide → the best; a take-back (on again, after a yield or a lost shot) urgent, else
 * the best.
 */

import type { Maybe } from '@dereekb/util';
import type { JsonObject } from '../../json';
import { fleetTraitUnit } from '../../personalities/traits';
import type { SceneVector } from '../../scene';
import { resolveHardpoint, WARP_LANDING_CORE_SPREAD, type HardpointRef, type ResolvedHardpoint } from '../hardpoints';
import type { CameraPose } from '../pose';
import { MAX_HARDPOINT_FILL } from '../shot';
import { engagementFrame, type CinemaScene } from '../subjects';
import { distanceVec, dotVec, normalizeVec, subVec, WORLD_UP } from '../vectors';
import { axisResets, directorAxis, flybyViewSide, leanOf, sideName, viewSideOf, type DirectorAxis, type DirectorSide, type DirectorSideMemory } from './axis';
import { DIRECTOR_SCALES, directorFramingAllowed, directorHold, directorRulesProblem, type CameraDirectorSettings, type DirectorScale } from './command';
import { compareDirectorKeys, sortDirectorEvents, type CameraDirectorEvent } from './events';
import { DIRECTOR_FRAMING_ROWS, DIRECTOR_FRAMINGS, framingDefaultFill, framingScale, toFramingShot, type DirectorFramingName, type DirectorFramingRow } from './framings';
import { EMPTY_DIRECTOR_INTEREST, stepDirectorInterest, subjectLabel, type DirectorEventRef, type DirectorInterestMemory, type DirectorPictureFacts, type DirectorSubject, type ScoredDirectorSubject } from './interest';
import { toDirectorScene, type CameraDirectorPicture } from './picture';
import { framedShipSize, roundShipSize, shipSizeText, SIZE_KEEP_FACTOR, TIGHTEN_MARGIN, TIGHTEN_TRIES } from './visibility';

export const CUT_RATIO = 1.4;
export const URGENT_INTEREST = 8;
export const URGENT_MIN_HOLD = 2;
export const KILL_HOLD = 4;
export const KILL_BLEND_SECONDS = 1;
export const SCALE_BLEND_SECONDS = 1.5;
export const RECENT_SHOTS = 8;
export const DIRECTOR_LOG_LENGTH = 20;
/**
 * The pull-out plays within this many seconds of the fleets engaging.
 */
export const ENGAGE_SHOT_SECONDS = 10;
/**
 * A destroyed ship is a new candidate (a kill framing) only with this long left before its removal, seconds; a shot on
 * one is cut with less than REMOVAL_CUT_SECONDS left.
 */
export const REMOVAL_MIN_SECONDS = 3;
export const REMOVAL_CUT_SECONDS = 2;
/**
 * A warp-in holds at least this long past its group's first landing, seconds.
 */
export const WARP_IN_LANDED_HOLD = 3;
/**
 * into-sun needs the sun more than this off vertical, degrees.
 */
export const SUN_VERTICAL_DEGREES = 15;
/**
 * An eye within a landmark's sphere × this is inside it.
 */
export const LANDMARK_EYE_CLEARANCE = 1.1;
/**
 * A station's or stargate's map radius is an approach envelope, not its hull (the CNAP's is 100 km; its SOF sphere
 * 156 km, from its spires): the eye guard takes this share of it, or a scene parked 30 km off the station would refuse
 * every eye on the station's side (seen on the real GPU, 2026-10-24).
 */
export const STRUCTURE_EYE_FRACTION = 0.5;
/**
 * The variety waiver: a subject this interesting by events may be shown again soon.
 */
export const VARIETY_WAIVER_INTEREST = 5;

/**
 * A director shot, as picked.
 */
export interface DirectorPick {
  readonly key: string;
  readonly framing: DirectorFramingName;
  readonly variant?: string;
  readonly subject: DirectorSubject;
  readonly label: string;
  readonly scale: DirectorScale;
  readonly side: DirectorSide;
  /**
   * A crossing framing (the fly-through) or a cross allowed after a neutral shot.
   */
  readonly crossing?: boolean;
  /**
   * Scene seconds and tick it started.
   */
  readonly since: number;
  readonly tick: number;
  /**
   * Its hold, seconds.
   */
  readonly min: number;
  readonly max: number;
  /**
   * A warp-in's first landing, scene seconds.
   */
  readonly landing?: number;
  readonly score: number;
  /**
   * Its ship size when picked (visibility.ts), and the fill it was tightened to, if it was.
   */
  readonly size: number;
  readonly fill?: number;
  readonly why: string;
  readonly event?: DirectorEventRef;
  readonly transition: 'cut' | 'blend';
  /**
   * The play_shot JSON.
   */
  readonly shot: JsonObject;
  readonly hardpoint: HardpointRef;
}

export interface DirectorRecentShot {
  readonly at: number;
  readonly framing: DirectorFramingName;
  readonly subject: string;
  readonly label: string;
  readonly scale: DirectorScale;
  readonly side: DirectorSide;
  readonly why: string;
}

export interface DirectorCutLogEntry {
  readonly tick: number;
  readonly at: number;
  readonly framing: DirectorFramingName;
  readonly subject: string;
  readonly scale: DirectorScale;
  readonly side: DirectorSide;
  /**
   * The cut crosses the axis on purpose: a crossing framing (the fly-through), or a crossing after a neutral shot.
   */
  readonly crossing?: true;
  /**
   * No side was kept before the cut (the first cut, no axis, or the axis turned past AXIS_RESET_DEGREES).
   */
  readonly free?: true;
  /**
   * Its ship size, a share of the frame height (3 significant figures).
   */
  readonly size: number;
  readonly why: string;
}

export interface CameraDirectorMemory extends DirectorInterestMemory {
  /**
   * Scene seconds of the first step since the memory was cleared.
   */
  readonly started: number;
  readonly side: Maybe<DirectorSideMemory>;
  /**
   * The director's shot (on screen while it drives).
   */
  readonly current: Maybe<DirectorPick>;
  /**
   * The last RECENT_SHOTS, newest first.
   */
  readonly recent: readonly DirectorRecentShot[];
  readonly lastLandmark: number;
  readonly cuts: number;
  /**
   * The last DIRECTOR_LOG_LENGTH cuts, oldest first.
   */
  readonly log: readonly DirectorCutLogEntry[];
}

export function emptyCameraDirectorMemory(time: number): CameraDirectorMemory {
  return { ...EMPTY_DIRECTOR_INTEREST, started: time, side: null, current: null, recent: [], lastLandmark: time, cuts: 0, log: [] };
}

/**
 * How the director stands this step: `drive` its shot is on screen (the cut rules apply); `take` it takes the camera now
 * (a first pick: on, a hand-back, after a load); `watch` on but yielded or paused (memory only, no pick).
 */
export type CameraDirectorMode = 'drive' | 'take' | 'watch';

export interface CameraDirectorStepInput {
  readonly picture: CameraDirectorPicture;
  readonly events?: readonly CameraDirectorEvent[];
  readonly settings: CameraDirectorSettings;
  readonly memory?: Maybe<CameraDirectorMemory>;
  readonly seed: number;
  readonly mode: CameraDirectorMode;
}

export interface DirectorCandidate {
  readonly key: string;
  readonly row: DirectorFramingRow;
  readonly variant?: string;
  readonly scored: ScoredDirectorSubject;
  readonly scale: DirectorScale;
  readonly view: -1 | 0 | 1;
  readonly lean: -1 | 0 | 1;
  readonly crossing: boolean;
  readonly score: number;
  /**
   * The score before rhythm, variety and the axis (the live score's basis).
   */
  readonly plain: number;
  readonly notes: readonly string[];
  readonly hardpoint: HardpointRef;
  readonly pose: CameraPose;
  /**
   * Its ship size (visibility.ts), and the fill tightening raised it to.
   */
  readonly size: number;
  readonly fill?: number;
}

export interface DirectorCandidateReport {
  readonly framing: DirectorFramingName;
  readonly variant?: string;
  readonly subject: string;
  readonly scale: DirectorScale;
  readonly side: DirectorSide;
  readonly score: number;
  readonly size: number;
  readonly why: string;
}

/**
 * Candidates the rules kept out this step: outside `framings` or in `exclude`, outside `scales`, under the size floor.
 */
export interface DirectorRuledOut {
  readonly framings: number;
  readonly scales: number;
  readonly size: number;
}

export interface CameraDirectorStepResult {
  readonly memory: CameraDirectorMemory;
  /**
   * The shot to cut to now.
   */
  readonly cut: Maybe<DirectorPick>;
  /**
   * The director's shot after the step.
   */
  readonly pick: Maybe<DirectorPick>;
  /**
   * The best candidates (at most 3).
   */
  readonly candidates: readonly DirectorCandidateReport[];
  readonly axis: Maybe<DirectorAxis>;
  /**
   * What the rules kept out; omitted when nothing.
   */
  readonly ruledOut?: DirectorRuledOut;
  readonly note?: string;
}

function round(value: number, places = 2): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * Runs one step.
 *
 * @param input - The picture, events, settings, memory, seed and mode.
 * @returns The memory after, the cut (if any), the standing pick and the best candidates.
 */
export function stepCameraDirector(input: CameraDirectorStepInput): CameraDirectorStepResult {
  const { picture, settings, seed, mode } = input;
  const time = picture.time;
  const previous = input.memory ?? emptyCameraDirectorMemory(time);
  const events = sortDirectorEvents(input.events ?? []);
  const current = mode === 'drive' ? previous.current : null;
  // The opening: no cut since a load or a jump cleared the memory. Any later pick with nothing on screen is a take-back.
  const opening = previous.cuts === 0;
  const interest = stepDirectorInterest({ picture, events, settings, memory: previous, first: opening && (mode === 'take' || (mode === 'drive' && !previous.current)), lastLandmark: previous.lastLandmark, keep: current ? [current.subject.key] : [] });
  let memory: CameraDirectorMemory = { ...previous, ...interest.memory };
  const facts = interest.facts;
  const axis = directorAxis(picture, facts);
  if (axisResets(memory.side, axis)) memory = { ...memory, side: null };
  if (mode === 'watch') return { memory, cut: null, pick: previous.current, candidates: [], axis };
  const scene = toDirectorScene(picture);
  const names = new Map(picture.ships.map((ship) => [ship.id, ship.name ?? ship.id]));
  const label = (id: string): string => names.get(id) ?? id;
  const { candidates, ruledOut } = buildCandidates({ picture, settings, seed, memory, facts, axis, scene, subjects: interest.subjects, label });
  const reports = candidates.slice(0, 3).map((candidate) => candidateReport(candidate, label));
  const hold = directorHold(settings);
  let cut: Maybe<DirectorPick> = null;
  let pick: Maybe<DirectorPick> = current;
  let note: Maybe<string> = null;
  const best = candidates[0];
  const choose = (candidate: Maybe<DirectorCandidate>, reason: string, overrides: { transition?: 'cut' | 'blend'; blend?: number; min?: number } = {}): void => {
    if (!candidate) return;
    cut = toPick({ candidate, reason, current, time, tick: picture.tick, hold, settings, memory, facts, label, overrides });
    pick = cut;
  };
  const ruled = ruledOut.framings + ruledOut.scales + ruledOut.size;
  if (!candidates.length) {
    const rules = directorRulesProblem(settings);
    if (rules) note = rules.replace(/^auto_camera: /, '');
    else if (ruled) note = `nothing the rules allow resolves on the scene (${ruledOutText(ruledOut)})`;
    else note = facts.landed.length || picture.arrivals?.length ? 'no framing resolves on the scene' : 'nothing to frame: the scene has no ships';
  } else if (!current) {
    const urgent = best.scored.events >= URGENT_INTEREST ? best : null;
    if (urgent) choose(urgent, opening ? 'first pick (urgent)' : 'taking back (urgent)');
    else if (!opening) choose(best, 'taking back');
    else {
      const favoured = settings.favour ? candidates.find((candidate) => candidate.scale === settings.favour) : null;
      const establishing = !facts.firing ? candidates.find((candidate) => candidate.row.name === 'establishing') : null;
      const wide = candidates.find((candidate) => candidate.scale === 'wide');
      if (favoured) choose(favoured, `first pick (favour ${settings.favour})`);
      else if (establishing) choose(establishing, 'first pick: setting the scene');
      else choose(wide ?? best, 'first pick');
    }
  } else {
    const held = time - current.since;
    const judged = liveScore(current, { scene, facts, subjects: interest.subjects, settings, held, picture });
    const live = 'score' in judged ? judged.score : 0;
    const killed = events.some((event) => event.kind === 'kill' && (current.subject.kind === 'ship' ? current.subject.ship === event.ship : current.subject.kind === 'pair' && current.subject.target === event.ship));
    const victim = current.subject.kind === 'pair' ? current.subject.target : current.subject.kind === 'ship' ? current.subject.ship : null;
    const max = current.framing === 'warp-in' ? Math.max(2 * current.max, (current.landing ?? time) + WARP_IN_LANDED_HOLD - current.since) : current.max;
    // An urgent subject (a kill, an arrival about to land) takes the camera after URGENT_MIN_HOLD, the hold or not; never
    // from a kill framing inside its hold (the blast stays on screen).
    const urgent = best.scored.events >= URGENT_INTEREST && held >= URGENT_MIN_HOLD && best.scored.subject.key !== current.subject.key && !(current.framing === 'kill' && held < current.min);
    if ('invalid' in judged) choose(best, judged.invalid);
    else if (killed && current.framing !== 'kill') {
      const kill = candidates.find((candidate) => candidate.row.name === 'kill' && candidate.scored.subject.kind === 'ship' && candidate.scored.subject.ship === victim);
      if (kill) choose(kill, 'blending to the kill', { transition: 'blend', blend: KILL_BLEND_SECONDS, min: KILL_HOLD });
      else pick = { ...current, min: Math.max(current.min, held + KILL_HOLD) };
    } else if (killed) pick = { ...current, min: Math.max(current.min, held + KILL_HOLD) };
    else if (urgent) choose(best, held < current.min ? 'cut early (urgent)' : 'urgent', best.row.name === 'kill' ? { min: KILL_HOLD } : {});
    else if (held >= current.min) {
      if (held >= max)
        choose(
          candidates.find((candidate) => candidate.key !== current.key),
          `the last shot held ${Math.round(held)} s`
        );
      else if (best.key !== current.key && best.score > live * CUT_RATIO) choose(best, live < 0.05 ? 'the last shot went quiet' : `beats the last shot ×${round(best.score / live, 1)}`);
    }
  }
  memory = cut ? recordDirectorCut(memory, cut, axis, time, picture.tick) : { ...memory, current: pick };
  return { memory, cut, pick, candidates: reports, axis, ...(ruled ? { ruledOut } : {}), ...(note ? { note } : {}) };
}

function ruledOutText(ruledOut: DirectorRuledOut): string {
  const parts = [...(ruledOut.framings ? [`${ruledOut.framings} by framing`] : []), ...(ruledOut.scales ? [`${ruledOut.scales} by scale`] : []), ...(ruledOut.size ? [`${ruledOut.size} under the size floor`] : [])];
  return `ruled out ${parts.join(', ')}`;
}

interface CandidateContext {
  readonly picture: CameraDirectorPicture;
  readonly settings: CameraDirectorSettings;
  readonly seed: number;
  readonly memory: CameraDirectorMemory;
  readonly facts: DirectorPictureFacts;
  readonly axis: Maybe<DirectorAxis>;
  readonly scene: CinemaScene;
  readonly subjects: readonly ScoredDirectorSubject[];
  readonly label: (id: string) => string;
}

/**
 * The engagement core's fill factor: when its radius is over twice its core's (the hulls within
 * WARP_LANDING_CORE_SPREAD × the median distance from the centre), framings fill on the core: logi 30 km out no longer
 * shrink the fight to pixels.
 */
export function engagementCoreFactor(scene: CinemaScene, teams: Maybe<readonly [string, string]>): number {
  const frame = engagementFrame(scene, teams ?? undefined);
  if (!frame) return 1;
  const ships = teams ? scene.ships.filter((ship) => ship.team === teams[0] || ship.team === teams[1]) : scene.ships;
  const distances = ships.map((ship) => distanceVec(ship.frameCentre, frame.centre)).sort((a, b) => a - b);
  const median = distances[Math.floor(distances.length / 2)] ?? 0;
  let core = 0;
  for (const ship of ships) {
    const distance = distanceVec(ship.frameCentre, frame.centre);
    if (distance <= WARP_LANDING_CORE_SPREAD * median + ship.frameRadius) core = Math.max(core, distance + ship.frameRadius);
  }
  return core > 0 && frame.radius > 2 * core ? Math.min(1.5 / 0.9, Math.max(1, frame.radius / core)) : 1;
}

function applies(row: DirectorFramingRow, scored: ScoredDirectorSubject, context: CandidateContext, landmark: boolean): boolean {
  const { subject } = scored;
  const { facts } = context;
  const shipOf = (id: string) => facts.ships.get(id)?.ship;
  let ok = true;
  if (subject.kind === 'ship') {
    const ship = shipOf(subject.ship);
    const speed = ship?.speed ?? 0;
    const top = ship?.maxVelocity ?? 0;
    if (!ship) ok = false;
    else if (row.name === 'kill') ok = Boolean(scored.doomed || scored.killed) && (!ship.destroyed || ship.destroyed.removesIn >= REMOVAL_MIN_SECONDS);
    else if (ship.destroyed) ok = false;
    else if (row.name === 'bow-on') ok = top > 0 ? speed > 0.3 * top : speed > 100;
    else if (row.name === 'chase') ok = top > 0 ? speed > 0.2 * top : speed > 50;
    else if (row.name === 'flyby') ok = speed > 100;
  } else if (subject.kind === 'pair') {
    const ship = shipOf(subject.ship);
    const target = shipOf(subject.target);
    ok = Boolean(ship && target && !ship.destroyed && (!target.destroyed || target.destroyed.removesIn >= REMOVAL_MIN_SECONDS));
  } else if (subject.kind === 'group') {
    const leader = subject.leader ? shipOf(subject.leader) : null;
    // Warp-in plays on a group's lead: its arrival's first landing, or a Destiny warp landing near the action, soon.
    if (row.name === 'warp-in') ok = Boolean(subject.warping) && ((subject.arrival != null && context.memory.arrivals[subject.arrival] != null) || context.memory.arrivals[`warp:${subject.key}`] != null);
    else if (row.name === 'behind-fc') ok = facts.landed.some((ship) => ship.team != null && leader?.team != null && ship.team !== leader.team);
    else if (row.name === 'leading-edge') ok = (leader?.speed ?? 0) > 20;
  } else if (subject.kind === 'engagement') {
    const sun = normalizeVec(context.picture.sunDirection);
    if (row.name === 'overlook-pull-out') ok = facts.engagedAt != null && context.picture.time - facts.engagedAt < ENGAGE_SHOT_SECONDS;
    else if (row.name === 'into-sun') ok = Boolean(sun) && Math.abs(dotVec(sun ?? [0, 1, 0], WORLD_UP)) < Math.cos((SUN_VERTICAL_DEGREES * Math.PI) / 180);
    else if (row.name === 'into-celestial') ok = landmark;
    else if (row.name === 'battle-fly-through') ok = facts.teams != null && facts.intensity > 0.5;
  }
  return ok;
}

/**
 * Whether an eye stands inside a landmark (a scene object or a celestial; a station or gate at STRUCTURE_EYE_FRACTION of its
 * map radius) × LANDMARK_EYE_CLEARANCE.
 */
export function eyeInsideLandmark(eye: SceneVector, scene: CinemaScene): boolean {
  const inside = (centre: SceneVector, radius: number): boolean => radius > 0 && distanceVec(eye, centre) < radius * LANDMARK_EYE_CLEARANCE;
  return (scene.objects ?? []).some((object) => inside(object.centre, object.radius)) || (scene.celestials ?? []).some((celestial) => inside(celestial.position, celestial.kind === 'station' || celestial.kind === 'stargate' ? celestial.radius * STRUCTURE_EYE_FRACTION : celestial.radius));
}

function scaleWeight(scale: DirectorScale, favour: Maybe<DirectorScale>): number {
  let weight = 1;
  if (favour) {
    const distance = Math.abs(DIRECTOR_SCALES.indexOf(scale) - DIRECTOR_SCALES.indexOf(favour));
    if (distance === 0) weight = 1.8;
    else if (distance > 1) weight = 0.6;
  }
  return weight;
}

/**
 * A framing that may raise its fill to reach the size floor: group framings but warp-in, engagement framings but the
 * fly-through (its path ignores fill).
 */
function tightenable(row: DirectorFramingRow): boolean {
  return (row.subject === 'group' && row.name !== 'warp-in') || (row.subject === 'engagement' && row.name !== 'battle-fly-through');
}

interface Tightened {
  readonly hardpoint: HardpointRef;
  readonly resolved: ResolvedHardpoint;
  readonly pose: CameraPose;
  readonly size: number;
  readonly fill: number;
}

/**
 * A candidate under the size floor re-resolved with a raised fill (fill × floor ÷ size × TIGHTEN_MARGIN, at most
 * MAX_HARDPOINT_FILL, TIGHTEN_TRIES times); null when it cannot reach the floor.
 */
function tighten(row: DirectorFramingRow, hardpoint: HardpointRef, size: number, floor: number, scene: CinemaScene, measure: (resolved: ResolvedHardpoint, pose: CameraPose) => number): Maybe<Tightened> {
  let fill = hardpoint.fill ?? framingDefaultFill(row);
  let measured = size;
  let result: Maybe<Tightened> = null;
  for (let attempt = 0; tightenable(row) && fill != null && !result && attempt < TIGHTEN_TRIES && fill < MAX_HARDPOINT_FILL; attempt++) {
    fill = Math.min(MAX_HARDPOINT_FILL, Math.ceil(fill * (floor / Math.max(measured, 1e-9)) * TIGHTEN_MARGIN * 100) / 100);
    const ref: HardpointRef = { ...hardpoint, fill };
    const resolved = resolveHardpoint(ref, scene);
    const pose = resolved.pose;
    if (!pose || eyeInsideLandmark(pose.eye, scene)) break;
    measured = measure(resolved, pose);
    if (measured >= floor) result = { hardpoint: ref, resolved, pose, size: measured, fill };
  }
  return result;
}

function buildCandidates(context: CandidateContext): { readonly candidates: DirectorCandidate[]; readonly ruledOut: DirectorRuledOut } {
  const { settings, seed, memory, axis, scene, subjects, picture, facts } = context;
  const floor = settings.minShipSize;
  const ruledOut = { framings: 0, scales: 0, size: 0 };
  const landmark = subjects.find((entry) => entry.subject.kind === 'landmark')?.subject;
  const coreFactor = engagementCoreFactor(scene, facts.teams);
  const recent = memory.recent;
  const lastShot = recent[0];
  const side = memory.side;
  const candidates: DirectorCandidate[] = [];
  for (const scored of subjects) {
    for (const row of DIRECTOR_FRAMINGS) {
      if (row.subject !== scored.subject.kind || !applies(row, scored, context, Boolean(landmark))) continue;
      const scale = framingScale(row, scored.subject);
      if (!directorFramingAllowed(row.name, settings)) {
        ruledOut.framings += 1;
        continue;
      }
      if (settings.scales && !settings.scales.includes(scale)) {
        ruledOut.scales += 1;
        continue;
      }
      for (const variant of row.variants ?? [undefined]) {
        const radius = scored.subject.kind === 'ship' ? (facts.ships.get(scored.subject.ship)?.ship.radius ?? 0) : 0;
        const framed = toFramingShot(row, scored.subject, variant, {
          transition: { type: 'cut' },
          coreFactor,
          teams: settings.teams,
          radius,
          ...(landmark?.kind === 'landmark' ? { landmark: { ...(landmark.object != null ? { object: landmark.object } : {}), ...(landmark.celestial != null ? { celestial: landmark.celestial } : {}) } } : {})
        });
        if (!framed) continue;
        let hardpoint = framed.hardpoint;
        let resolved = resolveHardpoint(hardpoint, scene);
        let pose = resolved.pose;
        if (!pose || eyeInsideLandmark(pose.eye, scene)) continue;
        const notes: string[] = [];
        const measure = (judged: ResolvedHardpoint, judgedPose: CameraPose): number => framedShipSize({ scene, framing: row.name, subject: scored.subject, resolved: judged, pose: judgedPose, teams: facts.teams });
        let size = measure(resolved, pose);
        let fill: Maybe<number> = null;
        if (floor > 0 && size < floor) {
          const tightened = tighten(row, hardpoint, size, floor, scene, measure);
          if (!tightened) {
            ruledOut.size += 1;
            continue;
          }
          ({ hardpoint, resolved, pose, size, fill } = tightened);
          notes.push(`tightened to fill ${fill}`);
        }
        let view: -1 | 0 | 1 = 0;
        let lean: -1 | 0 | 1 = 0;
        if (axis) {
          if (row.crossing) view = variant === 'starboard' ? 1 : -1;
          else if (row.name === 'flyby' && scored.subject.kind === 'ship') {
            const ship = facts.ships.get(scored.subject.ship)?.ship;
            view = ship ? flybyViewSide(pose.eye, ship, axis) : 0;
          } else view = viewSideOf(pose, axis);
          lean = leanOf(pose.eye, resolved.subject?.centre ?? pose.look, axis);
        }
        let axisFactor = 1;
        let crossing = Boolean(row.crossing);
        if (side && view === -side.value) {
          const neutralBefore = lastShot != null && lastShot.side === 'neutral';
          if (row.crossing || !neutralBefore) continue;
          axisFactor = 0.6;
          crossing = true;
          notes.push('crossing after a neutral shot');
        } else if (side && view === 0 && lean === -side.value) axisFactor = 0.85;
        let weight = row.weight;
        if (row.name === 'into-sun' && settings.sun) {
          weight *= 2.5;
          notes.push('into the sun');
        }
        let rhythm = 1;
        if (lastShot && lastShot.scale === scale && recent[1]?.scale === scale) rhythm = 0.3;
        else if (lastShot?.scale === 'wide' && scale === 'wide') rhythm = settings.favour === 'wide' ? 0.8 : 0.5;
        else if (lastShot?.scale === 'close' && scale === 'close') rhythm = 0.7;
        let variety = 1;
        if (recent.some((shot) => shot.framing === row.name && shot.subject === scored.subject.key)) variety *= 0.25;
        if (lastShot?.framing === row.name) variety *= 0.5;
        if (lastShot?.subject === scored.subject.key && lastShot.scale === scale) variety *= 0.4;
        if (recent.slice(0, 2).some((shot) => shot.subject === scored.subject.key) && scored.events <= VARIETY_WAIVER_INTEREST) variety *= 0.8;
        const key = [row.name, scored.subject.key, ...(variant ? [variant] : [])].join('|');
        const jitter = 1 + 0.06 * (fleetTraitUnit(seed, `camera|${picture.tick}|${key}`) - 0.5);
        const plain = scored.interest * weight * scaleWeight(scale, settings.favour);
        candidates.push({ key, row, ...(variant ? { variant } : {}), scored, scale, view, lean, crossing, score: plain * rhythm * variety * axisFactor * jitter, plain, notes, hardpoint, pose, size, ...(fill == null ? {} : { fill }) });
      }
    }
  }
  sunward(candidates, picture.sunDirection);
  return { candidates: candidates.sort((a, b) => b.score - a.score || compareDirectorKeys(a.key, b.key)), ruledOut };
}

/**
 * The sunward warp-in of each group (the eye whose direction runs most against the light) ×1.15.
 */
function sunward(candidates: DirectorCandidate[], sunDirection: SceneVector): void {
  const light = normalizeVec(sunDirection);
  if (!light) return;
  const bySubject = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    if (candidate.row.name === 'warp-in') bySubject.set(candidate.scored.subject.key, [...(bySubject.get(candidate.scored.subject.key) ?? []), index]);
  });
  for (const indexes of bySubject.values()) {
    if (indexes.length < 2) continue;
    const facing = (index: number): number => dotVec(normalizeVec(subVec(candidates[index].pose.eye, candidates[index].pose.look)) ?? [0, 0, 0], light);
    const best = indexes.reduce((a, b) => (facing(b) < facing(a) ? b : a));
    const candidate = candidates[best];
    candidates[best] = { ...candidate, score: candidate.score * 1.15, plain: candidate.plain * 1.15, notes: [...candidate.notes, 'sunward'] };
  }
}

interface LiveContext {
  readonly scene: CinemaScene;
  readonly facts: DirectorPictureFacts;
  readonly subjects: readonly ScoredDirectorSubject[];
  readonly settings: CameraDirectorSettings;
  readonly held: number;
  readonly picture: CameraDirectorPicture;
}

/**
 * The current shot's live score: its framing's score now with no variety penalty on itself, × continuity; or why it is
 * invalid (its subject gone or about to be removed, its hardpoint unresolvable, ruled out by the rules, or shrunk under
 * SIZE_KEEP_FACTOR × the size floor).
 */
function liveScore(current: DirectorPick, context: LiveContext): { readonly score: number } | { readonly invalid: string } {
  const { facts, settings, held } = context;
  const scored = context.subjects.find((entry) => entry.subject.key === current.subject.key);
  const ids = current.subject.kind === 'ship' ? [current.subject.ship] : current.subject.kind === 'pair' ? [current.subject.ship, current.subject.target] : [];
  const removing = ids.some((id) => {
    const ship = facts.ships.get(id)?.ship;
    return !ship || (ship.destroyed != null && ship.destroyed.removesIn < REMOVAL_CUT_SECONDS);
  });
  const resolved = scored && !removing ? resolveHardpoint(current.hardpoint, context.scene) : null;
  const floor = settings.minShipSize;
  let live: { readonly score: number } | { readonly invalid: string } = { invalid: `the last shot (${current.framing} ${current.label}) lost its subject` };
  if (scored && resolved?.pose) {
    const size = floor > 0 ? framedShipSize({ scene: context.scene, framing: current.framing, subject: scored.subject, resolved, pose: resolved.pose, teams: facts.teams }) : Infinity;
    if (!directorFramingAllowed(current.framing, settings) || (settings.scales && !settings.scales.includes(current.scale))) live = { invalid: `auto_camera rules out ${current.framing} now` };
    else if (size < SIZE_KEEP_FACTOR * floor) live = { invalid: `${current.framing} on ${current.label} shrank to ${shipSizeText(size)} (floor ${shipSizeText(floor)})` };
    else {
      const row = DIRECTOR_FRAMING_ROWS.get(current.framing);
      const weight = (row?.weight ?? 1) * (current.framing === 'into-sun' && settings.sun ? 2.5 : 1);
      const span = Math.max(1e-6, current.max - current.min);
      const continuity = 1.25 - 0.5 * Math.min(1, Math.max(0, (held - current.min) / span));
      live = { score: scored.interest * weight * scaleWeight(current.scale, settings.favour) * continuity };
    }
  }
  return live;
}

interface PickContext {
  readonly candidate: DirectorCandidate;
  readonly reason: string;
  readonly current: Maybe<DirectorPick>;
  readonly time: number;
  readonly tick: number;
  readonly hold: { readonly min: number; readonly max: number };
  readonly settings: CameraDirectorSettings;
  readonly memory: CameraDirectorMemory;
  readonly facts: DirectorPictureFacts;
  readonly label: (id: string) => string;
  readonly overrides: { readonly transition?: 'cut' | 'blend'; readonly blend?: number; readonly min?: number };
}

function memberOf(subject: DirectorSubject, ship: string): boolean {
  return subject.kind === 'group' && subject.members.includes(ship);
}

function toPick(context: PickContext): DirectorPick {
  const { candidate, current, time, tick, hold, settings, overrides, label } = context;
  const { row, scored, variant } = candidate;
  const subject = scored.subject;
  // A blend when the subject stays (or the new group holds the old ship) and the scale moves one step; warp-in and the
  // flyby always cut.
  let transition: 'cut' | 'blend' = 'cut';
  let blend = SCALE_BLEND_SECONDS;
  const steps = current ? Math.abs(DIRECTOR_SCALES.indexOf(current.scale) - DIRECTOR_SCALES.indexOf(candidate.scale)) : 0;
  const same = current != null && (current.subject.key === subject.key || (current.subject.kind === 'ship' && memberOf(subject, current.subject.ship)));
  if (overrides.transition) {
    transition = overrides.transition;
    blend = overrides.blend ?? blend;
  } else if (row.name !== 'warp-in' && row.name !== 'flyby' && same && steps === 1) transition = 'blend';
  const min = overrides.min ?? hold.min;
  const max = Math.max(hold.max, min + 1);
  const duration = row.name === 'warp-in' ? undefined : Math.round((hold.min + hold.max) / 2);
  const radius = subject.kind === 'ship' ? (context.facts.ships.get(subject.ship)?.ship.radius ?? 0) : 0;
  const framed = toFramingShot(row, subject, variant, {
    ...(duration == null ? {} : { duration }),
    transition: transition === 'blend' ? { type: 'blend', duration: blend, easing: 'ease-in-out' } : { type: 'cut' },
    letterbox: settings.letterbox,
    hud: settings.hud,
    coreFactor: 1,
    teams: settings.teams,
    radius,
    ...(candidate.hardpoint.object != null || candidate.hardpoint.celestial != null ? { landmark: { ...(candidate.hardpoint.object != null ? { object: candidate.hardpoint.object } : {}), ...(typeof candidate.hardpoint.celestial === 'number' ? { celestial: candidate.hardpoint.celestial } : {}) } } : {})
  });
  // The shot plays the hardpoint the candidate was judged on (the core fill included).
  const shot: JsonObject = framed ? withHardpointOptions(framed.shot, candidate.hardpoint) : {};
  const subjectText = subjectLabel(subject, label);
  const top = scored.terms[0];
  const event = scored.terms.find((term) => term.event)?.event;
  const framing = [[row.name, ...(variant ? [variant] : [])].join(' '), ...candidate.notes].join(', ');
  const why = [top?.why ?? subjectText, `${framing} on ${subjectText}`, context.reason].join(' · ');
  const arrival = subject.kind === 'group' ? ((subject.arrival ? context.memory.arrivals[subject.arrival] : undefined) ?? context.memory.arrivals[`warp:${subject.key}`]) : undefined;
  return {
    key: candidate.key,
    framing: row.name,
    ...(variant ? { variant } : {}),
    subject,
    label: subjectText,
    scale: candidate.scale,
    side: sideName(candidate.view),
    ...(candidate.crossing ? { crossing: true } : {}),
    since: time,
    tick,
    min,
    max,
    ...(arrival == null ? {} : { landing: arrival }),
    score: round(candidate.score, 3),
    size: candidate.size,
    ...(candidate.fill == null ? {} : { fill: candidate.fill }),
    why,
    ...(event ? { event } : {}),
    transition,
    shot,
    hardpoint: candidate.hardpoint
  };
}

/**
 * Carries the judged hardpoint's options (fill, side, teams, landmark) onto the shot: on an explicit shot's hardpoint,
 * or beside a library reference.
 */
function withHardpointOptions(shot: JsonObject, hardpoint: HardpointRef): JsonObject {
  let result = shot;
  if (hardpoint.fill != null) {
    if (shot['hardpoint'] && typeof shot['hardpoint'] === 'object') result = { ...shot, hardpoint: { ...(shot['hardpoint'] as JsonObject), fill: hardpoint.fill } };
    else result = { ...shot, fill: hardpoint.fill };
  }
  return result;
}

function sideValue(side: DirectorSide): -1 | 0 | 1 {
  let value: -1 | 0 | 1 = 0;
  if (side === 'starboard') value = 1;
  else if (side === 'port') value = -1;
  return value;
}

/**
 * The memory after a cut: the kept side (set by a sided shot, flipped by a crossing framing, cleared with no axis), the
 * shot on screen, the recent shots, the last landmark shot, and the cut log.
 */
export function recordDirectorCut(memory: CameraDirectorMemory, cut: DirectorPick, axis: Maybe<DirectorAxis>, time: number, tick: number): CameraDirectorMemory {
  let side = memory.side;
  const view = sideValue(cut.side);
  if (!axis) side = null;
  else if (DIRECTOR_FRAMING_ROWS.get(cut.framing)?.crossing) side = { value: view === 1 ? -1 : 1, forward: axis.forward, key: axis.key };
  else if (view !== 0) side = { value: view, forward: axis.forward, key: axis.key };
  const recent: DirectorRecentShot = { at: time, framing: cut.framing, subject: cut.subject.key, label: cut.label, scale: cut.scale, side: cut.side, why: cut.why };
  const entry: DirectorCutLogEntry = { tick, at: round(time, 3), framing: cut.framing, subject: cut.label, scale: cut.scale, side: cut.side, ...(cut.crossing ? { crossing: true } : {}), ...(memory.side == null ? { free: true } : {}), size: roundShipSize(cut.size), why: cut.why };
  return {
    ...memory,
    side,
    current: cut,
    recent: [recent, ...memory.recent].slice(0, RECENT_SHOTS),
    lastLandmark: cut.subject.kind === 'landmark' || cut.framing === 'into-celestial' ? time : memory.lastLandmark,
    cuts: memory.cuts + 1,
    log: [...memory.log, entry].slice(-DIRECTOR_LOG_LENGTH)
  };
}

function candidateReport(candidate: DirectorCandidate, label: (id: string) => string): DirectorCandidateReport {
  const top = candidate.scored.terms[0];
  return {
    framing: candidate.row.name,
    ...(candidate.variant ? { variant: candidate.variant } : {}),
    subject: subjectLabel(candidate.scored.subject, label),
    scale: candidate.scale,
    side: sideName(candidate.view),
    score: round(candidate.score, 3),
    size: roundShipSize(candidate.size),
    why: top?.why ?? subjectLabel(candidate.scored.subject, label)
  };
}
