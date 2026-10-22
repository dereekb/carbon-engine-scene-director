import { describe, expect, it } from 'vitest';
import { ASTRAHUS_DNA, MakeFakeObjectData, OBJECT_ROUTES, WRECK_DNA } from './object-data.testing';
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
    expect(await objectData.Type({ type: 'astrahus' })).toEqual({ typeID: 35832, name: 'Astrahus', group: 'Citadel', groupID: 1657, category: 'Structure', categoryID: 65, graphicID: 21137, radius: 45000, dna: ASTRAHUS_DNA, published: true, sdeBuild: SDE });
    expect(await objectData.Type({ type: 26550 })).toMatchObject({ name: 'Minmatar Frigate Wreck', group: 'Wreck', radius: 14, dna: WRECK_DNA, published: false });
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
});
