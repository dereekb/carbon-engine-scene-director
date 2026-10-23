import { describe, expect, it } from 'vitest';
import { IsWreckType } from './object-data';
import { ASTRAHUS_DNA, MakeFakeObjectData, OBJECT_ROUTES, RESOURCES, TITAN_WRECK_DNA, WRECK_DNA } from './object-data.testing';
import { type Answer, SDE } from './ship-data.testing';

async function Failure(action: Promise<unknown>): Promise<{ readonly failure: string; readonly message: string }> {
  const error = (await action.then(
    () => null,
    (failure: unknown) => failure
  )) as { readonly failure: string; readonly message: string } | null;
  if (!error) throw new Error('it resolved');
  return error;
}

describe('ObjectData.Type', () => {
  it('resolves a name, any case, and an id', async () => {
    const { objectData } = MakeFakeObjectData();
    expect(await objectData.Type({ type: 'astrahus' })).toEqual({ typeID: 35832, name: 'Astrahus', group: 'Citadel', groupID: 1657, category: 'Structure', categoryID: 65, graphicID: 21137, radius: 45000, radiusFrom: 'sde', sdeRadius: 45000, dna: ASTRAHUS_DNA, published: true, sdeBuild: SDE });
    expect(await objectData.Type({ type: 26550 })).toMatchObject({ name: 'Minmatar Frigate Wreck', group: 'Wreck', radius: 70, radiusFrom: 'sof', sdeRadius: 14, dna: WRECK_DNA, published: false });
  });

  it("gives a wreck with the SDE's 14 m placeholder its SOF hull's radius, read on the resource build", async () => {
    const { objectData, calls } = MakeFakeObjectData();
    expect(await objectData.Type({ type: 'Minmatar Titan Wreck' })).toMatchObject({ typeID: 26556, radius: 10891, radiusFrom: 'sof', sdeRadius: 14, dna: TITAN_WRECK_DNA });
    expect(calls).toContain(`/eve/${RESOURCES}/sof/hulls/mt1_t1_wreck`);
    expect(calls.filter((call) => call.startsWith(`/eve/${SDE}/sof/`))).toEqual([]);
  });

  it('keeps real SDE radii, wrecks included, with no SOF read', async () => {
    const { objectData, calls } = MakeFakeObjectData();
    expect(await objectData.Type({ type: 40644 })).toMatchObject({ name: 'Astrahus Wreck', radius: 45000, radiusFrom: 'sde', sdeRadius: 45000 });
    expect(await objectData.Type({ type: 16737 })).toMatchObject({ name: 'Ruined Stargate', radius: 5991, radiusFrom: 'sde' });
    expect(calls.filter((call) => call.includes('/sof/hulls/'))).toEqual([]);
  });

  it('gives a type with no SDE radius its SOF hull radius', async () => {
    expect(await MakeFakeObjectData().objectData.Type({ type: 2110 })).toMatchObject({ name: 'Minmatar Carrier Wreckage', radius: 1719, radiusFrom: 'sof', sdeRadius: null });
  });

  it('leaves no radius when the SOF read fails, says why, and retries; a missing hull is not asked twice', async () => {
    const route = `/eve/${RESOURCES}/sof/hulls/wreck_s`;
    const routes: Record<string, Answer> = { ...OBJECT_ROUTES, [route]: 'network-error' };
    const { objectData, calls } = MakeFakeObjectData(routes);
    const failed = await objectData.Type({ type: 26550 });
    expect(failed).toMatchObject({ radius: null, radiusFrom: 'none', sdeRadius: 14 });
    expect(failed.radiusNote).toMatch(/14 m placeholder radius and its model's \(SOF hull "wreck_s"\) could not be read/u);
    routes[route] = OBJECT_ROUTES[route];
    expect(await objectData.Type({ type: 26550 })).toMatchObject({ radius: 70, radiusFrom: 'sof' });
    expect(calls.filter((call) => call === route)).toHaveLength(2);

    delete routes[`/eve/${RESOURCES}/sof/hulls/mt1_t1_wreck`];
    const missing = await objectData.Type({ type: 26556 });
    expect(missing).toMatchObject({ radius: null, radiusFrom: 'none' });
    expect(missing.radiusNote).toMatch(/tools-core has no bounding radius for SOF hull "mt1_t1_wreck"/u);
    await objectData.Type({ type: 26556 });
    expect(calls.filter((call) => call.endsWith('/sof/hulls/mt1_t1_wreck'))).toHaveLength(1);
  });

  it('reads each SOF hull once', async () => {
    const { objectData, calls } = MakeFakeObjectData();
    expect((await objectData.Type({ type: 26550 })).radius).toBe(70);
    expect((await objectData.Type({ type: 26506 })).radius).toBe(70);
    expect(calls.filter((call) => call.endsWith('/sof/hulls/wreck_s'))).toHaveLength(1);
  });

  it('says a type has no graphic, by name and by id', async () => {
    const { objectData } = MakeFakeObjectData();
    const expected = 'type 34 "Tritanium" (Mineral) has no graphic, so it cannot be placed; search_objects lists types that can';
    expect(await Failure(objectData.Type({ type: 'Tritanium' }))).toMatchObject({ failure: 'invalid', message: expected });
    expect(await Failure(objectData.Type({ type: 34 }))).toMatchObject({ failure: 'invalid', message: expected });
  });

  it('says a graphic is not SOF', async () => {
    const { message } = await Failure(MakeFakeObjectData().objectData.Type({ type: 3796 }));
    expect(message).toMatch(/^type 3796 "Sun G5 \(Yellow\)" \(Sun\) has graphic 21468 but no SOF DNA: it is not a space object the page can build/u);
  });

  it('lists the ids of an ambiguous name and the close names of an unknown one', async () => {
    const { objectData } = MakeFakeObjectData();
    expect(await Failure(objectData.Type({ type: 'Sun G5 (Yellow)' }))).toMatchObject({ failure: 'ambiguous', message: '"Sun G5 (Yellow)" names 2 EVE types (3796, 3797); give a type id' });
    expect(await Failure(objectData.Type({ type: 'Astrahuss' }))).toMatchObject({ failure: 'not-found', message: 'no EVE type is named "Astrahuss"; close names: "Astrahus", "Astrahus Wreck"; search_objects finds more' });
    expect((await Failure(objectData.Type({ type: 999999 }))).failure).toBe('not-found');
  });

  it('reads an unprepared SDE as unavailable', async () => {
    const notPrepared = { status: 404, json: { error: `EVE SDE build ${SDE} is not prepared` } };
    const { objectData } = MakeFakeObjectData({ ...OBJECT_ROUTES, [`/eve/${SDE}/dna/resolve?name=Astrahus`]: notPrepared });
    const { failure, message } = await Failure(objectData.Type({ type: 'Astrahus' }));
    expect(failure).toBe('unavailable');
    expect(message).toMatch(/cjs-sde-prepare\.js --build 3632936/u);
  });

  it('caches lookups and retries a failure', async () => {
    const routes: Record<string, Answer> = { ...OBJECT_ROUTES, [`/eve/${SDE}/types/35832?lang=en`]: 'network-error' };
    const { objectData, calls } = MakeFakeObjectData(routes);
    expect((await Failure(objectData.Type({ type: 35832 }))).failure).toBe('unavailable');
    routes[`/eve/${SDE}/types/35832?lang=en`] = OBJECT_ROUTES[`/eve/${SDE}/types/35832?lang=en`];
    await objectData.Type({ type: 35832 });
    await objectData.Type({ type: 35832 });
    expect(calls.filter((call) => call.startsWith(`/eve/${SDE}/types/35832`))).toHaveLength(2);
  });
});

describe('IsWreckType', () => {
  it('takes the Wreck group, or a SOF wreck hull in any group', () => {
    expect(IsWreckType({ groupID: 186, dna: null })).toBe(true);
    expect(IsWreckType({ groupID: 319, dna: 'uwfr01_t1_wreck:upwell:generic' })).toBe(true);
    expect(IsWreckType({ groupID: 226, dna: WRECK_DNA })).toBe(true);
    expect(IsWreckType({ groupID: 1657, dna: ASTRAHUS_DNA })).toBe(false);
  });
});

describe('ObjectData.Search', () => {
  it('ranks name matches and drops description-only rows', async () => {
    const answer = await MakeFakeObjectData().objectData.Search({ query: 'Astrahus' });
    expect(answer.items.map((item) => item.name)).toEqual(['Astrahus', 'Astrahus Wreck']);
    expect(answer.items[0]).toEqual({ typeID: 35832, name: 'Astrahus', group: 'Citadel', category: 'Structure', radius: 45000, dna: ASTRAHUS_DNA, published: true });
    expect(answer.total).toBe(2);
  });

  it('filters on the group, and lists types without SOF only when placeable is false', async () => {
    const { objectData } = MakeFakeObjectData();
    expect((await objectData.Search({ query: 'Wreck', group: 'WRECK', limit: 1 })).items.map((item) => item.typeID)).toEqual([40644]);
    const placeable = await objectData.Search({ query: 'Tritanium' });
    expect(placeable.items).toEqual([]);
    expect(placeable.note).toMatch(/1 matching type\(s\) have no SOF graphic/u);
    expect((await objectData.Search({ query: 'Tritanium', placeable: false })).items).toEqual([{ typeID: 34, name: 'Tritanium', group: 'Mineral', category: 'Material', published: true }]);
    expect((await objectData.Search({ query: 'Astrahus', limit: 500 })).items).toHaveLength(2);
  });

  it('shows the radius add_objects gives each type', async () => {
    const { items } = await MakeFakeObjectData().objectData.Search({ query: 'Wreck' });
    const byName = (name: string) => items.find((item) => item.name === name);
    expect(byName('Minmatar Frigate Wreck')).toMatchObject({ radius: 70, radiusFrom: 'sof' });
    expect(byName('Minmatar Titan Wreck')).toMatchObject({ radius: 10891, radiusFrom: 'sof' });
    expect(byName('Astrahus Wreck')).toMatchObject({ radius: 45000 });
    expect(byName('Astrahus Wreck')).not.toHaveProperty('radiusFrom');
  });
});
