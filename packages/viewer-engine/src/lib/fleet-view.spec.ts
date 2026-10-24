import type { FleetPictureShip } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import type { FleetCommandReport } from './fleet-commanders';
import { FLEET_VIEW_DECISIONS, type FleetViewMember, toFleetView } from './fleet-view';

const FLEET = { id: 'blue', name: 'Blue', commander: 'fc', personality: 'brawler' };

function Member(id: string, patch: Partial<FleetViewMember> = {}): FleetViewMember {
  return { id, team: 'blue', alive: true, arriving: false, hp: 100, max: 100, position: [0, 0, 0], velocity: [1, 0, 0], ...patch };
}

function Hostile(id: string, distance: number): FleetPictureShip {
  return { id, team: 'red', distance, offset: [distance, 0, 0], health: 0.5, remaining: 50, dps: 10, role: 'dps', commands: [] } as unknown as FleetPictureShip;
}

function Fc(patch: Partial<FleetCommandReport> = {}): FleetCommandReport {
  return {
    personality: 'brawler',
    ship: 'fc',
    ability: 0.6,
    state: 'commanding',
    engaged: true,
    engagedBy: 'in-range',
    hostiles: 2,
    reach: {} as FleetCommandReport['reach'],
    stance: 'brawl',
    manual: [],
    pending: [],
    decisions: Array.from({ length: 8 }, (_, tick) => ({ tick, lever: 'call', tool: 'order_fleet', args: {}, why: `call ${tick}` })) as unknown as FleetCommandReport['decisions'],
    ...patch
  };
}

describe('toFleetView', () => {
  it('builds a brain fleet: its FC, counts, HP, calls and ranked targets', () => {
    const view = toFleetView({
      fleet: FLEET,
      members: [Member('fc'), Member('m1', { hp: 50 }), Member('m2', { alive: false, hp: 0 }), Member('m3', { arriving: true })],
      fc: Fc(),
      called: { primary: 'r2', queue: ['r1'] },
      freeFire: true,
      targets: { ranked: [Hostile('r2', 5_000), Hostile('r1', 9_000), Hostile('r3', 80_000)], reach: 20_000 },
      stances: { brawling: 3 },
      formation: { ready: true, heading: [0, 0], following: 2, inFormation: 2, catchingUp: 0, holding: 0, warping: 0, arriving: 0, leading: 1, detached: 0, piloting: 0, waiting: 0 },
      autoRepair: null
    });
    expect(view).toMatchObject({ id: 'blue', name: 'Blue', team: 'blue', personality: 'brawler', fc: 'fc', state: 'commanding', ships: 4, alive: 3, arriving: 1, primary: 'r2', queue: ['r1'], freeFire: true, reach: 20_000, stances: { brawling: 3 }, logi: null });
    expect(view.health).toBeCloseTo(250 / 300);
    expect(view.fcMotion).toEqual({ position: [0, 0, 0], velocity: [1, 0, 0] });
    expect(view.targets.map((target) => [target.id, target.inReach, target.called])).toEqual([
      ['r2', true, 'primary'],
      ['r1', true, 'queued'],
      ['r3', false, undefined]
    ]);
    expect(view.brain).toMatchObject({ personality: 'brawler', engaged: true, engagedBy: 'in-range', stance: 'brawl', held: false });
    expect(view.brain?.decisions).toHaveLength(FLEET_VIEW_DECISIONS);
    expect(view.brain?.decisions.at(-1)).toEqual({ tick: 7, lever: 'call', why: 'call 7' });
  });

  it('a fleet with no brain: state none, no targets; a dead FC has no motion', () => {
    const view = toFleetView({ fleet: { id: 'red', commander: 'x' }, members: [Member('x', { alive: false, team: 'red' })], fc: null, called: null, freeFire: false, targets: null, stances: null, formation: null, autoRepair: null });
    expect(view).toMatchObject({ personality: null, state: 'none', brain: null, alive: 0, health: null, primary: null, queue: [], targets: [], reach: null, fcMotion: null, stances: {} });
  });
});
