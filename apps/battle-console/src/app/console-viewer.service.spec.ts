import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { FleetView, StartViewerOptions, ViewerApi, ViewerChangeListener } from '@scene-director/viewer-engine/api';
import { CONSOLE_ENGINE_STARTER, CONSOLE_PANEL_REFRESH_MS, CONSOLE_STORE_PREFIX, CONSOLE_UI_HIDDEN_CLASS, ConsoleViewerService } from './console-viewer.service';

interface FakeEngine {
  readonly api: ViewerApi;
  readonly reads: () => number;
  readonly setHidden: (hidden: boolean) => void;
}

function makeFakeEngine(): FakeEngine {
  let reads = 0;
  let hidden = false;
  const fleets: FleetView[] = [];
  const api: ViewerApi = {
    Call: async () => ({}),
    CallHub: async () => ({}),
    Fleets: () => {
      reads += 1;
      return fleets;
    },
    Time: () => ({ seconds: 1, tick: 1, rate: 1, paused: false, state: 'live' }) as unknown as ReturnType<ViewerApi['Time']>,
    Timeline: () => null,
    Scene: () => ({ schema: 'cjs-scene/1', name: 'fake', ships: [] }) as unknown as ReturnType<ViewerApi['Scene']>,
    OnChange: (_listener: ViewerChangeListener) => () => undefined,
    SetUiHidden: (value: boolean) => {
      hidden = value;
    },
    UiHidden: () => hidden
  };

  return {
    api,
    reads: () => reads,
    setHidden: (value) => {
      hidden = value;
    }
  };
}

describe('ConsoleViewerService', () => {
  let engine: FakeEngine;
  let started: StartViewerOptions | undefined;

  function setup(starter: (options: StartViewerOptions) => Promise<ViewerApi>): ConsoleViewerService {
    TestBed.configureTestingModule({ providers: [{ provide: CONSOLE_ENGINE_STARTER, useValue: starter }] });
    return TestBed.inject(ConsoleViewerService);
  }

  beforeEach(() => {
    engine = makeFakeEngine();
    started = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.classList.remove(CONSOLE_UI_HIDDEN_CLASS);
  });

  it('starts the engine once with the console store prefix and reads its views', async () => {
    const service = setup(async (options) => {
      started = options;
      return engine.api;
    });
    const canvas = document.createElement('canvas');

    const api = await service.start(canvas);
    const again = await service.start(canvas);

    expect(api).toBe(engine.api);
    expect(again).toBe(engine.api);
    expect(started?.canvas).toBe(canvas);
    expect(started?.store?.prefix).toBe(CONSOLE_STORE_PREFIX);
    expect(service.state()).toBe('running');
    expect(service.sceneName()).toBe('fake');
    expect(service.time()?.tick).toBe(1);
  });

  it('reports a failed start', async () => {
    const service = setup(async () => {
      throw new Error('no engine');
    });

    const api = await service.start(document.createElement('canvas'));

    expect(api).toBeUndefined();
    expect(service.state()).toBe('failed');
    expect(service.error()).toBe('no engine');
  });

  it('throttles tick and scene changes to one read per refresh period', async () => {
    vi.useFakeTimers();
    const service = setup(async (options) => {
      started = options;
      return engine.api;
    });
    await service.start(document.createElement('canvas'));
    const readsAfterStart = engine.reads();

    for (let i = 0; i < 20; i += 1) {
      started?.onChange?.('tick');
      started?.onChange?.('scene');
    }

    expect(engine.reads()).toBe(readsAfterStart);
    vi.advanceTimersByTime(CONSOLE_PANEL_REFRESH_MS);
    expect(engine.reads()).toBe(readsAfterStart + 1);

    started?.onChange?.('tick');
    vi.advanceTimersByTime(CONSOLE_PANEL_REFRESH_MS);
    expect(engine.reads()).toBe(readsAfterStart + 2);
  });

  it('hides the console UI at once on a ui change', async () => {
    const service = setup(async (options) => {
      started = options;
      return engine.api;
    });
    await service.start(document.createElement('canvas'));

    engine.setHidden(true);
    started?.onChange?.('ui');

    expect(service.uiHidden()).toBe(true);
    expect(document.body.classList.contains(CONSOLE_UI_HIDDEN_CLASS)).toBe(true);

    engine.setHidden(false);
    started?.onChange?.('ui');

    expect(service.uiHidden()).toBe(false);
    expect(document.body.classList.contains(CONSOLE_UI_HIDDEN_CLASS)).toBe(false);
  });
});
