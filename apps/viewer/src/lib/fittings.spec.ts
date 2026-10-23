import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { computeShipStats, defaultWeaponsOf, type DogmaBundle, FLEET_COMPOSITION_EXAMPLES, type FitTypeAnswer, fitTypeCategoryOf, normalizeFleetComposition, readDogmaBundle, type SceneShip } from '@scene-director/scene';
import { FitLookup, FleetModuleCountsOf, MAX_FIT_DOGMA_TYPE_IDS, ResolveShipFitting, ShipCapacitorReportOf, ShipDefenseReportOf, ShipFitReportOf, ShipModuleSpecsOf, type ResolvedShipFitting, type ShipFitPropMod } from './fittings';
import { ResolveFlight, type PublishedHull } from './flight';
import { ResolveShipPropMod } from './prop-mods';

// The scene package's committed dogma fixture (SDE 3632936): the specs stand in for the hub's fit routes with it.
const FIXTURE = readDogmaBundle(JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../../packages/scene/src/lib/fitting/fixtures/dogma-3632936.json'), 'utf8'))).bundle as DogmaBundle;
const SLOT_EFFECTS = new Map([
  [11, 'low'],
  [13, 'mid'],
  [12, 'high'],
  [2663, 'rig']
] as const);
const BY_NAME = new Map(Object.values(FIXTURE.types).map((type) => [type.name, type]));
const RIFTER = 587;
const RIFTER_HULL: PublishedHull = { typeID: 587, name: 'Rifter', published: { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35, radius: 31, warpSpeedMultiplier: 5 } };
const PLATED = '[Rifter, Plated]\n200mm Steel Plates II\n\n5MN Microwarpdrive II\n';

function Respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * The hub's fit routes over the fixture, or failing with a status.
 */
function FixtureHub(fail: Partial<Record<'type' | 'types' | 'skills', number>> = {}) {
  return vi.fn((url: string) => {
    const parsed = new URL(url, 'http://hub');
    let response: Response;
    if (parsed.pathname === '/fit/type') {
      const type = BY_NAME.get(parsed.searchParams.get('name') ?? '');
      const slot = type?.effects.map((id) => SLOT_EFFECTS.get(id as 11)).find(Boolean) ?? null;
      const answer: Partial<FitTypeAnswer> | null = type ? { typeID: type.typeID, name: type.name, groupID: type.groupID, categoryID: type.categoryID, category: fitTypeCategoryOf(type.categoryID), slot } : null;
      if (fail.type) response = Respond(fail.type, { error: { message: `no SDE (${fail.type})` } });
      else response = answer ? Respond(200, answer) : Respond(404, { error: { message: `no type is named "${parsed.searchParams.get('name')}"` }, failure: 'not-found' });
    } else if (parsed.pathname === '/dogma/types') {
      const ids = (parsed.searchParams.get('ids') ?? '').split(',').map(Number);
      const types = Object.fromEntries(ids.flatMap((id) => (FIXTURE.types[id] ? [[id, FIXTURE.types[id]]] : [])));
      const missing = ids.filter((id) => !FIXTURE.types[id]);
      response = fail.types ? Respond(fail.types, { error: { message: 'no SDE' } }) : Respond(200, { sdeBuild: FIXTURE.sdeBuild, types, effects: FIXTURE.effects, attributes: FIXTURE.attributes, missing });
    } else {
      const types = Object.fromEntries(Object.values(FIXTURE.types).flatMap((type) => (type.categoryID === 16 ? [[type.typeID, type]] : [])));
      response = fail.skills ? Respond(fail.skills, { error: { message: 'no SDE' } }) : Respond(200, { sdeBuild: FIXTURE.sdeBuild, types, effects: FIXTURE.effects, attributes: FIXTURE.attributes });
    }
    return Promise.resolve(response);
  });
}

function Ship(fit: string, extra: Partial<SceneShip> = {}): SceneShip {
  return { id: 'rifter', dna: 'mf1_t1:minmatarbase:minmatar', position: [0, 0, 0], rotation: [0, 0, 0], fit, ...extra } as SceneShip;
}

function PropMod(typeID: number, explicit = false, module: string | number = BY_NAME.get('5MN Microwarpdrive II')?.name ?? ''): ShipFitPropMod {
  return { module, typeID, name: FIXTURE.types[typeID]?.name ?? String(typeID), explicit };
}

async function Resolved(text: string, options: { readonly lookup?: FitLookup; readonly propMod?: ShipFitPropMod | null; readonly ship?: Partial<SceneShip> } = {}): Promise<ResolvedShipFitting> {
  const lookup = options.lookup ?? new FitLookup({ fetch: FixtureHub(), retryDelaysMs: [] });
  const input = { doc: Ship(text, options.ship), scene: null, lookup, hullTypeID: RIFTER, propMod: options.propMod === undefined ? PropMod(440) : options.propMod };
  // As the director does: prepare again while a resolution still waits on types (a replacing prop mod's, once the
  // fit's names have landed).
  let resolved = ResolveShipFitting(input) as ResolvedShipFitting;
  for (let round = 0; round < 3 && (round === 0 || resolved.pending); round++) {
    await lookup.Prepare({ text, typeIDs: resolved.typeIDs });
    resolved = ResolveShipFitting(input) as ResolvedShipFitting;
  }
  return resolved;
}

describe('FitLookup', () => {
  it("resolves a fit's names, its types and the skills once each, batching the types", async () => {
    const fetch = FixtureHub();
    const lookup = new FitLookup({ fetch, retryDelaysMs: [] });
    await Promise.all([lookup.Prepare({ text: PLATED, typeIDs: [RIFTER] }), lookup.Prepare({ text: PLATED, typeIDs: [RIFTER] })]);
    await lookup.Prepare({ text: PLATED, typeIDs: [RIFTER] });
    const urls = fetch.mock.calls.map(([url]) => url);
    expect(urls.filter((url) => url.startsWith('/fit/type'))).toEqual(['/fit/type?name=200mm%20Steel%20Plates%20II&hull=Rifter', '/fit/type?name=5MN%20Microwarpdrive%20II&hull=Rifter']);
    expect(urls.filter((url) => url.startsWith('/dogma/types'))).toEqual(['/dogma/types?ids=587,20347,440']);
    expect(urls.filter((url) => url.startsWith('/dogma/skills'))).toHaveLength(1);
    expect(lookup.skillsReady).toBe(true);
    expect(lookup.Bundle()?.types[20347]?.name).toBe('200mm Steel Plates II');
  });

  it(`splits a batch into requests of at most ${MAX_FIT_DOGMA_TYPE_IDS} ids and records the ids the EVE data lacks`, async () => {
    const fetch = FixtureHub();
    const lookup = new FitLookup({ fetch, retryDelaysMs: [] });
    const ids = Array.from({ length: 450 }, (_value, index) => 900_000 + index);
    await Promise.all([lookup.LookupTypes(ids.slice(0, 300)), lookup.LookupTypes([...ids.slice(250), RIFTER])]);
    expect(fetch.mock.calls.map(([url]) => url.split(',').length)).toEqual([200, 200, 51]);
    expect(lookup.TypeFailure(900_001)).toBe('the EVE data has no type 900001');
    expect(lookup.TypePending(RIFTER)).toBe(false);
  });

  it('keeps an unknown name apart from an unavailable hub, forgets both on ForgetFailures and never rejects', async () => {
    const lookup = new FitLookup({ fetch: FixtureHub(), retryDelaysMs: [] });
    expect(await lookup.LookupName('Nosuch Module', 'Rifter')).toEqual({ type: null, note: 'no type is named "Nosuch Module"', unavailable: false });
    const down = new FitLookup({ fetch: FixtureHub({ type: 503 }), retryDelaysMs: [] });
    expect(await down.LookupName('200mm Steel Plates II', 'Rifter')).toMatchObject({ type: null, note: 'no SDE (503)', unavailable: true });
    const offline = new FitLookup({ fetch: vi.fn(() => Promise.reject(new Error('offline'))), retryDelaysMs: [] });
    expect(await offline.LookupName('200mm Steel Plates II', 'Rifter')).toMatchObject({ type: null, unavailable: true, note: "the hub's /fit/type did not answer (offline)" });
    await offline.LookupSkills();
    expect(offline.skillsFailure).toBe("the hub's /dogma/skills did not answer (offline)");
    offline.ForgetFailures();
    expect(offline.Name('200mm Steel Plates II')).toBeNull();
    expect(offline.skillsFailure).toBeNull();
  });

  it('retries a lookup the hub could not answer, but not an unknown name', async () => {
    const hub = FixtureHub();
    let drops = 2;
    const fetch = vi.fn((url: string) => (url.includes('Plates') && drops-- > 0 ? Promise.resolve(Respond(503, { error: { message: 'tools-core is unreachable: fetch failed' } })) : hub(url)));
    const lookup = new FitLookup({ fetch, retryDelaysMs: [0, 0] });
    expect((await lookup.LookupName('200mm Steel Plates II', 'Rifter')).type?.typeID).toBe(20347);
    expect(fetch).toHaveBeenCalledTimes(3);
    await lookup.LookupName('Nosuch Module', 'Rifter');
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('memoizes dogma stats per bundle', async () => {
    const lookup = new FitLookup({ fetch: FixtureHub(), retryDelaysMs: [] });
    const resolved = await Resolved(PLATED, { lookup });
    const input = { hull: null, dogma: resolved.dogma };
    expect(lookup.ShipStats(input)).toBe(lookup.ShipStats(input));
    expect(lookup.ShipStats(input)).toEqual(computeShipStats(input));
    const webbed = { ...input, incoming: [{ source: 'tackle: Stasis Webifier II (mid-0)', effect: 'remoteWebifierFalloff', attributeID: 37, operation: 6, amount: -60, resistanceAttributeID: 2115 }] };
    expect(lookup.ShipStats(webbed)).not.toBe(lookup.ShipStats(webbed));
    expect(lookup.ShipStats(webbed).maxVelocity).toBeCloseTo(lookup.ShipStats(input).maxVelocity * 0.4, 9);
  });

  it('webs a fitted ship on the dogma path, its running prop mod included', async () => {
    const lookup = new FitLookup({ fetch: FixtureHub(), retryDelaysMs: [] });
    const resolved = await Resolved(PLATED, { lookup });
    const propMod = ResolveShipPropMod({ module: 'mwd', rigSize: 1, answer: null });
    const incoming = [{ source: 'tackle: Stasis Webifier II (mid-0)', effect: 'remoteWebifierFalloff', attributeID: 37, operation: 6, amount: -60, resistanceAttributeID: 2115 }];
    const free = ResolveFlight({ published: null, hull: null, overrides: null, propMod, dogma: resolved.dogma, compute: (input) => lookup.ShipStats(input) });
    const webbed = ResolveFlight({ published: null, hull: null, overrides: null, propMod, dogma: resolved.dogma, incoming, compute: (input) => lookup.ShipStats(input) });
    expect(webbed.math).toBe('dogma');
    expect(webbed.maxVelocity).toBeCloseTo(free.maxVelocity * 0.4, 9);
    expect(webbed.propMod?.maxVelocity).toBeLessThan(free.propMod?.maxVelocity ?? 0);
    expect(webbed.warpScrambleStatus).toBe(0);
  });
});

describe('ResolveShipFitting', () => {
  it('types the fit provisionally while names are pending, then gives the dogma input', async () => {
    const lookup = new FitLookup({ fetch: FixtureHub(), retryDelaysMs: [] });
    const pending = ResolveShipFitting({ doc: Ship(PLATED), scene: null, lookup, hullTypeID: RIFTER, propMod: PropMod(440) });
    expect(pending).toMatchObject({ pending: true, dogma: null, note: "resolving 2 of the fit's 2 names", key: 'inline', typeIDs: [RIFTER] });
    expect(pending?.fitting.unknown).toEqual([]);
    expect(pending?.modules.map((module) => module.key)).toEqual(['low-0', 'mid-0']);
    const resolved = await Resolved(PLATED, { lookup });
    expect(resolved).toMatchObject({ pending: false, note: null });
    expect(resolved.dogma).toMatchObject({
      hullTypeID: RIFTER,
      propModKey: 'mid-0',
      modules: [
        { key: 'low-0', typeID: 20347, state: 'online' },
        { key: 'mid-0', typeID: 440, state: 'online' }
      ]
    });
  });

  it('flies the plated Rifter by its fit: armor, mass and the MWD from dogma', async () => {
    const resolved = await Resolved(PLATED);
    const flight = ResolveFlight({ published: RIFTER_HULL, hull: null, overrides: null, propMod: null, dogma: resolved.dogma });
    expect(flight).toMatchObject({ math: 'dogma', source: 'sde', mass: 1_168_250, radius: 31 });
    expect(flight.defense?.armor.hp).toBeCloseTo(1312.5, 9);
    // The online MWD's capacitor penalty.
    expect(flight.capacitor?.capacity).toBeCloseTo(250, 9);
    // Long Range Targeting V and Signature Analysis V on the Rifter's 22,500 m and 660 mm.
    expect(flight.targeting).toEqual({ maxTargetRange: 28_125, scanResolution: 825, maxLockedTargets: 4 });
  });

  it("flies a fit of only a prop mod at the table path's numbers", async () => {
    const resolved = await Resolved('[Rifter, AB]\n\n1MN Afterburner II\n', { propMod: PropMod(438) });
    const propMod = ResolveShipPropMod({ module: '1MN Afterburner II', rigSize: 1, answer: null });
    const dogma = ResolveFlight({ published: RIFTER_HULL, hull: null, overrides: null, propMod, dogma: resolved.dogma });
    const table = ResolveFlight({ published: RIFTER_HULL, hull: null, overrides: null, propMod });
    expect(dogma.math).toBe('dogma');
    expect(table.math).toBe('table');
    for (const key of ['mass', 'maxVelocity', 'agility', 'signatureRadius', 'alignTime', 'radius', 'warpSpeed'] as const) expect(dogma[key]).toBeCloseTo(table[key], 9);
    for (const key of ['mass', 'maxVelocity', 'signatureRadius', 'alignTime', 'cycleTime'] as const) expect(dogma.propMod?.[key]).toBeCloseTo(table.propMod?.[key] ?? Number.NaN, 9);
  });

  it('names the key of a document fit and waits for the hull or reports why there is no dogma', async () => {
    const lookup = new FitLookup({ fetch: FixtureHub(), retryDelaysMs: [] });
    await lookup.Prepare({ text: PLATED, typeIDs: [RIFTER] });
    const keyed = ResolveShipFitting({ doc: Ship('rifters/plated'), scene: { fits: { 'rifters/plated': PLATED } }, lookup, hullTypeID: null, propMod: PropMod(440) });
    expect(keyed).toMatchObject({ key: 'rifters/plated', dogma: null, pending: false, note: "waiting for the hull's EVE type" });
    expect(ResolveShipFitting({ doc: Ship('rifters/plated'), scene: { fits: { 'rifters/plated': PLATED } }, lookup, hullTypeID: null, hullNote: 'no SDE', propMod: null })?.note).toBe("the fit's modules need the hull's EVE type: no SDE");
    expect(ResolveShipFitting({ doc: Ship('rifters/gone'), scene: { fits: {} }, lookup, hullTypeID: RIFTER })).toBeNull();

    const down = new FitLookup({ fetch: FixtureHub({ type: 503 }), retryDelaysMs: [] });
    await down.Prepare({ text: PLATED, typeIDs: [RIFTER] });
    expect(ResolveShipFitting({ doc: Ship(PLATED), scene: null, lookup: down, hullTypeID: RIFTER, propMod: PropMod(440) })).toMatchObject({ dogma: null, pending: false, note: "the fit's modules need the EVE data: no SDE (503)" });

    const noSkills = new FitLookup({ fetch: FixtureHub({ skills: 503 }), retryDelaysMs: [] });
    await noSkills.Prepare({ text: PLATED, typeIDs: [RIFTER] });
    expect(ResolveShipFitting({ doc: Ship(PLATED), scene: null, lookup: noSkills, hullTypeID: RIFTER, propMod: PropMod(440) })?.note).toBe("the fit's modules need the skills' dogma: no SDE");
  });

  it('lists names the EVE data lacks as unknown and still runs dogma without them', async () => {
    const resolved = await Resolved(`${PLATED}\nNosuch Launcher\n`);
    expect(resolved.fitting.unknown).toEqual(['Nosuch Launcher']);
    expect(resolved.dogma?.modules?.map((module) => module.key)).toEqual(['low-0', 'mid-0']);
  });

  it("replaces the fit's prop mod with an explicit other one, adds one to a fit without, and leaves it offline for none", async () => {
    const ab = await Resolved(PLATED, { propMod: PropMod(438, true, 'ab') });
    expect(ab.dogma?.modules?.find((module) => module.key === 'mid-0')?.typeID).toBe(438);
    expect(ab.modules[1]).toMatchObject({ key: 'mid-0', name: '1MN Afterburner II', prop: true, note: `propMod.module "ab" replaces the fit's 5MN Microwarpdrive II` });
    expect(ab.typeIDs).toEqual([RIFTER, 438]);

    const same = await Resolved(PLATED, { propMod: PropMod(440, true, '5mn microwarpdrive ii') });
    expect(same.modules[1].note).toBeUndefined();

    const added = await Resolved('[Rifter, Plates only]\n200mm Steel Plates II\n', { propMod: PropMod(438) });
    expect(added.modules.at(-1)).toMatchObject({ key: 'mid-0', typeID: 438, slot: 'mid', prop: true });
    expect(added.dogma?.propModKey).toBe('mid-0');

    const none = await Resolved(PLATED, { propMod: null });
    expect(none.modules[1]).toMatchObject({ key: 'mid-0', offline: true, note: 'propMod.module "none": left offline' });
    expect(none.dogma).toMatchObject({ propModKey: null });
    expect(none.dogma?.modules?.[1]).toMatchObject({ state: 'offline' });
  });
});

describe('default weapons and cargo charges', () => {
  it("flies an unfitted Rifter's default guns as its fit, at the bare hull's numbers", async () => {
    const lookup = new FitLookup({ fetch: FixtureHub(), retryDelaysMs: [] });
    const text = defaultWeaponsOf({ hull: FIXTURE.types[RIFTER] }).text ?? Fail('no default weapons');
    const input = { doc: Ship('', { fit: undefined }), scene: null, lookup, hullTypeID: RIFTER, propMod: PropMod(440), fallback: { text, key: 'default' } };
    let resolved = ResolveShipFitting(input) as ResolvedShipFitting;
    for (let round = 0; round < 3 && (round === 0 || resolved.pending); round++) {
      await lookup.Prepare({ text, typeIDs: resolved.typeIDs });
      resolved = ResolveShipFitting(input) as ResolvedShipFitting;
    }
    expect(resolved).toMatchObject({ key: 'default', default: true, pending: false, note: null });
    expect(resolved.modules.map((module) => [module.key, module.name, module.charge?.name ?? null])).toEqual([
      ['high-0', '200mm AutoCannon II', 'EMP S'],
      ['high-1', '200mm AutoCannon II', 'EMP S'],
      ['high-2', '200mm AutoCannon II', 'EMP S'],
      ['mid-0', '5MN Microwarpdrive II', null]
    ]);
    expect(resolved.modules.slice(0, 3).every((module) => module.weapon === 'turret')).toBe(true);
    expect(ShipFitReportOf(resolved, () => ({ state: 'online' }))).toMatchObject({ key: 'default', default: true, math: 'dogma' });
    // Turrets and charges touch no flight attribute: the default fit flies the bare hull's table numbers.
    const propMod = ResolveShipPropMod({ module: '5MN Microwarpdrive II', rigSize: 1, answer: null });
    const dogma = ResolveFlight({ published: RIFTER_HULL, hull: null, overrides: null, propMod, dogma: resolved.dogma });
    const table = ResolveFlight({ published: RIFTER_HULL, hull: null, overrides: null, propMod });
    expect(dogma.math).toBe('dogma');
    for (const key of ['mass', 'maxVelocity', 'agility', 'signatureRadius', 'alignTime', 'radius', 'warpSpeed'] as const) expect(dogma[key]).toBeCloseTo(table[key], 9);
    // The ship's own fit always wins over the fallback.
    const own = ResolveShipFitting({ ...input, doc: Ship(PLATED) });
    expect(own?.key).toBe('inline');
    expect(own?.default).toBeUndefined();
    expect(ResolveShipFitting({ ...input, fallback: null })).toBeNull();
  });

  it("loads a TFI's guns with the first fitting charge in its cargo, Barrage L, and notes it", async () => {
    const fits = normalizeFleetComposition({ input: FLEET_COMPOSITION_EXAMPLES[0] }).composition?.fits ?? {};
    const text = fits['tfi'] ?? Fail('no TFI fit');
    const lookup = new FitLookup({ fetch: FixtureHub(), retryDelaysMs: [] });
    const input = { doc: Ship(text, { dna: 'mb2_t1:minmatarbase:minmatar' }), scene: null, lookup, hullTypeID: 17732, propMod: null };
    let resolved = ResolveShipFitting(input) as ResolvedShipFitting;
    for (let round = 0; round < 3 && (round === 0 || resolved.pending); round++) {
      await lookup.Prepare({ text, typeIDs: resolved.typeIDs });
      resolved = ResolveShipFitting(input) as ResolvedShipFitting;
    }
    const guns = resolved.modules.filter((module) => module.weapon === 'turret');
    expect(guns.map((module) => module.key)).toEqual(['high-0', 'high-1', 'high-3', 'high-4', 'high-6', 'high-7']);
    expect(guns.every((module) => module.charge?.name === 'Barrage L' && module.chargeNote === 'loaded from cargo')).toBe(true);
    // The loaded charge enters dogma with its gun.
    const barrage = BY_NAME.get('Barrage L')?.typeID;
    expect(resolved.dogma?.modules?.find((module) => module.key === 'high-0')?.chargeTypeID).toBe(barrage);
    const row = ShipFitReportOf(resolved, () => ({ state: 'online' })).modules.find((module) => module.module === 'high-0');
    expect(row).toMatchObject({ charge: 'Barrage L', note: 'loaded from cargo' });
  });
});

describe('ShipModuleSpecsOf', () => {
  it('gives the activation layer every resolved module but the prop mod, with how it activates', async () => {
    const lookup = new FitLookup({ fetch: FixtureHub(), retryDelaysMs: [] });
    const resolved = await Resolved(`[Rifter, Tackle]\n200mm Steel Plates II\nDamage Control II /OFFLINE\n\n5MN Microwarpdrive II\nStasis Webifier II\nWarp Scrambler II\n`, { lookup });
    const specs = ShipModuleSpecsOf(resolved, lookup);
    expect(specs.map((spec) => [spec.key, spec.activation.category, spec.offline, spec.activation.refusal == null, spec.activation.targeted])).toEqual([
      ['low-0', 'other', false, false, false],
      ['low-1', 'damage-control', true, false, false],
      ['mid-1', 'web', false, true, true],
      ['mid-2', 'scram', false, true, true]
    ]);
    const dogma = resolved.dogma ?? Fail('no dogma');
    expect(lookup.Evaluate({ bundle: dogma.bundle, hullTypeID: RIFTER, modules: dogma.modules })).toBe(lookup.Evaluate({ bundle: dogma.bundle, hullTypeID: RIFTER, modules: dogma.modules }));
    expect(ShipModuleSpecsOf({ ...resolved, dogma: null }, lookup)).toEqual([]);
  });

  it("gives each turret its combat numbers from the same evaluation (the default Rifter's §1.3 row)", async () => {
    const lookup = new FitLookup({ fetch: FixtureHub(), retryDelaysMs: [] });
    const resolved = await Resolved(
      `[Rifter, Guns]


200mm AutoCannon II, EMP S
`,
      { lookup }
    );
    const [gun] = ShipModuleSpecsOf(resolved, lookup);
    expect(gun.activation.weapon).toBe('turret');
    expect(gun.combat).toMatchObject({ key: 'high-0', kind: 'tracking', optimal: 750, falloff: 9675 });
    expect(gun.combat?.volley).toBeCloseTo(65.75, 2);
    expect(gun.combat?.tracking).toBeCloseTo(393.75, 6);
  });
});

describe('get_state reports', () => {
  it('reports the fit compactly, the defense rounded and the fleet counts by state', async () => {
    const resolved = await Resolved(`[Rifter, Plated]\n200mm Steel Plates II\nDamage Control II /OFFLINE\n\n5MN Microwarpdrive II\n\n\nWarrior II x2\n`);
    const report = ShipFitReportOf(resolved, (module) => ({ state: module.offline ? 'offline' : module.prop ? 'active' : 'online' }));
    expect(report).toEqual({
      name: 'Plated',
      key: 'inline',
      hull: 'Rifter',
      typeID: RIFTER,
      unknown: ['Warrior II'],
      modules: [
        { module: 'low-0', name: '200mm Steel Plates II', state: 'online' },
        { module: 'low-1', name: 'Damage Control II', state: 'offline' },
        { module: 'mid-0', name: '5MN Microwarpdrive II', state: 'active', prop: true }
      ],
      drones: [],
      math: 'dogma'
    });
    expect(FleetModuleCountsOf([...report.modules, ...report.modules])).toEqual({ offline: 2, online: 2, activating: 0, active: 2, stopping: 0, reactivating: 0 });
    const flight = ResolveFlight({ published: RIFTER_HULL, hull: null, overrides: null, dogma: resolved.dogma });
    const defense = ShipDefenseReportOf(flight.defense ?? Fail('no defense'));
    expect(defense.armor).toEqual({ hp: 1312.5, max: 1312.5, resists: { em: 60, thermal: 35, kinetic: 25, explosive: 10 }, ehp: expect.any(Number) });
    expect(ShipCapacitorReportOf(flight.capacitor ?? Fail('no capacitor'))).toMatchObject({ capacity: 250, rechargeTime: 93.75, drain: 0, stable: true });
  });
});

function Fail(message: string): never {
  throw new Error(message);
}
