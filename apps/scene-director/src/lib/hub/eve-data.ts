/**
 * Where the hub's EVE data comes from, chosen once at construction (sd-dev-env, "No-EVE-data mode"): tools-core's
 * sources, or the no-EVE-data sources. Those reject every lookup at once with a NoEveDataError, which is a
 * ShipDataError 'unavailable', so the hub's existing fallbacks (four stats, baked prop mods, lines and objects by dna,
 * given rocks) keep working, the tools that need EVE data refuse with a mode-named message, and the HTTP routes answer
 * 503. No code path here makes a request: with the mode off the hub never touches tools-core.
 */

import type { Maybe } from '@dereekb/util';
import type { EveDataMode, EveDataStatus } from '@scene-director/scene';
import { AsteroidData, type AsteroidDataApi } from './asteroid-data';
import { DogmaData, type DogmaDataApi } from './dogma-data';
import { MapData, type MapDataApi } from './map-data';
import { ObjectData, type ObjectDataApi } from './object-data';
import { SdeClient, ShipDataError } from './sde-client';
import { ShipData, type ShipDataApi } from './ship-data';
import { ToolsCore, type ToolsCoreApi } from './tools-core';
import { WeaponData, type WeaponDataApi } from './weapon-data';

export const NO_EVE_DATA = 'this hub runs without EVE data (--eve-data off, or SCENE_DIRECTOR_EVE_DATA=off)';

/**
 * A lookup the hub cannot answer in no-EVE-data mode: `failure` is 'unavailable' (503 on the HTTP routes).
 */
export class NoEveDataError extends ShipDataError {
  /**
   * @param what - What needs EVE data, e.g. `the EVE map`.
   * @param hint - What works instead, if anything.
   */
  constructor(what: string, hint?: Maybe<string>) {
    const instead = hint ? '; ' + hint : '';
    super('unavailable', `${what} needs EVE data, and ${NO_EVE_DATA}${instead}`);
    this.name = 'NoEveDataError';
  }
}

/**
 * Every source of EVE data the hub reads.
 */
export interface EveDataSources {
  readonly toolsCore: ToolsCoreApi;
  readonly shipData: ShipDataApi;
  readonly dogmaData: DogmaDataApi;
  readonly weaponData: WeaponDataApi;
  readonly mapData: MapDataApi;
  readonly objectData: ObjectDataApi;
  readonly asteroidData: AsteroidDataApi;
}

export interface HubEveDataSourcesInput extends Partial<EveDataSources> {
  readonly mode: EveDataMode;
  readonly log?: (line: string) => void;
}

/**
 * The hub's sources: with tools-core, the injected ones first, else the defaults on one shared SDE client (ShipData's
 * build pin and cache) and MapData, ObjectData and AsteroidData on ShipData's pinned SDE build; with the mode off, the
 * no-EVE-data sources, ignoring every injected one.
 *
 * @param input - The mode, any injected sources, and the log MapData reports to.
 * @returns The sources.
 */
export function HubEveDataSources(input: HubEveDataSourcesInput): EveDataSources {
  if (input.mode === 'off') return NoEveDataSources();
  const toolsCore = input.toolsCore ?? new ToolsCore();
  // Every client reaches tools-core through its fetch: a shared tools-core's token rides along.
  const { url, fetch } = toolsCore;
  const shipData = input.shipData ?? new ShipData({ url, fetch });
  const sde = shipData instanceof ShipData ? shipData.sde : new SdeClient({ url, fetch });
  const sdeBuild = () => shipData.SdeBuild();
  const objectData = input.objectData ?? new ObjectData({ url, fetch, sdeBuild, resourceBuild: () => toolsCore.ResolveBuild() });
  return {
    toolsCore,
    shipData,
    dogmaData: input.dogmaData ?? new DogmaData({ sde }),
    weaponData: input.weaponData ?? new WeaponData({ sde }),
    mapData: input.mapData ?? new MapData({ url, fetch, sdeBuild, log: input.log }),
    objectData,
    asteroidData: input.asteroidData ?? new AsteroidData({ objectData, url, fetch, sdeBuild })
  };
}

/**
 * Sources that answer nothing: every lookup rejects with a NoEveDataError naming what needed EVE data and what works
 * instead; tools-core's status is unreachable with the mode's message.
 *
 * @returns The sources.
 */
export function NoEveDataSources(): EveDataSources {
  const refuse = (what: string, hint?: string) => Promise.reject(new NoEveDataError(what, hint));
  const sdeBuild = () => refuse('the SDE build');
  return {
    toolsCore: {
      url: 'none',
      fetch: () => refuse('tools-core'),
      ResolveBuild: () => refuse('the EVE build'),
      ResourceUrl: () => refuse('EVE files'),
      ResFileIndexUrl: () => refuse('EVE files'),
      AudioLibraryUrl: () => refuse('EVE audio'),
      AudioPathUrl: () => refuse('EVE audio'),
      SofCatalog: (kind) => refuse(`the SOF ${kind} catalog`, 'write DNA as <hull>:<faction>:<race> by hand; every ship draws as a stand-in cube'),
      Status: () => Promise.resolve({ reachable: false, url: 'none', build: null, error: NO_EVE_DATA })
    },
    shipData: {
      SdeBuild: sdeBuild,
      Hull: (lookup) => refuse(`the hull lookup for "${lookup.type ?? lookup.dna ?? ''}"`, 'name hulls by dna; all four stats pin real numbers'),
      PropMod: (typeID) => refuse(`prop mod ${typeID}`, 'use mwd or ab'),
      PropModByName: (name) => refuse(`prop mod "${name}"`, 'use mwd or ab')
    },
    dogmaData: {
      SdeBuild: sdeBuild,
      TypeByName: () => refuse('fit lookups', "fits fly as their hull's class numbers"),
      Bundle: () => refuse('fit lookups', "fits fly as their hull's class numbers"),
      Skills: () => refuse('fit lookups', "fits fly as their hull's class numbers")
    },
    weaponData: {
      Weapon: () => refuse('weapon graphics'),
      Missile: () => refuse('weapon graphics')
    },
    mapData: {
      SdeBuild: sdeBuild,
      Index: () => refuse('the EVE map', 'a scene has no location without EVE data'),
      Search: () => refuse('the EVE map', 'a scene has no location without EVE data'),
      System: () => refuse('the EVE map', 'a scene has no location without EVE data'),
      SystemCelestials: () => refuse('the EVE map', 'a scene has no location without EVE data'),
      Celestial: () => refuse('the EVE map', 'a scene has no location without EVE data')
    },
    objectData: {
      Type: (lookup) => refuse(`EVE type "${lookup.type}"`, 'place it by dna (and a radius)'),
      Search: () => refuse('searching EVE types')
    },
    asteroidData: {
      Ore: (name) => refuse(`ore "${name}"`, 'give the field its rocks (they draw only with EVE data)'),
      RockSet: (faction) => refuse(`rock set "${faction}"`, 'give the field its rocks (they draw only with EVE data)')
    }
  };
}

/**
 * The mode as viewer_status, GET /config and the hello reply report it.
 *
 * @param mode - The hub's mode.
 * @returns The status, with a note while off.
 */
export function EveDataStatusOf(mode: EveDataMode): EveDataStatus {
  return mode === 'off'
    ? {
        mode,
        note: `no EVE data: ${NO_EVE_DATA}. Ships and objects draw as stand-in cubes on a green screen, fly class numbers and fight with stand-in guns by class (ships[].standIn.class; a cruiser otherwise); search_hulls, search_map, get_system, set_location, search_objects, and lookups by EVE name refuse.`
      }
    : { mode };
}
