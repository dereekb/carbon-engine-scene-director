import { describe, expect, it } from 'vitest';
import type { SceneFleet } from '../fleets/fleet';
import type { SceneVector } from '../scene';
import {
  cameraPathAnchors,
  cameraShotSubjects,
  cinemaSpheres,
  distanceVec,
  engagementFrame,
  dotVec,
  fitDistance,
  groupFrame,
  hardpointKind,
  lengthVec,
  MIN_WARP_LANDING_RADIUS,
  normalizeCameraShot,
  normalizeHardpointSubject,
  normalizeVec,
  quatFromAxisAngle,
  resolveHardpoint,
  subVec,
  toHardpointListing,
  type CameraPose,
  type CinemaScene,
  type CinemaShip,
  type CinemaWarp
} from './index';

const DEGREES = Math.PI / 180;

function Ship(id: string, position: SceneVector, options: { yaw?: number; radius?: number; team?: string } = {}): CinemaShip {
  return { id, position, rotation: quatFromAxisAngle([0, 1, 0], (options.yaw ?? 0) * DEGREES), velocity: [0, 0, 0], frameCentre: position, frameRadius: options.radius ?? 50, ...(options.team ? { team: options.team } : {}) };
}

function Scene(ships: CinemaShip[], extra: Partial<CinemaScene> = {}): CinemaScene {
  return { ships, sunDirection: [0, 0, -1], aspect: 16 / 9, ...extra };
}

function Forward(pose: CameraPose): SceneVector {
  return normalizeVec(subVec(pose.look, pose.eye)) ?? [0, 0, 0];
}

describe('warp-landing', () => {
  const fleets: SceneFleet[] = [{ id: 'blue', commander: 'fc', wings: [{ id: 'main', squads: [{ id: 's1', role: 'dps', members: ['m1', 'm2'] }] }] }];
  const formation = (): CinemaShip[] => [Ship('fc', [0, 0, 0]), Ship('m1', [600, 0, -800]), Ship('m2', [-600, 0, -800])];
  const landing: SceneVector = [0, 0, 1e6];
  const aligning = (id: string): CinemaWarp | null => (['fc', 'm1', 'm2'].includes(id) ? { phase: 'aligning', landing } : null);

  it('waits downstream of the landing, to starboard and above, looking back up the lane', () => {
    const ships = formation();
    const scene = Scene(ships, { fleets, warpOf: aligning });
    const resolved = resolveHardpoint({ name: 'warp-landing', fleet: 'blue' }, scene);
    const pose = resolved.pose as CameraPose;
    const group = groupFrame(ships, ships[0]);
    const centre = [group.centre[0], group.centre[1], group.centre[2] + 1e6];
    pose.look.forEach((value, axis) => expect(value).toBeCloseTo(centre[axis], 3));
    expect(pose.eye[2]).toBeGreaterThan(1e6);
    expect(pose.eye[0]).toBeLessThan(0);
    expect(pose.eye[1]).toBeGreaterThan(0);
    expect(distanceVec(pose.eye, pose.look)).toBeCloseTo(fitDistance(Math.max(group.radius, MIN_WARP_LANDING_RADIUS), 50, 16 / 9, 0.8), 3);
    expect(dotVec(Forward(pose), [0, 0, -1])).toBeGreaterThan(Math.cos(40 * DEGREES));
    expect(resolved.anchor?.look).toBeDefined();
    expect(resolved.note).toMatch(/aligning/u);
  });

  it('frames the landings once in warp, and the port side mirrors the eye', () => {
    const ships = formation();
    const landings: Record<string, SceneVector> = { fc: [0, 0, 1e6], m1: [3000, 0, 1e6 - 800], m2: [-3000, 0, 1e6 - 800] };
    const scene = Scene(ships, { fleets, warpOf: (id) => (landings[id] ? { phase: 'warping', landing: landings[id] } : null) });
    const starboard = resolveHardpoint({ name: 'warp-landing', fleet: 'blue' }, scene);
    const port = resolveHardpoint({ name: 'warp-landing', fleet: 'blue', side: 'port' }, scene);
    expect(starboard.subject?.radius).toBeGreaterThan(3000);
    expect(starboard.pose?.eye[0]).toBeLessThan(0);
    expect(port.pose?.eye[0]).toBeGreaterThan(0);
  });

  it('frames a group with no warp where it is, without an anchor', () => {
    const resolved = resolveHardpoint({ name: 'warp-landing', fleet: 'blue' }, Scene(formation(), { fleets }));
    expect(resolved.pose).toBeTruthy();
    expect(resolved.anchor).toBeUndefined();
    expect(resolved.note).toMatch(/no warp in progress/u);
  });

  it('holds its eye and look once anchored while the ships move', () => {
    const first = resolveHardpoint({ name: 'warp-landing', fleet: 'blue' }, Scene(formation(), { fleets, warpOf: aligning }));
    const moved = formation().map((ship) => Ship(ship.id, [ship.position[0], 0, ship.position[2] + 4e5]));
    const later = resolveHardpoint({ name: 'warp-landing', fleet: 'blue' }, Scene(moved, { fleets, warpOf: aligning }), first.anchor);
    expect(later.pose?.eye).toEqual(first.pose?.eye);
    expect(later.pose?.look).toEqual(first.pose?.look);
  });

  it('turns the landing formation to the lane', () => {
    // Facing -Z with its wing 800 m behind (+Z), warping to +Z: the wing lands 800 m behind the landing (-Z).
    const ships = [Ship('fc', [0, 0, 0], { yaw: 180 }), Ship('m1', [600, 0, 800], { yaw: 180 }), Ship('m2', [-600, 0, 800], { yaw: 180 })];
    const look = resolveHardpoint({ name: 'warp-landing', fleet: 'blue' }, Scene(ships, { fleets, warpOf: aligning })).pose?.look ?? [0, 0, 0];
    expect(look[0]).toBeCloseTo(0, 3);
    expect(look[2]).toBeCloseTo(1e6 - 1600 / 3, 3);
  });

  it('frames the core of the formation, leaving logi far behind out', () => {
    const ships = [...formation(), Ship('m3', [0, 0, -400]), Ship('logi', [0, 0, -30000])];
    const warpOf = (): CinemaWarp => ({ phase: 'aligning', landing });
    const resolved = resolveHardpoint({ name: 'warp-landing', ships: ships.map((ship) => ship.id) }, Scene(ships, { warpOf }));
    expect(resolved.subject?.radius).toBe(MIN_WARP_LANDING_RADIUS);
    expect(resolved.pose?.look[2]).toBeGreaterThan(1e6 - 1000);
  });

  it('frames a landed warp unanchored, and leaves a stale landing out', () => {
    const landed = resolveHardpoint({ name: 'warp-landing', fleet: 'blue' }, Scene(formation(), { fleets, warpOf: (id) => (id === 'fc' ? { phase: 'landed', landing: [0, 0, 0] } : null) }));
    expect(landed.pose).toBeTruthy();
    expect(landed.anchor).toBeUndefined();
    const landings: Record<string, CinemaWarp> = { fc: { phase: 'warping', landing: [0, 0, 1e6] }, m1: { phase: 'warping', landing: [600, 0, 1e6 - 800] }, m2: { phase: 'landed', landing: [0, 0, -2e6] } };
    const warping = resolveHardpoint({ name: 'warp-landing', fleet: 'blue' }, Scene(formation(), { fleets, warpOf: (id) => landings[id] ?? null }));
    expect(warping.subject?.radius).toBe(MIN_WARP_LANDING_RADIUS);
    expect(warping.anchor).toBeDefined();
  });

  it('frames a lone ship like a one-ship group', () => {
    const scene = Scene(formation(), { fleets, warpOf: aligning });
    const ship = resolveHardpoint({ name: 'warp-landing', ship: 'fc' }, scene);
    const group = resolveHardpoint({ name: 'warp-landing', ships: ['fc'] }, scene);
    expect(ship.pose?.eye).toEqual(group.pose?.eye);
  });
});

describe('warp-landing on arrivals', () => {
  const fleets: SceneFleet[] = [{ id: 'blue', commander: 'fc', wings: [{ id: 'main', squads: [{ id: 's1', role: 'dps', members: ['m1', 'm2'] }] }] }];
  // Landing at the origin in formation, parked 3,000 km out along -X (they warp in along +X).
  const landings: Record<string, SceneVector> = { fc: [0, 0, 0], m1: [-800, 0, 600], m2: [-800, 0, -600] };
  const parked = (): CinemaShip[] => Object.entries(landings).map(([id, landing]) => Ship(id, [landing[0] - 3e9, landing[1], landing[2]], { yaw: 90 }));
  const arriving = (id: string): CinemaWarp | null => (landings[id] ? { phase: 'arriving', landing: landings[id] } : null);
  const others = [Ship('enemy', [0, 0, 20000], { team: 'red' })];

  it('frames the landings, anchored at once, looking back up the lane from where they wait', () => {
    const resolved = resolveHardpoint({ name: 'warp-landing', fleet: 'blue' }, Scene(others, { fleets, arriving: parked(), warpOf: arriving }));
    const pose = resolved.pose as CameraPose;
    expect(resolved.anchor?.look).toBeDefined();
    expect(distanceVec(pose.look, [-1600 / 3, 0, 0])).toBeLessThan(1);
    // Downstream of the landing (+X) and looking back toward the parked ships (-X).
    expect(pose.eye[0]).toBeGreaterThan(0);
    expect(dotVec(Forward(pose), [-1, 0, 0])).toBeGreaterThan(Math.cos(40 * DEGREES));
    expect(resolved.note).toMatch(/arriving/u);
    // A lone arriving ship too.
    const ship = resolveHardpoint({ name: 'warp-landing', ship: 'm1' }, Scene(others, { fleets, arriving: parked(), warpOf: arriving }));
    expect(distanceVec(ship.pose?.look ?? [0, 0, 0], landings['m1'])).toBeLessThan(1);
    expect(ship.anchor).toBeDefined();
  });

  it('anchors on a member still arriving once the leader has landed', () => {
    const ships = parked();
    const fc = Ship('fc', [0, 0, 0], { yaw: 90 });
    const warpOf = (id: string): CinemaWarp | null => (id === 'fc' ? { phase: 'landed', landing: [0, 0, 0] } : arriving(id));
    const resolved = resolveHardpoint({ name: 'warp-landing', fleet: 'blue' }, Scene([fc, ...others], { fleets, arriving: ships.filter((ship) => ship.id !== 'fc'), warpOf }));
    expect(resolved.anchor).toBeDefined();
    expect(distanceVec(resolved.pose?.look ?? [0, 0, 0], [-1600 / 3, 0, 0])).toBeLessThan(1);
    // Other hardpoints frame only the landed.
    const behind = resolveHardpoint({ name: 'behind-fc', fleet: 'blue' }, Scene([fc, ...others], { fleets, arriving: ships.filter((ship) => ship.id !== 'fc'), warpOf }));
    expect(behind.subject?.centre).toEqual(fc.frameCentre);
  });

  it('gives other hardpoints on an all-arriving subject no pose, with a note', () => {
    const scene = Scene(others, { fleets, arriving: parked(), warpOf: arriving });
    const note = /still arriving by warp: play warp-in, or wait for it to land/u;
    for (const ref of [
      { name: 'behind-fc', fleet: 'blue' },
      { name: 'top-down', ships: ['m1', 'm2'] },
      { name: 'chase', ship: 'fc' },
      { name: 'flyby', ship: 'm2' }
    ]) {
      const resolved = resolveHardpoint(ref, scene);
      expect(resolved.pose).toBeNull();
      expect(resolved.note).toMatch(note);
    }
    // The engagement, the spheres and the listing leave them out until they land.
    expect(cinemaSpheres(scene)).toHaveLength(1);
    expect(engagementFrame(scene)?.centre).toEqual(others[0].frameCentre);
    const listing = toHardpointListing({ fleet: 'blue' }, scene);
    expect(listing.subject?.['arriving']).toBe(3);
    expect(listing.hardpoints.find((entry) => entry.name === 'warp-landing')?.eye).toBeDefined();
    expect(toHardpointListing({ ship: 'fc' }, scene).subject?.['arriving']).toBe(true);
  });
});

describe('landmark hardpoints', () => {
  const teams = [Ship('a1', [-1000, 0, 0], { team: 'a' }), Ship('b1', [1000, 0, 0], { team: 'b' })];
  const objects = [{ id: 'astra', centre: [0, 0, 50000] as SceneVector, radius: 5000, rotation: [0, 0, 0, 1] as [number, number, number, number] }];

  it('establishes an object past the ships, the ships below the frame centre', () => {
    const resolved = resolveHardpoint({ name: 'establishing', object: 'astra' }, Scene(teams, { objects }));
    const pose = resolved.pose as CameraPose;
    expect(pose.look).toEqual([0, 0, 50000]);
    expect(pose.eye[2]).toBeLessThan(0);
    expect(pose.eye[1]).toBeGreaterThan(0);
    const forward = Forward(pose);
    const toShips = normalizeVec(subVec([0, 0, 0], pose.eye)) as SceneVector;
    expect(dotVec(toShips, forward)).toBeGreaterThan(Math.cos(25 * DEGREES));
    expect(toShips[1]).toBeLessThan(forward[1]);
  });

  it('establishes a landmark alone from its own side', () => {
    const resolved = resolveHardpoint({ name: 'establishing', object: 'astra' }, Scene([], { objects }));
    expect(distanceVec(resolved.pose?.eye ?? [0, 0, 0], [0, 0, 50000])).toBeCloseTo(fitDistance(5000, 50, 16 / 9, 0.6), 3);
  });

  it('keeps a planet establishing near the ships and a hero inside the cap', () => {
    const celestials = [{ id: 40000001, name: 'Planet I', kind: 'planet', position: [0, 0, 1.2e7] as SceneVector, radius: 6e6 }];
    const scene = Scene(teams, { celestials });
    const establishing = resolveHardpoint({ name: 'establishing', celestial: 'planet i' }, scene);
    expect(lengthVec(establishing.pose?.eye ?? [1e9, 0, 0])).toBeLessThan(1e6);
    const hero = resolveHardpoint({ name: 'hero', celestial: 40000001 }, scene);
    expect(distanceVec(hero.pose?.eye ?? [0, 0, 0], [0, 0, 1.2e7])).toBeCloseTo(fitDistance(6e6, 30, 16 / 9, 0.75), 0);
  });

  it('refuses a hero past the float32 cap', () => {
    const celestials = [{ id: 1, name: 'Far', kind: 'planet', position: [0, 0, 1e11] as SceneVector, radius: 6e6 }];
    const hero = resolveHardpoint({ name: 'hero', celestial: 'Far' }, Scene(teams, { celestials }));
    expect(hero.pose).toBeNull();
    expect(hero.note).toMatch(/float32/u);
  });

  it('puts the landmark in the foreground, the sightline clear of it', () => {
    const pose = resolveHardpoint({ name: 'foreground', object: 'astra' }, Scene(teams, { objects })).pose as CameraPose;
    expect(pose.look).toEqual([0, 0, 0]);
    const toLook = subVec(pose.look, pose.eye);
    const along = dotVec(subVec([0, 0, 50000], pose.eye), toLook) / dotVec(toLook, toLook);
    const closest = pose.eye.map((value, axis) => value + toLook[axis] * Math.max(0, Math.min(1, along))) as SceneVector;
    expect(distanceVec(closest, [0, 0, 50000])).toBeGreaterThan(5000);
  });

  it('looks into an object across the battle', () => {
    const pose = resolveHardpoint({ name: 'into-celestial', object: 'astra' }, Scene(teams, { objects })).pose as CameraPose;
    expect(Forward(pose)[2]).toBeGreaterThan(0.99);
  });

  it('names the kinds and refuses two subjects', () => {
    expect(hardpointKind({ name: 'hero', object: 'astra' })).toBe('landmark');
    expect(hardpointKind({ name: 'establishing', celestial: 'x' })).toBe('landmark');
    expect(hardpointKind({ name: 'into-celestial', object: 'astra' })).toBe('engagement');
    expect(normalizeCameraShot({ hardpoint: { name: 'hero', object: 'astra', ship: 'a1' } }).problems.join()).toMatch(/give one subject/u);
    expect(normalizeCameraShot({ hardpoint: { name: 'hero', object: 'astra', celestial: 'x' } }).problems.join()).toMatch(/give one subject/u);
    expect(normalizeHardpointSubject({ fleet: 'a', ships: ['b'] }).problems.join()).toMatch(/give one subject/u);
  });
});

describe('toHardpointListing', () => {
  const fleets: SceneFleet[] = [{ id: 'blue', commander: 'a1', wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', members: ['a2'] }] }] }];
  const ships = [Ship('a1', [-1000.123456, 0, 0], { team: 'a' }), Ship('a2', [-1200, 0, 300], { team: 'a' }), Ship('b1', [1000, 0, 0], { team: 'b', yaw: 180 })];
  const objects = [{ id: 'astra', centre: [0, 0, 50000] as SceneVector, radius: 5000, rotation: [0, 0, 0, 1] as [number, number, number, number] }];
  const celestials = [{ id: 60003760, name: 'Station', kind: 'station', position: [0, 20000, 80000] as SceneVector, radius: 12000 }];
  const scene = Scene(ships, { fleets, objects, celestials });

  it('lists a ship with warp-landing, rounded, the anchored ones marked', () => {
    const listing = toHardpointListing({ ship: 'a1' }, scene);
    expect(listing.kind).toBe('ship');
    expect(listing.subject?.['ship']).toBe('a1');
    const names = listing.hardpoints.map((entry) => entry.name);
    expect(names).toContain('warp-landing');
    expect(listing.hardpoints.find((entry) => entry.name === 'flyby')?.anchored).toBe(true);
    const chase = listing.hardpoints.find((entry) => entry.name === 'chase');
    for (const value of [...(chase?.eye ?? []), ...(chase?.look ?? [])]) expect(Math.round(value * 100) / 100).toBe(value);
    expect(chase?.distance).toBeGreaterThan(0);
  });

  it('lists a group, the engagement, an object and a celestial', () => {
    expect(toHardpointListing({ fleet: 'blue' }, scene).subject?.['leader']).toBe('a1');
    const engagement = toHardpointListing({}, scene);
    expect(engagement.kind).toBe('engagement');
    expect(engagement.subject?.['teams']).toEqual(['a', 'b']);
    expect(engagement.subject?.['a']).toBeDefined();
    const object = toHardpointListing({ object: 'astra' }, scene);
    expect(object.hardpoints.map((entry) => entry.name)).toEqual(['establishing', 'hero', 'foreground', 'into-celestial']);
    expect(object.hardpoints.every((entry) => entry.eye)).toBe(true);
    const celestial = toHardpointListing({ celestial: 'celestial:60003760' }, scene);
    expect(celestial.subject?.['name']).toBe('Station');
    expect(celestial.hardpoints.find((entry) => entry.name === 'into-celestial')?.eye).toBeDefined();
  });

  it('notes a hardpoint that cannot resolve', () => {
    const listing = toHardpointListing({ object: 'gone' }, scene);
    expect(listing.subject).toBeNull();
    expect(listing.hardpoints[0].eye).toBeUndefined();
    expect(listing.hardpoints[0].note).toMatch(/gone/u);
  });
});

describe('shot spec additions', () => {
  it('defaults end to release and checks it', () => {
    expect(normalizeCameraShot({ hardpoint: { name: 'chase', ship: 'a' } }).shot?.end).toBe('release');
    expect(normalizeCameraShot({ hardpoint: { name: 'chase', ship: 'a' }, end: 'hold' }).shot?.end).toBe('hold');
    expect(normalizeCameraShot({ hardpoint: { name: 'chase', ship: 'a' }, end: 'loop' }).problems.join()).toMatch(/end must be/u);
  });

  it('takes waypoints for a pose eye and look', () => {
    const { shot, problems } = normalizeCameraShot({ pose: { eye: { ship: 'deck', offset: [0, 0, 2], units: 'radii' }, look: { ship: 'fc' }, roll: 8, fov: 35 } });
    expect(problems).toEqual([]);
    expect(cameraShotSubjects(shot)).toEqual(expect.arrayContaining(['deck', 'fc']));
    expect(cameraPathAnchors(shot)).toEqual(['deck']);
    expect(normalizeCameraShot({ pose: { eye: [1, 2, 3], look: [1, 2, 3] } }).problems.join()).toMatch(/must differ/u);
  });

  it('needs the subject frame for radius path units', () => {
    const path = {
      type: 'path',
      units: 'radii',
      points: [
        [0, 0, 0],
        [1, 0, 0]
      ]
    };
    expect(normalizeCameraShot({ hardpoint: { name: 'overlook' }, duration: 4, moves: [path] }).problems.join()).toMatch(/needs frame "subject"/u);
    expect(normalizeCameraShot({ hardpoint: { name: 'overlook' }, duration: 4, moves: [{ ...path, frame: 'subject' }] }).shot?.moves[0]).toMatchObject({ units: 'radii' });
  });

  it('counts a hardpoint object as a subject', () => {
    expect(cameraShotSubjects(normalizeCameraShot({ hardpoint: { name: 'hero', object: 'astra' } }).shot)).toEqual(['astra']);
  });
});
