/**
 * Fits in the scene document. A ship's `fit` is inline EFT text (it starts with `[`) or a key of the document's
 * `fits` map; compositions put their fits in the map under `<composition id>/<fit key>`, so a 44-ship fleet carries
 * its 13 fits once rather than 44 times.
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject } from '../json';
import { DEFAULT_PROP_MOD_MODULE, PROP_MOD_MODULE_NONE, type PropModModule } from '../stats/prop-mods';
import { MAX_FIT_LENGTH, readEftHeader, readEftPropMod } from './eft';

/**
 * A key of the document's `fits`: 1-64 letters, digits, `_`, `-` or `.`, optionally twice with one `/` between
 * (`tfis/tfi`).
 */
export const FIT_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}(?:\/[A-Za-z0-9_.-]{1,64})?$/u;

const FIT_KEY_RULE = '1-64 letters, digits, "_", "-" or ".", optionally twice with one "/" between';

/**
 * Whether a ship's `fit` value is EFT text rather than a key of `fits`.
 *
 * @param value - The ship's fit value.
 * @returns True when it starts with `[` after trimming.
 */
export function isInlineFit(value: string): boolean {
  return value.trimStart().startsWith('[');
}

/**
 * The fit key a composition's fit gets in the scene: `<prefix>/<key>`.
 *
 * @param prefix - The composition id, or the fleet id when the composition's key is taken by other text.
 * @param key - The composition's fit key.
 * @returns The scene fit key.
 */
export function sceneFitKey(prefix: string, key: string): string {
  return `${prefix}/${key}`;
}

export interface ChooseSceneFitKeyInput {
  /**
   * The fits the scene already holds (merged with any this edit added).
   */
  readonly fits: Maybe<Readonly<Record<string, string>>>;
  /**
   * The key prefixes to try in order: the composition id, then the fleet id.
   */
  readonly prefixes: readonly string[];
  /**
   * The fit's own key (a composition fits key, or a slug of the fit's name).
   */
  readonly key: string;
  readonly text: string;
}

/**
 * The scene key a fit is stored under: the first `<prefix>/<key>` that is free or already holds the same text, else
 * the first prefix numbered (`<prefix>-2/<key>`, ...). So a second fleet of one composition reuses its fits, and a
 * different text under a taken key gets the fleet's own.
 *
 * @param input - The scene's fits, the prefixes, the key and the text.
 * @returns The key.
 */
export function chooseSceneFitKey(input: ChooseSceneFitKeyInput): string {
  const { fits, prefixes, key, text } = input;
  const held = fits ?? {};
  const usable = (candidate: string): boolean => held[candidate] == null || held[candidate] === text;
  const segment = (value: string): string => value.slice(0, 64);
  let chosen = prefixes.map((prefix) => sceneFitKey(segment(prefix), segment(key))).find(usable);
  for (let number = 2; chosen == null; number += 1) {
    const candidate = sceneFitKey(`${segment(prefixes[0] ?? 'fit').slice(0, 58)}-${number}`, segment(key));
    if (usable(candidate)) chosen = candidate;
  }
  return chosen;
}

/**
 * Reads one EFT text: non-empty, at most MAX_FIT_LENGTH characters, with an EFT header.
 *
 * @param value - The candidate.
 * @param where - Where it sits, for messages.
 * @param problems - Receives what is wrong with it.
 * @returns The trimmed text, or null when it is not usable.
 */
export function readFitText(value: unknown, where: string, problems: string[]): Maybe<string> {
  let text: Maybe<string> = null;
  if (typeof value !== 'string' || !value.trim()) problems.push(`${where} must be EFT fit text`);
  else if (value.length > MAX_FIT_LENGTH) problems.push(`${where} is longer than ${MAX_FIT_LENGTH} characters`);
  else if (!readEftHeader(value)) problems.push(`${where} must be EFT text starting with a [Hull, Fit name] header`);
  else text = value.trim();
  return text;
}

export interface NormalizedSceneFits {
  /**
   * EFT text by key, or null when there are none.
   */
  readonly fits: Maybe<Record<string, string>>;
  readonly problems: string[];
}

/**
 * Validates the document's `fits` map: keys per FIT_KEY_PATTERN, values EFT text with a header.
 *
 * @param input - The candidate map.
 * @param where - Where it sits, for messages.
 * @returns The map (null when absent or empty) and its problems.
 */
export function normalizeSceneFits(input: unknown, where = 'fits'): NormalizedSceneFits {
  const problems: string[] = [];
  let fits: Maybe<Record<string, string>> = null;
  if (input != null && !isPlainObject(input)) {
    problems.push(`${where} must be an object of EFT fit text by key`);
  } else if (input != null) {
    const read: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!FIT_KEY_PATTERN.test(key)) {
        problems.push(`${where} key "${key}" must be ${FIT_KEY_RULE}`);
        continue;
      }
      const text = readFitText(value, `${where}["${key}"]`, problems);
      if (text) read[key] = text;
    }
    if (Object.keys(read).length) fits = read;
  }
  return { fits, problems };
}

export interface NormalizeShipFitInput {
  readonly input: unknown;
  /**
   * Where the fit sits, e.g. "ships[0].fit".
   */
  readonly where: string;
  /**
   * The document's normalized fits.
   */
  readonly fits: Maybe<Readonly<Record<string, string>>>;
  /**
   * The ship's `type`, to compare with the fit's hull.
   */
  readonly type?: Maybe<string | number>;
}

export interface NormalizedShipFit {
  /**
   * The inline text or the key, or null when absent.
   */
  readonly fit: Maybe<string>;
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * Validates a ship's `fit`: inline EFT text, or a key that `fits` holds. A string `type` that names another hull
 * than the fit's header warns (the ship flies as its type; the fit's modules still apply).
 *
 * @param config - The candidate, where it sits, the document's fits and the ship's type.
 * @returns The fit value with its problems and warnings.
 */
export function normalizeShipFit(config: NormalizeShipFitInput): NormalizedShipFit {
  const { input, where, fits, type } = config;
  const problems: string[] = [];
  const warnings: string[] = [];
  let fit: Maybe<string> = null;
  if (input != null && (typeof input !== 'string' || !input.trim())) {
    problems.push(`${where} must be EFT fit text or a key of the scene's fits`);
  } else if (typeof input === 'string' && isInlineFit(input)) {
    fit = readFitText(input, where, problems);
  } else if (typeof input === 'string') {
    const key = input.trim();
    if (!FIT_KEY_PATTERN.test(key)) problems.push(`${where} "${key}" is neither EFT text (starting with a [Hull, Fit name] header) nor a fit key (${FIT_KEY_RULE})`);
    else if (fits?.[key] == null) problems.push(`${where} "${key}" is not a key of the scene's fits`);
    else fit = key;
  }
  const text = fit == null ? null : (fits?.[fit] ?? fit);
  const hull = text ? readEftHeader(text)?.hull : null;
  if (hull && typeof type === 'string' && type.trim().toLowerCase() !== hull.toLowerCase()) {
    warnings.push(`${where}: the fit is for a ${hull}, but the ship's type is "${type}"; the ship flies as its type`);
  }
  return { fit, problems, warnings };
}

/**
 * A ship's fit text: its inline fit, or the text its key names.
 *
 * @param ship - The ship.
 * @param scene - The document, for its fits.
 * @returns The EFT text, or null when the ship has no fit (or its key is missing).
 */
export function fitTextOf(ship: Maybe<{ readonly fit?: string }>, scene: Maybe<{ readonly fits?: Readonly<Record<string, string>> }>): Maybe<string> {
  const fit = ship?.fit;
  let text: Maybe<string> = null;
  if (fit != null) text = isInlineFit(fit) ? fit : (scene?.fits?.[fit] ?? null);
  return text;
}

/**
 * The prop mod a ship flies: its `propMod.module`; else, when it has a fit, the fit's first microwarpdrive or
 * afterburner ("none" when it fits none); else DEFAULT_PROP_MOD_MODULE (the hull-sized microwarpdrive).
 *
 * @param ship - The ship.
 * @param fitText - Its fit text (fitTextOf).
 * @returns The prop mod module.
 */
export function shipPropModModuleOf(ship: Maybe<{ readonly propMod?: { readonly module?: PropModModule } }>, fitText: Maybe<string>): PropModModule {
  let module: PropModModule = ship?.propMod?.module ?? DEFAULT_PROP_MOD_MODULE;
  if (ship?.propMod?.module == null && fitText) module = readEftPropMod(fitText) ?? PROP_MOD_MODULE_NONE;
  return module;
}
