import { expect } from 'vitest';
import { type FleetComposition } from './composition';
import { FLEET_COMPOSITION_EXAMPLES } from './examples';
import { normalizeFleetComposition } from './normalize';

export const RIFTER = 'mf1_t1:minmatarbase:minmatar';
export const TFI = 'mb2_t1:minmatarnavy:minmatar';
export const GUARDIAN = 'ac3_t2:carthum:amarr';

/**
 * The 13 fits the TFIs example carries.
 */
export const TFIS_FIT_KEYS = ['tfi', 'zarmazd', 'guardian', 'revelation', 'damnation', 'eos', 'bhaalgorn', 'vindicator', 'devoter', 'apostle-active', 'thanatos', 'nidhoggur', 'archon'];

/**
 * An FC-only composition.
 *
 * @param id - The composition id.
 * @returns A candidate composition.
 */
export function makeFcOnlyComposition(id = 'solo'): Record<string, unknown> {
  return { id, commander: { hull: 'Rifter', dna: RIFTER, radius: 31 } };
}

/**
 * A small composition: a TFI FC, a DPS squad of three TFIs on the FC and a logi squad of two Guardians on its lead.
 *
 * @returns A candidate composition.
 */
export function makeMiniComposition(): Record<string, unknown> {
  return {
    id: 'mini',
    name: 'Mini',
    commander: { hull: 'Tempest Fleet Issue', dna: TFI, radius: 250 },
    wings: [
      {
        id: 'w',
        squads: [
          { id: 'dps', role: 'dps', ships: [{ hull: 'Tempest Fleet Issue', count: 3, dna: TFI, radius: 250 }] },
          { id: 'logi', role: 'logi', ships: [{ hull: 'Guardian', count: 2, dna: GUARDIAN, radius: 80 }] }
        ]
      }
    ]
  };
}

/**
 * The shipped TFIs example, normalized.
 *
 * @returns The composition.
 */
export function tfisComposition(): FleetComposition {
  const normalized = normalizeFleetComposition({ input: FLEET_COMPOSITION_EXAMPLES[0] });
  expect(normalized.problems).toEqual([]);
  return normalized.composition as FleetComposition;
}

/**
 * Normalizes a candidate that must be valid.
 *
 * @param input - The candidate.
 * @returns The composition.
 */
export function requireComposition(input: unknown): FleetComposition {
  const normalized = normalizeFleetComposition({ input });
  expect(normalized.problems).toEqual([]);
  return normalized.composition as FleetComposition;
}
