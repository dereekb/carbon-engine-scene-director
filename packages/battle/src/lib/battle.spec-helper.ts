import { FLEET_COMPOSITION_SCHEMA, SCENE_SCHEMA, type SceneDocument, applySceneOperations } from '@scene-director/scene';
import type { ScenarioHubCall } from './scenario/staging';
import type { BattleFleetView } from './views';

export const TEST_DNA = 'wreck_s:genericbase:generic';

/**
 * A dna-only composition (no EVE data needed): an FC, a dps squad of 2 and a logi squad of 1.
 */
export function makeTestComposition(id: string): Record<string, unknown> {
  return {
    schema: FLEET_COMPOSITION_SCHEMA,
    id,
    commander: { dna: TEST_DNA },
    wings: [
      {
        id: 'wing-1',
        squads: [
          { id: 'dps', role: 'dps', ships: [{ dna: TEST_DNA, count: 2 }] },
          { id: 'logi', role: 'logi', ships: [{ dna: TEST_DNA }] }
        ]
      }
    ]
  };
}

/**
 * A two-sided offline scenario: blue warps in, red starts placed and holds.
 */
export function makeTestScenario(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'cjs-scenario/1',
    id: 'test-battle',
    name: 'Test battle',
    combat: { seed: 7 },
    range: 60000,
    heading: 90,
    sides: [
      { fleet: 'blue', team: 'blue', composition: 'blue-comp', warpIn: true, settings: { personality: { extends: 'brawler', targeting: { reach: 20000 } }, logi: { formation: 'loose' }, retreat: 'away' } },
      { fleet: 'red', team: 'red', composition: makeTestComposition('red-comp'), start: 'hold', settings: { personality: 'sniper' } }
    ],
    camera: { auto: true },
    compositions: { 'blue-comp': makeTestComposition('blue-comp') },
    ...overrides
  };
}

/**
 * A fake hub for the staging pipeline: stage_engagement on the passed scene (an inline doctrine embedded as
 * set_personalities), as one t = 0 patch cue when `at` is given; set_location is refused (no EVE data).
 */
export const FAKE_STAGING_HUB: ScenarioHubCall = async (tool, args) => {
  const scene = args['scene'] as SceneDocument;
  let result: unknown;

  if (tool === 'stage_engagement') {
    const embed: Record<string, unknown> = {};
    const sides = (args['sides'] as Record<string, unknown>[]).map((side) => {
      const personality = side['personality'];
      let next = side;

      if (personality && typeof personality === 'object') {
        const id = (personality as Record<string, unknown>)['id'] as string;
        embed[id] = personality;
        next = { ...side, personality: id };
      }

      return next;
    });
    const operations: Record<string, unknown>[] = [...(Object.keys(embed).length > 0 ? [{ op: 'set_personalities', personalities: embed }] : []), { op: 'stage_engagement', sides, range: args['range'], heading: args['heading'] }];

    if (args['at'] === 0) {
      const added = applySceneOperations(scene, [{ op: 'add_cue', cue: { id: args['cue'], at: 0, name: 'stage_engagement', patch_scene: { operations } } }]);
      result = { scene: added.scene, warnings: added.warnings, loaded: false };
    } else {
      const applied = applySceneOperations(scene, operations);
      result = { scene: applied.scene, warnings: applied.warnings, loaded: false };
    }
  } else {
    throw new Error(`${tool} needs EVE data`);
  }

  return result;
};

export function makeFleetView(overrides: Partial<BattleFleetView> = {}): BattleFleetView {
  return {
    id: 'blue',
    team: 'blue',
    personality: 'blue-fc',
    fc: 'blue-01',
    state: 'commanding',
    brain: { personality: 'blue-fc', state: 'commanding', engaged: true, stance: 'brawl', manual: [], held: false },
    ships: 4,
    alive: 4,
    arriving: 0,
    health: 0.8,
    primary: 'red-02',
    queue: [],
    freeFire: true,
    targets: [
      { id: 'red-02', role: 'dps', distance: 25300, health: 0.5, dps: 120.4, inReach: true, called: 'primary' },
      { id: 'red-01', role: 'fc', distance: 140000, health: 1, dps: 80, inReach: false }
    ],
    fcMotion: { position: [0, 0, 0] },
    ...overrides
  };
}

export const EMPTY_SCENE_SCHEMA = SCENE_SCHEMA;
