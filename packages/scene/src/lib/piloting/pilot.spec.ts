import { describe, expect, it } from 'vitest';
import type { ShipOrder } from '../orders';
import type { SceneVector } from '../scene';
import { BURN_OUT_DEGREES, KITE_AWAY_DEGREES, SPIRAL_DEGREES, supportPointOf } from './maneuvers';
import { legacyOrbitOf } from './orbit';
import { stepShipPilot, type ShipPilotPicture, type ShipPilotSelf } from './pilot';
import { flightOf } from './profile';
import { contactOf, PUNISHER_PROFILE, RIFTER_PROFILE, type ContactConfig } from './piloting.spec-helper';
import type { PilotStance } from './stance';
import { angleBetween, subtractVectors } from './vectors';

const KITE: PilotStance = { type: 'kite', range: 'ideal', propMods: 'always', disengage: 0.35 };

function selfOf(config: Partial<ContactConfig> & { readonly health?: number; readonly order?: ShipOrder }): ShipPilotSelf {
  return { ...contactOf({ id: 'rifter', profile: RIFTER_PROFILE, position: [0, 0, 10_400], ...config }), health: config.health ?? 1, order: config.order ?? null };
}

const PUNISHER = contactOf({ id: 'punisher', profile: PUNISHER_PROFILE, propModOn: true });

function pictureOf(self: ShipPilotSelf, extra: Partial<ShipPilotPicture> = {}): ShipPilotPicture {
  return { self, focus: PUNISHER, hostiles: [PUNISHER], friends: [], now: 100, ...extra };
}

function directionOf(step: ReturnType<typeof stepShipPilot>): SceneVector {
  const call = step.calls.find((each) => each.tool === 'order_ship');
  if (call?.tool !== 'order_ship' || call.args.order.type !== 'direction') throw new Error(`no direction call: ${JSON.stringify(step.calls)}`);
  return call.args.order.direction;
}

describe('stepShipPilot', () => {
  it('aligns toward its to with the prop mod on, aligned at 75 % of its top speed along the line, and never disengages', () => {
    const ALIGN: PilotStance = { type: 'align', to: [0, 0, 200_000], range: 'ideal', propMods: 'always', disengage: 0.35 };
    const alignTo: SceneVector = [0, 0, 200_000];
    const top = flightOf(RIFTER_PROFILE, true).speed;
    const still = stepShipPilot({ picture: pictureOf(selfOf({}), { alignTo }), stance: ALIGN });
    expect(still.state).toBe('aligning');
    expect(directionOf(still)[2]).toBeCloseTo(1);
    expect(still.calls).toContainEqual(expect.objectContaining({ tool: 'switch_prop_mods', args: { ships: ['rifter'], active: true } }));
    const slow = stepShipPilot({ picture: pictureOf(selfOf({ propModOn: true, velocity: [0, 0, 0.7 * top] }), { alignTo }), stance: ALIGN });
    expect(slow.state).toBe('aligning');
    const fast = stepShipPilot({ picture: pictureOf(selfOf({ propModOn: true, velocity: [0, 0, 0.8 * top], health: 0.1 }), { alignTo }), stance: ALIGN });
    expect(fast.state).toBe('aligned');
    expect(fast.why).toMatch(/aligned/);
    // No to: straight away from the hostiles (the Punisher sits at the origin, the Rifter on +z).
    const away = stepShipPilot({ picture: pictureOf(selfOf({})), stance: { ...ALIGN, to: null } });
    expect(directionOf(away)[2]).toBeCloseTo(1);
    expect(away.why).toMatch(/away from the hostiles/);
  });

  it('holds its ideal on the focus, then leaves it be while it flies inside the window', () => {
    const first = stepShipPilot({ picture: pictureOf(selfOf({ propModOn: false })), stance: KITE });
    expect(first.state).toMatch(/holding|orbiting/);
    expect(first.ideal?.window[0]).toBeLessThanOrEqual(10_400);
    const order = first.calls.find((call) => call.tool === 'order_ship');
    expect(order?.args).toMatchObject({ id: 'rifter', order: { target: 'punisher' } });
    expect(first.calls.find((call) => call.tool === 'switch_prop_mods')?.args).toEqual({ ships: ['rifter'], active: true });
    const held = order?.tool === 'order_ship' ? order.args.order : null;
    const second = stepShipPilot({ picture: { ...pictureOf(selfOf({ order: held ?? undefined, propModOn: true })), now: 101 }, stance: KITE, memory: first.memory });
    expect(second.calls).toEqual([]);
    expect(second.memory.idealAt).toBe(100);
  });

  it('spirals in from beyond its window while the focus can shoot it, and closes straight from farther out', () => {
    const brawl: PilotStance = { type: 'brawl', range: 'ideal', propMods: 'never', disengage: 0.35 };
    const near = stepShipPilot({ picture: pictureOf(selfOf({ position: [0, 0, 8000], velocity: [100, 0, 0] })), stance: brawl });
    expect(near.state).toBe('closing');
    expect(near.ideal?.window[1]).toBeLessThan(6000);
    expect(angleBetween(directionOf(near), [0, 0, -1])).toBeCloseTo(SPIRAL_DEGREES, 6);
    expect(directionOf(near)[0]).toBeGreaterThan(0);
    const far = stepShipPilot({ picture: pictureOf(selfOf({ position: [0, 0, 27_000] })), stance: brawl });
    expect(angleBetween(directionOf(far), [0, 0, -1])).toBeCloseTo(0, 6);
  });

  it('kites away at an angle when the focus is inside its window', () => {
    const step = stepShipPilot({ picture: pictureOf(selfOf({ position: [0, 0, 4000], velocity: [0, 100, 0] })), stance: KITE });
    expect(step.state).toBe('kiting');
    expect(angleBetween(directionOf(step), [0, 0, 1])).toBeCloseTo(KITE_AWAY_DEGREES, 6);
    expect(directionOf(step)[1]).toBeGreaterThan(0);
  });

  it('burns out below its disengage HP, waits on a friend out of reach, and re-engages once repaired', () => {
    const friend = contactOf({ id: 'guardian', profile: RIFTER_PROFILE, position: [0, 0, 80_000] });
    const burning = stepShipPilot({ picture: pictureOf(selfOf({ health: 0.3, propModOn: false }), { friends: [friend], attackedBy: [{ id: 'punisher', at: 95 }] }), stance: KITE });
    expect(burning.state).toBe('disengaging');
    expect(angleBetween(directionOf(burning), [0, 0, 1])).toBeCloseTo(BURN_OUT_DEGREES, 6);
    expect(burning.calls.find((call) => call.tool === 'switch_prop_mods')?.args).toMatchObject({ active: true });
    expect(burning.memory).toMatchObject({ disengaged: true, shooters: ['punisher'] });
    const away = selfOf({ health: 0.4, position: [0, 0, 70_000], propModOn: true });
    const waiting = stepShipPilot({ picture: pictureOf(away, { friends: [friend], now: 130 }), stance: KITE, memory: burning.memory });
    expect(waiting.state).toBe('waiting');
    expect(waiting.calls).toContainEqual({ tool: 'order_ship', args: { id: 'rifter', order: { type: 'keep-at-range', target: 'guardian', range: 2500, speed: 1 } }, why: expect.any(String) });
    const repaired = stepShipPilot({ picture: pictureOf({ ...away, health: 0.5 }, { friends: [friend], now: 140 }), stance: KITE, memory: waiting.memory });
    expect(repaired.state).not.toMatch(/waiting|disengaging/);
    expect(repaired.memory.disengaged).toBe(false);
  });

  it('re-engages once every hostile that shot it is gone', () => {
    const burning = stepShipPilot({ picture: pictureOf(selfOf({ health: 0.3 }), { attackedBy: [{ id: 'punisher', at: 95 }] }), stance: KITE });
    const other = contactOf({ id: 'other', profile: PUNISHER_PROFILE, position: [0, 0, -5000] });
    const step = stepShipPilot({ picture: pictureOf(selfOf({ health: 0.3 }), { focus: other, hostiles: [other] }), stance: KITE, memory: burning.memory });
    expect(step.memory.disengaged).toBe(false);
  });

  it('orbits a friendly squad leader inside a band as a lever, and leaves the order be inside it', () => {
    const leader = contactOf({ id: 'leader', profile: PUNISHER_PROFILE, position: [0, 0, 0] });
    const stance: PilotStance = { type: 'orbit', on: 'leader', range: [20_000, 30_000], propMods: 'never', disengage: 0.35 };
    const step = stepShipPilot({ picture: pictureOf(selfOf({ position: [0, 0, 60_000] }), { anchor: leader }), stance });
    const call = step.calls.find((each) => each.tool === 'order_ship');
    if (call?.tool !== 'order_ship' || call.args.order.type !== 'orbit') throw new Error('no orbit');
    expect(call.args.order.target).toBe('leader');
    const flown = legacyOrbitOf({ speed: RIFTER_PROFILE.flight.speed, tau: RIFTER_PROFILE.flight.tau, radii: RIFTER_PROFILE.radius + PUNISHER_PROFILE.radius, range: call.args.order.range }).distance;
    expect(Math.abs(flown - 25_000)).toBeLessThan(20);
    const inside = stepShipPilot({ picture: pictureOf(selfOf({ position: [0, 0, 25_000], order: call.args.order }), { anchor: leader }), stance });
    expect(inside.calls).toEqual([]);
    expect(inside.state).toBe('orbiting');
  });

  it('holds: stops once', () => {
    const stance: PilotStance = { type: 'hold', range: 'ideal', propMods: 'auto', disengage: 0.35 };
    expect(stepShipPilot({ picture: pictureOf(selfOf({})), stance }).calls).toEqual([{ tool: 'order_ship', args: { id: 'rifter', order: { type: 'stop' } }, why: 'hold: stop where it is' }]);
    expect(stepShipPilot({ picture: pictureOf(selfOf({ order: { type: 'stop' } })), stance }).calls).toEqual([]);
  });

  it('supports from behind its friend, inside repair reach', () => {
    const logi = { ...RIFTER_PROFILE, reps: [{ layer: 'armor' as const, hps: 50, optimal: 10_000, falloff: 5000 }] };
    const friend = contactOf({ id: 'dps', profile: PUNISHER_PROFILE, position: [0, 0, 20_000] });
    const stance: PilotStance = { type: 'support', range: 'ideal', propMods: 'closing', disengage: 0.35 };
    const self = selfOf({ profile: logi, position: [0, 0, 50_000] });
    const { point, range } = supportPointOf({ self, friend, hostiles: [PUNISHER], reach: 10_000 });
    expect(range).toBe(8000);
    expect(angleBetween(subtractVectors(point, friend.position), [0, 0, 1])).toBeCloseTo(0, 6);
    const going = stepShipPilot({ picture: pictureOf(self, { friends: [friend] }), stance });
    expect(going.state).toBe('closing');
    expect(going.calls[0]?.args).toMatchObject({ order: { type: 'goto' } });
    const there = stepShipPilot({ picture: pictureOf({ ...self, position: point }, { friends: [friend] }), stance });
    expect(there.state).toBe('holding');
    expect(there.calls[0]?.args).toMatchObject({ order: { type: 'keep-at-range', target: 'dps', range: 8000 } });
  });

  it('idles without a focus', () => {
    expect(stepShipPilot({ picture: pictureOf(selfOf({}), { focus: null, hostiles: [] }), stance: KITE })).toMatchObject({ state: 'idle', calls: [] });
  });
});
