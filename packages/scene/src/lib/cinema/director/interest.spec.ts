import { describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA_DIRECTOR_SETTINGS, type CameraDirectorSettings } from './command';
import { directorPicture, directorShip, twoFleets } from './director.spec-helper';
import type { CameraDirectorEvent } from './events';
import { decayedInterest, EMPTY_DIRECTOR_INTEREST, ENGAGE_QUIET_SECONDS, ENGAGE_WATCH_SECONDS, stepDirectorInterest, type DirectorInterestMemory, type ScoredDirectorSubject } from './interest';
import type { CameraDirectorPicture } from './picture';

function step(picture: CameraDirectorPicture, events: CameraDirectorEvent[] = [], memory: DirectorInterestMemory = EMPTY_DIRECTOR_INTEREST, settings: Partial<CameraDirectorSettings> = {}) {
  return stepDirectorInterest({ picture, events, settings: { ...DEFAULT_CAMERA_DIRECTOR_SETTINGS, ...settings }, memory, first: false, lastLandmark: 0 });
}

function subject(subjects: readonly ScoredDirectorSubject[], key: string): ScoredDirectorSubject {
  const found = subjects.find((entry) => entry.subject.key === key);
  if (!found) throw new Error(`no subject ${key}`);
  return found;
}

describe('camera director interest', () => {
  it('decays an event by its half-life and drops it under the floor', () => {
    const { ships, fleets } = twoFleets();
    const killed = step(directorPicture(0, ships, fleets), [{ kind: 'kill', tick: 0, ship: 'red-2', by: 'blue-1' }]);
    const entry = killed.memory.interest.find((candidate) => candidate.kind === 'kill');
    expect(entry && decayedInterest(entry, 5)).toBeCloseTo(5);
    expect(entry && decayedInterest(entry, 10)).toBeCloseTo(2.5);
    const later = step(directorPicture(60, ships, fleets), [], killed.memory);
    expect(later.memory.interest.some((candidate) => candidate.kind === 'kill')).toBe(false);
  });

  it('ranks a kill over a primary switch over an MWD, and a lower time to live dooms harder', () => {
    const { ships, fleets } = twoFleets();
    const at = (events: CameraDirectorEvent[], id: string): number => subject(step(directorPicture(0, ships, fleets), events).subjects, `ship:${id}`).events;
    expect(at([{ kind: 'kill', tick: 0, ship: 'red-2' }], 'red-2')).toBeGreaterThan(at([{ kind: 'primary', tick: 0, fleet: 'blue', primary: 'red-2' }], 'red-2'));
    expect(at([{ kind: 'primary', tick: 0, fleet: 'blue', primary: 'red-2' }], 'red-2')).toBeGreaterThan(at([{ kind: 'prop-mod', tick: 0, ship: 'red-2' }], 'red-2'));
    const hurt = (remaining: number) => twoFleets({ red: { health: 0.3, remaining, pressure: 200 } });
    const doom = (remaining: number): number => {
      const scene = hurt(remaining);
      return subject(step(directorPicture(0, scene.ships, scene.fleets)).subjects, 'ship:red-2').continuous;
    };
    expect(doom(400)).toBeGreaterThan(doom(1600));
    expect(doom(400)).toBeGreaterThan(0);
  });

  it('multiplies the FC and the followed subject', () => {
    const { ships, fleets } = twoFleets();
    const plain = step(directorPicture(0, ships, fleets)).subjects;
    const followed = step(directorPicture(0, ships, fleets), [], EMPTY_DIRECTOR_INTEREST, { follow: { fleet: 'blue' } }).subjects;
    expect(subject(plain, 'ship:blue-fc').interest).toBeGreaterThan(subject(plain, 'ship:blue-1').interest);
    expect(subject(followed, 'ship:blue-fc').interest).toBeGreaterThan(2 * subject(plain, 'ship:blue-fc').interest);
    expect(subject(followed, 'ship:blue-1').interest).toBeGreaterThan(subject(plain, 'ship:blue-1').interest);
    expect(subject(followed, 'fleet:blue').interest).toBeGreaterThan(subject(followed, 'fleet:red').interest);
  });

  it('fires engage once when a team pair opens fire, and again only after a quiet spell', () => {
    const quiet = twoFleets();
    const firing = twoFleets({ blue: { dealt: 100, target: 'red-1' } });
    const engages = (memory: DirectorInterestMemory): number => memory.interest.filter((entry) => entry.kind === 'engage' && entry.subject === 'engagement').length;
    let result = step(directorPicture(0, quiet.ships, quiet.fleets));
    expect(engages(result.memory)).toBe(0);
    result = step(directorPicture(1, firing.ships, firing.fleets), [], result.memory);
    const first = result.memory.interest.find((entry) => entry.kind === 'engage' && entry.subject === 'engagement');
    expect(first?.time).toBe(1);
    result = step(directorPicture(2, firing.ships, firing.fleets), [], result.memory);
    expect(result.memory.interest.find((entry) => entry.kind === 'engage' && entry.subject === 'engagement')?.time).toBe(1);
    // The quiet spell, watched boundary by boundary.
    for (let tick = 3; tick < 3 + ENGAGE_QUIET_SECONDS; tick += 1) result = step(directorPicture(tick, quiet.ships, quiet.fleets), [], result.memory);
    result = step(directorPicture(3 + ENGAGE_QUIET_SECONDS, firing.ships, firing.fleets), [], result.memory);
    expect(result.memory.interest.find((entry) => entry.kind === 'engage' && entry.subject === 'engagement')?.time).toBe(3 + ENGAGE_QUIET_SECONDS);
    expect(engages(result.memory)).toBe(1);
  });

  it('records a fight already in progress as firing, not as an engage: on a fresh memory or after a gap', () => {
    const quiet = twoFleets();
    const firing = twoFleets({ blue: { dealt: 100, target: 'red-1' } });
    const engages = (memory: DirectorInterestMemory): number => memory.interest.filter((entry) => entry.kind === 'engage').length;
    let result = step(directorPicture(40, firing.ships, firing.fleets));
    expect(engages(result.memory)).toBe(0);
    expect(result.memory.firing['blue|red']).toBe(40);
    expect(result.memory.observed).toBe(40);
    // A boundary watched, then a gap past ENGAGE_WATCH_SECONDS (the director was off) before the fire.
    result = step(directorPicture(0, quiet.ships, quiet.fleets));
    result = step(directorPicture(1 + ENGAGE_WATCH_SECONDS, firing.ships, firing.fleets), [], result.memory);
    expect(engages(result.memory)).toBe(0);
  });

  it('fires a head-on pass once per pair, never for parallel flight', () => {
    const fleets = twoFleets().fleets;
    const headOn = (tick: number) => [directorShip('a', [0, 0, -600 + tick * 0], { velocity: [0, 0, 300] }), directorShip('b', [200, 0, 600], { velocity: [0, 0, -300] })];
    let result = step(directorPicture(0, headOn(0), fleets));
    expect(result.memory.interest.filter((entry) => entry.kind === 'pass').map((entry) => entry.subject)).toEqual(expect.arrayContaining(['ship:a', 'pair:a>b']));
    const count = result.memory.interest.filter((entry) => entry.kind === 'pass').length;
    result = step(directorPicture(1, headOn(1), fleets), [], result.memory);
    expect(result.memory.interest.filter((entry) => entry.kind === 'pass')).toHaveLength(count);
    expect(result.memory.interest.find((entry) => entry.kind === 'pass')?.time).toBe(0);
    const parallel = [directorShip('a', [0, 0, 0], { velocity: [0, 0, 300] }), directorShip('b', [200, 0, 0], { velocity: [0, 0, 300] })];
    expect(step(directorPicture(0, parallel, fleets)).memory.interest.some((entry) => entry.kind === 'pass')).toBe(false);
  });

  it('leads an arrival by warp before its first landing, holding full weight until it lands', () => {
    const { ships, fleets } = twoFleets();
    const arrivals = [{ group: 'red-in', fleet: 'red', ships: ['red-fc'], state: 'warping', lands: 4 }];
    const result = step(directorPicture(10, ships, fleets, { arrivals }));
    const entry = result.memory.interest.find((candidate) => candidate.kind === 'arrival');
    expect(entry?.subject).toBe('fleet:red');
    expect(entry && decayedInterest(entry, 12)).toBeCloseTo(9);
    expect(result.memory.arrivals['red-in']).toBe(14);
  });
});
