import type { Maybe } from '@dereekb/util';
import { describe, expect, it } from 'vitest';
import { TICKS_PER_SECOND } from './clock';
import { TurretAudioPosts, TurretSoundQueue, type TurretAimTransition, type TurretShotSound, type TurretSoundFacts } from './turret-audio';
import { RoundTrip } from './state-capture.spec-helper';

const S = TICKS_PER_SECOND;

const AUTOCANNON: TurretSoundFacts = { fireEvents: ['ship_turret_sp3_play'], impactEvents: ['ship_impact_sp3_play'], deployEvent: 'turret_move_projectile_out_small', packEvent: 'turret_move_projectile_in_small' };
const PULSE: TurretSoundFacts = { fireEvents: ['ship_turret_se1_play'], impactEvents: ['ship_impact_se1_play'], deployEvent: 'turret_move_energy_out_small', packEvent: 'turret_move_energy_in_small' };

function Facts(ship: string, module: string): Maybe<TurretSoundFacts> {
  if (module === 'high-9') return null;
  return ship === 'punisher' ? PULSE : AUTOCANNON;
}

function Shot(extra: Partial<TurretShotSound> = {}): TurretShotSound {
  return { ship: 'rifter', module: 'high-0', target: 'punisher', targetKind: 'ship', tick: 10, at: 11 * S, ...extra };
}

function Transition(extra: Partial<TurretAimTransition> = {}): TurretAimTransition {
  return { ship: 'rifter', aim: 'targeting', modules: ['high-0', 'high-1', 'high-2'], tick: 10, at: 10 * S, ...extra };
}

describe('TurretAudioPosts', () => {
  it('posts the firing event on the shooter and the impact event on the ship it hits', () => {
    expect(TurretAudioPosts({ shots: [Shot()], transitions: [], facts: Facts })).toEqual([
      { ship: 'rifter', tick: 10, at: 11 * S, events: ['ship_turret_sp3_play'] },
      { ship: 'punisher', tick: 10, at: 11 * S, events: ['ship_impact_sp3_play'] }
    ]);
  });

  it('posts no impact on an object or for a miss', () => {
    const posts = TurretAudioPosts({ shots: [Shot({ target: 'astrahus', targetKind: 'object' }), Shot({ module: 'high-1', missed: true, at: 12 * S })], transitions: [], facts: Facts });
    expect(posts).toEqual([{ ship: 'rifter', tick: 10, at: 11 * S, events: ['ship_turret_sp3_play'] }]);
  });

  it('posts nothing for a weapon whose files have not loaded', () => {
    expect(TurretAudioPosts({ shots: [Shot({ module: 'high-9' })], transitions: [Transition({ modules: ['high-9'] })], facts: Facts })).toEqual([]);
  });

  it('deploys onto a target and packs when it has none', () => {
    const posts = TurretAudioPosts({ shots: [], transitions: [Transition(), Transition({ ship: 'punisher', aim: 'idle', modules: ['high-0'], at: 9 * S })], facts: Facts });
    expect(posts).toEqual([
      { ship: 'punisher', tick: 10, at: 9 * S, events: ['turret_move_energy_in_small'] },
      { ship: 'rifter', tick: 10, at: 10 * S, events: ['turret_move_projectile_out_small'] }
    ]);
  });

  it('posts each (ship, event) once, at the earliest burst', () => {
    const shots = [Shot({ at: 11.4 * S }), Shot({ module: 'high-1', at: 11.1 * S }), Shot({ module: 'high-2', at: 11.5 * S }), Shot({ ship: 'punisher', target: 'rifter', at: 11.2 * S })];
    expect(TurretAudioPosts({ shots, transitions: [], facts: Facts })).toEqual([
      { ship: 'rifter', tick: 10, at: 11.1 * S, events: ['ship_turret_sp3_play'] },
      { ship: 'punisher', tick: 10, at: 11.1 * S, events: ['ship_impact_sp3_play'] },
      { ship: 'punisher', tick: 10, at: 11.2 * S, events: ['ship_turret_se1_play'] },
      { ship: 'rifter', tick: 10, at: 11.2 * S, events: ['ship_impact_se1_play'] }
    ]);
  });
});

describe('TurretSoundQueue', () => {
  it('holds posts until their time and merges a frame into one post per ship', () => {
    const queue = new TurretSoundQueue();
    queue.Add(TurretAudioPosts({ shots: [Shot({ at: 11 * S }), Shot({ ship: 'punisher', target: 'rifter', at: 11.3 * S })], transitions: [], facts: Facts }));
    queue.Add(TurretAudioPosts({ shots: [Shot({ module: 'high-1', at: 11.2 * S })], transitions: [Transition({ at: 11.2 * S })], facts: Facts }));
    expect(queue.Due(10.9 * S)).toEqual([]);
    expect(queue.Due(11.25 * S)).toEqual([
      { ship: 'rifter', tick: 10, at: 11 * S, events: ['ship_turret_sp3_play', 'turret_move_projectile_out_small'] },
      { ship: 'punisher', tick: 10, at: 11 * S, events: ['ship_impact_sp3_play'] }
    ]);
    expect(queue.pending).toBe(2);
    expect(queue.Due(12 * S)).toEqual([
      { ship: 'punisher', tick: 10, at: 11.3 * S, events: ['ship_turret_se1_play'] },
      { ship: 'rifter', tick: 10, at: 11.3 * S, events: ['ship_impact_se1_play'] }
    ]);
  });

  it('forgets a ship that left, and everything on a load', () => {
    const queue = new TurretSoundQueue();
    queue.Add(TurretAudioPosts({ shots: [Shot()], transitions: [], facts: Facts }));
    queue.Forget('punisher');
    expect(queue.Due(20 * S).map((post) => post.ship)).toEqual(['rifter']);
    queue.Add(TurretAudioPosts({ shots: [Shot()], transitions: [], facts: Facts }));
    queue.Clear();
    expect(queue.pending).toBe(0);
  });
});

describe('TurretSoundQueue snapshots (sd-time)', () => {
  it('restores the queued posts', () => {
    const queue = new TurretSoundQueue();
    queue.Add(TurretAudioPosts({ shots: [Shot({ at: 11 * S }), Shot({ ship: 'punisher', target: 'rifter', at: 11.3 * S })], transitions: [], facts: Facts }));
    const trip = RoundTrip(
      queue,
      (q) => q.pending,
      (q) => {
        q.Due(11.25 * S);
        q.Forget('punisher');
      }
    );
    expect(trip.mutated).not.toEqual(trip.before);
    expect(trip.after).toEqual(trip.before);
    expect(trip.again).toEqual(trip.snapshot);
  });
});
