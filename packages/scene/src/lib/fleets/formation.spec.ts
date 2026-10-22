import { describe, expect, it } from 'vitest';
import { expandFleetComposition } from '../compositions/expand';
import { requireComposition, TFI, tfisComposition } from '../compositions/compositions.spec-helper';
import type { FleetComposition } from '../compositions/composition';
import type { SceneVector } from '../scene';
import type { SceneFleet } from './fleet';
import { formationSpacing, layoutFleetFormation } from './formation';
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
