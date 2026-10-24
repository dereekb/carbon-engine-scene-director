import { describe, expect, it } from 'vitest';
import { EMPTY_FLEET_BRAIN_MEMORY, type FleetBrainMemory, type FleetBrainStepInput, MAX_FLEET_DECISIONS, stepFleetBrain } from './brain';
import { hostile, member, personality, picture } from './personalities.spec-helper';
import type { FleetPicture } from './picture';

const line = personality('line');

function step(extra: Partial<FleetBrainStepInput> & { readonly picture: FleetPicture }) {
  return stepFleetBrain({ personality: line, memory: EMPTY_FLEET_BRAIN_MEMORY, tick: 100, readyAt: 90, seed: 42, ...extra });
}

/**
 * Steps the brain each tick from `from` until it acts on a lever, the picture unchanged.
 */
function ticksUntil(input: Omit<FleetBrainStepInput, 'tick' | 'memory'>, lever: string, from = 100): number {
  let memory: FleetBrainMemory = EMPTY_FLEET_BRAIN_MEMORY;
  let tick = from;
  let acted = -1;
  while (acted < 0 && tick < from + 30) {
    const result = stepFleetBrain({ ...input, memory, tick });
    if (result.actions.some((action) => action.lever === lever)) acted = tick - from;
    memory = result.memory;
    tick += 1;
  }
  return acted;
}

describe('stepFleetBrain', () => {
  const fight = picture({ hostiles: [hostile('d1', 5000), hostile('l1', 25_000, { role: 'logi' })], propMods: 'on' });

  it('an able FC calls, turns free fire on and moves in the same step, as tool calls', () => {
    const { actions, memory } = step({ picture: fight });
    expect(actions.map((action) => action.lever)).toEqual(['call', 'free-fire', 'move', 'prop-mods']);
    expect(actions[0]).toMatchObject({ tool: 'order_fleet', args: { fleet: 'f', by: 'fc', order: { type: 'targets', set: ['l1', 'd1'] } } });
    expect(actions[1].args).toEqual({ fleet: 'f', by: 'fc', order: { type: 'free-fire', on: true } });
    expect(actions[2].args).toEqual({ fleet: 'f', by: 'fc', order: { type: 'keep-at-range', target: 'l1', range: 30_000, speed: 1 } });
    expect(actions[3]).toMatchObject({ tool: 'switch_prop_mods', args: { fleet: 'f', active: false } });
    expect(memory.engaged).toBe(true);
    expect(memory.engagedBy).toBe('d1 within 30 km');
    expect(memory.decisions.map((decision) => decision.tick)).toEqual([100, 100, 100, 100]);
    expect(memory.pending).toEqual([]);
  });

  it('with calls off it makes no call and clears its own once; free fire still goes on', () => {
    const quiet = { ...line, targeting: { ...line.targeting, calls: false } };
    const fresh = step({ picture: fight, personality: quiet });
    expect(fresh.actions.map((action) => action.lever)).toEqual(['free-fire', 'move', 'prop-mods']);
    const called = step({ picture: picture({ ...fight, call: ['l1'] }), personality: quiet, memory: { ...EMPTY_FLEET_BRAIN_MEMORY, engaged: true } });
    expect(called.actions[0]).toMatchObject({ lever: 'call', args: { order: { type: 'targets', clear: true } }, why: expect.stringMatching(/calls are off/) });
    expect(step({ picture: picture({ ...fight, call: ['l1'] }), personality: quiet, held: true }).actions.some((action) => action.lever === 'call')).toBe(false);
  });

  it('turns free fire off when its personality has none, unless the lever is manual or the fleet held', () => {
    const noFree = { ...line, targeting: { ...line.targeting, freeFire: false } };
    const on = picture({ ...fight, freeFire: true });
    expect(step({ picture: on, personality: noFree }).actions.find((action) => action.lever === 'free-fire')?.args).toEqual({ fleet: 'f', by: 'fc', order: { type: 'free-fire', on: false } });
    expect(step({ picture: on, personality: noFree, manual: ['free-fire'] }).actions.some((action) => action.lever === 'free-fire')).toBe(false);
    expect(step({ picture: on, personality: noFree, held: true }).actions.some((action) => action.lever === 'free-fire')).toBe(false);
    expect(step({ picture: picture({ ...fight, freeFire: false }), personality: noFree }).actions.some((action) => action.lever === 'free-fire')).toBe(false);
  });

  it('does nothing once the fleet already does what it wants', () => {
    const settled = picture({ ...fight, call: ['l1', 'd1'], freeFire: true, order: { type: 'keep-at-range', target: 'l1', range: 30_000, speed: 1 }, propMods: 'off' });
    expect(step({ picture: settled, memory: { ...EMPTY_FLEET_BRAIN_MEMORY, engaged: true } }).actions).toEqual([]);
  });

  it('an FC of ability 0 waits 5-10 s over a decision; ability 1 not at all', () => {
    const slow = picture({ ...fight, fc: { ship: 'fc', ability: 0 } });
    const wait = ticksUntil({ picture: slow, personality: line, readyAt: 90, seed: 42 }, 'call');
    expect(wait).toBeGreaterThanOrEqual(5);
    expect(wait).toBeLessThanOrEqual(10);
    expect(ticksUntil({ picture: fight, personality: line, readyAt: 90, seed: 42 }, 'call')).toBe(0);
    const pending = step({ picture: slow }).memory.pending;
    expect(pending.map((each) => each.lever)).toEqual(['call', 'free-fire', 'move', 'prop-mods']);
    expect(pending[0].due).toBe(100 + wait);
  });

  it('drops a pending decision whose want goes away', () => {
    const slow = picture({ ...fight, fc: { ship: 'fc', ability: 0 } });
    const first = step({ picture: slow });
    const solved = picture({ ...slow, call: ['l1', 'd1'] });
    const next = stepFleetBrain({ picture: solved, personality: line, memory: first.memory, tick: 101, readyAt: 90, seed: 42 });
    expect(next.memory.pending.map((each) => each.lever)).not.toContain('call');
  });

  it('leaves manual levers alone and makes no calls while held', () => {
    const manual = step({ picture: fight, manual: ['call', 'move'] }).actions.map((action) => action.lever);
    expect(manual).toEqual(['free-fire', 'prop-mods']);
    expect(step({ picture: fight, held: true }).actions.map((action) => action.lever)).toEqual(['move', 'prop-mods']);
  });

  it('decides nothing while leaderless and drops what was pending', () => {
    const slow = step({ picture: picture({ ...fight, fc: { ship: 'fc', ability: 0 } }) });
    const leaderless = step({ picture: picture({ ...fight, fc: null }), memory: slow.memory, tick: 101 });
    expect(leaderless.actions).toEqual([]);
    expect(leaderless.memory.pending).toEqual([]);
  });

  it('does not call before it engages: a defensive fleet waits to be shot', () => {
    const defensive = personality('defensive');
    const calm = picture({ ...fight, propMods: 'off' });
    const quiet = step({ picture: calm, personality: defensive });
    expect(quiet.actions).toEqual([]);
    expect(quiet.memory.engaged).toBe(false);
    const shot = picture({ ...calm, members: [member('fc', { role: 'fc', commands: ['fleet'] }), member('m1', { attackedBy: ['d1'] })] });
    const answered = step({ picture: shot, personality: defensive });
    expect(answered.memory.engaged).toBe(true);
    expect(answered.actions[0].args).toMatchObject({ order: { type: 'targets', set: ['l1', 'd1'] } });
  });

  it('a brawler closes with its prop mods on', () => {
    const brawler = personality('brawler');
    const far = picture({ hostiles: [hostile('t1', 50_000, { role: 'tackle' })] });
    const { actions } = step({ picture: far, personality: brawler });
    expect(actions.find((action) => action.lever === 'move')?.args).toMatchObject({ order: { type: 'keep-at-range', target: 't1', range: 20_000 } });
    expect(actions.find((action) => action.lever === 'prop-mods')?.args).toEqual({ fleet: 'f', active: true });
  });

  it('keeps the latest decisions only', () => {
    const decisions = Array.from({ length: MAX_FLEET_DECISIONS }, (_, index) => ({ tick: index, lever: 'call' as const, tool: 'order_fleet' as const, args: {}, why: 'old' }));
    const { memory } = step({ picture: fight, memory: { ...EMPTY_FLEET_BRAIN_MEMORY, decisions } });
    expect(memory.decisions).toHaveLength(MAX_FLEET_DECISIONS);
    expect(memory.decisions[MAX_FLEET_DECISIONS - 1].tick).toBe(100);
  });

  it('is deterministic: the same picture, memory, tick and seed decide the same; another seed may not', () => {
    const slow = picture({ ...fight, fc: { ship: 'fc', ability: 0.3 } });
    expect(step({ picture: slow })).toEqual(step({ picture: slow }));
    const dues = (seed: number) => step({ picture: slow, seed }).memory.pending.map((each) => each.due);
    const seeds = [1, 2, 3, 4, 5, 6].map((seed) => dues(seed).join(','));
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });
});
