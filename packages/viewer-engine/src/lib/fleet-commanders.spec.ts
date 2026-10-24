import { applySceneOperations, type FleetBrainAction, type FleetShipFacts, normalizeScene, resolveShipStances, type SceneDocument, type ShipOrder, toLiveFleetScene } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { type FleetBrainPort, FleetCommanders } from './fleet-commanders';
import { RoundTrip } from './state-capture.spec-helper';

const DNA = 'mf1_t1:minmatarbase:minmatar';
const FLEET = 'f';
const DPS = { fleet: FLEET, kind: 'squad', id: 'dps' } as const;
const WHOLE = { fleet: FLEET, kind: 'fleet', id: FLEET } as const;

function MakeScene(): SceneDocument {
  const ids = ['fc', 'd1', 'd2', 'r1', 'r2', 'r3'];
  return normalizeScene({
    ships: ids.map((id) => ({ id, dna: DNA })),
    objects: [{ id: 'astra', dna: DNA }],
    fleets: [{ id: FLEET, commander: 'fc', targets: ['r1', 'r2'], wings: [{ id: 'w', squads: [{ id: 'dps', role: 'dps', members: ['d1', 'd2'] }] }] }]
  }).scene;
}

const Live = (scene: SceneDocument, commanders: FleetCommanders) => toLiveFleetScene(scene, new Set(), commanders.Overlay()).scene;

describe('FleetCommanders', () => {
  it("overlays live calls on the document's, [] calling nothing, and bumps its version on a change only", () => {
    const scene = MakeScene();
    const commanders = new FleetCommanders();
    expect(Live(scene, commanders)).toBe(scene);

    commanders.SetCall(DPS, ['r3']);
    commanders.SetCall(WHOLE, []);
    const version = commanders.version;
    const live = Live(scene, commanders);
    expect(live.fleets?.[0].wings[0].squads[0].targets).toEqual(['r3']);
    expect(live.fleets?.[0].targets).toBeUndefined();
    expect(scene.fleets?.[0].targets).toEqual(['r1', 'r2']);
    expect(commanders.CallOf(DPS)).toEqual(['r3']);

    const overlay = commanders.Overlay();
    commanders.SetCall(DPS, ['r3']);
    expect(commanders.version).toBe(version);
    expect(commanders.Overlay()).toBe(overlay);

    commanders.Clear();
    expect(commanders.version).toBe(version + 1);
    expect(commanders.CallOf(DPS)).toBeNull();
    expect(Live(scene, commanders)).toBe(scene);
  });

  it("prunes removed ships and objects from live lists with remove_ship's warning, and keeps an emptied list", () => {
    const scene = MakeScene();
    const commanders = new FleetCommanders();
    commanders.SetCall(DPS, ['astra', 'r3']);
    commanders.SetCall(WHOLE, ['r2']);
    const after = applySceneOperations(scene, [
      { op: 'remove_object', id: 'astra' },
      { op: 'remove_ship', id: 'r2' }
    ]);
    expect(after.scene.fleets?.[0].targets).toEqual(['r1']);
    const warnings = commanders.AfterEdit(scene, after.scene);
    expect(warnings).toEqual(['fleet "f": squad "dps" no longer calls "astra" (it was removed)', 'fleet "f" no longer calls "r2" (it was removed)']);
    expect(after.warnings).toContain('fleet "f" no longer calls "r2" (it was removed)');
    expect(commanders.CallOf(DPS)).toEqual(['r3']);
    // The FC's live call ran out: the document's pruned list must not come back.
    expect(commanders.CallOf(WHOLE)).toEqual([]);
    expect(Live(after.scene, commanders).fleets?.[0].targets).toBeUndefined();
  });

  it("drops a live call when its group goes or the patch edits the group's document list", () => {
    const scene = MakeScene();
    const commanders = new FleetCommanders();
    commanders.SetCall(DPS, ['r3']);
    commanders.SetCall(WHOLE, ['r3']);
    const unrelated = applySceneOperations(scene, [{ op: 'update_ship', id: 'r1', set: { name: 'Red one' } }]).scene;
    expect(commanders.AfterEdit(scene, unrelated)).toEqual([]);
    expect(commanders.CallOf(WHOLE)).toEqual(['r3']);

    const edited = applySceneOperations(unrelated, [{ op: 'update_fleet', fleet: FLEET, set: { targets: ['r2'] } }]).scene;
    const version = commanders.version;
    commanders.AfterEdit(unrelated, edited);
    expect(commanders.version).toBe(version + 1);
    expect(commanders.CallOf(WHOLE)).toBeNull();
    expect(Live(edited, commanders).fleets?.[0].targets).toEqual(['r2']);
    expect(commanders.CallOf(DPS)).toEqual(['r3']);

    const gone = applySceneOperations(edited, [{ op: 'remove_squad', fleet: FLEET, squad: 'dps' }]).scene;
    commanders.AfterEdit(edited, gone);
    expect(commanders.CallOf(DPS)).toBeNull();
  });

  it('keeps free fire per group, out of the live view, until its group goes or a load', () => {
    const scene = MakeScene();
    const commanders = new FleetCommanders();
    const version = commanders.version;
    commanders.SetFreeFire(DPS, true);
    commanders.SetFreeFire(WHOLE, true);
    expect(commanders.FreeFireOf(DPS)).toBe(true);
    expect([...commanders.FreeFireKeys()]).toEqual(['f/squad/dps', 'f']);
    expect(commanders.version).toBe(version);
    expect(Live(scene, commanders)).toBe(scene);
    commanders.SetFreeFire(WHOLE, false);
    expect(commanders.FreeFireOf(WHOLE)).toBe(false);

    const removed = applySceneOperations(scene, [{ op: 'remove_squad', fleet: FLEET, squad: 'dps' }]).scene;
    commanders.AfterEdit(scene, removed);
    expect(commanders.FreeFireOf(DPS)).toBe(false);
    commanders.SetFreeFire(WHOLE, true);
    commanders.Clear();
    expect(commanders.FreeFireKeys().size).toBe(0);
  });
});

/**
 * A personality fleet `f` (fc, d1, d2 on team blue) and two hostiles r1, r2 on team red, ahead along +x. The custom
 * personalities fix the FC ability (1 or 0) and hold position (no moves, no prop mods, no free fire), so only the call
 * lever pulls.
 */
function BrainScene(personality: string, extra: Record<string, unknown> = {}): SceneDocument {
  const template = (ability: number, more: Record<string, unknown> = {}) => ({
    schema: 'cjs-fleet-personality/1',
    command: { ability, backups: 2, handover: 20 },
    pilots: { reaction: 1 },
    engage: 'on-sight',
    targeting: { queue: 1, freeFire: false },
    movement: { stance: 'hold', propMods: 'never' },
    ...more
  });
  return normalizeScene({
    ships: [
      { id: 'fc', dna: DNA, team: 'blue', position: [0, 0, 0] },
      { id: 'd1', dna: DNA, team: 'blue', position: [0, 0, 500] },
      { id: 'd2', dna: DNA, team: 'blue', position: [0, 0, -500] },
      { id: 'r1', dna: DNA, team: 'red', position: [5000, 0, 0] },
      { id: 'r2', dna: DNA, team: 'red', position: [8000, 0, 0] }
    ],
    personalities: {
      sharp: template(1),
      slow: template(0),
      lone: template(1, { command: { ability: 1, backups: 0, succession: ['most-able'], handover: 20 } })
    },
    fleets: [{ id: FLEET, commander: 'fc', personality, wings: [{ id: 'w', squads: [{ id: 'dps', role: 'dps', members: ['d1', 'd2'] }] }] }],
    ...extra
  }).scene;
}

interface BrainRun extends FleetBrainAction {
  readonly tick: number;
}

/**
 * The brain over a fake port: every ship settled and planned, facts from the document's positions, the brain's calls
 * landing in the call book, its moves as the FC's order. `Kill` explodes a ship (out of the live view), `Flag` flags it,
 * `arriving` holds ships still warping in (away), `Edit` patches the document.
 */
function BrainRig(initial: SceneDocument, piloted: ReadonlySet<string> = new Set()) {
  let scene = initial;
  const runs: BrainRun[] = [];
  const handovers: { fleet: string; from: string; to: string }[] = [];
  const destroyed = new Set<string>();
  const dead = new Set<string>();
  const arriving = new Set<string>();
  const unsettled = new Set<string>();
  const orders = new Map<string, ShipOrder>();
  // The port reads the commanders it is built into (set below, before any call).
  const holder: { commanders?: FleetCommanders } = {};
  const Commanders = (): FleetCommanders => holder.commanders as FleetCommanders;
  const live = (): SceneDocument => toLiveFleetScene(scene, dead, Commanders().Overlay()).scene;
  const port: FleetBrainPort = {
    Document: () => scene,
    Live: live,
    Destroyed: (id) => destroyed.has(id),
    Ready: () => true,
    Settled: (id) => !unsettled.has(id),
    Facts: () =>
      scene.ships
        .filter((doc) => !dead.has(doc.id))
        .map((doc): FleetShipFacts => ({
          id: doc.id,
          ...(doc.team ? { team: doc.team } : {}),
          position: doc.position,
          radius: 50,
          health: 1,
          remaining: 5000,
          dps: 100,
          signature: 40,
          speed: 400,
          ...(destroyed.has(doc.id) || arriving.has(doc.id) ? { away: true } : {}),
          reach: { lock: 30_000, optimal: 5000, falloff: 10_000 },
          attackedBy: []
        })),
    OrderOf: (id) => orders.get(id) ?? null,
    CallOf: (fleet) => (Commanders().CallOf({ fleet, kind: 'fleet', id: fleet }) ?? []).filter((id) => !destroyed.has(id)),
    PropMods: () => 'none',
    Run: (action, tick) => {
      runs.push({ tick, ...action });
      const order = action.args['order'] as Record<string, unknown>;
      if (order['type'] === 'targets') Commanders().SetCall(WHOLE, (order['set'] as string[] | undefined) ?? []);
      else if (order['type'] === 'free-fire') Commanders().SetFreeFire(WHOLE, order['on'] === true);
    },
    HandOver: (fleet, from, to, apply) => {
      handovers.push({ fleet, from, to });
      apply();
    },
    Piloted: (id) => piloted.has(id)
  };
  const commanders = new FleetCommanders({ port });
  holder.commanders = commanders;
  return {
    commanders,
    runs,
    handovers,
    arriving,
    unsettled,
    live,
    Edit(operations: unknown[]) {
      const before = scene;
      scene = applySceneOperations(scene, operations as Parameters<typeof applySceneOperations>[1]).scene;
      commanders.AfterEdit(before, scene);
    },
    Steps(from: number, to: number) {
      for (let tick = from; tick <= to; tick++) commanders.Step(tick);
    },
    Kill(id: string, tick: number) {
      // As Director.Destroy: the fleets it commands are read before its death enters the live view.
      const commanded = (live().fleets ?? []).filter((fleet) => fleet.commander === id).map((fleet) => fleet.id);
      destroyed.add(id);
      dead.add(id);
      for (const fleet of commanded) commanders.CommanderDown(fleet, id, tick);
    },
    Flag(id: string) {
      destroyed.add(id);
    }
  };
}

const CallArgs = (by: string, set: string[]) => ({ fleet: FLEET, by, order: { type: 'targets', set } });

describe('FleetCommanders: the stance book', () => {
  it("splices live group stances over the document's, null clearing one, and keeps the pilots' own by ship", () => {
    const scene = applySceneOperations(MakeScene(), [{ op: 'update_fleet', fleet: FLEET, set: { stance: { type: 'kite' } } }]).scene;
    const commanders = new FleetCommanders();
    const version = commanders.version;
    commanders.SetStance(DPS, { type: 'orbit', on: 'r1', range: [20000, 30000], formation: 'loose' }, { tick: 7, delays: new Map([['d2', 3]]) });
    commanders.SetStance(WHOLE, null, { tick: 7, delays: new Map() });
    commanders.SetShipStance('d1', { type: 'brawl' });
    expect(commanders.version).toBe(version + 3);
    expect(commanders.StanceOf(DPS)).toMatchObject({ tick: 7, delays: new Map([['d2', 3]]) });
    const live = Live(scene, commanders);
    expect(live.fleets?.[0].stance).toBeUndefined();
    expect(scene.fleets?.[0].stance).toEqual({ type: 'kite' });
    const resolved = resolveShipStances(live, { ships: commanders.ShipStances() });
    expect(resolved.get('fc')?.type).toBe('in-line');
    expect(resolved.get('d1')).toMatchObject({ type: 'brawl', flownBy: 'd1' });
    expect(resolved.get('d2')).toMatchObject({ type: 'orbit', flownBy: 'd2', pilot: { on: 'r1' } });

    commanders.Clear();
    expect(commanders.StanceOf(DPS)).toBeNull();
    expect(commanders.ShipStances().size).toBe(0);
    expect(Live(scene, commanders)).toBe(scene);
  });

  it('drops a live stance its patch edits or whose group is gone, and falls an on back to the focus when its ship goes', () => {
    const scene = MakeScene();
    const commanders = new FleetCommanders();
    commanders.SetStance(DPS, { type: 'orbit', on: 'r1' }, { tick: 0, delays: new Map() });
    commanders.SetStance(WHOLE, { type: 'kite' }, { tick: 0, delays: new Map() });
    commanders.SetShipStance('d2', { type: 'keep-at-range', on: 'r1', range: 5000 });
    commanders.SetShipStance('r3', { type: 'brawl' });
    const after = applySceneOperations(scene, [
      { op: 'remove_ship', id: 'r1' },
      { op: 'remove_ship', id: 'r3' },
      { op: 'update_fleet', fleet: FLEET, set: { stance: { type: 'snipe' } } }
    ]);
    const warnings = commanders.AfterEdit(scene, after.scene);
    expect(warnings).toEqual(expect.arrayContaining([`fleet "f": squad "dps"'s live stance now flies on its focus (its on ship "r1" was removed)`, `ship "d2"'s live stance now flies on its focus (its on ship "r1" was removed)`]));
    expect(commanders.StanceOf(DPS)?.stance).toEqual({ type: 'orbit' });
    expect(commanders.StanceOf(WHOLE)).toBeNull();
    expect(commanders.ShipStances().get('d2')).toEqual({ type: 'keep-at-range', range: 5000 });
    expect(commanders.ShipStances().has('r3')).toBe(false);

    const gone = applySceneOperations(after.scene, [{ op: 'remove_squad', fleet: FLEET, squad: 'dps' }]).scene;
    commanders.AfterEdit(after.scene, gone);
    expect(commanders.StanceOf(DPS)).toBeNull();
  });

  it('round-trips the stance book through a snapshot', () => {
    const commanders = new FleetCommanders();
    commanders.SetStance(DPS, { type: 'support' }, { tick: 3, delays: new Map([['d1', 2]]) });
    commanders.SetShipStance('d2', null);
    const trip = RoundTrip(
      commanders,
      (c) => [c.Overlay(), c.StanceOf(DPS), [...c.ShipStances()]],
      (c) => {
        c.SetStance(WHOLE, { type: 'kite' }, { tick: 9, delays: new Map() });
        c.SetShipStance('d2', { type: 'brawl' });
      }
    );
    expect(trip.mutated).not.toEqual(trip.before);
    expect(trip.after).toEqual(trip.before);
  });
});

describe('FleetCommanders: the FC brain', () => {
  it('an FC of ability 1 calls the nearest in reach at the boundary it engages; ability 0 waits 5-10 s over it', () => {
    const sharp = BrainRig(BrainScene('sharp'));
    sharp.Steps(1, 3);
    expect(sharp.runs.map((run) => [run.tick, run.tool, run.args])).toEqual([[1, 'order_fleet', CallArgs('fc', ['r1', 'r2'])]]);
    expect(sharp.commanders.Report(FLEET, 3)).toMatchObject({ personality: 'sharp', ship: 'fc', ability: 1, state: 'commanding', engaged: true, hostiles: 2, readyAt: 1, manual: [], pending: [] });
    expect(sharp.commanders.Report(FLEET, 3)?.decisions).toEqual([expect.objectContaining({ tick: 1, lever: 'call', tool: 'order_fleet', args: CallArgs('fc', ['r1', 'r2']) })]);
    // The console's target list: every hostile of the last picture, ranked, and the reach the brain calls within.
    expect(sharp.commanders.Targets(FLEET)?.ranked.map((ship) => ship.id)).toEqual(['r1', 'r2']);
    expect(sharp.commanders.Targets(FLEET)?.reach).toBeGreaterThan(0);

    const slow = BrainRig(BrainScene('slow'));
    slow.Steps(1, 1);
    const due = slow.commanders.Report(FLEET, 1)?.pending[0];
    expect(due).toMatchObject({ lever: 'call' });
    expect(due?.dueIn).toBeGreaterThanOrEqual(5);
    expect(due?.dueIn).toBeLessThanOrEqual(10);
    slow.Steps(2, 12);
    expect(slow.runs.map((run) => run.tick)).toEqual([1 + (due?.dueIn ?? 0)]);
  });

  it('replays the same decisions at the same ticks for the same seed', () => {
    const runOf = () => {
      const rig = BrainRig(BrainScene('slow'));
      rig.Steps(1, 12);
      rig.Kill('fc', 12);
      rig.Steps(13, 45);
      return { runs: rig.runs, report: rig.commanders.Report(FLEET, 45) };
    };
    expect(runOf()).toEqual(runOf());
  });

  it('a dead FC hands the formation to the designate at once, who takes command after its handover', () => {
    const rig = BrainRig(BrainScene('sharp'));
    rig.Steps(1, 4);
    rig.Kill('fc', 4);
    // The protocol's designate (most-able: the backups drew ability 1; ties go by fleet order) flies as the root at once.
    expect(rig.live().fleets?.[0].commander).toBe('d1');
    expect(rig.commanders.Report(FLEET, 4)).toMatchObject({ ship: 'd1', state: 'handover', successor: 'd1', takesOverIn: 2 });
    rig.Steps(5, 5);
    expect(rig.commanders.Report(FLEET, 5)).toMatchObject({ state: 'handover', takesOverIn: 1 });
    rig.Steps(6, 6);
    expect(rig.commanders.Report(FLEET, 6)).toMatchObject({ ship: 'd1', state: 'commanding' });
    expect(rig.commanders.Report(FLEET, 6)).not.toHaveProperty('successor');

    // Ability 0: half to all of the 20 s handover.
    const slow = BrainRig(BrainScene('slow'));
    slow.Steps(1, 3);
    slow.Kill('fc', 3);
    const takesOverIn = slow.commanders.Report(FLEET, 3)?.takesOverIn ?? 0;
    expect(takesOverIn).toBeGreaterThanOrEqual(11);
    expect(takesOverIn).toBeLessThanOrEqual(20);
  });

  it('a flagged FC flies on as the root until the handover moves the command', () => {
    const rig = BrainRig(BrainScene('sharp'));
    rig.Steps(1, 3);
    rig.Flag('fc');
    rig.Steps(4, 4);
    expect(rig.live().fleets?.[0].commander).toBe('fc');
    expect(rig.commanders.Report(FLEET, 4)).toMatchObject({ ship: 'fc', state: 'handover', successor: 'd1', takesOverIn: 2 });
    rig.Steps(5, 6);
    expect(rig.handovers).toEqual([{ fleet: FLEET, from: 'fc', to: 'd1' }]);
    expect(rig.live().fleets?.[0].commander).toBe('d1');
    expect(rig.commanders.Report(FLEET, 6)).toMatchObject({ ship: 'd1', state: 'commanding' });
  });

  it('a designate dying during the handover re-runs the protocol', () => {
    const rig = BrainRig(BrainScene('sharp'));
    rig.Steps(1, 2);
    rig.Kill('fc', 2);
    rig.Kill('d1', 3);
    expect(rig.live().fleets?.[0].commander).toBe('d2');
    expect(rig.commanders.Report(FLEET, 3)).toMatchObject({ state: 'handover', successor: 'd2', takesOverIn: 2 });
    rig.Steps(3, 5);
    expect(rig.commanders.Report(FLEET, 5)).toMatchObject({ ship: 'd2', state: 'commanding' });
  });

  it('leaderless when the protocol finds nobody: the default rule keeps a root and the brain decides nothing', () => {
    const rig = BrainRig(BrainScene('lone'));
    rig.Steps(1, 2);
    const before = rig.runs.length;
    rig.Kill('fc', 2);
    rig.commanders.SetCall(WHOLE, []);
    rig.Steps(3, 8);
    expect(rig.live().fleets?.[0].commander).toBe('d1');
    expect(rig.commanders.Report(FLEET, 8)).toMatchObject({ state: 'leaderless', pending: [] });
    expect(rig.runs.length).toBe(before);
  });

  it('a stance flown by the acting FC takes the move and prop mods levers; the brain still calls targets', () => {
    const rig = BrainRig(BrainScene('sharp'), new Set(['fc']));
    rig.Steps(1, 30);
    expect(rig.runs.length).toBeGreaterThan(0);
    expect(rig.runs.every((run) => run.lever !== 'move' && run.lever !== 'prop-mods')).toBe(true);
    expect(rig.runs.some((run) => (run.args['order'] as Record<string, unknown>)['type'] === 'targets')).toBe(true);
    expect(rig.commanders.Report(FLEET, 30)).toMatchObject({ manual: [], piloted: ['move', 'prop-mods'] });
    const free = BrainRig(BrainScene('sharp'));
    free.Steps(1, 30);
    expect(free.commanders.Report(FLEET, 30)).not.toHaveProperty('piloted');
  });

  it('a leaderless fleet runs the protocol again each boundary: a ship that can command ends it after its handover', () => {
    const rig = BrainRig(BrainScene('lone'));
    rig.Steps(1, 2);
    rig.Kill('fc', 2);
    rig.commanders.SetCall(WHOLE, []);
    rig.Steps(3, 5);
    expect(rig.commanders.Report(FLEET, 5)).toMatchObject({ state: 'leaderless' });
    // d2 can command now (a reinforcement joins the same way): it is designated over d1, the default rule's root, who
    // flies on until the handover moves the formation to d2.
    rig.Edit([{ op: 'update_ship', id: 'd2', set: { pilot: { command: 1 } } }]);
    rig.Steps(6, 6);
    expect(rig.commanders.Report(FLEET, 6)).toMatchObject({ ship: 'd1', state: 'handover', successor: 'd2', takesOverIn: 2 });
    expect(rig.live().fleets?.[0].commander).toBe('d1');
    rig.Steps(7, 8);
    expect(rig.handovers).toEqual([{ fleet: FLEET, from: 'd1', to: 'd2' }]);
    expect(rig.live().fleets?.[0].commander).toBe('d2');
    expect(rig.commanders.Report(FLEET, 8)).toMatchObject({ ship: 'd2', ability: 1, state: 'commanding' });
    expect(rig.runs.at(-1)).toMatchObject({ tick: 8, args: CallArgs('d2', ['r1', 'r2']) });
  });

  it('the gate waits out a warp-in, then gives up on unsettled ships 20 boundaries after the last landing', () => {
    const rig = BrainRig(BrainScene('sharp'));
    for (const id of ['fc', 'd1', 'd2']) rig.arriving.add(id);
    rig.unsettled.add('r2');
    rig.Steps(1, 30);
    expect(rig.commanders.Report(FLEET, 30)).toMatchObject({ state: 'waiting' });
    expect(rig.commanders.Report(FLEET, 30)).not.toHaveProperty('note');
    rig.arriving.clear();
    rig.Steps(31, 49);
    expect(rig.commanders.Report(FLEET, 49)).toMatchObject({ state: 'waiting' });
    expect(rig.runs).toEqual([]);
    rig.Steps(50, 50);
    expect(rig.commanders.Report(FLEET, 50)).toMatchObject({ state: 'commanding', readyAt: 50, note: 'the gate gave up waiting for "r2" after 20 s' });
    expect(rig.runs.map((run) => [run.tick, run.args])).toEqual([[50, CallArgs('fc', ['r1', 'r2'])]]);
  });

  it('a lever a model pulls is manual until set_fleet_personality; cease_fire also holds the fleet', () => {
    const rig = BrainRig(BrainScene('sharp'));
    rig.Steps(1, 1);
    rig.commanders.TakeLevers('order_fleet', { fleet: FLEET, order: { type: 'targets', set: ['r2'] } });
    rig.commanders.SetCall(WHOLE, ['r2']);
    rig.Steps(2, 4);
    expect(rig.runs).toHaveLength(1);
    expect(rig.commanders.Report(FLEET, 4)).toMatchObject({ manual: ['call', 'free-fire'] });
    expect(rig.commanders.Report(FLEET, 4)).not.toHaveProperty('held');

    rig.commanders.TakeLevers('order_ship', { id: 'fc', order: { type: 'stop' } });
    rig.commanders.TakeLevers('switch_prop_mods', { ships: ['d1'], active: true });
    rig.commanders.TakeLevers('cease_fire', { ships: ['d2'] });
    expect(rig.commanders.Report(FLEET, 4)).toMatchObject({ manual: ['call', 'free-fire', 'move', 'prop-mods'], held: true });
    // A wing or squad move and ships outside the fleet take nothing more.
    rig.commanders.TakeLevers('engage', { ships: ['r1'], target: 'fc' });

    expect(rig.commanders.AfterOperations([{ op: 'update_fleet', fleet: FLEET, set: { personality: 'sharp' } }])).toEqual([FLEET]);
    expect(rig.commanders.Report(FLEET, 4)).toMatchObject({ manual: [] });
    expect(rig.commanders.Report(FLEET, 4)).not.toHaveProperty('held');
    // The brain keeps the live primary the model called and refills the queue behind it.
    rig.Steps(5, 5);
    expect(rig.runs.at(-1)).toMatchObject({ tick: 5, args: CallArgs('fc', ['r2', 'r1']) });
  });

  it('gives pilots their traits: personality draws under authored ones, authored traits outside personality fleets', () => {
    const scene = BrainScene('slow', {});
    const withPilots = applySceneOperations(scene, [
      { op: 'update_ship', id: 'd2', set: { pilot: { reaction: 0.25 } } },
      { op: 'update_ship', id: 'r1', set: { pilot: { command: 0.5 } } }
    ]).scene;
    const rig = BrainRig(withPilots);
    expect(rig.commanders.PilotOf('fc')).toEqual({ command: 0, reaction: 1, source: 'personality' });
    expect(rig.commanders.PilotOf('d2')).toMatchObject({ reaction: 0.25, source: 'mixed' });
    expect(rig.commanders.PilotOf('r1')).toEqual({ command: 0.5, source: 'pilot' });
    expect(rig.commanders.PilotOf('r2')).toBeNull();
    expect(rig.commanders.ReactionOf('d2')).toBe(0.25);
  });
});

describe('FleetCommanders snapshots (sd-time)', () => {
  it("restores the brains, calls and book, and the brain then decides what an uncaptured twin's decides", () => {
    const rig = BrainRig(BrainScene('slow'));
    const twin = BrainRig(BrainScene('slow'));
    rig.Steps(1, 3);
    twin.Steps(1, 3);
    rig.commanders.SetFreeFire(WHOLE, true);
    twin.commanders.SetFreeFire(WHOLE, true);
    const runs = rig.runs.length;
    const trip = RoundTrip(
      rig.commanders,
      (c) => [c.Report(FLEET, 3), c.Overlay(), c.CallOf(WHOLE)],
      (c) => {
        for (let tick = 4; tick <= 20; tick++) c.Step(tick);
        c.SetCall(DPS, ['r2']);
      }
    );
    rig.runs.length = runs;
    expect(trip.mutated).not.toEqual(trip.before);
    expect(trip.after).toEqual(trip.before);
    expect(trip.again).toEqual(trip.snapshot);
    rig.Steps(4, 30);
    twin.Steps(4, 30);
    expect(rig.runs).toEqual(twin.runs);
    expect(rig.commanders.Report(FLEET, 30)).toEqual(twin.commanders.Report(FLEET, 30));
  });
});
