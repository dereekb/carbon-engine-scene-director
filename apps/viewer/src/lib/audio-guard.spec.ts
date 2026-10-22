import { describe, expect, it, vi } from 'vitest';
import { GuardWebAudioBackend, IsAutomationOverlap, RunDetached, type WebAudioGuardOptions } from './audio-guard';
import type { CjsWebAudioSoundEngine, CjsWebAudioVoice } from './runtime';

function Overlap(): DOMException {
  return new DOMException('setValueAtTime(1, 0.512) overlaps setValueCurveAtTime(..., 0.509, 10)', 'NotSupportedError');
}

function FakeParam() {
  return { cancelScheduledValues: vi.fn() };
}

/**
 * A voice with a gain, both filters, and optionally a source and a bus gain.
 */
function FakeVoice(input: { readonly source?: boolean; readonly bus?: boolean } = {}) {
  const params = { gain: FakeParam(), rate: FakeParam(), lowPass: FakeParam(), highPass: FakeParam(), bus: FakeParam() };
  const nodes = {
    gain: { gain: params.gain },
    busGain: input.bus ? { gain: params.bus } : null,
    busVoiceActionGain: null,
    busVoiceGain: null,
    source: input.source ? { playbackRate: params.rate } : null,
    lowPassFilter: { frequency: params.lowPass },
    highPassFilter: { frequency: params.highPass }
  };
  return { voice: nodes as unknown as CjsWebAudioVoice, params };
}

/**
 * A backend whose members are mocks; `originals` keeps them after the guard replaces the members.
 */
function FakeBackend() {
  const originals = {
    PostEvent: vi.fn((): number => 7),
    ExecuteActionOnPlayingID: vi.fn((): boolean => true),
    SetPosition: vi.fn(),
    SeekOnEventPercent: vi.fn(),
    SeekOnEventMs: vi.fn(),
    SetListenerPosition: vi.fn(),
    SetScalingFactor: vi.fn(),
    SetRTPCValue: vi.fn(),
    SetSwitch: vi.fn(),
    _ApplyVoiceGain: vi.fn(),
    _ApplyVoicePlaybackRate: vi.fn(),
    _ApplyVoiceFilters: vi.fn(),
    _ApplyVoiceBusGain: vi.fn(),
    _ApplyVoiceBusActionGain: vi.fn(),
    _ApplyVoiceBusRtpcGain: vi.fn()
  };
  const backend: CjsWebAudioSoundEngine = { ...originals };
  return { backend, originals };
}

function Guarded() {
  const { backend, originals } = FakeBackend();
  const options = { onRescheduled: vi.fn(), onContained: vi.fn() } satisfies WebAudioGuardOptions;
  GuardWebAudioBackend(backend, options);
  return { backend, originals, options };
}

describe('GuardWebAudioBackend', () => {
  it('clears an applier’s own params before the runtime schedules them, and forwards this and the arguments', () => {
    const { backend, originals } = Guarded();
    const { voice, params } = FakeVoice({ source: true });
    backend._ApplyVoiceGain(voice, true);
    expect(params.gain.cancelScheduledValues).toHaveBeenCalledWith(0);
    expect(params.gain.cancelScheduledValues.mock.invocationCallOrder[0]).toBeLessThan(originals._ApplyVoiceGain.mock.invocationCallOrder[0]);
    expect(originals._ApplyVoiceGain).toHaveBeenCalledWith(voice, true);
    expect(originals._ApplyVoiceGain.mock.contexts[0]).toBe(backend);
    backend._ApplyVoiceFilters(voice);
    expect(params.lowPass.cancelScheduledValues).toHaveBeenCalledWith(0);
    expect(params.highPass.cancelScheduledValues).toHaveBeenCalledWith(0);
    backend._ApplyVoicePlaybackRate(voice);
    expect(params.rate.cancelScheduledValues).toHaveBeenCalledWith(0);
    // Only the applier's own params.
    expect(params.gain.cancelScheduledValues).toHaveBeenCalledTimes(1);
  });

  it('skips the params a voice does not have', () => {
    const { backend, originals, options } = Guarded();
    const { voice, params } = FakeVoice();
    backend._ApplyVoiceBusGain(voice);
    backend._ApplyVoicePlaybackRate(voice);
    backend._ApplyVoiceBusRtpcGain(voice);
    expect(params.bus.cancelScheduledValues).not.toHaveBeenCalled();
    expect(originals._ApplyVoiceBusGain).toHaveBeenCalledOnce();
    expect(originals._ApplyVoicePlaybackRate).toHaveBeenCalledOnce();
    expect(options.onContained).not.toHaveBeenCalled();
  });

  it('clears again and retries once on an automation overlap, and reports the reschedule', () => {
    const { backend, originals, options } = Guarded();
    const { voice, params } = FakeVoice();
    const overlap = Overlap();
    originals._ApplyVoiceGain.mockImplementationOnce(() => {
      throw overlap;
    });
    expect(() => backend._ApplyVoiceGain(voice)).not.toThrow();
    expect(originals._ApplyVoiceGain).toHaveBeenCalledTimes(2);
    expect(params.gain.cancelScheduledValues).toHaveBeenCalledTimes(2);
    expect(options.onRescheduled).toHaveBeenCalledExactlyOnceWith(overlap, '_ApplyVoiceGain');
    expect(options.onContained).not.toHaveBeenCalled();
  });

  it('contains a second overlap, and does not retry any other error', () => {
    const { backend, originals, options } = Guarded();
    const { voice } = FakeVoice();
    originals._ApplyVoiceFilters.mockImplementation(() => {
      throw Overlap();
    });
    expect(backend._ApplyVoiceFilters(voice)).toBeUndefined();
    expect(originals._ApplyVoiceFilters).toHaveBeenCalledTimes(2);
    expect(options.onContained).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'NotSupportedError' }), '_ApplyVoiceFilters');
    const broken = new TypeError('voice.getGainAtVoiceVolumeDb is not a function');
    originals._ApplyVoiceGain.mockImplementation(() => {
      throw broken;
    });
    expect(() => backend._ApplyVoiceGain(voice)).not.toThrow();
    expect(originals._ApplyVoiceGain).toHaveBeenCalledOnce();
    expect(options.onContained).toHaveBeenLastCalledWith(broken, '_ApplyVoiceGain');
    expect(options.onRescheduled).not.toHaveBeenCalled();
  });

  it('contains the entry points with a neutral result, and passes results through otherwise', () => {
    const { backend, originals, options } = Guarded();
    expect(backend.PostEvent('ship_engine_M_booster_3rd_on', 3)).toBe(7);
    expect(originals.PostEvent.mock.contexts[0]).toBe(backend);
    expect(backend.ExecuteActionOnPlayingID('stop', 7, 1000)).toBe(true);
    originals.PostEvent.mockImplementation(() => {
      throw Overlap();
    });
    originals.SetPosition.mockImplementation(() => {
      throw Overlap();
    });
    expect(backend.PostEvent('ship_engine_M_booster_3rd_on', 3)).toBe(0);
    expect(backend.SetPosition(3, [0, 0, 1], [0, 1, 0], [10, 0, 0])).toBeUndefined();
    expect(originals.SetPosition).toHaveBeenCalledWith(3, [0, 0, 1], [0, 1, 0], [10, 0, 0]);
    expect(options.onContained.mock.calls.map(([, where]) => where)).toEqual(['PostEvent', 'SetPosition']);
  });

  it('guards a backend once', () => {
    const { backend, originals } = FakeBackend();
    const options = { onRescheduled: vi.fn(), onContained: vi.fn() };
    expect(GuardWebAudioBackend(backend, options)).toBe(true);
    const applier = backend._ApplyVoiceGain;
    expect(GuardWebAudioBackend(backend, options)).toBe(false);
    expect(backend._ApplyVoiceGain).toBe(applier);
    const { voice, params } = FakeVoice();
    backend._ApplyVoiceGain(voice);
    expect(originals._ApplyVoiceGain).toHaveBeenCalledOnce();
    expect(params.gain.cancelScheduledValues).toHaveBeenCalledOnce();
  });
});

describe('IsAutomationOverlap', () => {
  it('matches only NotSupportedError', () => {
    expect(IsAutomationOverlap(Overlap())).toBe(true);
    expect(IsAutomationOverlap(new TypeError('no'))).toBe(false);
    expect(IsAutomationOverlap('NotSupportedError')).toBe(false);
    expect(IsAutomationOverlap(null)).toBe(false);
  });
});

describe('RunDetached', () => {
  it('builds with the seams detached and re-attaches them, also when the build throws', () => {
    const order: string[] = [];
    const seams = { Detach: vi.fn(() => order.push('detach')), Attach: vi.fn(() => order.push('attach')) };
    expect(
      RunDetached(seams, () => {
        order.push('build');
        return 'ship';
      })
    ).toBe('ship');
    expect(order).toEqual(['detach', 'build', 'attach']);
    expect(() =>
      RunDetached(seams, () => {
        throw new Error('hydration failed');
      })
    ).toThrow('hydration failed');
    expect(seams.Attach).toHaveBeenCalledTimes(2);
  });

  it('just builds without seams', () => {
    expect(RunDetached(null, () => 3)).toBe(3);
  });
});
