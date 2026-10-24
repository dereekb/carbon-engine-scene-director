import { describe, expect, it } from 'vitest';
import { type CueTrigger, cueEventDueSecond, cueTriggerMatches, cueTriggerReferences, describeCueTrigger, describeTimelineEvent, MAX_EVENT_COUNT, normalizeCueTrigger, resolveCueTrigger, type TimelineEvent, type TimelineEventEntry } from './events';

function trigger(input: unknown): CueTrigger {
  const read = normalizeCueTrigger(input, 'when');
  expect(read.problems).toEqual([]);
  return read.trigger as CueTrigger;
}

function problems(input: unknown): string {
  return normalizeCueTrigger(input, 'when').problems.join('\n');
}

const kill = (victim: string, extra: Partial<Extract<TimelineEvent, { kind: 'kill' }>> = {}): TimelineEvent => ({ kind: 'kill', victim: { ship: victim, team: 'red', fleet: 'red', wing: 'rw', squad: 'rs' }, ...extra });

describe('normalizeCueTrigger', () => {
  it('reads every kind and filter key, dropping default options', () => {
    expect(trigger({ kill: {} })).toEqual({ kill: {} });
    expect(trigger({ kill: { ship: 'a', team: 'red', fleet: 'red', squad: 'rs', primary: 'blue', by: { team: 'blue' } }, count: 1, after: 0 })).toEqual({ kill: { ship: 'a', team: 'red', fleet: 'red', squad: 'rs', primary: 'blue', by: { team: 'blue' } } });
    expect(trigger({ arrival: { fleet: 'red', ship: 'r1', phase: 'formed' }, count: 2, after: 1.5, latest: 70 })).toEqual({ arrival: { fleet: 'red', ship: 'r1', phase: 'formed' }, count: 2, after: 1.5, latest: 70 });
    expect(trigger({ warp: { ship: 'a', phase: 'enter', arrival: false } })).toEqual({ warp: { ship: 'a', phase: 'enter', arrival: false } });
    expect(trigger({ cue: 'go', after: 3 })).toEqual({ cue: 'go', after: 3 });
    expect(trigger({ primary: { fleet: 'blue', wing: 'w1', ship: 'red-fc' } })).toEqual({ primary: { fleet: 'blue', wing: 'w1', ship: 'red-fc' } });
    expect(trigger({ fire: { team: 'red', target: { ship: 'blue-fc' } } })).toEqual({ fire: { team: 'red', target: { ship: 'blue-fc' } } });
  });

  it('refuses every bad input together', () => {
    expect(problems('kill')).toMatch(/when must be an object/);
    expect(problems({})).toMatch(/needs exactly one event kind/);
    expect(problems({ kill: {}, cue: 'go' })).toMatch(/needs exactly one event kind .*got kill, cue/);
    expect(problems({ landed: 'red' })).toMatch(/when\.landed is not an event kind/);
    const all = problems({ kill: { ship: 'bad id!', planet: 'x', wing: 'w1', squad: 's1' }, count: 0, after: -1, latest: 'soon' });
    expect(all).toMatch(/kill\.ship must be an id/);
    expect(all).toMatch(/kill\.planet is not a kill filter key/);
    expect(all).toMatch(/give wing or squad, not both/);
    expect(all).toMatch(/a wing or squad needs its fleet/);
    expect(all).toMatch(/count must be a whole number in \[1, 1000\]/);
    expect(all).toMatch(/after must be seconds/);
    expect(all).toMatch(/latest must be timeline seconds/);
    expect(problems({ arrival: { phase: 'warping' } })).toMatch(/arrival\.phase must be one of first, landed, formed/);
    expect(problems({ warp: { arrival: 'yes' } })).toMatch(/warp\.arrival must be true or false/);
    expect(problems({ primary: {} })).toMatch(/primary\.fleet is required/);
    expect(problems({ fire: { target: { planet: 'x' } } })).toMatch(/fire\.target\.planet is not a filter key/);
    expect(problems({ cue: 5 })).toMatch(/when\.cue must be a cue id/);
    expect(problems({ kill: {}, count: MAX_EVENT_COUNT + 1 })).toMatch(/count must be/);
  });

  it('lists the filter references and the chained cue', () => {
    expect(cueTriggerReferences(trigger({ kill: { ship: 'a', fleet: 'red', squad: 'rs', primary: 'blue', by: { team: 'blue' } } })).references.map((reference) => [reference.kind, reference.id, reference.path])).toEqual([
      ['ship', 'a', 'kill.ship'],
      ['fleet', 'red', 'kill.fleet'],
      ['squad', 'rs', 'kill.squad'],
      ['team', 'blue', 'kill.by.team'],
      ['fleet', 'blue', 'kill.primary']
    ]);
    expect(cueTriggerReferences(trigger({ cue: 'go' }))).toEqual({ references: [], cue: 'go' });
    expect(cueTriggerReferences(trigger({ primary: { fleet: 'blue', ship: 'red-fc' } })).references.map((reference) => reference.kind)).toEqual(['fleet', 'target']);
  });
});

describe('cueTriggerMatches', () => {
  it('matches kills by victim, group, called primary and killer', () => {
    expect(cueTriggerMatches(trigger({ kill: {} }), kill('r1'))).toBe(true);
    expect(cueTriggerMatches(trigger({ kill: { ship: 'r2' } }), kill('r1'))).toBe(false);
    expect(cueTriggerMatches(trigger({ kill: { fleet: 'red', squad: 'rs' } }), kill('r1'))).toBe(true);
    expect(cueTriggerMatches(trigger({ kill: { primary: 'blue' } }), kill('r1'))).toBe(false);
    expect(cueTriggerMatches(trigger({ kill: { primary: 'blue' } }), kill('r1', { primaryOf: ['blue'] }))).toBe(true);
    expect(cueTriggerMatches(trigger({ kill: { by: { team: 'blue' } } }), kill('r1'))).toBe(false);
    expect(cueTriggerMatches(trigger({ kill: { by: { team: 'blue' } } }), kill('r1', { killer: { ship: 'b1', team: 'blue' } }))).toBe(true);
    expect(cueTriggerMatches(trigger({ arrival: {} }), kill('r1'))).toBe(false);
  });

  it('matches arrivals, warps, cues, primaries and opened fire', () => {
    const landed: TimelineEvent = { kind: 'arrival', group: 'red', fleet: 'red', phase: 'landed', ships: ['r1', 'r2'] };
    expect(cueTriggerMatches(trigger({ arrival: { fleet: 'red' } }), landed)).toBe(true);
    expect(cueTriggerMatches(trigger({ arrival: { ship: 'r2', phase: 'landed' } }), landed)).toBe(true);
    expect(cueTriggerMatches(trigger({ arrival: { fleet: 'red', phase: 'first' } }), landed)).toBe(false);
    const exit: TimelineEvent = { kind: 'warp', ship: { ship: 'r1', team: 'red' }, phase: 'exit', arrival: true };
    expect(cueTriggerMatches(trigger({ warp: { team: 'red' } }), exit)).toBe(true);
    expect(cueTriggerMatches(trigger({ warp: { team: 'red', arrival: false } }), exit)).toBe(false);
    expect(cueTriggerMatches(trigger({ warp: { phase: 'enter' } }), exit)).toBe(false);
    expect(cueTriggerMatches(trigger({ cue: 'go' }), { kind: 'cue', cue: 'go', state: 'fired' })).toBe(true);
    expect(cueTriggerMatches(trigger({ cue: 'go' }), { kind: 'cue', cue: 'go', state: 'skipped' })).toBe(false);
    const call: TimelineEvent = { kind: 'primary', fleet: 'blue', primary: 'red-fc', previous: null };
    expect(cueTriggerMatches(trigger({ primary: { fleet: 'blue' } }), call)).toBe(true);
    expect(cueTriggerMatches(trigger({ primary: { fleet: 'blue', ship: 'red-1' } }), call)).toBe(false);
    expect(cueTriggerMatches(trigger({ primary: { fleet: 'blue' } }), { ...call, squad: 's1' })).toBe(false);
    expect(cueTriggerMatches(trigger({ primary: { fleet: 'blue', squad: 's1' } }), { ...call, wing: 'w1', squad: 's1' })).toBe(true);
    const fire: TimelineEvent = { kind: 'fire', shooter: { ship: 'r1', team: 'red' }, target: { ship: 'b1', team: 'blue' } };
    expect(cueTriggerMatches(trigger({ fire: { team: 'red', target: { ship: 'b1' } } }), fire)).toBe(true);
    expect(cueTriggerMatches(trigger({ fire: { team: 'blue' } }), fire)).toBe(false);
  });
});

describe('resolveCueTrigger', () => {
  const entry = (second: number, event: TimelineEvent): TimelineEventEntry => ({ second, event, text: describeTimelineEvent(event) });
  const log = [entry(3, kill('r1')), entry(5, kill('r2')), entry(9, kill('r3'))];

  it('is due max(1, ceil(after)) seconds after the event, never in its own tick', () => {
    expect(cueEventDueSecond(5, 0)).toBe(6);
    expect(cueEventDueSecond(5, 0.2)).toBe(6);
    expect(cueEventDueSecond(5, 2.5)).toBe(8);
  });

  it('counts the nth match at or after arms', () => {
    expect(resolveCueTrigger({ trigger: trigger({ kill: {} }), arms: 0 }, log)).toEqual({ matched: 1, due: 4, event: { second: 3, text: 'r1 destroyed' } });
    expect(resolveCueTrigger({ trigger: trigger({ kill: {}, count: 2, after: 2 }), arms: 4 }, log)).toEqual({ matched: 2, due: 11, event: { second: 9, text: 'r3 destroyed' } });
    expect(resolveCueTrigger({ trigger: trigger({ kill: {}, count: 3 }), arms: 0 }, log, 2)).toEqual({ matched: 2 });
  });

  it('honours latest: due then when its event has not come before it', () => {
    expect(resolveCueTrigger({ trigger: trigger({ kill: { ship: 'never' }, latest: 30 }), arms: 0 }, log)).toEqual({ matched: 0, due: 30, late: true });
    expect(resolveCueTrigger({ trigger: trigger({ kill: { ship: 'r3' }, latest: 9 }), arms: 0 }, log)).toEqual({ matched: 0, due: 9, late: true });
    expect(resolveCueTrigger({ trigger: trigger({ kill: { ship: 'r3' }, latest: 9.5 }), arms: 0 }, log).due).toBe(10);
  });
});

describe('describeCueTrigger', () => {
  it('says what the cue waits for', () => {
    expect(describeCueTrigger(trigger({ kill: {} }))).toBe('the 1st kill');
    expect(describeCueTrigger(trigger({ kill: { team: 'red' }, count: 2 }))).toBe('the 2nd kill of a ship on team red');
    expect(describeCueTrigger(trigger({ kill: { primary: 'blue' } }))).toBe("the kill of blue's called primary");
    expect(describeCueTrigger(trigger({ kill: { ship: 'blue-fc' }, latest: 70 }))).toBe('the kill of blue-fc, at 70 s at the latest');
    expect(describeCueTrigger(trigger({ arrival: { fleet: 'red' }, after: 2 }))).toBe('fleet red landed + 2 s');
    expect(describeCueTrigger(trigger({ arrival: { fleet: 'red', phase: 'first' } }))).toBe("fleet red's first landing");
    expect(describeCueTrigger(trigger({ warp: { ship: 'red-fc' } }))).toBe("red-fc's warp exit");
    expect(describeCueTrigger(trigger({ cue: 'go' }))).toBe('cue go fired');
    expect(describeCueTrigger(trigger({ primary: { fleet: 'blue', ship: 'red-fc' } }))).toBe('blue calling red-fc');
    expect(describeCueTrigger(trigger({ fire: { team: 'red' } }))).toBe('team red opening fire');
    expect(describeCueTrigger(trigger({ kill: {}, count: 11 }))).toBe('the 11th kill');
  });
});
