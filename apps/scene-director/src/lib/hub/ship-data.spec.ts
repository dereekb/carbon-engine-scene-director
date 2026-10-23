import { describe, expect, it } from 'vitest';
import { ShipDataError } from './ship-data';
import { type Answer, MakeFakeShipData, PROP_MOD_LISTING_ROUTE, SDE, SHIP_ROUTES, TFI_DNA, UnpreparedSdeRoutes } from './ship-data.testing';

async function CaughtShipDataFailure(action: Promise<unknown>): Promise<ShipDataError> {
  const error = await action.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ShipDataError);
  return error as ShipDataError;
}

describe('ShipData', () => {
  it('pins the SDE build once, from builds.sde, falling back to build', async () => {
    const { shipData, calls } = MakeFakeShipData();
    expect(await shipData.SdeBuild()).toBe(SDE);
    await shipData.Hull({ type: 17732 });
    await shipData.Hull({ type: 11987 });
    expect(calls.filter((call) => call === '/eve/latest/build')).toHaveLength(1);
    const fallback = MakeFakeShipData({ '/eve/latest/build': { json: { build: 3632940 } } });
    expect(await fallback.shipData.SdeBuild()).toBe('3632940');
  });

  it('picks a hull by DNA: bare-hull exact matches, lowest id, others as candidates, commands ignored', async () => {
    const { shipData } = MakeFakeShipData();
    const hull = await shipData.Hull({ dna: `${TFI_DNA.toUpperCase()}:mesh?x` });
    expect(hull.typeID).toBe(17732);
    expect(hull.resolvedFrom).toBe('dna');
    expect(hull.dna).toBe(TFI_DNA);
    expect(hull.candidates).toEqual([{ typeID: 90000 }]);
    expect(hull.name).toBe('Tempest Fleet Issue');
    expect(hull.group).toBe('Battleship');
    expect(hull.sdeBuild).toBe(SDE);
    expect(hull.published).toEqual({ mass: 103_300_000, maxVelocity: 130, agility: 0.115, signatureRadius: 350, radius: 250, warpSpeedMultiplier: 3, rigSize: 3, advancedAgility: null, advancedCapitalAgility: null, warpScrambleStatus: null });
    const missing = await CaughtShipDataFailure(shipData.Hull({ dna: 'zz9_t1:nobody:amarr' }));
    expect(missing.failure).toBe('not-found');
    expect(missing.message).toMatch(/set the ship's type/);
  });

  it('resolves a type name, and reports unknown and ambiguous names', async () => {
    const { shipData } = MakeFakeShipData();
    const guardian = await shipData.Hull({ type: 'Guardian', dna: TFI_DNA });
    expect(guardian).toMatchObject({ typeID: 11987, resolvedFrom: 'type', dna: 'ac3_t2:carthum:amarr', name: 'Guardian', group: 'Logistics' });
    expect((await CaughtShipDataFailure(shipData.Hull({ type: 'Nopeship' }))).failure).toBe('not-found');
    expect((await CaughtShipDataFailure(shipData.Hull({ type: 'Tempest' }))).failure).toBe('ambiguous');
  });

  it("reads the capital agility hooks and a hull's warp scramble status, and refuses a type with no agility", async () => {
    const { shipData } = MakeFakeShipData();
    expect((await shipData.Hull({ type: 19720 })).published).toMatchObject({ rigSize: 4, advancedAgility: 1, advancedCapitalAgility: 1, mass: 1_290_000_000 });
    expect((await shipData.Hull({ type: 32880 })).published).toMatchObject({ rigSize: 1, warpScrambleStatus: -2 });
    const structure = await CaughtShipDataFailure(shipData.Hull({ type: 35833 }));
    expect(structure.failure).toBe('invalid');
    expect(structure.message).toBe('type 35833 (Astrahus) has no agility; it is not a ship');
  });

  it('reads prop mods by attribute id and their kind from the effects', async () => {
    const { shipData } = MakeFakeShipData();
    expect(await shipData.PropMod(12084)).toEqual({ typeID: 12084, name: '500MN Microwarpdrive II', kind: 'microwarpdrive', speedFactor: 510, speedBoostFactor: 1.5e8, massAddition: 5e7, signatureRadiusBonus: 475, duration: 10_000 });
    expect(await shipData.PropMod(12058)).toMatchObject({ kind: 'afterburner', signatureRadiusBonus: 0, speedBoostFactor: 1.5e7 });
    expect((await CaughtShipDataFailure(shipData.PropMod(3001))).failure).toBe('invalid');
  });

  it('an unprepared SDE or an unreachable tools-core is unavailable, naming the prepare command', async () => {
    const unprepared = MakeFakeShipData(UnpreparedSdeRoutes('42', 17732));
    const error = await CaughtShipDataFailure(unprepared.shipData.Hull({ type: 17732 }));
    expect(error.failure).toBe('unavailable');
    expect(error.message).toMatch(/node bin\/cjs-sde-prepare\.js --build 42/);
    const offline = MakeFakeShipData({ '/eve/latest/build': 'network-error' });
    expect((await CaughtShipDataFailure(offline.shipData.Hull({ type: 17732 }))).failure).toBe('unavailable');
  });

  it('reports the DNA of a numeric type, best effort', async () => {
    const { shipData } = MakeFakeShipData();
    expect(await shipData.Hull({ type: 17732 })).toMatchObject({ typeID: 17732, dna: TFI_DNA, resolvedFrom: 'type' });
    const guardian = await shipData.Hull({ type: 11987 });
    expect(guardian.dna).toBeNull();
    expect(guardian.name).toBe('Guardian');
  });

  it('caches lookups and retries a failed one', async () => {
    const routes: Record<string, Answer> = { ...SHIP_ROUTES, [`/eve/${SDE}/types/12058?lang=en`]: 'network-error' };
    const { shipData, calls } = MakeFakeShipData(routes);
    await shipData.Hull({ dna: TFI_DNA });
    const before = calls.length;
    await shipData.Hull({ dna: TFI_DNA });
    expect(calls.length).toBe(before);
    await CaughtShipDataFailure(shipData.PropMod(12058));
    routes[`/eve/${SDE}/types/12058?lang=en`] = SHIP_ROUTES[`/eve/${SDE}/types/12058?lang=en`];
    expect((await shipData.PropMod(12058)).kind).toBe('afterburner');
  });

  it('finds a prop mod by name: exactly, any case, MWD / AB abbreviated, listing the group once', async () => {
    const { shipData, calls } = MakeFakeShipData();
    expect(await shipData.PropModByName('500MN Cold-Gas Enduring Microwarpdrive')).toMatchObject({ typeID: 5945, kind: 'microwarpdrive', signatureRadiusBonus: 500, duration: 10_000 });
    expect((await shipData.PropModByName('500mn mwd ii')).typeID).toBe(12084);
    expect((await shipData.PropModByName('10MN AB II')).typeID).toBe(12058);
    expect(calls.filter((call) => call === PROP_MOD_LISTING_ROUTE)).toHaveLength(1);
  });

  it('refuses an unknown or unpublished module name, listing close names', async () => {
    const { shipData } = MakeFakeShipData();
    const unknown = await CaughtShipDataFailure(shipData.PropModByName('500MN Microwarpdrive I'));
    expect(unknown.failure).toBe('not-found');
    expect(unknown.message).toBe('no propulsion module is named "500MN Microwarpdrive I"; close names: "500MN Microwarpdrive II", "500MN Cold-Gas Enduring Microwarpdrive"');
    expect((await CaughtShipDataFailure(shipData.PropModByName('Unpublished Microwarpdrive'))).failure).toBe('not-found');
  });
});
