/**
 * The page's EVE data mode (sd-dev-env, "No-EVE-data mode"): learned from the hub's GET /config before the page
 * configures resources or creates the engine, or forced off for one tab with ?eve=off. One PageEveData value is built
 * in main.ts and handed to every subsystem at construction; while it is off nothing on the page asks for an EVE file,
 * lookup, map or sound. Node-tested: imports only @scene-director/scene.
 */

import type { Maybe } from '@dereekb/util';
import { type EveDataStatus, type HubPageConfig, readHubPageConfig } from '@scene-director/scene';

export interface PageEveData {
  /**
   * False in no-EVE-data mode: nothing on the page asks for an EVE file, lookup, map or sound.
   */
  readonly on: boolean;
  /**
   * Who turned it off: the hub (--eve-data off) or this tab (?eve=off); null while on.
   */
  readonly from: Maybe<'hub' | 'url'>;
  /**
   * The one short reason every skipped lookup, build and report gives; null while on.
   */
  readonly note: Maybe<string>;
}

export const EVE_DATA_ON: PageEveData = { on: true, from: null, note: null };

export const HUB_EVE_DATA_OFF_NOTE = 'no EVE data (the hub runs with --eve-data off)';
export const URL_EVE_DATA_OFF_NOTE = 'no EVE data (this tab was opened with ?eve=off)';

/**
 * How long the page waits for GET /config before it boots with EVE data on.
 */
export const HUB_CONFIG_TIMEOUT_MS = 5000;

export interface PageEveDataInput {
  /**
   * The hub's mode (GET /config's eveData), or null when the hub had no answer.
   */
  readonly hub: Maybe<EveDataStatus>;
  /**
   * The page URL's search string.
   */
  readonly search: string;
}

/**
 * The tab's mode: the hub's `off` wins, then the URL's ?eve=off (one way: it can never turn EVE data on against an
 * `off` hub), else on.
 *
 * @param input - The hub's mode and the URL's search string.
 * @returns The mode.
 */
export function PageEveDataOf(input: PageEveDataInput): PageEveData {
  let eveData = EVE_DATA_ON;
  if (input.hub?.mode === 'off') eveData = { on: false, from: 'hub', note: HUB_EVE_DATA_OFF_NOTE };
  else if (new URLSearchParams(input.search).get('eve') === 'off') eveData = { on: false, from: 'url', note: URL_EVE_DATA_OFF_NOTE };
  return eveData;
}

/**
 * The part of fetch FetchHubConfig uses.
 */
export type HubConfigFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/**
 * Asks the hub for GET /config.
 *
 * @param fetch - Defaults to the global fetch.
 * @returns The config; null (and one warning) when the hub has no answer: a stale hub without the route, or a timeout.
 */
export async function FetchHubConfig(fetch: HubConfigFetch = (url, init) => globalThis.fetch(url, init)): Promise<Maybe<HubPageConfig>> {
  let config: Maybe<HubPageConfig> = null;
  let problem: Maybe<string> = null;
  try {
    const response = await fetch('/config', { signal: AbortSignal.timeout(HUB_CONFIG_TIMEOUT_MS) });
    if (response.ok) config = readHubPageConfig(await Promise.resolve(response.json()).catch(() => null));
    problem = config ? null : `it answered ${response.status}${response.ok ? ' without an eveData mode' : ''}`;
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  if (problem) console.warn(`the hub's /config did not answer (${problem}); booting with EVE data on`);
  return config;
}

/**
 * Get_state's eveData, before the Director adds `refused`.
 *
 * @param eveData - The tab's mode.
 * @returns { mode, from?, note? }.
 */
export function EveDataReport(eveData: PageEveData): { readonly mode: 'tools-core' | 'off'; readonly from?: 'hub' | 'url'; readonly note?: string } {
  return eveData.on ? { mode: 'tools-core' } : { mode: 'off', ...(eveData.from ? { from: eveData.from } : {}), ...(eveData.note ? { note: eveData.note } : {}) };
}

/**
 * The HUD's "EVE data" row.
 *
 * @param eveData - The tab's mode.
 * @returns The row's text, or null while on (no row).
 */
export function EveDataText(eveData: PageEveData): Maybe<string> {
  const why = eveData.from === 'url' ? 'this tab was opened with ?eve=off' : 'the hub runs with --eve-data off';
  return eveData.on ? null : `off · ${why} · ships and objects are stand-in cubes`;
}

/**
 * Whether a tab must reload for the hub it (re)connected to: only a tab whose mode came from the hub (or that is on)
 * and only when the hub's mode differs. A tab forced off by ?eve=off stays off against any hub.
 *
 * @param booted - The mode the tab booted with.
 * @param hub - The hello reply's eveData; null when the hub sent none (a stale hub).
 * @returns Whether to reload.
 */
export function HubModeChanged(booted: PageEveData, hub: Maybe<EveDataStatus>): boolean {
  if (!hub || booted.from === 'url') return false;
  return hub.mode === 'off' ? booted.on : !booted.on;
}
