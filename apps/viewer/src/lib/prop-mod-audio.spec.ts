import { describe, expect, it } from 'vitest';
import { PropModAudioEvents, PropModAudioStem } from './prop-mod-audio';

describe('prop mod audio', () => {
  it('names the stem for both kinds and every size', () => {
    for (const size of ['S', 'M', 'L', 'XL'] as const) {
      expect(PropModAudioStem({ kind: 'microwarpdrive', size })).toBe(`ship_engine_${size}_microwarpdrive_3rd`);
      expect(PropModAudioStem({ kind: 'afterburner', size })).toBe(`ship_engine_${size}_afterburner_3rd`);
    }
  });

  it('posts _on when a module switches on and _powerdown when it switches off', () => {
    expect(PropModAudioEvents('on', { kind: 'microwarpdrive', size: 'L' })).toEqual(['ship_engine_L_microwarpdrive_3rd_on']);
    expect(PropModAudioEvents('off', { kind: 'afterburner', size: 'M' })).toEqual(['ship_engine_M_afterburner_3rd_powerdown']);
  });
});
