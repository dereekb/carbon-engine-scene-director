import { describe, expect, it } from 'vitest';
import { PropModAudioEvents, PropModAudioStem, PropModAudioStops } from './prop-mod-audio';

describe('prop mod audio', () => {
  it('names the stem for both kinds and every size', () => {
    for (const size of ['S', 'M', 'L', 'XL'] as const) {
      expect(PropModAudioStem({ kind: 'microwarpdrive', size })).toBe(`ship_engine_${size}_microwarpdrive_3rd`);
      expect(PropModAudioStem({ kind: 'afterburner', size })).toBe(`ship_engine_${size}_afterburner_3rd`);
    }
  });

  it('posts _activate when a module switches on and _powerdown when it switches off', () => {
    expect(PropModAudioEvents('on', { kind: 'microwarpdrive', size: 'L' })).toEqual(['ship_engine_L_microwarpdrive_3rd_activate']);
    expect(PropModAudioEvents('off', { kind: 'afterburner', size: 'M' })).toEqual(['ship_engine_M_afterburner_3rd_powerdown']);
  });

  it('stops a swell still playing when a module switches off, and nothing when it switches on', () => {
    expect(PropModAudioStops('off', { kind: 'microwarpdrive', size: 'L' })).toEqual(['ship_engine_L_microwarpdrive_3rd_activate']);
    expect(PropModAudioStops('off', { kind: 'afterburner', size: 'XL' })).toEqual(['ship_engine_XL_afterburner_3rd_activate']);
    expect(PropModAudioStops('on', { kind: 'afterburner', size: 'S' })).toEqual([]);
  });
});
