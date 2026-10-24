import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ConsoleViewerService } from './console-viewer.service';

/**
 * The read-only status: the engine's state, the scene, the clock and the timeline (the viewer's overlay, as a
 * component).
 */
@Component({
  selector: 'console-status',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="console-status" data-ui>
      @switch (viewer.state()) {
        @case ('running') {
          <div class="console-status-title">{{ viewer.sceneName() ?? 'No scene' }}</div>
          <div class="console-status-line">{{ viewer.shipCount() }} ships, {{ viewer.fleets().length }} fleets</div>
          <div class="console-status-line">{{ clockText() }}</div>
          @if (timelineText(); as text) {
            <div class="console-status-line">{{ text }}</div>
          }
        }
        @case ('failed') {
          <div class="console-status-title">The engine did not start</div>
          <div class="console-status-line">{{ viewer.error() }}</div>
        }
        @default {
          <div class="console-status-title">Starting the engine...</div>
        }
      }
    </div>
  `,
  styles: `
    .console-status {
      padding: 8px 12px;
      border-radius: 6px;
      background: rgba(8, 12, 20, 0.78);
      border: 1px solid rgba(120, 150, 190, 0.25);
      color: #cfd8e6;
      font-size: 13px;
      line-height: 1.4;
      pointer-events: auto;
    }

    .console-status-title {
      font-weight: 600;
    }
  `
})
export class ConsoleStatusComponent {
  readonly viewer = inject(ConsoleViewerService);

  readonly clockText = computed(() => {
    const time = this.viewer.time();
    let text = '';

    if (time) {
      const state = time.paused ? 'paused' : `x${time.rate}`;
      text = `t ${time.seconds.toFixed(1)} s (tick ${time.tick}), ${state}`;
    }

    return text;
  });

  readonly timelineText = computed(() => {
    const timeline = this.viewer.timeline();
    return timeline ? `timeline ${timeline.state} at ${timeline.time} s, ${timeline.cues.total} cues` : undefined;
  });
}
