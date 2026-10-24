/**
 * No-EVE-data mode's shared contract: the hub's switch (--eve-data, SCENE_DIRECTOR_EVE_DATA) and what the page reads
 * from GET /config before it boots. With the mode off the hub never touches tools-core and the page asks for no EVE file,
 * lookup, map or sound (sd-dev-env).
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject } from './json';

/**
 * Where the hub's EVE data comes from: tools-core (the default), or nowhere (`off`, no-EVE-data mode).
 */
export type EveDataMode = 'tools-core' | 'off';

export const EVE_DATA_MODES: readonly EveDataMode[] = ['tools-core', 'off'];
export const DEFAULT_EVE_DATA_MODE: EveDataMode = 'tools-core';

/**
 * The hub's EVE data mode and, while off, why, for people: viewer_status.eveData, GET /config and the hello reply.
 */
export interface EveDataStatus {
  readonly mode: EveDataMode;
  readonly note?: string;
}

/**
 * GET /config: what the page must know before it boots.
 */
export interface HubPageConfig {
  readonly eveData: EveDataStatus;
}

/**
 * Reads a flag or env value.
 *
 * @param value - The raw value.
 * @returns 'tools-core' or 'off' (trimmed, any case); null for anything else.
 */
export function readEveDataMode(value: unknown): Maybe<EveDataMode> {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : null;
  return EVE_DATA_MODES.find((candidate) => candidate === mode) ?? null;
}

/**
 * Reads an EVE data status leniently (the hello reply's hub.eveData, GET /config's eveData).
 *
 * @param value - The raw value.
 * @returns The status, or null when it is not one.
 */
export function readEveDataStatus(value: unknown): Maybe<EveDataStatus> {
  let status: Maybe<EveDataStatus> = null;
  if (isPlainObject(value)) {
    const mode = readEveDataMode(value['mode']);
    const note = value['note'];
    if (mode) status = { mode, ...(typeof note === 'string' && note ? { note } : {}) };
  }
  return status;
}

/**
 * Reads a GET /config body leniently.
 *
 * @param value - The parsed body.
 * @returns The config, or null when it is not one.
 */
export function readHubPageConfig(value: unknown): Maybe<HubPageConfig> {
  const eveData = isPlainObject(value) ? readEveDataStatus(value['eveData']) : null;
  return eveData ? { eveData } : null;
}
