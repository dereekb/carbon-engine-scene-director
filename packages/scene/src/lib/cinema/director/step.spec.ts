import { describe, expect, it } from 'vitest';
import type { SceneVector } from '../../scene';
import { DEFAULT_CAMERA_DIRECTOR_SETTINGS, type CameraDirectorSettings } from './command';
import { cutsOf, directorFleet, directorPicture, directorShip, runDirector, twoFleets } from './director.spec-helper';
import type { CameraDirectorEvent } from './events';
import type { CameraDirectorPicture, DirectorShip } from './picture';
import { toDirectorScene } from './picture';
import { emptyCameraDirectorMemory, eyeInsideLandmark, recordDirectorCut, stepCameraDirector, type CameraDirectorMemory, type CameraDirectorMode, type DirectorPick } from './step';

function calm(tick: number) {
  const { ships, fleets } = twoFleets();
  return { picture: directorPicture(tick, ships, fleets) };
}

function gaps(cuts: readonly { tick: number }[]): number[] {
  return cuts.slice(1).map((cut, index) => cut.tick - cuts[index].tick);
}

function share(cuts: readonly { scale: string }[], scale: string): number {
  return cuts.filter((cut) => cut.scale === scale).length / Math.max(1, cuts.length);
}

/**
 * Steps until the pick frames a ship (favour close), returning the memory and the ship.
 */
function untilShip(frame: (tick: number) => { picture: CameraDirectorPicture }, settings: Partial<CameraDirectorSettings> = { favour: 'close' }): { memory: CameraDirectorMemory; tick: number; ship: string } {
  let memory: CameraDirectorMemory | null = null;
  for (let tick = 0; tick < 60; tick += 1) {
    const run = runDirector(1, frame, { settings, from: tick, ...(memory ? { memory } : {}) });
    memory = run.memory;
    const pick = memory.current;
    if (pick?.subject.kind === 'ship' && run.results[0].cut) return { memory, tick, ship: pick.subject.ship };
  }
  throw new Error('never framed a ship');
}

describe('camera director step', () => {
  it('takes the camera with a wide first pick, then holds every shot between min and max', () => {
    const run = runDirector(60, calm);
    const cuts = cutsOf(run);
    expect(cuts[0]).toMatchObject({ tick: 0, scale: 'wide' });
    expect(cuts.length).toBeGreaterThanOrEqual(5);
    for (const gap of gaps(cuts)) {
      expect(gap).toBeGreaterThanOrEqual(4);
      expect(gap).toBeLessThanOrEqual(12);
    }
    expect(run.results.every((result) => result.candidates.length <= 3)).toBe(true);
    expect(run.memory.current?.why).toMatch(/ · /);
  });

  it('varies: no framing on the same subject within 8 cuts, never three in a row at one scale, two or more scales', () => {
    const cuts = cutsOf(runDirector(90, calm));
    for (const [index, cut] of cuts.entries()) {
      const before = cuts.slice(Math.max(0, index - 8), index);
      expect(before.some((other) => other.framing === cut.framing && other.subject === cut.subject)).toBe(false);
      if (index >= 2) expect(cuts[index - 1].scale === cut.scale && cuts[index - 2].scale === cut.scale).toBe(false);
    }
    expect(new Set(cuts.map((cut) => cut.scale)).size).toBeGreaterThanOrEqual(2);
  });

  it('keeps one side of the axis: no cut from one side to the other without a neutral shot or a crossing framing between', () => {
    const run = runDirector(120, calm);
    let last = 0;
    for (const result of run.results) {
      const cut = result.cut;
      if (!cut) continue;
      const value = cut.side === 'starboard' ? 1 : cut.side === 'port' ? -1 : 0;
      if (value !== 0 && last !== 0 && !cut.crossing) expect(value).toBe(last);
      last = cut.crossing && cut.framing === 'battle-fly-through' ? -value : value;
    }
  });

  it('favours wide shots, and into the sun with sun', () => {
    const plain = cutsOf(runDirector(80, calm));
    const wide = cutsOf(runDirector(80, calm, { settings: { favour: 'wide' } }));
    expect(share(wide, 'wide')).toBeGreaterThan(share(plain, 'wide'));
    const sunny = cutsOf(runDirector(80, calm, { settings: { sun: true, favour: 'wide' } }));
    expect(sunny.some((cut) => cut.framing === 'into-sun')).toBe(true);
  });

  it('follows the followed fleet: its FC in at least half the calm picks', () => {
    const run = runDirector(90, calm, { settings: { follow: { fleet: 'blue' } } });
    const picks = run.results.flatMap((result) => (result.cut ? [result.cut] : []));
    const withFc = picks.filter((pick) => (pick.subject.kind === 'ship' && pick.subject.ship === 'blue-fc') || (pick.subject.kind === 'pair' && (pick.subject.ship === 'blue-fc' || pick.subject.target === 'blue-fc')) || (pick.subject.kind === 'group' && pick.subject.members.includes('blue-fc')));
    expect(withFc.length / picks.length).toBeGreaterThanOrEqual(0.5);
  });

  it('cuts early to an urgent kill after 2 s', () => {
    const frame = (tick: number) => {
      const { ships, fleets } = twoFleets();
      const dead = tick >= 2 ? ships.map((ship) => (ship.id === 'red-3' ? { ...ship, health: 0, remaining: 0, destroyed: { tick: 2, removesIn: 10 - (tick - 2) } } : ship)) : ships;
      const events: CameraDirectorEvent[] = tick === 2 ? [{ kind: 'kill', tick: 2, ship: 'red-3', by: 'blue-1' }] : [];
      return { picture: directorPicture(tick, dead, fleets), events };
    };
    const cuts = cutsOf(runDirector(4, frame));
    expect(cuts[1]).toMatchObject({ tick: 2, framing: 'kill', subject: 'ship:red-3' });
  });

  it('blends to the kill framing when the framed ship dies, and holds it through the blast', () => {
    const { memory, tick, ship } = untilShip(calm);
    const frame = (at: number) => {
      const { ships, fleets } = twoFleets();
      const dead = ships.map((candidate) => (candidate.id === ship ? { ...candidate, health: 0, remaining: 0, destroyed: { tick: tick + 1, removesIn: 12 - (at - tick - 1) } } : candidate));
      return { picture: directorPicture(at, dead, fleets), events: at === tick + 1 ? ([{ kind: 'kill', tick: at, ship }] as CameraDirectorEvent[]) : [] };
    };
    const run = runDirector(5, frame, { memory, from: tick + 1, settings: { favour: 'close' } });
    expect(run.results[0].cut).toMatchObject({ framing: 'kill', transition: 'blend', subject: { kind: 'ship', ship } });
    expect(run.results[0].cut?.shot['transition']).toEqual({ type: 'blend', duration: 1, easing: 'ease-in-out' });
    expect(run.results.slice(1, 4).every((result) => !result.cut)).toBe(true);
  });

  it('pre-cuts to warp-in 5 s before a fleet lands, on its landing', () => {
    const landingAt = 12;
    const frame = (tick: number) => {
      const blue = twoFleets().ships.filter((ship) => ship.team === 'blue');
      const lands = landingAt - tick;
      const red: DirectorShip[] = [0, 1, 2, 3, 4].map((i) => directorShip(i ? `red-${i}` : 'red-fc', [(i - 2) * 600, 0, 200000], { team: 'red', ...(lands > 0 ? { arriving: { landing: [(i - 2) * 600, 0, 20000] as SceneVector, landsIn: lands } } : {}) }));
      const fleets = [twoFleets().fleets[0], directorFleet('red', 'red-fc', ['red-1', 'red-2', 'red-3', 'red-4'])];
      return { picture: directorPicture(tick, [...blue, ...red], fleets, { arrivals: [{ group: 'red-in', fleet: 'red', ships: red.map((ship) => ship.id), state: lands > 0 ? 'warping' : 'landed', lands }] }) };
    };
    const cuts = cutsOf(runDirector(14, frame));
    const warpIn = cuts.find((cut) => cut.framing === 'warp-in');
    expect(warpIn).toMatchObject({ tick: landingAt - 5, subject: 'fleet:red', transition: 'cut' });
    // It holds past the landing.
    expect(cuts.filter((cut) => cut.tick > (warpIn?.tick ?? 0) && cut.tick <= landingAt + 2)).toEqual([]);
  });

  it('cuts at once when the framed subject leaves the scene', () => {
    const { memory, tick, ship } = untilShip(calm);
    const frame = (at: number) => {
      const { ships, fleets } = twoFleets();
      return {
        picture: directorPicture(
          at,
          ships.filter((candidate) => candidate.id !== ship),
          fleets
        )
      };
    };
    const run = runDirector(1, frame, { memory, from: tick + 1 });
    expect(run.results[0].cut?.why).toMatch(/lost its subject/);
  });

  it('refuses an eye inside a landmark', () => {
    const { ships, fleets } = twoFleets();
    const scene = toDirectorScene(directorPicture(0, ships, fleets, { objects: [{ id: 'cnap', centre: [0, 5000, 10000], radius: 4000, rotation: [0, 0, 0, 1] }] }));
    expect(eyeInsideLandmark([0, 6000, 10000], scene)).toBe(true);
    expect(eyeInsideLandmark([0, 20000, 10000], scene)).toBe(false);
  });

  it('cuts a movement-only fleet on one side, at two or more scales', () => {
    const frame = (tick: number) => {
      const ships = [0, 1, 2, 3, 4].map((i) => directorShip(i ? `m-${i}` : 'm-fc', [tick * 300 + (i - 2) * 400, 0, (i % 2) * 500], { velocity: [300, 0, 0], forward: [1, 0, 0] }));
      return { picture: directorPicture(tick, ships, [directorFleet('m', 'm-fc', ['m-1', 'm-2', 'm-3', 'm-4'])]) };
    };
    const run = runDirector(60, frame);
    const cuts = cutsOf(run);
    expect(cuts.length).toBeGreaterThanOrEqual(4);
    expect(new Set(cuts.map((cut) => cut.scale)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(cuts.filter((cut) => cut.side !== 'neutral').map((cut) => cut.side)).size).toBeLessThanOrEqual(1);
    expect(run.results.at(-1)?.axis).toMatchObject({ kind: 'motion' });
  });

  it('flips the kept side after a fly-through', () => {
    const run = runDirector(1, calm);
    const axis = run.results[0].axis;
    const pick = { ...(run.memory.current as DirectorPick), framing: 'battle-fly-through' as const, side: 'starboard' as const, crossing: true };
    expect(recordDirectorCut(emptyCameraDirectorMemory(0), pick, axis, 1, 1).side?.value).toBe(-1);
    expect(recordDirectorCut(emptyCameraDirectorMemory(0), { ...pick, framing: 'overlook' }, axis, 1, 1).side?.value).toBe(1);
  });

  it('is deterministic, and continues identically from a cloned memory', () => {
    const fight = (tick: number) => {
      const { ships, fleets } = twoFleets({ blue: { dealt: 50, target: 'red-1', velocity: [0, 0, 80] }, red: { pressure: 40, health: 0.7 } });
      return { picture: directorPicture(tick, ships, fleets), events: tick === 9 ? ([{ kind: 'primary', tick, fleet: 'blue', primary: 'red-2' }] as CameraDirectorEvent[]) : [] };
    };
    const a = runDirector(50, fight);
    const b = runDirector(50, fight);
    expect(cutsOf(a)).toEqual(cutsOf(b));
    const head = runDirector(25, fight);
    const tail = runDirector(25, fight, { memory: structuredClone(head.memory), from: 25 });
    expect([...cutsOf(head), ...cutsOf(tail)]).toEqual(cutsOf(a));
    expect(cutsOf(runDirector(50, fight, { seed: 99 }))).not.toEqual([]);
  });

  // ~4 ms on an idle box; the best of three steps keeps the 20 ms budget stable under a loaded parallel suite.
  it('steps a 500-ship fight in under 20 ms', () => {
    const ships: DirectorShip[] = [];
    for (let i = 0; i < 500; i += 1) {
      const team = i < 250 ? 'blue' : 'red';
      const k = i % 250;
      ships.push(directorShip(`${team}-${k}`, [(k % 25) * 300, Math.floor(k / 25) * 200, team === 'blue' ? 0 : 30000], { team, velocity: [0, 0, team === 'blue' ? 150 : -150], dealt: k % 3 ? 30 : 0, target: `${team === 'blue' ? 'red' : 'blue'}-${k}`, pressure: k % 5 ? 20 : 0, health: 0.8 }));
    }
    const fleets = ['blue', 'red'].map((team) =>
      directorFleet(
        team,
        `${team}-0`,
        ships.filter((ship) => ship.team === team && ship.id !== `${team}-0`).map((ship) => ship.id)
      )
    );
    const run = runDirector(2, (tick) => ({ picture: directorPicture(tick, ships, fleets) }));
    const times = [0, 1, 2].map(() => {
      const started = performance.now();
      stepCameraDirector({ picture: directorPicture(2, ships, fleets), events: [], settings: DEFAULT_CAMERA_DIRECTOR_SETTINGS, memory: run.memory, seed: 7, mode: 'drive' });
      return performance.now() - started;
    });
    expect(Math.min(...times)).toBeLessThan(20);
  });
});

/**
 * A spread fight like the user's TFIs one: two 8-ship fleets 30 km apart, each with a 3-ship rear squad 25 km behind,
 * 100 m hulls (stand-ins), the main bodies firing.
 */
function spreadFight(tick: number, firing = true): { picture: CameraDirectorPicture } {
  const ships: DirectorShip[] = [];
  const fleets = [];
  for (const [team, enemy, z, rear, facing] of [
    ['blue', 'red', 0, -25000, 1],
    ['red', 'blue', 30000, 55000, -1]
  ] as const) {
    for (let i = 0; i < 8; i += 1) ships.push(directorShip(`${team}-${i}`, [(i - 4) * 800, 0, z], { team, radius: 100, forward: [0, 0, facing], ...(firing ? { dealt: 100, target: `${enemy}-0` } : {}) }));
    for (let i = 0; i < 3; i += 1) ships.push(directorShip(`${team}-rear-${i}`, [(i - 1) * 800, 0, rear], { team, radius: 100, forward: [0, 0, facing] }));
    const fleet = directorFleet(team, `${team}-0`, []);
    fleets.push({
      ...fleet,
      wings: [
        {
          id: `${team}-w`,
          squads: [
            { id: `${team}-main`, role: 'dps', members: Array.from({ length: 7 }, (_, i) => `${team}-${i + 1}`) },
            { id: `${team}-rear`, role: 'logi', members: [0, 1, 2].map((i) => `${team}-rear-${i}`) }
          ]
        }
      ]
    } as typeof fleet);
  }
  return { picture: directorPicture(tick, ships, fleets) };
}

/**
 * Two fleets that go quiet → firing at tick 1 (a watched engage), flying so chase and the flyby apply.
 */
function opening(tick: number): { picture: CameraDirectorPicture } {
  const { ships, fleets } = twoFleets(tick >= 1 ? { blue: { dealt: 100, target: 'red-1', velocity: [0, 0, 300] }, red: { dealt: 100, target: 'blue-1', velocity: [0, 0, -300] } } : { blue: { velocity: [0, 0, 300] }, red: { velocity: [0, 0, -300] } });
  return { picture: directorPicture(tick, ships, fleets) };
}

describe('camera director shot rules and the visibility floor', () => {
  it('never cuts to an excluded framing, where it would otherwise', () => {
    // Watched quiet at 0, then the fleets open fire as the director takes the camera at 1: the pull-out is the pick.
    const mode = (tick: number): CameraDirectorMode => (tick === 0 ? 'watch' : tick === 1 ? 'take' : 'drive');
    const open = runDirector(2, opening, { settings: { minShipSize: 0 }, mode });
    expect(open.results[1].cut?.framing).toBe('overlook-pull-out');
    const ruled = cutsOf(runDirector(30, opening, { settings: { minShipSize: 0, exclude: ['overlook-pull-out'] }, mode: (tick) => (tick === 0 ? 'watch' : tick === 1 ? 'take' : 'drive') }));
    expect(ruled.length).toBeGreaterThan(2);
    expect(ruled.some((cut) => cut.framing === 'overlook-pull-out')).toBe(false);
  });

  it('keeps to the allowed scales and framings', () => {
    const scaled = cutsOf(runDirector(90, calm, { settings: { scales: ['medium', 'close'] } }));
    expect(scaled.length).toBeGreaterThan(5);
    expect(scaled.some((cut) => cut.scale === 'wide')).toBe(false);
    const framed = cutsOf(runDirector(60, opening, { settings: { framings: ['hero', 'chase'] } }));
    expect(framed.length).toBeGreaterThan(3);
    expect(new Set(framed.map((cut) => cut.framing))).toEqual(new Set(['hero', 'chase']));
  });

  it('skips the wides of a spread fight under the floor, and does not open on one', () => {
    const run = runDirector(30, spreadFight);
    const cuts = run.results.flatMap((result) => (result.cut ? [result.cut] : []));
    expect(cuts.length).toBeGreaterThan(2);
    expect(['overlook', 'overlook-pull-out', 'into-sun', 'battle-fly-through']).not.toContain(cuts[0].framing);
    for (const cut of cuts) expect(cut.size).toBeGreaterThanOrEqual(DEFAULT_CAMERA_DIRECTOR_SETTINGS.minShipSize);
    expect(run.results[0].ruledOut?.size).toBeGreaterThan(0);
    // The probe as a regression: the stand-in overlook over this fight measures under the floor.
    const loose = runDirector(1, spreadFight, { settings: { minShipSize: 0, framings: ['overlook'] } });
    expect(loose.results[0].cut?.size).toBeLessThan(DEFAULT_CAMERA_DIRECTOR_SETTINGS.minShipSize);
  });

  it('tightens a near-floor engagement wide with a raised fill', () => {
    const natural = runDirector(1, calm, { settings: { minShipSize: 0, framings: ['overlook'] } }).results[0].cut;
    expect(natural?.fill).toBeUndefined();
    const floor = (natural?.size ?? 0) * 1.3;
    const tightened = runDirector(1, calm, { settings: { minShipSize: floor, framings: ['overlook'] } }).results[0].cut;
    expect(tightened?.framing).toBe('overlook');
    expect(tightened?.fill).toBeGreaterThan(0.9);
    expect(tightened?.size).toBeGreaterThanOrEqual(floor);
    expect(tightened?.shot['hardpoint']).toMatchObject({ fill: tightened?.fill });
    expect(tightened?.why).toMatch(/tightened to fill/);
  });

  it('cuts at the next boundary when the rules rule out the shot on screen', () => {
    const run = runDirector(1, calm);
    const framing = run.memory.current?.framing;
    const next = runDirector(1, calm, { from: 1, memory: run.memory, settings: { exclude: [framing as 'overlook'] } });
    expect(next.results[0].cut?.framing).not.toBe(framing);
    expect(next.results[0].cut?.why).toContain(`auto_camera rules out ${framing} now`);
  });

  it('cuts a held group wide once its ships shrink under 0.8 × the floor', () => {
    const settings = { framings: ['flank', 'hero'] as const, favour: 'wide' as const };
    const run = runDirector(1, calm, { settings: { ...settings, framings: [...settings.framings] } });
    expect(run.memory.current).toMatchObject({ framing: 'flank', scale: 'wide', label: 'fleet red' });
    const spread = (tick: number) => {
      const { ships, fleets } = twoFleets();
      return {
        picture: directorPicture(
          tick,
          ships.map((ship) => ({ ...ship, position: [ship.position[0] * 200, 0, ship.position[2]] as SceneVector })),
          fleets
        )
      };
    };
    const next = runDirector(1, spread, { from: 1, memory: run.memory, settings: { ...settings, framings: [...settings.framings] } });
    expect(next.results[0].cut?.why).toMatch(/flank on fleet red shrank to [\d.]+ % \(floor 0\.5 %\)/);
  });

  it('opens on the favoured scale on a firing fight, and takes back with the best', () => {
    const medium = runDirector(1, (tick) => opening(tick + 5), { settings: { favour: 'medium' } }).results[0].cut;
    expect(medium?.scale).toBe('medium');
    expect(medium?.why).toContain('first pick (favour medium)');
    const run = runDirector(20, calm);
    const back = runDirector(1, calm, { from: 20, memory: run.memory, mode: () => 'take' }).results[0].cut;
    expect(back?.why).toMatch(/taking back/);
  });

  it("does not read a fight in progress as opening fire: the user's TFIs scenario", () => {
    const run = runDirector(12, (tick) => spreadFight(tick + 60));
    const cuts = cutsOf(run);
    expect(cuts.some((cut) => cut.framing === 'overlook-pull-out')).toBe(false);
    expect(run.memory.interest.some((entry) => entry.kind === 'engage')).toBe(false);
    expect(run.results[0].cut?.why).not.toMatch(/open fire/);
  });

  it('waits with a note when the rules leave nothing to frame', () => {
    expect(runDirector(1, calm, { settings: { framings: ['warp-in'] } }).results[0].note).toMatch(/^nothing the rules allow resolves on the scene \(ruled out \d+ by framing\)$/);
    expect(runDirector(1, calm, { settings: { framings: ['overlook'], scales: ['close'] } }).results[0].note).toBe('the rules leave no framing to pick (framings overlook; scales close)');
  });
});
