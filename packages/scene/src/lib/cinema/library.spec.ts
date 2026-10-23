import { describe, expect, it } from 'vitest';
import { findTool } from '../tools';
import { CAMERA_SHOT_LIBRARY, CAMERA_SHOT_NAMES, listCameraShots, normalizeCameraSequence, normalizeCameraShot, type CameraMove } from './index';

/**
 * Whether a move is scale-free: it fits any subject size.
 */
function ScaleFree(move: CameraMove): boolean {
  let free: boolean;
  switch (move.type) {
    case 'push':
    case 'zoom':
    case 'orbit':
    case 'roll':
    case 'spin':
    case 'track':
    case 'shake':
      free = true;
      break;
    case 'path':
      free = move.frame === 'subject' && move.units === 'radii';
      break;
    default:
      free = false;
  }
  return free;
}

describe('the shot library', () => {
  it('normalizes every example with scale-free moves, holding its last frame', () => {
    for (const entry of CAMERA_SHOT_LIBRARY) {
      const { shot, problems } = normalizeCameraShot(entry.example);
      expect(problems, entry.name).toEqual([]);
      expect(shot?.library).toBe(entry.name);
      expect(shot?.end).toBe('hold');
      expect(shot?.duration).toBe(entry.duration);
      expect(shot?.moves.every(ScaleFree), entry.name).toBe(true);
    }
  });

  it('names the missing subject and the unknown shot', () => {
    expect(normalizeCameraShot({ shot: 'chase' }).problems.join()).toMatch(/needs ship/u);
    expect(normalizeCameraShot({ shot: 'warp-in' }).problems.join()).toMatch(/needs fleet/u);
    expect(normalizeCameraShot({ shot: 'establishing' }).problems.join()).toMatch(/needs object/u);
    expect(normalizeCameraShot({ shot: 'into-celestial' }).problems.join()).toMatch(/needs celestial/u);
    const unknown = normalizeCameraShot({ shot: 'dutch-angle' }).problems.join();
    for (const name of CAMERA_SHOT_NAMES) expect(unknown).toContain(name);
  });

  it('applies overrides: the duration rescales, moves append, the rest replaces, options go on the hardpoint', () => {
    const { shot, problems } = normalizeCameraShot({
      shot: 'battle-fly-through',
      duration: 30,
      moves: [{ type: 'roll', angle: 10 }],
      transition: 'cut',
      end: 'release',
      fov: 60,
      fill: 0.5,
      bank: true,
      teams: ['a', 'b']
    });
    expect(problems).toEqual([]);
    expect(shot?.duration).toBe(30);
    expect(shot?.moves.map((move) => move.type)).toEqual(['path', 'zoom', 'zoom', 'roll']);
    expect(shot?.moves[1]).toMatchObject({ duration: 15 });
    expect(shot?.moves[2]).toMatchObject({ at: 15, duration: 15 });
    expect(shot?.transition).toEqual({ type: 'cut' });
    expect(shot?.end).toBe('release');
    expect(shot?.hardpoint).toMatchObject({ name: 'overlook', fov: 60, fill: 0.5, bank: true, teams: ['a', 'b'] });
  });

  it('warns about keys a shot does not read', () => {
    const { warnings } = normalizeCameraShot({ shot: 'overlook-pull-out', ship: 'a', colour: 'red' });
    expect(warnings.join()).toMatch(/ship is not used/u);
    expect(warnings.join()).toMatch(/colour/u);
  });

  it('picks the hero side and swings it toward the beam', () => {
    const port = normalizeCameraShot({ shot: 'hero', ship: 'a' }).shot;
    const starboard = normalizeCameraShot({ shot: 'hero', ship: 'a', side: 'starboard' }).shot;
    expect(port?.hardpoint?.name).toBe('hero-port');
    expect(starboard?.hardpoint?.name).toBe('hero-starboard');
    expect(port?.moves[0]).toMatchObject({ type: 'orbit', angle: 25 });
    expect(starboard?.moves[0]).toMatchObject({ type: 'orbit', angle: -25 });
  });

  it('plays in a sequence beside explicit shots', () => {
    const explicit = { hardpoint: { name: 'chase', ship: 'a' }, duration: 3 };
    expect(normalizeCameraSequence({ shots: [explicit, { shot: 'flyby', ship: 'a' }, { shot: 'chase', ship: 'a' }] }).problems).toEqual([]);
    expect(normalizeCameraSequence({ shots: [{ shot: 'chase', ship: 'a' }, explicit] }).problems.join()).toMatch(/shots\[0\] needs a duration/u);
  });

  it('lists ten shots, each expanded', () => {
    const listing = listCameraShots();
    expect(listing).toHaveLength(10);
    expect(listing.every((entry) => entry.expanded)).toBe(true);
    expect(listing.map((entry) => entry.name)).toEqual(CAMERA_SHOT_NAMES);
  });

  it('puts the camera tools on the shared tool list', () => {
    expect(findTool('list_shots')?.where).toBe('hub');
    for (const name of ['list_hardpoints', 'play_shot', 'play_sequence', 'stop_shot', 'resume_shot']) expect(findTool(name)?.where, name).toBe('page');
    const shot = (findTool('play_shot')?.inputSchema.properties as Record<string, { enum?: string[] }>)['shot'];
    expect(shot.enum).toEqual(CAMERA_SHOT_NAMES);
  });

  it('puts warp-in on warp-landing with its side', () => {
    expect(normalizeCameraShot({ shot: 'warp-in', ships: ['a'], side: 'port' }).shot?.hardpoint).toMatchObject({ name: 'warp-landing', ships: ['a'], side: 'port' });
  });
});
