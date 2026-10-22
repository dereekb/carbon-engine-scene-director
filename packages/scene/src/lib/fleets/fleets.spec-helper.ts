import { expect } from 'vitest';
import { SceneError } from '../scene';

export const TFI = 'mb2_t1:minmatarnavy:minmatar';
export const GUARDIAN = 'ac3_t2:carthum:amarr';

/**
 * The sd-fleets ref's fleet example: an FC, a DPS squad of three on the FC at 1 km, and a logi squad of two on its own
 * logi anchor at 30 km.
 */
export const TFI_FLEET_SCENE = {
  schema: 'cjs-scene/1',
  name: 'tfi-fleet',
  ships: [
    { id: 'fc', dna: TFI, name: 'FC' },
    { id: 'tfi-1', dna: TFI, position: [1500, 0, 0] },
    { id: 'tfi-2', dna: TFI, position: [-1500, 0, 0] },
    { id: 'tfi-3', dna: TFI, position: [0, 0, 1500] },
    { id: 'guardian-1', dna: GUARDIAN, position: [30000, 0, 0] },
    { id: 'guardian-2', dna: GUARDIAN, position: [31000, 0, 0] }
  ],
  fleets: [
    {
      id: 'tfi',
      name: 'TFI fleet',
      commander: 'fc',
      wings: [
        {
          id: 'wing-1',
          squads: [
            { id: 'dps', role: 'dps', members: ['tfi-1', 'tfi-2', 'tfi-3'], anchor: { range: 1000 } },
            { id: 'logi', role: 'logi', commander: 'guardian-1', members: ['guardian-1', 'guardian-2'], anchor: { ship: 'guardian-1', range: 30000 } }
          ]
        }
      ]
    }
  ]
};

/**
 * A scene of ships with the given ids and the given fleets.
 *
 * @param ids - The ship ids.
 * @param fleets - The fleets.
 * @returns A candidate document.
 */
export function makeFleetScene(ids: string[], fleets: unknown): Record<string, unknown> {
  return { ships: ids.map((id) => ({ id, dna: TFI })), fleets };
}

/**
 * Runs `action`, which must throw a SceneError, and returns the error.
 *
 * @param action - The action.
 * @returns The error.
 * @throws {Error} When the action does not throw.
 */
export function catchSceneError(action: () => unknown): SceneError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SceneError);
    return error as SceneError;
  }
  throw new Error('expected a SceneError');
}
