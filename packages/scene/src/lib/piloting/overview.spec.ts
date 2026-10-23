import { describe, expect, it } from 'vitest';
import type { FleetShipFacts } from '../personalities/picture';
import { idealRangeOf } from './ideal';
import { overviewRelationOf, toPilotContact, toShipOverview } from './overview';
import { PUNISHER_PROFILE, RIFTER_PROFILE, WARP_SCRAMBLER_RANGE } from './piloting.spec-helper';
import type { ShipCombatProfile } from './profile';
import type { ResolvedShipStance } from './stances';

interface FactsConfig {
  readonly id: string;
  readonly team?: string;
  readonly profile?: ShipCombatProfile;
  readonly position: FleetShipFacts['position'];
  readonly velocity?: FleetShipFacts['velocity'];
  readonly propModOn?: boolean;
  readonly extra?: Partial<FleetShipFacts>;
}

function factsOf(config: FactsConfig): FleetShipFacts {
  const { id, team, profile, position, velocity, propModOn, extra } = config;
  return {
    id,
    ...(team ? { team } : {}),
    position,
    velocity: velocity ?? [0, 0, 0],
    radius: profile?.radius ?? 50,
    health: 1,
    remaining: profile?.ehp ?? 1000,
    remainingEhp: profile?.ehp ?? 1000,
    dps: 0,
    signature: profile?.flight.signature ?? 40,
    speed: profile?.flight.speed ?? 300,
    ...(profile ? { profile } : {}),
    ...(propModOn ? { propModOn } : {}),
    ...extra
  };
}

const RIFTER_RADIUS = RIFTER_PROFILE.radius;

const PUNISHER_RADIUS = PUNISHER_PROFILE.radius;

function rifterAt(z: number, extra?: Partial<FleetShipFacts>): FleetShipFacts {
  return factsOf({ id: 'rifter', team: 'blue', profile: RIFTER_PROFILE, position: [0, 0, z], propModOn: true, extra });
}

const PUNISHER = factsOf({ id: 'punisher', team: 'red', profile: PUNISHER_PROFILE, position: [0, 0, 0], propModOn: true });

const KITE_STANCE: ResolvedShipStance = {
  type: 'kite',
  on: 'focus',
  range: 'ideal',
  propMods: 'always',
  formation: 'in-line',
  disengage: 0.35,
  sources: { type: 'ship', propMods: 'ship', formation: 'default', disengage: 'default' },
  flownBy: 'rifter',
  pilot: { type: 'kite', on: null, range: 'ideal', propMods: 'always', disengage: 0.35 }
};

describe('overviewRelationOf', () => {
  it('reads teams: equal friendly, different hostile, either unset neutral', () => {
    expect(overviewRelationOf({ team: 'a' }, { team: 'a' })).toBe('friendly');
    expect(overviewRelationOf({ team: 'a' }, { team: 'b' })).toBe('hostile');
    expect(overviewRelationOf({ team: 'a' }, {})).toBe('neutral');
  });
});

describe('toPilotContact', () => {
  it('is null while the profile is pending, and reads EHP left over HP left', () => {
    expect(toPilotContact(factsOf({ id: 'x', position: [0, 0, 0] }))).toBeNull();
    const contact = toPilotContact({ ...PUNISHER, remaining: 10, remainingEhp: 25, scrammed: true, webFactor: 0.4 });
    expect(contact).toMatchObject({ id: 'punisher', remaining: 25, propModOn: true, scrammed: true, webFactor: 0.4 });
  });
});

describe('toShipOverview', () => {
  it('lists rows nearest first, surface to surface, with the cuts counted', () => {
    const far = factsOf({ id: 'far', team: 'red', position: [0, 0, 400_000] });
    const wing = factsOf({ id: 'wing', team: 'blue', position: [0, 0, 12_000] });
    const away = factsOf({ id: 'warping', team: 'red', position: [0, 0, 11_000], extra: { away: true } });
    const overview = toShipOverview({ ship: 'rifter', ships: [far, PUNISHER, wing, away, rifterAt(10_000)], envelope: false });
    expect(overview.rows.map((row) => row.id)).toEqual(['wing', 'punisher']);
    expect(overview.rows[1].distance).toBe(Math.round(10_000 - RIFTER_RADIUS - PUNISHER_RADIUS));
    expect(overview.rows[0].relation).toBe('friendly');
    expect(overview.counts).toMatchObject({ hostile: 1, friendly: 1, neutral: 0, beyond: 1, cut: 0 });
    expect(overview.envelope).toBeUndefined();
    const limited = toShipOverview({ ship: 'rifter', ships: [PUNISHER, wing, rifterAt(10_000)], limit: 1, envelope: false });
    expect(limited.rows.map((row) => row.id)).toEqual(['wing']);
    expect(limited.counts.cut).toBe(1);
  });

  it('measures radial, transversal, angular, bearing and aspect from the ship', () => {
    // The Rifter flies across the line of sight at 300 m/s, nose along +x; the Punisher closes head-on.
    const rifter = rifterAt(10_000, { velocity: [300, 0, 0], heading: [1, 0, 0] });
    const punisher: FleetShipFacts = { ...PUNISHER, velocity: [0, 0, 200], heading: [0, 0, 1] };
    const [row] = toShipOverview({ ship: 'rifter', ships: [punisher, rifter], envelope: false }).rows;
    expect(row.radial).toBeCloseTo(-200, 1);
    expect(row.transversal).toBeCloseTo(300, 1);
    expect(row.angular).toBeCloseTo(300 / 10_000, 4);
    expect(row.bearing).toBeCloseTo(90, 1);
    expect(row.aspect).toBeCloseTo(0, 1);
    expect(row.velocity).toBeCloseTo(200, 1);
  });

  it("gives each side's applied DPS now, the ship's hit chance, and the hostile's lock and fire on it", () => {
    const punisher = { ...PUNISHER, locks: [{ target: 'rifter', state: 'locked' as const }], shooting: ['rifter'], target: 'rifter' };
    const close = toShipOverview({ ship: 'rifter', ships: [punisher, rifterAt(4000)], envelope: false }).rows[0];
    expect(close.incomingDps).toBeGreaterThan(50);
    expect(close.outgoingDps).toBeGreaterThan(50);
    expect(close.hitChance).toBeGreaterThan(0.5);
    expect(close).toMatchObject({ targeting: 'locked', shooting: true, target: 'rifter', propModOn: true });
    const far = toShipOverview({ ship: 'rifter', ships: [punisher, rifterAt(25_000)], envelope: false }).rows[0];
    expect(far.incomingDps ?? 0).toBeLessThan(close.incomingDps ?? 0);
    expect(far.reach).toBeGreaterThan(0);
  });

  it('reports the hostile tackle and the ship being scrammed and webbed', () => {
    const tackler = factsOf({ id: 'punisher', team: 'red', profile: { ...PUNISHER_PROFILE, tackle: { scram: WARP_SCRAMBLER_RANGE } }, position: [0, 0, 0] });
    const overview = toShipOverview({ ship: 'rifter', ships: [tackler, rifterAt(5000, { scrammed: true, webFactor: 0.4 })], envelope: false });
    expect(overview.rows[0].tackle).toEqual({ scram: WARP_SCRAMBLER_RANGE });
    expect(overview.ship).toMatchObject({ scrammed: true, webFactor: 0.4 });
    // A scrammed MWD Rifter webbed to 40 % flies its prop mod off, webbed.
    expect(overview.ship.maxSpeed).toBeCloseTo(RIFTER_PROFILE.flight.speed * 0.4, 0);
  });

  it('weighs the envelope on its focus for its stance: an MWD Rifter kiting a Punisher holds 10-11 km', () => {
    const overview = toShipOverview({ ship: 'rifter', ships: [PUNISHER, rifterAt(20_000)], stance: KITE_STANCE, envelope: true });
    const direct = idealRangeOf({ self: toPilotContact(rifterAt(20_000))!, focus: toPilotContact(PUNISHER)!, hostiles: [toPilotContact(PUNISHER)!], type: 'kite', propMods: 'always' });
    expect(overview.envelope).toMatchObject({ focus: 'punisher', for: 'kite', inWindow: false });
    expect(overview.envelope?.ideal?.ideal).toBe(Math.round(direct?.ideal ?? 0));
    expect(overview.envelope?.ideal?.ideal).toBeGreaterThanOrEqual(10_000);
    expect(overview.envelope?.ideal?.ideal).toBeLessThanOrEqual(11_000);
    expect(overview.envelope?.points?.length).toBeGreaterThan(10);
    expect(overview.stance?.type).toBe('kite');
    const inside = toShipOverview({ ship: 'rifter', ships: [PUNISHER, rifterAt(10_500 + RIFTER_RADIUS + PUNISHER_RADIUS)], stance: KITE_STANCE });
    expect(inside.envelope?.inWindow).toBe(true);
    expect(inside.envelope?.points).toBeUndefined();
  });

  it('weighs auto without a stance, on the target given, and warns on an unknown one', () => {
    const other = factsOf({ id: 'other', team: 'red', profile: PUNISHER_PROFILE, position: [0, 0, 60_000] });
    const overview = toShipOverview({ ship: 'rifter', ships: [PUNISHER, other, rifterAt(20_000)], target: 'other' });
    expect(overview.envelope).toMatchObject({ focus: 'other', for: 'auto' });
    const unknown = toShipOverview({ ship: 'rifter', ships: [PUNISHER, rifterAt(20_000)], target: 'nobody' });
    expect(unknown.envelope?.focus).toBe('punisher');
    expect(unknown.warnings?.[0]).toContain('nobody');
  });

  it('has no envelope while its numbers are pending, and refuses a ship that is not live', () => {
    const pending = toShipOverview({ ship: 'x', ships: [PUNISHER, factsOf({ id: 'x', team: 'blue', position: [0, 0, 5000] })] });
    expect(pending.envelope).toBeNull();
    expect(pending.rows[0].incomingDps).toBeGreaterThan(0);
    expect(pending.rows[0].outgoingDps).toBeUndefined();
    expect(() => toShipOverview({ ship: 'gone', ships: [PUNISHER] })).toThrow('gone');
  });
});
