/**
 * Turret sounds, named by the files themselves (turret-plan.ts TurretFileFacts): the firing effect's `PlayTurretFX`
 * events on the shooter and its `PlayTurretImpact` events on a ship it hits, as each burst starts; the set's movement
 * events as a ship's guns deploy onto a target (a first one or a new one) and pack away when it has none.
 *
 * - The sets and their firing effects hydrate with their own audio cut (turrets.ts), so these posts are the only turret
 *   sounds that play. They go through PageAudio.Post on the ship's own emitter, the one its prop mod and module sounds
 *   use; the runtime culls each emitter at its playing events' largest radius (`ship_turret_*` 150-260 km,
 *   `ship_impact_*` 10-28.5 km or unbounded, `turret_move_*` 2.5-4.3 km, XL 36 km).
 * - A burst starts after its set's random firing delay (up to 0.6 s), so its sounds post then, not at the draw: the
 *   client's AudEventCurves sit at t = 0 of the effect's `play_start`, which plays from minus that delay.
 * - One post per (ship, event) per batch, at the earliest time any of its sources asks for, and one per (ship, event)
 *   per frame (TurretSoundQueue.Due), however many sets fire together.
 * - A missed shot (Combat rules' `missed`) plays no impact; an object target has no emitter, so no impact either.
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { Maybe } from '@dereekb/util';
import type { ShotTargetKind } from '@scene-director/scene';
import type { TurretFileFacts } from './turret-plan';

/**
 * The sound events of one weapon module's files.
 */
export type TurretSoundFacts = Pick<TurretFileFacts, 'fireEvents' | 'impactEvents' | 'deployEvent' | 'packEvent'>;

/**
 * A drawn shot: its burst starts at `at`.
 */
export interface TurretShotSound {
  readonly ship: string;
  readonly module: string;
  readonly target: string;
  readonly targetKind: ShotTargetKind;
  readonly missed?: boolean;
  /**
   * The Destiny tick of the boundary that raised it.
   */
  readonly tick: number;
  /**
   * When the burst starts, scene clock (100 ns ticks): the draw plus the set's random firing delay.
   */
  readonly at: number;
}

/**
 * A ship's guns changing aim: `targeting` when it takes a target (a first one or a new one; the client's
 * SetTargetObject posts the deploy event for both), `idle` when it loses its target.
 */
export interface TurretAimTransition {
  readonly ship: string;
  readonly aim: 'targeting' | 'idle';
  /**
   * Its weapon modules' keys.
   */
  readonly modules: readonly string[];
  readonly tick: number;
  /**
   * Scene clock, 100 ns ticks.
   */
  readonly at: number;
}

export interface TurretAudioInput {
  readonly shots: readonly TurretShotSound[];
  readonly transitions: readonly TurretAimTransition[];
  /**
   * A ship's weapon module's sound events; null while its files load or when it has none.
   */
  readonly facts: (ship: string, module: string) => Maybe<TurretSoundFacts>;
}

/**
 * Events to post on a ship's emitter at `at`.
 */
export interface TurretAudioPost {
  /**
   * The ship whose emitter posts: the shooter, or the ship hit.
   */
  readonly ship: string;
  readonly tick: number;
  /**
   * Scene clock, 100 ns ticks.
   */
  readonly at: number;
  readonly events: readonly string[];
}

/**
 * The sounds a batch of drawn shots and aim transitions posts.
 *
 * @param input - The shots, the transitions and each weapon's sound events.
 * @returns The posts, one per (ship, time), in time order; each (ship, event) once, at its earliest time.
 */
export function TurretAudioPosts(input: TurretAudioInput): TurretAudioPost[] {
  const wanted = new Map<string, { ship: string; event: string; tick: number; at: number }>();
  const want = (ship: string, events: readonly Maybe<string>[], tick: number, at: number): void => {
    for (const event of events) {
      if (!event) continue;
      const key = `${ship} ${event}`;
      const previous = wanted.get(key);
      if (!previous || at < previous.at) wanted.set(key, { ship, event, tick, at });
    }
  };
  for (const shot of input.shots) {
    const facts = input.facts(shot.ship, shot.module);
    if (!facts) continue;
    want(shot.ship, facts.fireEvents, shot.tick, shot.at);
    if (shot.targetKind === 'ship' && shot.missed !== true) want(shot.target, facts.impactEvents, shot.tick, shot.at);
  }
  for (const transition of input.transitions) {
    for (const module of transition.modules) {
      const facts = input.facts(transition.ship, module);
      if (facts) want(transition.ship, [transition.aim === 'targeting' ? facts.deployEvent : facts.packEvent], transition.tick, transition.at);
    }
  }
  return GroupPosts([...wanted.values()]).sort((a, b) => a.at - b.at);
}

/**
 * Turret sound posts waiting for their time.
 */
export class TurretSoundQueue {
  private queued: TurretAudioPost[] = [];

  Add(posts: readonly TurretAudioPost[]): void {
    if (!posts.length) return;
    this.queued.push(...posts);
    this.queued.sort((a, b) => a.at - b.at);
  }

  /**
   * Takes the posts due by `now`, one per ship, each event once.
   *
   * @param now - The scene clock, 100 ns ticks.
   * @returns The posts, in the order their ships first fell due.
   */
  Due(now: number): TurretAudioPost[] {
    let count = 0;
    while (count < this.queued.length && this.queued[count].at <= now) count++;
    const due = this.queued.splice(0, count);
    return GroupPosts(
      due.flatMap((post) => post.events.map((event) => ({ ship: post.ship, event, tick: post.tick, at: post.at }))),
      (post) => post.ship
    );
  }

  /**
   * Posts not due yet.
   */
  get pending(): number {
    return this.queued.length;
  }

  /**
   * Drops the posts on a ship that left the scene.
   *
   * @param ship - The ship id.
   */
  Forget(ship: string): void {
    this.queued = this.queued.filter((post) => post.ship !== ship);
  }

  /**
   * Forgets everything (a load).
   */
  Clear(): void {
    this.queued = [];
  }
}

/**
 * Groups single events into posts, each (ship, event) once.
 *
 * @param items - The events, in order.
 * @param keyOf - What one post groups by; (ship, time) by default.
 * @returns The posts, in first-seen order; a post keeps its first item's tick and time.
 */
function GroupPosts(items: readonly { ship: string; event: string; tick: number; at: number }[], keyOf: (item: { ship: string; at: number }) => string = (item) => `${item.ship} ${item.at}`): TurretAudioPost[] {
  const posts = new Map<string, { ship: string; tick: number; at: number; events: string[] }>();
  for (const item of items) {
    const key = keyOf(item);
    const post = posts.get(key) ?? { ship: item.ship, tick: item.tick, at: item.at, events: [] };
    if (!post.events.includes(item.event)) post.events.push(item.event);
    posts.set(key, post);
  }
  return [...posts.values()];
}
