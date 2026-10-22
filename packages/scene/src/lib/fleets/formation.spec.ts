import { describe, expect, it } from 'vitest';
import { expandFleetComposition } from '../compositions/expand';
import { requireComposition, TFI, tfisComposition } from '../compositions/compositions.spec-helper';
import type { FleetComposition } from '../compositions/composition';
import type { SceneVector } from '../scene';
import type { SceneFleet } from './fleet';
import { formationSpacing, layoutFleetFormation, toFleetFormationSlots } from './formation';
import { toFleetAnchors } from './membership';

interface Laid {
  readonly fleet: SceneFleet;
  readonly radii: Map<string, number>;
  readonly positions: Map<string, SceneVector>;
}

const EMPTY = { ships: new Map<string, SceneVector>(), fleets: new Set<string>() };

function lay(composition: FleetComposition, heading = 0): Laid {
  const expanded = expandFleetComposition({ composition, position: [0, 0, 0], heading, existing: EMPTY });
  expect(expanded.problems).toEqual([]);
  const fleet = expanded.fleet!;
  const byDna = new Map<string, number>();
  for (const line of [composition.commander, ...composition.wings.flatMap((wing) => wing.squads.flatMap((squad) => squad.ships))]) byDna.set(line.dna!, line.radius!);
  const radii = new Map(expanded.ships.map((ship) => [ship.id, byDna.get(ship.dna)!]));
  const positions = layoutFleetFormation({ fleet, origin: [0, 0, 0], heading, radiusOf: (ship) => radii.get(ship)! });
  expect(positions).toEqual(new Map(expanded.ships.map((ship) => [ship.id, ship.position])));
  return { fleet, radii, positions };
}

function distance(a: SceneVector, b: SceneVector): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function battleshipSquad(count: number, range?: number): FleetComposition {
  const anchor = range == null ? {} : { anchor: { range } };
  return requireComposition({ id: 'bs', commander: { dna: TFI, radius: 250 }, wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', ...anchor, ships: [{ dna: TFI, radius: 250, count }] }] }] });
}

function expectFormation(laid: Laid): void {
  const { fleet, radii, positions } = laid;
  const ships = [...positions];
  for (const [index, [a, at]] of ships.entries()) {
    for (const [b, bt] of ships.slice(index + 1)) expect(distance(at, bt), `${a} to ${b}`).toBeGreaterThanOrEqual(formationSpacing(radii.get(a)!, radii.get(b)!));
  }
  for (const [ship, membership] of toFleetAnchors(fleet)) {
    const anchor = membership.anchor;
    if (!anchor) continue;
    const from = positions.get(anchor.ship)!;
    const at = positions.get(ship)!;
    expect(distance(at, from) - radii.get(ship)! - radii.get(anchor.ship)!, ship).toBeGreaterThanOrEqual(anchor.range - 1);
    expect(at[2] - from[2], `${ship} trails its anchor`).toBeLessThanOrEqual(1);
  }
}

describe('layoutFleetFormation', () => {
  it('spaces the TFIs fleet, keeps every anchor range and trails the heading', () => {
    const laid = lay(tfisComposition());
    expectFormation(laid);
    const at = (ship: string): SceneVector | undefined => laid.positions.get(ship);
    expect(at('tfis-fc')).toEqual([0, 0, 0]);
    expect(at('tfis-dps-a-01')).toEqual([0, 0, -1500]);
    expect(at('tfis-logi-01')).toEqual([0, 0, -30330]);
    expect(at('tfis-logi-02')).toEqual([0, 0, -31490]);
    expect(at('tfis-dreads-01')).toEqual([0, 0, -11950]);
    expect(at('tfis-carriers-01')).toEqual([0, 0, -16384]);
    expect(at('tfis-fax-01')).toEqual([0, 0, -38410]);
  });

  it('spaces a 60-battleship squad', () => {
    expectFormation(lay(battleshipSquad(60)));
  });

  it('turns with the heading: heading 90 is heading 0 a quarter turn about +Y', () => {
    const north = lay(tfisComposition(), 0).positions;
    const east = lay(tfisComposition(), 90).positions;
    for (const [ship, [x, y, z]] of north) {
      const turned = east.get(ship)!;
      expect(Math.abs(turned[0] - z) + Math.abs(turned[1] - y) + Math.abs(turned[2] + x), ship).toBeLessThanOrEqual(2);
    }
  });

  it('is deterministic', () => {
    expect(lay(tfisComposition()).positions).toEqual(lay(tfisComposition()).positions);
  });

  it('clears the anchor when the range is 0: spacing wins over the range', () => {
    const laid = lay(battleshipSquad(5, 0));
    for (const [ship, at] of laid.positions) if (ship !== 'bs-fc') expect(distance(at, [0, 0, 0])).toBeGreaterThanOrEqual(formationSpacing(250, 250));
  });

  it('lays out a 256-ship fleet', () => {
    expect(lay(battleshipSquad(255)).positions.size).toBe(256);
  });

  it('throws when an anchor is never placed', () => {
    const fleet: SceneFleet = { id: 'f', commander: 'fc', wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', members: ['a'], anchor: { ship: 'ghost' } }] }] };
    expect(() => layoutFleetFormation({ fleet, origin: [0, 0, 0], heading: 0, radiusOf: () => 100 })).toThrow(/ship "a" anchors on a ship that is never placed/u);
  });
});

describe('toFleetFormationSlots', () => {
  const rotateYaw = (heading: number, [x, y, z]: SceneVector): SceneVector => {
    const yaw = (heading * Math.PI) / 180;
    return [x * Math.cos(yaw) + z * Math.sin(yaw), y, -x * Math.sin(yaw) + z * Math.cos(yaw)];
  };

  it('flies every ship back onto layoutFleetFormation from its laid anchor, at headings 0, 90 and 180', () => {
    const { fleet, radii } = lay(tfisComposition());
    const radiusOf = (ship: string): number => radii.get(ship)!;
    for (const heading of [0, 90, 180]) {
      const input = { fleet, origin: [0, 0, 80000] as SceneVector, heading, radiusOf };
      const positions = layoutFleetFormation(input);
      const slots = toFleetFormationSlots(input);
      expect(slots.size).toBe(positions.size - 1);
      for (const [ship, slot] of slots) {
        const from = positions.get(slot.anchor)!;
        const direction = rotateYaw(heading, slot.direction);
        const reach = slot.range + radiusOf(slot.anchor) + radiusOf(ship);
        const flown: SceneVector = [from[0] + direction[0] * reach, from[1] + direction[1] * reach, from[2] + direction[2] * reach];
        expect(distance(flown, positions.get(ship)!), `${ship} at heading ${heading}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps the anchor range on the first shell and one spacing more per outer shell', () => {
    const { fleet, radii } = lay(battleshipSquad(60));
    const slots = toFleetFormationSlots({ fleet, origin: [0, 0, 0], heading: 0, radiusOf: (ship) => radii.get(ship)! });
    const anchors = toFleetAnchors(fleet);
    const shells = new Set<number>();
    for (const [ship, slot] of slots) {
      const anchor = anchors.get(ship)!.anchor!;
      expect(slot.anchor).toBe(anchor.ship);
      const shell = (slot.range - anchor.range) / formationSpacing(250, 250);
      expect(Number.isInteger(shell), `${ship} shell ${shell}`).toBe(true);
      shells.add(shell);
    }
    expect(shells.has(0)).toBe(true);
    expect([...shells].some((shell) => shell >= 1)).toBe(true);
  });

  it('gives unit directions on the trailing hemisphere, deterministically, and no slot for the FC', () => {
    const { fleet, radii } = lay(tfisComposition());
    const input = { fleet, origin: [0, 0, 0] as SceneVector, heading: 0, radiusOf: (ship: string) => radii.get(ship)! };
    const slots = toFleetFormationSlots(input);
    expect(slots.has(fleet.commander)).toBe(false);
    for (const [ship, { direction }] of slots) {
      expect(Math.hypot(...direction), ship).toBeCloseTo(1, 9);
      expect(direction[2], ship).toBeLessThanOrEqual(0);
    }
    expect(toFleetFormationSlots(input)).toEqual(slots);
  });

  it('clears the anchor when the range is 0: the slot range covers the spacing', () => {
    const { fleet, radii } = lay(battleshipSquad(5, 0));
    for (const slot of toFleetFormationSlots({ fleet, origin: [0, 0, 0], heading: 0, radiusOf: (ship) => radii.get(ship)! }).values()) {
      expect(slot.range).toBeGreaterThanOrEqual(formationSpacing(250, 250) - 500);
    }
  });
});
