import type { SceneFleet } from '../fleets/fleet';
import { resolveFleetPersonality } from './normalize';
import type { ResolvedFleetPersonality } from './personality';
import type { FleetPicture, FleetPictureMember, FleetPictureShip, FleetReachNumbers } from './picture';

/**
 * Synthetic pictures for the brain's specs: an FC at the origin, hostiles along +x at their distance.
 */

export const REACH: FleetReachNumbers = { lock: 60_000, optimal: 20_000, falloff: 30_000 };

export function hostile(id: string, distance: number, extra: Partial<FleetPictureShip> = {}): FleetPictureShip {
  return { id, team: 'red', distance, offset: [distance, 0, 0], health: 1, remaining: 10_000, dps: 100, role: 'dps', commands: [], signature: 100, speed: 300, ...extra };
}

export function member(id: string, extra: Partial<FleetPictureMember> = {}): FleetPictureMember {
  return { id, team: 'blue', distance: 0, offset: [0, 0, 0], health: 1, remaining: 10_000, dps: 100, role: 'dps', commands: [], signature: 100, speed: 300, reach: REACH, attackedBy: [], ...extra };
}

export function picture(extra: Partial<FleetPicture> = {}): FleetPicture {
  return { fleet: 'f', fc: { ship: 'fc', ability: 1 }, team: 'blue', members: [member('fc', { role: 'fc', commands: ['fleet'] }), member('m1'), member('m2')], hostiles: [], call: [], order: null, freeFire: false, propMods: 'off', reach: REACH, ...extra };
}

export function personality(name: string): ResolvedFleetPersonality {
  const resolved = resolveFleetPersonality({ name }).personality;
  if (!resolved) throw new Error(`no personality ${name}`);
  return resolved;
}

/**
 * A fleet: FC `fc`, wing `w` (commander `wc`) with a dps squad `s1` (commander `s1c`, members m1-m4) and a boost
 * squad `b` (b1, b2).
 */
export function commandFleet(extra: Partial<SceneFleet> = {}): SceneFleet {
  return {
    id: 'f',
    commander: 'fc',
    wings: [
      {
        id: 'w',
        commander: 'wc',
        squads: [
          { id: 's1', role: 'dps', commander: 's1c', members: ['s1c', 'm1', 'm2', 'm3', 'm4'] },
          { id: 'b', role: 'boost', members: ['b1', 'b2'] }
        ]
      }
    ],
    ...extra
  };
}
