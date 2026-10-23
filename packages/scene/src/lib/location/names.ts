import type { Maybe } from '@dereekb/util';
import type { MapCelestial } from './map';

const STAR_WORDS = new Set(['star', 'sun', 'the star', 'the sun']);
const GATE_TO_PATTERN = /^(?:the )?(?:star)?gate\s*(?:to )?\(?(.+?)\)?$/u;
const GATE_NAMED_PATTERN = /^(?:the )?(.+?) (?:star)?gate$/u;

/**
 * Which rule of matchCelestialName matched.
 */
export type CelestialMatchRule = 'exact' | 'prefixed' | 'star' | 'gate' | 'substring';

export type CelestialMatch<T extends MapCelestial = MapCelestial> = Maybe<{ readonly celestial: T; readonly rule: CelestialMatchRule } | { readonly candidates: T[] }>;

export interface MatchCelestialNameInput<T extends MapCelestial = MapCelestial> {
  readonly celestials: readonly T[];
  readonly text: string;
  readonly systemName: string;
}

/**
 * A name as the resolver compares it: NFKC, trimmed, single spaces, lower case.
 *
 * @param text - The name.
 * @returns Its comparable form.
 */
export function normalizeMapName(text: string): string {
  return text.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLowerCase();
}

/**
 * Which of a system's celestials a name means. The first rule that matches wins: the exact name; the system-prefixed
 * name ("IV - Moon 4" in Jita is "Jita IV - Moon 4", "Star" is "Jita - Star"); a star word ("star", "the sun"); a
 * gate shorthand ("Perimeter gate", "the gate to Perimeter"); a unique substring (after a leading "at" or "the").
 *
 * @param input - The system's celestials and name, and the text.
 * @returns The celestial and the rule, the candidates when a substring matches several, or null.
 */
export function matchCelestialName<T extends MapCelestial>(input: MatchCelestialNameInput<T>): CelestialMatch<T> {
  const { celestials } = input;
  const text = normalizeMapName(input.text);
  const bare = text.replace(/^at /u, '').replace(/^the /u, '');
  const system = normalizeMapName(input.systemName);
  const named = (name: string) => celestials.find((celestial) => normalizeMapName(celestial.name) === name);

  let match: CelestialMatch<T> = null;
  const exact = named(text) ?? named(bare);
  const prefixed = [text, bare]
    .flatMap((part) => [`${system} ${part}`, `${system} - ${part}`])
    .map(named)
    .find((celestial) => celestial != null);
  const gate = (GATE_TO_PATTERN.exec(text) ?? GATE_NAMED_PATTERN.exec(text))?.[1];
  const gateName = gate ? `stargate (${gate.trim()})` : null;
  const star = STAR_WORDS.has(text) ? celestials.find((celestial) => celestial.kind === 'star') : undefined;
  const gated = gateName ? celestials.find((celestial) => celestial.kind === 'stargate' && normalizeMapName(celestial.name) === gateName) : undefined;
  if (exact) match = { celestial: exact, rule: 'exact' };
  else if (prefixed) match = { celestial: prefixed, rule: 'prefixed' };
  else if (star) match = { celestial: star, rule: 'star' };
  else if (gated) match = { celestial: gated, rule: 'gate' };
  else if (bare) {
    const found = celestials.filter((celestial) => normalizeMapName(celestial.name).includes(bare));
    if (found.length === 1) match = { celestial: found[0], rule: 'substring' };
    else if (found.length > 1) match = { candidates: found };
  }
  return match;
}
