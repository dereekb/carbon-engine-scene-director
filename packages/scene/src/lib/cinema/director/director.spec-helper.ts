/**
 * Synthetic pictures for the camera director's specs: ships, fleets and a runner over boundaries.
 */

import type { SceneFleet } from '../../fleets/fleet';
import type { SceneVector } from '../../scene';
import { DEFAULT_CAMERA_DIRECTOR_SETTINGS, type CameraDirectorSettings } from './command';
import type { CameraDirectorEvent } from './events';
import type { CameraDirectorPicture, DirectorShip } from './picture';
import { stepCameraDirector, type CameraDirectorMemory, type CameraDirectorMode, type CameraDirectorStepResult } from './step';

export function directorShip(id: string, position: SceneVector, extra: Partial<DirectorShip> = {}): DirectorShip {
  const velocity = extra.velocity ?? [0, 0, 0];
  const speed = Math.hypot(...velocity);
  return { id, position, velocity, speed, forward: extra.forward ?? (speed > 1 ? velocity.map((value) => value / speed) as SceneVector : [0, 0, 1]), radius: 50, maxVelocity: 400, health: 1, remaining: 5000, total: 5000, ...extra };
}

/**
 * A fleet: its commander and one squad of the rest.
 */
export function directorFleet(id: string, commander: string, members: readonly string[]): SceneFleet {
  return { id, commander, wings: [{ id: `${id}-w`, squads: [{ id: `${id}-s`, role: 'dps', members: [...members] }] }] } as SceneFleet;
}

/**
 * Two five-ship fleets 20 km apart: blue at z 0 facing +Z, red at z 20 km facing −Z.
 */
export function twoFleets(extra: { readonly blue?: Partial<DirectorShip>; readonly red?: Partial<DirectorShip> } = {}): { ships: DirectorShip[]; fleets: SceneFleet[] } {
  const ships: DirectorShip[] = [];
  for (let i = 0; i < 5; i += 1) ships.push(directorShip(i === 0 ? 'blue-fc' : `blue-${i}`, [(i - 2) * 600, 0, 0], { team: 'blue', forward: [0, 0, 1], ...extra.blue }));
  for (let i = 0; i < 5; i += 1) ships.push(directorShip(i === 0 ? 'red-fc' : `red-${i}`, [(i - 2) * 600, 0, 20000], { team: 'red', forward: [0, 0, -1], ...extra.red }));
  return {
    ships,
    fleets: [
      directorFleet(
        'blue',
        'blue-fc',
        ships.filter((ship) => ship.team === 'blue' && ship.id !== 'blue-fc').map((ship) => ship.id)
      ),
      directorFleet(
        'red',
        'red-fc',
        ships.filter((ship) => ship.team === 'red' && ship.id !== 'red-fc').map((ship) => ship.id)
      )
    ]
  };
}

export function directorPicture(tick: number, ships: readonly DirectorShip[], fleets: readonly SceneFleet[], extra: Partial<CameraDirectorPicture> = {}): CameraDirectorPicture {
  return { tick, time: tick, ships, fleets, sunDirection: [0.6, -0.3, 0.74], ...extra };
}

export interface DirectorRun {
  readonly results: CameraDirectorStepResult[];
  readonly memory: CameraDirectorMemory;
}

/**
 * Steps the director over boundaries 0..count − 1: the first takes the camera, the rest drive.
 *
 * @param count - Boundaries.
 * @param frame - The picture and events at a tick.
 * @param options - Settings, seed, a starting memory and the first tick.
 */
export function runDirector(
  count: number,
  frame: (tick: number) => { picture: CameraDirectorPicture; events?: CameraDirectorEvent[] },
  options: { readonly settings?: Partial<CameraDirectorSettings>; readonly seed?: number; readonly memory?: CameraDirectorMemory; readonly from?: number; readonly mode?: (tick: number) => CameraDirectorMode } = {}
): DirectorRun {
  const settings = { ...DEFAULT_CAMERA_DIRECTOR_SETTINGS, ...options.settings };
  const results: CameraDirectorStepResult[] = [];
  let memory = options.memory ?? null;
  const from = options.from ?? 0;
  for (let tick = from; tick < from + count; tick += 1) {
    const { picture, events } = frame(tick);
    const mode = options.mode?.(tick) ?? (memory?.current ? 'drive' : 'take');
    const result = stepCameraDirector({ picture, events: events ?? [], settings, memory, seed: options.seed ?? 7, mode });
    results.push(result);
    memory = result.memory;
  }
  return { results, memory: memory as CameraDirectorMemory };
}

/**
 * The cuts of a run: tick, framing, subject key, scale, side.
 */
export function cutsOf(run: DirectorRun): { tick: number; framing: string; subject: string; scale: string; side: string; transition: string }[] {
  return run.results.flatMap((result) => (result.cut ? [{ tick: result.cut.tick, framing: result.cut.framing, subject: result.cut.subject.key, scale: result.cut.scale, side: result.cut.side, transition: result.cut.transition }] : []));
}
