import { MAX_SCENE_DISTANCE } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { makeFleetView } from './battle.spec-helper';
import { FleetCommandError, RETREAT_AWAY_DISTANCE, WARP_OUT_EXTENT_SHARE, clampWarpOutPoint, toFleetCommandCall } from './commands';

const blue = makeFleetView();
const red = makeFleetView({ id: 'red', team: 'red', fc: 'red-01', fcMotion: { position: [0, 0, 60000] } });

describe('toFleetCommandCall', () => {
  it('maps each button to one tool call', () => {
    expect(toFleetCommandCall({ command: 'engage', fleet: blue })).toEqual({ tool: 'order_fleet', args: { fleet: 'blue', order: { type: 'engage' } } });
    expect(toFleetCommandCall({ command: 'hold-position', fleet: blue }).args['order']).toEqual({ type: 'stance', set: { type: 'hold' } });
    expect(toFleetCommandCall({ command: 'pull-range', fleet: blue }).args['order']).toEqual({ type: 'stance', set: { type: 'kite', propMods: 'auto' } });
    expect(toFleetCommandCall({ command: 'pull-range', fleet: blue, range: 'falloff' }).args['order']).toEqual({ type: 'stance', set: { type: 'kite', range: 'falloff', propMods: 'auto' } });
    expect(toFleetCommandCall({ command: 'dive-close', fleet: blue }).args['order']).toEqual({ type: 'stance', set: { type: 'brawl', propMods: 'always' } });
    expect(toFleetCommandCall({ command: 'hold-fire', fleet: blue })).toEqual({ tool: 'cease_fire', args: { fleet: 'blue' } });
    expect(toFleetCommandCall({ command: 'call-primary', fleet: blue, target: 'red-01' }).args['order']).toEqual({ type: 'targets', primary: 'red-01', until: 'gone' });
    expect(toFleetCommandCall({ command: 'clear-call', fleet: blue }).args['order']).toEqual({ type: 'targets', clear: true, until: 'gone' });
  });

  it('retreats toward a named out, or away from the nearest enemy', () => {
    expect(toFleetCommandCall({ command: 'retreat', fleet: blue, retreat: 'Jita IV - Moon 4' }).args['order']).toEqual({ type: 'stance', set: { type: 'align', to: 'Jita IV - Moon 4', propMods: 'always' } });
    expect(toFleetCommandCall({ command: 'retreat', fleet: blue, fleets: [blue, red] }).args['order']).toEqual({ type: 'stance', set: { type: 'align', to: [0, 0, -RETREAT_AWAY_DISTANCE], propMods: 'always' } });
    expect(() => toFleetCommandCall({ command: 'retreat', fleet: blue, fleets: [blue] })).toThrow(/no enemy fleet to retreat from/);
  });

  it('warps out to a named out, a point clamped inside the extent, or away', () => {
    expect(toFleetCommandCall({ command: 'warp-out', fleet: blue, retreat: 'sun' }).args['order']).toEqual({ type: 'warp', target: 'sun' });
    expect(toFleetCommandCall({ command: 'warp-out', fleet: blue, retreat: [0, 0, 400000] }).args['order']).toEqual({ type: 'warp', point: [0, 0, 400000] });
    const far = toFleetCommandCall({ command: 'warp-out', fleet: blue, retreat: [0, 0, 50_000_000] }).args['order'] as { point: number[] };
    expect(far.point[2]).toBeCloseTo(MAX_SCENE_DISTANCE * WARP_OUT_EXTENT_SHARE);
    expect(toFleetCommandCall({ command: 'warp-out', fleet: blue, fleets: [red] }).args['order']).toEqual({ type: 'warp', point: [0, 0, -RETREAT_AWAY_DISTANCE] });
    expect(() => toFleetCommandCall({ command: 'warp-out', fleet: blue, retreat: [0, 0, 1000] })).toThrow(/too close to warp to/);
  });

  it('refuses while arriving, without a brain, or without a call target', () => {
    expect(() => toFleetCommandCall({ command: 'engage', fleet: makeFleetView({ arriving: 2 }) })).toThrow(FleetCommandError);
    expect(() => toFleetCommandCall({ command: 'engage', fleet: makeFleetView({ brain: null }) })).toThrow(/no FC brain/);
    expect(() => toFleetCommandCall({ command: 'call-primary', fleet: blue })).toThrow(/needs a target/);
  });
});

describe('clampWarpOutPoint', () => {
  it('keeps a point inside the extent and clamps one outside along the line from the FC', () => {
    const limit = MAX_SCENE_DISTANCE * WARP_OUT_EXTENT_SHARE;

    expect(clampWarpOutPoint([0, 0, 0], [100, 0, 0])).toEqual([100, 0, 0]);
    const clamped = clampWarpOutPoint([1_000_000, 0, 0], [1_000_000, 0, 20_000_000]);
    expect(Math.hypot(...clamped)).toBeCloseTo(limit);
    expect(clamped[0]).toBeCloseTo(1_000_000);
  });
});
