import { describe, expect, it } from 'vitest';
import { CycleEnd, ModuleCycle, type ModuleCycleEvent } from './module-cycle';

const TIMING = { cycleTicks: 10, reactivationTicks: 0 };

function Kinds(events: readonly ModuleCycleEvent[]): string[] {
  return events.map((event) => `${event.kind}${event.cycle}@${event.tick}`);
}

/**
 * Runs boundaries from `from` to `to` inclusive.
 */
function Run(cycle: ModuleCycle, from: number, to: number): string[] {
  const events: string[] = [];
  for (let tick = from; tick <= to; tick++) events.push(...Kinds(cycle.Boundary(tick)));
  return events;
}

describe('CycleEnd', () => {
  it("rounds the running cycle's end up to a tick", () => {
    expect(CycleEnd({ since: 100, boundary: 101, cycle: 10 })).toBe(110);
    expect(CycleEnd({ since: 100, boundary: 111, cycle: 10 })).toBe(120);
    expect(CycleEnd({ since: 100, boundary: 101, cycle: 7.5 })).toBe(108);
  });
});

describe('ModuleCycle', () => {
  it('activates at the next boundary, cycles, and stops at the end of its cycle', () => {
    const cycle = new ModuleCycle('online', TIMING);
    cycle.Request('active', { boundary: 100 });
    expect(cycle.Report(100, 1)).toEqual({ state: 'activating', at: 100 });
    expect(Run(cycle, 100, 100)).toEqual(['on1@100', 'cycle1@100']);
    expect(cycle.Report(104, 1)).toEqual({ state: 'active', cycle: { number: 1, endsIn: 6 } });
    expect(Run(cycle, 101, 110)).toEqual(['end1@110', 'cycle2@110']);
    cycle.Request('online', { boundary: 112 });
    expect(cycle.Report(112, 1)).toMatchObject({ state: 'stopping', stopsIn: 8 });
    expect(Run(cycle, 112, 120)).toEqual(['end2@120', 'off2@120']);
    expect(cycle.state).toBe('online');
  });

  it('fires a cycle boundary between ticks at the next tick, and cancels a stop when asked active again', () => {
    const cycle = new ModuleCycle('online', { cycleTicks: 7.5, reactivationTicks: 0 });
    cycle.Request('active', { boundary: 0 });
    expect(Run(cycle, 0, 15)).toEqual(['on1@0', 'cycle1@0', 'end1@8', 'cycle2@8', 'end2@15', 'cycle3@15']);
    cycle.Request('online', { boundary: 16 });
    cycle.Request('active', { boundary: 17 });
    expect(cycle.state).toBe('active');
    expect(Run(cycle, 16, 23)).toEqual(['end3@23', 'cycle4@23']);
  });

  it('waits out the reactivation delay, queueing an activation until it is ready', () => {
    const cycle = new ModuleCycle('online', { cycleTicks: 5, reactivationTicks: 30 });
    cycle.Request('active', { boundary: 0 });
    Run(cycle, 0, 0);
    cycle.Request('online', { boundary: 1 });
    expect(Run(cycle, 1, 5)).toEqual(['end1@5', 'off1@5']);
    expect(cycle.Report(5, 1)).toEqual({ state: 'reactivating', readyIn: 30 });
    cycle.Request('active', { boundary: 6 });
    expect(cycle.Report(6, 1)).toEqual({ state: 'reactivating', readyIn: 29, activatesIn: 29 });
    expect(Run(cycle, 6, 35)).toEqual(['on1@35', 'cycle1@35']);
  });

  it('onlines and activates an offline module at one boundary, and takes a running one offline after its cycle', () => {
    const cycle = new ModuleCycle('offline', TIMING);
    cycle.Request('active', { boundary: 10 });
    expect(Run(cycle, 10, 10)).toEqual(['on1@10', 'cycle1@10']);
    cycle.Request('offline', { boundary: 12 });
    expect(Run(cycle, 12, 20)).toEqual(['end1@20', 'off1@20']);
    expect(cycle.state).toBe('offline');
    cycle.Request('online', { boundary: 21 });
    expect(cycle.state).toBe('offline');
    Run(cycle, 21, 21);
    expect(cycle.state).toBe('online');
    cycle.Request('offline', { boundary: 22 });
    Run(cycle, 22, 22);
    expect(cycle.state).toBe('offline');
  });

  it('makes a delayed switch at its boundary, and stops at once with a reason', () => {
    const cycle = new ModuleCycle('online', TIMING);
    cycle.Request('active', { boundary: 0, delay: 3 });
    expect(cycle.Report(0, 1)).toEqual({ state: 'online', respondsIn: 3 });
    expect(Run(cycle, 0, 3)).toEqual(['on1@3', 'cycle1@3']);
    expect(Kinds(cycle.StopNow(5, 'entered warp'))).toEqual(['off1@5']);
    expect(cycle.Report(5, 1)).toEqual({ state: 'online', note: 'stopped: entered warp' });
    cycle.Request('active', { boundary: 6 });
    expect(cycle.StopNow(6, 'its target is gone')).toEqual([]);
    expect(cycle.Report(6, 1)).toEqual({ state: 'online', note: 'not started: its target is gone' });
  });

  it('stops at the cycle end when told to (a target out of range)', () => {
    const cycle = new ModuleCycle('online', TIMING);
    cycle.Request('active', { boundary: 0 });
    Run(cycle, 0, 2);
    cycle.StopAtCycleEnd(3, 'its target is out of range');
    expect(cycle.Report(3, 1)).toEqual({ state: 'stopping', cycle: { number: 1, endsIn: 7 }, stopsIn: 7, note: 'stopping: its target is out of range' });
    expect(Run(cycle, 3, 10)).toEqual(['end1@10', 'off1@10']);
  });
});
