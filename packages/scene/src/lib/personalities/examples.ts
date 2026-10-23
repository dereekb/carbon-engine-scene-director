import ALPHA from './examples/alpha.json';
import BRAWLER from './examples/brawler.json';
import DEFENSIVE from './examples/defensive.json';
import GREEN from './examples/green.json';
import HEADHUNTER from './examples/headhunter.json';
import KITER from './examples/kiter.json';
import LINE from './examples/line.json';
import SNIPER from './examples/sniper.json';
import VETERAN from './examples/veteran.json';

/**
 * The built-in personalities, as written (builtInFleetPersonalities normalizes them). `line` is the complete root
 * every other extends; each description says when to pick it. The hub lists them read-only beside the saved ones.
 */
export const FLEET_PERSONALITY_EXAMPLES: readonly unknown[] = [LINE, BRAWLER, KITER, SNIPER, HEADHUNTER, ALPHA, GREEN, VETERAN, DEFENSIVE];

/**
 * The built-ins' names, in library order.
 */
export const BUILT_IN_FLEET_PERSONALITY_NAMES: readonly string[] = [LINE, BRAWLER, KITER, SNIPER, HEADHUNTER, ALPHA, GREEN, VETERAN, DEFENSIVE].map((example) => example.id);
