import { describe, expect, it } from 'vitest';
import type { SceneVector } from '../../scene';
import { DEFAULT_CAMERA_DIRECTOR_SETTINGS, type CameraDirectorSettings } from './command';
import { cutsOf, directorFleet, directorPicture, directorShip, runDirector, twoFleets } from './director.spec-helper';
import type { CameraDirectorEvent } from './events';
import type { CameraDirectorPicture, DirectorShip } from './picture';
import { toDirectorScene } from './picture';
import { emptyCameraDirectorMemory, eyeInsideLandmark, recordDirectorCut, stepCameraDirector, type CameraDirectorMemory, type DirectorPick } from './step';

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
