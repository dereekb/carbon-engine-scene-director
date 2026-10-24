import { DEFAULT_FLEET_PERSONALITY, FLEET_PERSONALITY_SCHEMA, type SceneDocument, type SceneFleet } from '@scene-director/scene';
import type { Scenario, ScenarioFleetSettings, ScenarioPersonality, ScenarioSettingsDrop } from './scenario';

/**
 * The suffix of the personality key each fleet's doctrine is staged under: `<fleet>-fc`, its own template extending
 * the chosen base, so Apply edits one fleet's doctrine without touching the other's.
 */
export const FLEET_DOCTRINE_SUFFIX = '-fc';

/**
 * The personality key a fleet's doctrine lives under.
 *
 * @param fleet - The fleet id.
 * @returns `<fleet>-fc`.
 */
export function fleetDoctrineKey(fleet: string): string {
  return `${fleet}${FLEET_DOCTRINE_SUFFIX}`;
}

/**
 * The fleet's doctrine as its own `cjs-fleet-personality/1` template, `<fleet>-fc`: a base name becomes a template
 * that extends it; a template keeps its overrides and extends its base (`line` by default).
 *
 * @param fleet - The fleet id.
 * @param personality - The settings' doctrine; none extends `line`.
 * @returns The template.
 */
export function toFleetDoctrineTemplate(fleet: string, personality?: ScenarioPersonality): Record<string, unknown> {
  const base = typeof personality === 'string' ? { extends: personality } : { extends: DEFAULT_FLEET_PERSONALITY, ...personality };
  return { ...base, schema: FLEET_PERSONALITY_SCHEMA, id: fleetDoctrineKey(fleet) };
}

/**
 * The logi squads of a fleet in a document (role `logi`).
 *
 * @param fleet - The fleet.
 * @returns Their ids.
 */
export function logiSquadsOf(fleet: SceneFleet): string[] {
  return fleet.wings.flatMap((wing) => wing.squads.filter((squad) => squad.role === 'logi').map((squad) => squad.id));
}

/**
 * The document edits one fleet's settings make: `set_personalities` on its `<fleet>-fc` template, and `update_squad`
 * on each logi squad for its stance (follow: none, so it keeps its anchor 30 km on the FC; loose: support pilots) and
 * its auto-repair. No `update_fleet`: the brain's book rebuilds on the new document at the next boundary, and no
 * manual lever is released (sd-console).
 *
 * @param scene - The document the fleet is in (for its logi squads).
 * @param fleet - The fleet id.
 * @param settings - Its settings.
 * @returns The operations (empty when the fleet is not in the document and only a personality is not given).
 */
export function toFleetSettingsOperations(scene: Pick<SceneDocument, 'fleets'>, fleet: string, settings: ScenarioFleetSettings): Record<string, unknown>[] {
  const operations: Record<string, unknown>[] = [];

  if (settings.personality != null) {
    operations.push({ op: 'set_personalities', personalities: { [fleetDoctrineKey(fleet)]: toFleetDoctrineTemplate(fleet, settings.personality) } });
  }

  const logi = settings.logi;
  const found = scene.fleets?.find((candidate) => candidate.id === fleet);

  if (logi && found) {
    const set: Record<string, unknown> = {};

    if (logi.formation) {
      set['stance'] = logi.formation === 'loose' ? { formation: 'loose' } : null;
    }

    if (logi.autoRepair) {
      set['autoRepair'] = logi.autoRepair;
    }

    if (Object.keys(set).length > 0) {
      for (const squad of logiSquadsOf(found)) {
        operations.push({ op: 'update_squad', fleet, squad, set });
      }
    }
  }

  return operations;
}

/**
 * The fleet's settings merged with newer ones, key by key (a drop's `logi` merges into the old logi).
 *
 * @param current - The settings so far.
 * @param next - The newer settings.
 * @returns The merged settings.
 */
export function mergeFleetSettings(current: ScenarioFleetSettings = {}, next: ScenarioFleetSettings = {}): ScenarioFleetSettings {
  const logi = current.logi || next.logi ? { ...current.logi, ...next.logi } : undefined;
  return { ...current, ...next, ...(logi ? { logi } : {}) };
}

export interface MergedScenarioSettings {
  readonly scenario: Scenario;
  /**
   * The drop's fleets the scenario has no side for (ignored).
   */
  readonly unknownFleets: readonly string[];
}

/**
 * Merges a settings drop (or the panel's edits) into the console's copy of the scenario, so Reset keeps them.
 *
 * @param scenario - The console's scenario.
 * @param drop - The settings, by fleet.
 * @returns The scenario with each named side's settings merged, and the fleets it has no side for.
 */
export function mergeScenarioSettings(scenario: Scenario, drop: Pick<ScenarioSettingsDrop, 'sides'>): MergedScenarioSettings {
  const unknownFleets = drop.sides.filter((entry) => !scenario.sides.some((side) => side.fleet === entry.fleet)).map((entry) => entry.fleet);
  const sides = scenario.sides.map((side) => {
    const entry = drop.sides.find((candidate) => candidate.fleet === side.fleet);
    return entry ? { ...side, settings: mergeFleetSettings(side.settings, entry.settings) } : side;
  });

  return { scenario: { ...scenario, sides }, unknownFleets };
}

/**
 * The document edits a settings drop makes on the running battle: each fleet's toFleetSettingsOperations, for the
 * fleets the live document has.
 *
 * @param scene - The live document.
 * @param drop - The settings, by fleet.
 * @returns The operations, in the drop's order.
 */
export function toSettingsDropOperations(scene: Pick<SceneDocument, 'fleets'>, drop: Pick<ScenarioSettingsDrop, 'sides'>): Record<string, unknown>[] {
  return drop.sides.filter((entry) => scene.fleets?.some((fleet) => fleet.id === entry.fleet)).flatMap((entry) => toFleetSettingsOperations(scene, entry.fleet, entry.settings));
}
