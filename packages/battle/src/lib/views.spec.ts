import { describe, expect, it } from 'vitest';
import { makeFleetView } from './battle.spec-helper';
import { fleetCommandsBlocked, formatDistance, toFleetCardView, toFleetTargetRows } from './views';

describe('toFleetCardView', () => {
  it('shows the brain, the alive count, HP and the commands', () => {
    const card = toFleetCardView(makeFleetView());

    expect(card).toMatchObject({ title: 'blue', stateText: 'commanding (blue-fc)', aliveText: '4/4 alive', healthPercent: 80, primary: 'red-02', engaged: true, commandsBlocked: null, offerDoctrine: false });
  });

  it('blocks commands while arriving and offers a doctrine without a brain', () => {
    expect(toFleetCardView(makeFleetView({ arriving: 3 })).aliveText).toBe('4/4 alive, 3 arriving');
    expect(fleetCommandsBlocked(makeFleetView({ arriving: 3 }))).toMatch(/arriving/);
    expect(toFleetCardView(makeFleetView({ brain: null }))).toMatchObject({ stateText: 'no FC brain', offerDoctrine: true });
    expect(toFleetCardView(makeFleetView({ brain: { personality: 'line', state: 'handover', engaged: true, stance: 'brawl', manual: [], held: false, successor: 'blue-02', takesOverIn: 2.2 } })).stateText).toBe('handover to blue-02 in 3 s');
  });
});

describe('toFleetTargetRows', () => {
  it('lists the ranked hostiles with their call', () => {
    expect(toFleetTargetRows(makeFleetView())).toEqual([
      { id: 'red-02', role: 'dps', distanceText: '25.3 km', healthPercent: 50, dps: 120, inReach: true, called: 'primary' },
      { id: 'red-01', role: 'fc', distanceText: '140 km', healthPercent: 100, dps: 80, inReach: false, called: null }
    ]);
    expect(toFleetTargetRows(makeFleetView(), 1)).toHaveLength(1);
  });

  it('formats distances', () => {
    expect(formatDistance(850.4)).toBe('850 m');
    expect(formatDistance(12_345)).toBe('12.3 km');
  });
});
