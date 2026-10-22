import { describe, expect, it } from 'vitest';
import { normalizeScene } from '../scene';
import { catchSceneError, makeFleetScene, TFI_FLEET_SCENE } from './fleets.spec-helper';
import { toFleetMemberships, toFleetReports } from './membership';

const fleetOf = (squads: unknown[], extra: Record<string, unknown> = {}) => ({ id: 'f', commander: 'fc', wings: [{ id: 'w', squads }], ...extra });

describe('fleets in the scene document', () => {
  it('the sd-fleets example normalizes as written', () => {
    const { scene, warnings } = normalizeScene(TFI_FLEET_SCENE);
    expect(warnings).toEqual([]);
    expect(JSON.stringify(scene.fleets)).toBe(JSON.stringify(TFI_FLEET_SCENE.fleets));
    const [report] = toFleetReports(scene);
    expect(report.ships).toHaveLength(6);
    expect(report.wings[0].squads[0].anchor).toEqual({ ship: 'fc', range: 1000 });
    expect(report.wings[0].squads[1].anchor).toEqual({ ship: 'guardian-1', range: 30000 });
  });

  it('documents without fleets are unchanged', () => {
    const duel = { ships: [{ id: 'a', dna: 'af1_t1:amarrbase:amarr' }] };
    expect('fleets' in normalizeScene(duel).scene).toBe(false);
    expect('fleets' in normalizeScene({ ...duel, fleets: [] }).scene).toBe(false);
    expect('fleets' in normalizeScene({ ...duel, fleets: null }).scene).toBe(false);
  });

  it('fills defaults, trims names and reads roles case-insensitively', () => {
    const { scene } = normalizeScene(
      makeFleetScene(
        ['fc', 'x'],
        [
          { id: 'empty', commander: 'fc' },
          {
            id: 'f',
            name: '  Main  ',
            commander: 'x',
            wings: [
              {
                id: 'w',
                squads: [
                  { id: 'a', role: ' Logi ', anchor: {} },
                  { id: 'b', role: 'DPS', anchor: { ship: null, range: null } }
                ]
              }
            ]
          }
        ]
      )
    );
    expect(scene.fleets).toEqual([
      { id: 'empty', commander: 'fc', wings: [] },
      {
        id: 'f',
        name: 'Main',
        commander: 'x',
        wings: [
          {
            id: 'w',
            squads: [
              { id: 'a', role: 'logi', members: [] },
              { id: 'b', role: 'dps', members: [] }
            ]
          }
        ]
      }
    ]);
  });

  it('unknown keys warn and are dropped', () => {
    const { scene, warnings } = normalizeScene(makeFleetScene(['fc', 'x'], [{ ...fleetOf([{ id: 's', role: 'dps', members: ['x'], size: 3, anchor: { range: 500, bearing: 90 } }]), colour: 'red' }]));
    expect(warnings).toEqual(['fleets[0].colour is not a known field and was dropped', 'fleets[0].wings[0].squads[0].size is not a known field and was dropped', 'fleets[0].wings[0].squads[0].anchor.bearing is not a known field and was dropped']);
    expect(scene.fleets?.[0].wings[0].squads[0]).toEqual({ id: 's', role: 'dps', members: ['x'], anchor: { range: 500 } });
  });

  it('every problem is reported together', () => {
    const error = catchSceneError(() =>
      normalizeScene(
        makeFleetScene(
          ['a', 'b', 'c', 'd'],
          [
            {
              id: 'bad id!',
              commander: 'zz',
              wings: [{ id: 'w', squads: [{ id: 's', role: 'sniper', commander: 'd', members: ['a', 'b', 'nope'], anchor: { ship: 'c', range: -5 } }] }]
            },
            { id: 'f2', commander: 'a', wings: 'none' }
          ]
        )
      )
    );
    const expected = [
      'fleets[0].id must be 1-64 letters, digits, "_", "-" or "."',
      'fleets[0].wings[0].squads[0].role must be one of dps, logi, tackle, ewar, boost, support',
      'fleets[0].wings[0].squads[0].anchor.range must be a number of 0 or more (metres)',
      'fleets[0].commander "zz" is not a ship id',
      'fleets[0].wings[0].squads[0].members[2] "nope" is not a ship id',
      `fleets[0].wings[0].squads[0].commander "d" is not one of the squad's members`,
      'fleets[0].wings[0].squads[0].anchor.ship "c" is not in fleet "bad id!"',
      'fleets[1].wings must be an array',
      'fleets[1].commander "a" is already in fleet "bad id!"'
    ];
    expect(error.problems).toEqual(expect.arrayContaining(expected));
    expect(error.problems).toHaveLength(expected.length);
  });

  it('a ship holds positions in one fleet and sits in one squad', () => {
    const twoSquads = catchSceneError(() =>
      normalizeScene(
        makeFleetScene(
          ['fc', 'x'],
          [
            fleetOf([
              { id: 's1', role: 'dps', members: ['x'] },
              { id: 's2', role: 'dps', members: ['x'] }
            ])
          ]
        )
      )
    );
    expect(twoSquads.problems).toEqual(['fleets[0].wings[0].squads[1].members[0] "x" already sits in squad "s1" of fleet "f"']);

    const twice = catchSceneError(() => normalizeScene(makeFleetScene(['fc', 'x'], [fleetOf([{ id: 's1', role: 'dps', members: ['x', 'x'] }])])));
    expect(twice.problems).toEqual(['fleets[0].wings[0].squads[0].members[1] "x" already sits in squad "s1" of fleet "f"']);

    const twoFleets = catchSceneError(() =>
      normalizeScene(
        makeFleetScene(
          ['fc1', 'fc2', 'x'],
          [
            { id: 'f1', commander: 'fc1', wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', members: ['x'] }] }] },
            { id: 'f2', commander: 'fc2', wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', members: ['x'] }] }] }
          ]
        )
      )
    );
    expect(twoFleets.problems).toEqual(['fleets[1].wings[0].squads[0].members[0] "x" already sits in squad "s" of fleet "f1"']);

    const fcElsewhere = catchSceneError(() =>
      normalizeScene(
        makeFleetScene(
          ['fc1', 'fc2'],
          [
            { id: 'f1', commander: 'fc1' },
            { id: 'f2', commander: 'fc2', wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', members: ['fc1'] }] }] }
          ]
        )
      )
    );
    expect(fcElsewhere.problems).toEqual(['fleets[1].wings[0].squads[0].members[0] "fc1" is already in fleet "f1"']);
  });

  it('commanders sit where EVE lets them', () => {
    const accepted = [
      fleetOf([{ id: 's', role: 'dps', members: ['fc', 'x'] }]),
      fleetOf([{ id: 's', role: 'dps', members: ['x'] }]),
      { id: 'f', commander: 'fc', wings: [{ id: 'w', commander: 'x', squads: [{ id: 's', role: 'dps', members: ['x'] }] }] },
      { id: 'f', commander: 'fc', wings: [{ id: 'w', commander: 'x', squads: [] }] }
    ];
    for (const fleet of accepted) expect(() => normalizeScene(makeFleetScene(['fc', 'x'], [fleet]))).not.toThrow();

    const otherWing = catchSceneError(() =>
      normalizeScene(
        makeFleetScene(
          ['fc', 'x'],
          [
            {
              id: 'f',
              commander: 'fc',
              wings: [
                { id: 'w1', commander: 'x' },
                { id: 'w2', squads: [{ id: 's', role: 'dps', members: ['x'] }] }
              ]
            }
          ]
        )
      )
    );
    expect(otherWing.problems).toEqual([`fleets[0].wings[0].commander "x" sits in squad "s" of wing "w2"; a wing commander sits in one of its own wing's squads or in none`]);

    const twoWings = catchSceneError(() =>
      normalizeScene(
        makeFleetScene(
          ['fc', 'x'],
          [
            {
              id: 'f',
              commander: 'fc',
              wings: [
                { id: 'w1', commander: 'x' },
                { id: 'w2', commander: 'x' }
              ]
            }
          ]
        )
      )
    );
    expect(twoWings.problems).toEqual(['fleets[0].wings[1].commander "x" already commands wing "w1"']);

    const notMember = catchSceneError(() => normalizeScene(makeFleetScene(['fc', 'x', 'y'], [fleetOf([{ id: 's', role: 'dps', commander: 'y', members: ['x'] }])])));
    expect(notMember.problems).toEqual([`fleets[0].wings[0].squads[0].commander "y" is not one of the squad's members`]);
  });

  it('wing and squad ids are scoped to their fleet', () => {
    const accepted = makeFleetScene(
      ['fc1', 'fc2', 'x', 'y'],
      [
        { id: 'f1', commander: 'fc1', wings: [{ id: 'dps', squads: [{ id: 'dps', role: 'dps', members: ['x'] }] }] },
        { id: 'f2', commander: 'fc2', wings: [{ id: 'w', squads: [{ id: 'dps', role: 'dps', members: ['y'] }] }] }
      ]
    );
    expect(() => normalizeScene(accepted)).not.toThrow();

    const error = catchSceneError(() =>
      normalizeScene(
        makeFleetScene(
          ['fc'],
          [
            {
              id: 'f',
              commander: 'fc',
              wings: [
                { id: 'w', squads: [{ id: 'dps', role: 'dps' }] },
                { id: 'w', squads: [{ id: 'dps', role: 'dps' }] }
              ]
            },
            { id: 'f', commander: 'fc' }
          ]
        )
      )
    );
    expect(error.problems).toEqual(expect.arrayContaining(['fleets[0].wings[1].id "w" is used more than once in fleet "f"', 'fleets[0].wings[1].squads[0].id "dps" is used more than once in fleet "f"', 'fleets[1].id "f" is used more than once']));
  });

  it('anchors are ships of the fleet, at a range of 0 or more, with no loops', () => {
    const anchorProblem = (anchor: unknown) => catchSceneError(() => normalizeScene(makeFleetScene(['fc', 'x', 'out'], [fleetOf([{ id: 's', role: 'dps', members: ['x'], anchor }])]))).problems;
    expect(anchorProblem({ ship: 'zz' })).toEqual(['fleets[0].wings[0].squads[0].anchor.ship "zz" is not a ship id']);
    expect(anchorProblem({ ship: 'out' })).toEqual(['fleets[0].wings[0].squads[0].anchor.ship "out" is not in fleet "f"']);
    expect(anchorProblem('fc')).toEqual(['fleets[0].wings[0].squads[0].anchor must be an object of ship and range']);
    for (const range of ['far', -1, Infinity]) {
      expect(anchorProblem({ range })).toEqual(['fleets[0].wings[0].squads[0].anchor.range must be a number of 0 or more (metres)']);
    }

    const loop = catchSceneError(() =>
      normalizeScene(
        makeFleetScene(
          ['fc', 'x', 'y'],
          [
            fleetOf([
              { id: 'a', role: 'dps', members: ['x'], anchor: { ship: 'y' } },
              { id: 'b', role: 'dps', members: ['y'], anchor: { ship: 'x' } }
            ])
          ]
        )
      )
    );
    expect(loop.problems).toEqual(['fleets[0]: anchors form a loop (x → y → x); every anchor chain must end at the fleet commander "fc"']);

    // A squad anchored on another squad's lead is a chain, not a loop.
    const chain = makeFleetScene(
      ['fc', 'g1', 'g2', 'x'],
      [
        fleetOf([
          { id: 'logi', role: 'logi', members: ['g1', 'g2'], anchor: { ship: 'g1' } },
          { id: 'dps', role: 'dps', members: ['x'], anchor: { ship: 'g2' } }
        ])
      ]
    );
    expect(() => normalizeScene(chain)).not.toThrow();
  });

  describe('resolution', () => {
    it('resolves the sd-fleets example', () => {
      const memberships = toFleetMemberships(normalizeScene(TFI_FLEET_SCENE).scene);
      const dps = { fleet: 'tfi', wing: 'wing-1', squad: 'dps', role: 'dps', commands: [], anchor: { ship: 'fc', range: 1000 } };
      expect(Object.fromEntries(memberships)).toEqual({
        fc: { fleet: 'tfi', wing: null, squad: null, role: null, commands: ['fleet'], anchor: null },
        'tfi-1': dps,
        'tfi-2': dps,
        'tfi-3': dps,
        'guardian-1': { fleet: 'tfi', wing: 'wing-1', squad: 'logi', role: 'logi', commands: ['squad'], anchor: { ship: 'fc', range: 30000 } },
        'guardian-2': { fleet: 'tfi', wing: 'wing-1', squad: 'logi', role: 'logi', commands: [], anchor: { ship: 'guardian-1', range: 1000 } }
      });
    });

    it('resolves commanders, defaults and combined commands', () => {
      const resolve = (fleet: unknown, ids = ['fc', 'x', 'y']) => toFleetMemberships(normalizeScene(makeFleetScene(ids, [fleet])).scene);

      const wingCommander = resolve({ id: 'f', commander: 'fc', wings: [{ id: 'w', commander: 'x' }] });
      expect(wingCommander.get('x')).toEqual({ fleet: 'f', wing: 'w', squad: null, role: null, commands: ['wing'], anchor: { ship: 'fc', range: 1000 } });

      const fcInSquad = resolve(fleetOf([{ id: 's', role: 'tackle', members: ['fc', 'x'], anchor: { range: 2000 } }]));
      expect(fcInSquad.get('fc')?.anchor).toBeNull();
      expect(fcInSquad.get('fc')?.squad).toBe('s');
      expect(fcInSquad.get('x')?.anchor).toEqual({ ship: 'fc', range: 2000 });

      const logi = resolve(fleetOf([{ id: 's', role: 'logi', members: ['x', 'y'] }]));
      expect(logi.get('x')?.anchor).toEqual({ ship: 'fc', range: 30000 });
      expect(logi.get('y')?.anchor).toEqual({ ship: 'fc', range: 30000 });

      const tackle = resolve(fleetOf([{ id: 's', role: 'tackle', members: ['x'] }]));
      expect(tackle.get('x')?.anchor).toEqual({ ship: 'fc', range: 1000 });

      const allCommands = resolve({ id: 'f', commander: 'fc', wings: [{ id: 'w', commander: 'fc', squads: [{ id: 's', role: 'dps', commander: 'fc', members: ['fc', 'x'] }] }] });
      expect(allCommands.get('fc')?.commands).toEqual(['fleet', 'wing', 'squad']);
    });
  });
});

describe("a squad's home", () => {
  const sceneOf = (home: unknown) => makeFleetScene(['fc', 'a', 'b', 'other'], [fleetOf([{ id: 's', role: 'dps', members: ['a', 'b'], anchor: { ship: 'a', range: 9000 }, home }])]);
  const squadOf = (home: unknown) => normalizeScene(sceneOf(home)).scene.fleets![0].wings[0].squads[0];

  it('keeps a home as written, {} included, and changes no membership', () => {
    expect(squadOf({ ship: 'a', range: 1000 }).home).toEqual({ ship: 'a', range: 1000 });
    expect(squadOf({}).home).toEqual({});
    expect('home' in squadOf(null)).toBe(false);
    const withHome = normalizeScene(sceneOf({ range: 1000 })).scene;
    const without = normalizeScene(sceneOf(null)).scene;
    expect(toFleetMemberships(withHome)).toEqual(toFleetMemberships(without));
  });

  it('checks the home ship like an anchor ship and warns on unknown keys', () => {
    expect(catchSceneError(() => normalizeScene(sceneOf({ ship: 'x' }))).problems.join('\n')).toMatch(/squads\[0\]\.home\.ship "x" is not a ship id/u);
    expect(catchSceneError(() => normalizeScene(sceneOf({ ship: 'other' }))).problems.join('\n')).toMatch(/squads\[0\]\.home\.ship "other" is not in fleet "f"/u);
    expect(catchSceneError(() => normalizeScene(sceneOf({ range: -1 }))).problems.join('\n')).toMatch(/home\.range must be a number of 0 or more/u);
    expect(normalizeScene(sceneOf({ range: 1, bearing: 2 })).warnings.join('\n')).toMatch(/home\.bearing/u);
  });
});
