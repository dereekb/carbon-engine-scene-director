import { turretHitChance } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { DestinyWorld, FIRST_SHIP_BALL_ID } from './destiny';

// The Rifter's 200mm AutoCannon II at max skills (plan §1.3) on a Punisher's signature.
const GUN = { optimal: 750, falloff: 9675, tracking: 393.75, signatureRadius: 37, signatureResolution: 40_000 };

/**
 * Two ships on both parks, `b` 5 km off `a` moving sideways at `speed` m/s.
 */
function World(speed: number, offset = 5000): DestinyWorld {
  const world = new DestinyWorld();
  world.AddShip({ id: 'a', position: [0, 0, 0], rotation: [0, 0, 0] });
  world.AddShip({ id: 'b', position: [0, 0, offset], rotation: [0, 0, 0] });
  for (const park of [world.master, world.replica]) park.SetBallVelocity(FIRST_SHIP_BALL_ID + 1, speed, 0, 0);
  return world;
}

describe('DestinyWorld.Accuracy', () => {
  it("equals the package's turretHitChance for the same geometry", () => {
    const world = World(400);
    const accuracy = world.Accuracy('a', 'b', GUN);
    const distance = world.SurfaceDistance('a', 'b') ?? 0;
    expect(accuracy?.distance).toBeCloseTo(distance, 9);
    expect(accuracy?.angularVelocity).toBeCloseTo(400 / 5000, 12);
    expect(accuracy?.chance).toBeCloseTo(turretHitChance({ ...GUN, angularVelocity: 400 / 5000, distance }), 9);
    expect(world.master.GetBall(FIRST_SHIP_BALL_ID + 1)?.vx).toBe(world.replica.GetBall(FIRST_SHIP_BALL_ID + 1)?.vx);
  });

  it('hits for sure at rest within optimal, and never past optimal without falloff', () => {
    expect(World(0, 500).Accuracy('a', 'b', GUN)?.chance).toBe(1);
    const past = World(0, 2000).Accuracy('a', 'b', { ...GUN, falloff: null });
    expect(past?.chance).toBeLessThan(1e-6);
  });

  it('is null for the same id or a missing ball', () => {
    const world = World(0);
    expect(world.Accuracy('a', 'a', GUN)).toBeNull();
    expect(world.Accuracy('a', 'nobody', GUN)).toBeNull();
  });
});
