import { describe, expect, it } from 'vitest';
import { applySceneOperations, normalizeScene, type SceneDocument, SceneError } from '../scene';
import { normalizeSceneTimeline } from './normalize';
import { sceneAtTimelineTime, timelinePatchScenes } from './projection';
import { normalizeShipOrderSteps, shipStepCompletion } from './steps';
import { cueActionOf, cueDueSecond, MAX_PATCH_CUES, MAX_SHIP_STEPS, type SceneCue } from './timeline';
import { TIMELINE_ACTIONS } from './actions';

const AMARR = 'af1_t1:amarrbase:amarr';
const MINMATAR = 'mf1_t1:minmatarbase:minmatar';

const base = {
  name: 'skirmish',
  ships: [
    { id: 'blue-fc', dna: AMARR, team: 'blue', position: [0, 0, 0] },
    { id: 'blue-1', dna: AMARR, team: 'blue', position: [500, 0, 0] },
    { id: 'blue-2', dna: AMARR, team: 'blue', position: [-500, 0, 0] },
    { id: 'red-1', dna: MINMATAR, team: 'red', position: [0, 0, 20000] }
  ],
  fleets: [{ id: 'blue', commander: 'blue-fc', wings: [{ id: 'w1', squads: [{ id: 's1', role: 'dps', members: ['blue-1', 'blue-2'] }] }] }],
  objects: [{ id: 'gate', dna: 'ge1_t1:amarrbase:amarr', position: [0, 0, 60000] }]
};

const late = { op: 'add_ship', ship: { id: 'late', dna: MINMATAR, team: 'red', position: [0, 0, 25000] } };
const redFleet = { op: 'add_fleet', fleet: { id: 'red', commander: 'red-1', wings: [{ id: 'rw', squads: [{ id: 'rs', role: 'dps', members: ['late'] }] }] } };

function scene(extra: Record<string, unknown> = {}): ReturnType<typeof normalizeScene> {
  return normalizeScene({ ...structuredClone(base), ...extra });
}

function problemsOf(action: () => unknown): string[] {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SceneError);
    return (error as SceneError).problems;
  }
  throw new Error('expected a SceneError');
}

function cues(document: SceneDocument): SceneCue[] {
  return document.timeline?.cues ?? [];
}

describe('normalizeSceneTimeline', () => {
  it('takes a bare array, assigns the lowest free ids in input order and sorts stably by at', () => {
    const { scene: document } = scene({
      timeline: [
        { at: 5, order_ship: { id: 'blue-1', order: { type: 'stop' } } },
        { id: 'cue-2', at: 2.5, switch_prop_mods: { fleet: 'blue', active: true } },
        { at: 2.5, set_target: { ships: ['blue-1'], target: 'red-1' } },
        { at: 0, name: 'open', stop_shot: {} }
      ]
    });
    expect(cues(document).map((cue) => [cue.id, cue.at])).toEqual([
      ['cue-4', 0],
      ['cue-2', 2.5],
      ['cue-3', 2.5],
      ['cue-1', 5]
    ]);
    expect(cues(document)[0]).toEqual({ id: 'cue-4', at: 0, name: 'open', stop_shot: {} });
    expect(cueActionOf(cues(document)[1])).toEqual({ name: 'switch_prop_mods', args: { fleet: 'blue', active: true } });
    expect(cueDueSecond(2.5)).toBe(3);
  });

  it('stores the levers normalized, camera shots and patches as written', () => {
    const shot = { shot: 'hero', ship: 'blue-fc' };
    const { scene: document } = scene({
      timeline: {
        cues: [
          { id: 'a', at: 1, order_fleet: { fleet: 'blue', order: { type: 'approach', target: 'red-1' } } },
          { id: 'b', at: 1, engage: { fleet: 'blue', target: 'red-1' } },
          { id: 'c', at: 1, play_shot: shot },
          { id: 'd', at: 1, play_sequence: [shot, { pose: { eye: [0, 0, -1000], look: { ship: 'red-1' } } }] },
          { id: 'e', at: 1, auto_repair: { fleet: 'blue', on: false } },
          { id: 'f', at: 1, cease_fire: { ships: ['blue-1'] } }
        ]
      }
    });
    const [a, b, c, d, e, f] = cues(document);
    expect(cueActionOf(a).args).toEqual({ fleet: 'blue', order: { type: 'approach', target: 'red-1', speed: 1 } });
    expect(cueActionOf(b).args).toEqual({ fleet: 'blue', target: 'red-1', modules: ['turret', 'launcher'] });
    expect(cueActionOf(c).args).toEqual(shot);
    expect(cueActionOf(d).args).toEqual({ shots: [shot, { pose: { eye: [0, 0, -1000], look: { ship: 'red-1' } } }] });
    expect(cueActionOf(e).args).toEqual({ fleet: 'blue', on: false });
    expect(cueActionOf(f).args).toEqual({ ships: ['blue-1'], unlock: false });
    expect(TIMELINE_ACTIONS.order_fleet.kind(cueActionOf(a).args as never)).toBe('live');
    expect(TIMELINE_ACTIONS.order_fleet.kind({ fleet: 'blue', order: { type: 'regroup' } })).toBe('document');
    expect(TIMELINE_ACTIONS.auto_repair.kind(cueActionOf(e).args as never)).toBe('document');
  });

  it('refuses every structural problem together', () => {
    const problems = problemsOf(() =>
      scene({
        timeline: [
          { id: 'dup', at: -1, stop_shot: {} },
          { id: 'dup', at: 1, stop_shot: {}, order_ship: { id: 'blue-1', order: { type: 'stop' } } },
          { at: 2 },
          { id: 'event', when: { landed: 'red' }, at: 3, stop_shot: {} },
          {
            at: 4,
            patch_scene: {
              operations: [
                { op: 'set_environment', environment: {} },
                { op: 'add_cue', cue: {} }
              ]
            }
          },
          { at: 4, order_ship: { id: 'blue-1', order: { type: 'fly' } } }
        ]
      })
    ).join('\n');
    expect(problems).toMatch(/cues\[0\] \("dup"\)\.at must be a number of seconds/);
    expect(problems).toMatch(/cues\[1\] \("dup"\) needs exactly one action .*got order_ship, stop_shot/);
    expect(problems).toMatch(/cues\[2\] needs exactly one action/);
    expect(problems).toMatch(/cues\[3\] \("event"\)\.when is reserved for Movie mode's event cues/);
    expect(problems).toMatch(/set_environment reloads the page; it cannot be cued/);
    expect(problems).toMatch(/a cue cannot edit the timeline \(add_cue\)/);
    expect(problems).toMatch(/order_ship\.order\.type must be one of/);
  });

  it('checks references against the scene when the cue fires', () => {
    const timeline = [
      { id: 'early', at: 1, order_fleet: { fleet: 'red', order: { type: 'stop' } } },
      { id: 'adds', at: 2, patch_scene: { operations: [late, redFleet] } },
      { id: 'after', at: 3, order_fleet: { fleet: 'red', squad: 'rs', order: { type: 'targets', primary: 'blue-fc' } } },
      { id: 'drop', at: 4, patch_scene: { operations: [{ op: 'remove_ship', id: 'blue-2' }] } },
      { id: 'gone', at: 5, set_target: { ships: ['blue-2'], target: 'late' } },
      { id: 'team', at: 6, play_shot: { hardpoint: { name: 'overlook', teams: ['blue', 'green'] } } }
    ];
    const problems = problemsOf(() => scene({ timeline })).join('\n');
    expect(problems).toMatch(/cues\[0\] \("early"\)\.order_fleet\.fleet: no fleet "red"/);
    expect(problems).not.toMatch(/"after"/);
    expect(problems).toMatch(/cues\[4\] \("gone"\)\.set_target\.ships\[0\]: no ship "blue-2"/);
    expect(problems).toMatch(/cues\[5\] \("team"\)\.play_shot\.hardpoint\.teams\[1\]: no ship is on team "green"/);
  });

  it('warns about names and authority instead of refusing them; refuses a celestial call', () => {
    const { warnings } = scene({
      timeline: [
        { id: 'go', at: 1, order_ship: { id: 'blue-1', order: { type: 'approach', target: 'Caldari Navy Assembly Plant' } } },
        { id: 'cel', at: 1, order_ship: { id: 'blue-1', order: { type: 'warp', target: 'celestial:60003760' } } },
        { id: 'by', at: 2, order_fleet: { fleet: 'blue', squad: 's1', by: 'red-1', order: { type: 'stop' } } }
      ]
    });
    expect(warnings).toContain('timeline.cues[0] ("go").order_ship.order.target "Caldari Navy Assembly Plant" is no ship or object id: it is resolved as a name when the cue fires');
    expect(warnings.some((warning) => warning.includes('"cel"'))).toBe(false);
    expect(warnings.some((warning) => /cues\[2\] \("by"\)\.order_fleet may fail when it fires: /.test(warning))).toBe(true);
    expect(problemsOf(() => scene({ timeline: [{ at: 1, order_fleet: { fleet: 'blue', order: { type: 'targets', primary: 'celestial:1' } } }] })).join('\n')).toMatch(/cannot be targeted yet/);
  });

  it('enforces the limits', () => {
    const patches = Array.from({ length: MAX_PATCH_CUES + 1 }, (_, index) => ({ at: index, patch_scene: { operations: [{ op: 'rename', name: `n${index}` }] } }));
    expect(problemsOf(() => scene({ timeline: patches }))).toContain(`timeline holds ${MAX_PATCH_CUES + 1} patch_scene cues; at most ${MAX_PATCH_CUES}`);
    expect(problemsOf(() => scene({ timeline: [{ at: 86_401, stop_shot: {} }] })).join('\n')).toMatch(/at must be a number of seconds from play start in \[0, 86400\]/);
  });

  it('omits a timeline without cues', () => {
    expect(scene({ timeline: { cues: [] } }).scene.timeline).toBeUndefined();
    expect(normalizeSceneTimeline({ input: [], scene: scene().scene, apply: applySceneOperations }).timeline).toBeNull();
  });
});

describe('the projection and adds', () => {
  const timeline = [
    { id: 'adds', at: 4.5, patch_scene: { operations: [late, redFleet] } },
    { id: 'go', at: 6, order_ship: { id: 'late', order: { type: 'goto', point: [0, 0, 0] } } }
  ];

  it('records what a patch cue adds', () => {
    const adds = cues(scene({ timeline }).scene)[0].adds;
    expect(adds).toEqual({ ships: ['late'], fleets: ['red'], wings: ['red/rw'], squads: ['red/rs'] });
  });

  it('refuses an edit that takes an id a cue adds, naming the cue', () => {
    const document = scene({ timeline }).scene;
    const problems = problemsOf(() => applySceneOperations(document, [{ op: 'add_ship', ship: { id: 'late', dna: AMARR } }])).join('\n');
    expect(problems).toMatch(/ship "late" is added by timeline cue "adds" at 4.5 s: give the new ship another id, or edit the cue/);
  });

  it('re-pins a drifted allocation with a warning, and later cues on the old ids fail', () => {
    const staged = (prefix: string): Record<string, unknown> => ({ op: 'add_ships', dna: MINMATAR, count: 1, prefix, position: [0, 0, 30000] });
    const document = scene({ timeline: [{ id: 'adds', at: 2, patch_scene: { operations: [staged('red')] } }] }).scene;
    const added = cues(document)[0].adds?.ships ?? [];
    expect(added).toHaveLength(1);
    const repinned = applySceneOperations(document, [{ op: 'update_cue', id: 'adds', set: { at: 3 } }]);
    expect(cues(repinned.scene)[0].adds?.ships).toEqual(added);
    const drifted = { ...structuredClone(document), timeline: { cues: [{ ...cues(document)[0], adds: { ships: ['red-old'] } }] } };
    const result = normalizeScene(drifted);
    expect(result.warnings).toContain(`timeline cue "adds" now adds ship "${added[0]}" (it added ship "red-old")`);
  });

  it('projects the scene at a time', () => {
    const document = scene({ timeline }).scene;
    expect(sceneAtTimelineTime(document, 4, applySceneOperations).ships.map((ship) => ship.id)).not.toContain('late');
    const at5 = sceneAtTimelineTime(document, 5, applySceneOperations);
    expect(at5.ships.map((ship) => ship.id)).toContain('late');
    expect(at5.timeline).toBeUndefined();
  });

  it('lists the scene after each patch cue, up to a time', () => {
    const document = scene({ timeline }).scene;
    const scenes = timelinePatchScenes(document, applySceneOperations);
    expect(scenes.length).toBeGreaterThan(0);
    expect(scenes[0].scene.ships.map((ship) => ship.id)).toContain('late');
    expect(scenes.every((step) => step.scene.timeline === undefined)).toBe(true);
    expect(timelinePatchScenes(document, applySceneOperations, 4)).toEqual([]);
  });

  it('refuses a removal that breaks a patch cue, naming the cue', () => {
    const document = scene({ timeline: [{ id: 'later', at: 40, patch_scene: { operations: [{ op: 'update_ship', id: 'red-1', set: { name: 'x' } }] } }] }).scene;
    expect(problemsOf(() => applySceneOperations(document, [{ op: 'remove_ship', id: 'red-1' }])).join('\n')).toMatch(/timeline\.cues\[0\] \("later"\) \(40 s\): operations\[0\]: no ship "red-1": edit or remove the cue first/);
  });
});

describe('ship orders', () => {
  const read = (input: unknown, inFleet = true): ReturnType<typeof normalizeShipOrderSteps> => normalizeShipOrderSteps({ input, where: 'ships[1].orders', self: 'blue-1', targets: new Set(['red-1', 'gate']), inFleet });

  it('reads after and duration around an order_ship order', () => {
    const steps = read([{ after: 20, type: 'orbit', target: 'red-1', range: 2500, duration: 30 }, { type: 'stop' }, { type: 'warp', point: [0, 0, 400000] }, { type: 'rejoin' }]);
    expect(steps.problems).toEqual([]);
    expect(steps.steps).toEqual([{ after: 20, type: 'orbit', target: 'red-1', range: 2500, speed: 1, duration: 30 }, { type: 'stop' }, { type: 'warp', point: [0, 0, 400000], range: 0 }, { type: 'rejoin' }]);
    expect(shipStepCompletion('warp')).toBe('landed');
    expect(shipStepCompletion('orbit')).toBe('never');
  });

  it('refuses a never-ending step that is not last, a self target and bad times', () => {
    const steps = read([
      { type: 'orbit', target: 'red-1', range: 500 },
      { type: 'approach', target: 'blue-1' },
      { type: 'stop', after: -1, duration: 0 }
    ]);
    expect(steps.problems).toEqual([
      'ships[1].orders[0] (orbit) never ends on its own: give it a duration (seconds) or make it the last step',
      'ships[1].orders[1].target must be another ship, not "blue-1" itself',
      'ships[1].orders[2].after must be a number of seconds in [0, 86400]',
      'ships[1].orders[2].duration must be a number of seconds in (0, 86400]'
    ]);
    expect(read(Array.from({ length: MAX_SHIP_STEPS + 1 }, () => ({ type: 'stop' }))).problems).toEqual([`ships[1].orders holds ${MAX_SHIP_STEPS + 1} steps; at most ${MAX_SHIP_STEPS}`]);
  });

  it('warns about rejoin outside a fleet, and reads unknown targets as names unless a cue adds them', () => {
    expect(read([{ type: 'rejoin' }], false).warnings).toEqual(['ships[1].orders[0] (rejoin): ship "blue-1" is in no fleet; it rejoins only if a cue puts it in one']);
    expect(read([{ type: 'approach', target: 'Jita' }]).names).toEqual([{ where: 'ships[1].orders[0].target', target: 'Jita' }]);
    const document = scene({
      ships: [...base.ships.slice(0, 3), { ...base.ships[3], orders: [{ type: 'approach', target: 'late' }] }],
      timeline: [{ at: 1, patch_scene: { operations: [late] } }]
    });
    expect(document.warnings.some((warning) => warning.includes('resolved as a name'))).toBe(false);
    expect(scene({ ships: [...base.ships.slice(0, 3), { ...base.ships[3], orders: [{ type: 'approach', target: 'nowhere' }] }] }).warnings).toContain('ships[3].orders[0].target "nowhere" is no ship or object id: it is resolved as a name when the step runs');
  });
});

describe('timeline operations', () => {
  const edit = (document: SceneDocument, operations: unknown[]): SceneDocument => applySceneOperations(document, operations).scene;
  const start = (): SceneDocument => scene({ timeline: [{ id: 'mwd', at: 15, switch_prop_mods: { fleet: 'blue', active: true } }] }).scene;

  it('adds, updates and removes cues', () => {
    let document = edit(start(), [{ op: 'add_cue', cue: { id: 'go', at: 10, order_ship: { id: 'blue-1', order: { type: 'stop' } } } }]);
    expect(cues(document).map((cue) => cue.id)).toEqual(['go', 'mwd']);
    document = edit(document, [{ op: 'update_cue', id: 'go', set: { at: 20, name: 'halt', set_target: { ships: ['blue-1'], target: 'red-1' } } }]);
    expect(cues(document)[1]).toEqual({ id: 'go', at: 20, name: 'halt', set_target: { ships: ['blue-1'], target: 'red-1' } });
    document = edit(document, [{ op: 'update_cue', id: 'go', set: { name: null } }]);
    expect(cues(document)[1].name).toBeUndefined();
    document = edit(document, [{ op: 'remove_cue', id: 'go' }]);
    expect(cues(document).map((cue) => cue.id)).toEqual(['mwd']);
  });

  it('refuses an existing id, an unknown cue, an id change, set adds and a null action', () => {
    const problems = problemsOf(() =>
      edit(start(), [
        { op: 'add_cue', cue: { id: 'mwd', at: 1, stop_shot: {} } },
        { op: 'remove_cue', id: 'nope' },
        { op: 'update_cue', id: 'mwd', set: { id: 'x', adds: {}, switch_prop_mods: null } }
      ])
    );
    expect(problems).toEqual([
      'operations[0]: timeline cue "mwd" already exists',
      'operations[1]: no timeline cue "nope"',
      "operations[2]: a cue's id cannot be changed; remove and add it instead",
      "operations[2].set.adds is derived from the cue's patch_scene and cannot be set",
      'operations[2].set.switch_prop_mods cannot be null: remove_cue removes a cue'
    ]);
  });

  it('replacing a patch cue action clears its adds; set_timeline and clear_timeline replace and remove it', () => {
    let document = edit(start(), [{ op: 'add_cue', cue: { id: 'adds', at: 2, patch_scene: { operations: [late] } } }]);
    expect(cues(document)[0].adds).toEqual({ ships: ['late'] });
    document = edit(document, [{ op: 'update_cue', id: 'adds', set: { patch_scene: { operations: [{ ...late, ship: { ...late.ship, id: 'later' } }] } } }]);
    expect(cues(document)[0].adds).toEqual({ ships: ['later'] });
    expect(edit(document, [{ op: 'set_timeline', timeline: [{ id: 'x', at: 1, stop_shot: {} }] }]).timeline).toEqual({ cues: [{ id: 'x', at: 1, stop_shot: {} }] });
    expect(edit(document, [{ op: 'set_timeline', timeline: null }]).timeline).toBeUndefined();
    expect(edit(document, [{ op: 'clear_timeline' }]).timeline).toBeUndefined();
    expect(edit(scene().scene, [{ op: 'clear_timeline' }]).timeline).toBeUndefined();
  });

  it('edits ship orders with update_ship; null clears them', () => {
    const document = edit(start(), [{ op: 'update_ship', id: 'blue-1', set: { orders: [{ type: 'stop' }] } }]);
    expect(document.ships[1].orders).toEqual([{ type: 'stop' }]);
    expect(edit(document, [{ op: 'update_ship', id: 'blue-1', set: { orders: null } }]).ships[1].orders).toBeUndefined();
  });
});

describe('removal pruning', () => {
  const timeline = [
    { id: 'ship', at: 1, order_ship: { id: 'blue-2', order: { type: 'stop' } } },
    { id: 'at', at: 1, order_ship: { id: 'blue-1', order: { type: 'orbit', target: 'blue-2', range: 500 } } },
    { id: 'mwd', at: 2, switch_prop_mods: { ships: ['blue-1', 'blue-2'], active: true } },
    { id: 'solo', at: 2, switch_prop_mods: { ships: ['blue-2'], active: true } },
    { id: 'primary', at: 3, order_fleet: { fleet: 'blue', order: { type: 'targets', primary: 'blue-2' } } },
    { id: 'queue', at: 3, order_fleet: { fleet: 'blue', squad: 's1', order: { type: 'targets', queue: ['red-1', 'gate'] } } },
    { id: 'squad', at: 4, cease_fire: { fleet: 'blue', squad: 's1' } },
    { id: 'camera', at: 5, play_shot: { shot: 'hero', ship: 'blue-2' } }
  ];

  it('remove_ship drops the cues on and at it, shrinks selections, and drops steps aimed at it', () => {
    const ships = [base.ships[0], { ...base.ships[1], orders: [{ type: 'approach', target: 'blue-2', duration: 5 }, { type: 'stop' }] }, ...base.ships.slice(2)];
    const document = scene({ ships, timeline }).scene;
    const result = applySceneOperations(document, [{ op: 'remove_ship', id: 'blue-2' }]);
    expect(cues(result.scene).map((cue) => cue.id)).toEqual(['mwd', 'queue', 'squad']);
    expect(cueActionOf(cues(result.scene)[0]).args).toEqual({ ships: ['blue-1'], active: true });
    expect(result.scene.ships[1].orders).toEqual([{ type: 'stop' }]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'timeline: cue "ship" (order_ship at 1 s) was removed with ship "blue-2"',
        'timeline: cue "mwd" (switch_prop_mods at 2 s) no longer names "blue-2" (it was removed)',
        'timeline: cue "solo" (switch_prop_mods at 2 s) was removed: its ships selection named only removed "blue-2"',
        'timeline: cue "camera" (play_shot at 5 s) was removed with ship "blue-2"',
        'ships[1].orders[0] (approach "blue-2") was dropped: "blue-2" was removed'
      ])
    );
  });

  it('remove_object shrinks a queue; remove_squad and remove_fleet drop the cues on them', () => {
    const document = scene({ timeline }).scene;
    const withoutGate = applySceneOperations(document, [{ op: 'remove_object', id: 'gate' }]).scene;
    expect(cueActionOf(cues(withoutGate).find((cue) => cue.id === 'queue') as SceneCue).args).toEqual({ fleet: 'blue', squad: 's1', order: { type: 'targets', queue: ['red-1'] } });
    expect(cues(applySceneOperations(document, [{ op: 'remove_squad', fleet: 'blue', squad: 's1' }]).scene).map((cue) => cue.id)).not.toContain('squad');
    expect(cues(applySceneOperations(document, [{ op: 'remove_fleet', fleet: 'blue' }]).scene).map((cue) => cue.id)).toEqual(['ship', 'at', 'mwd', 'solo', 'camera']);
  });
});
