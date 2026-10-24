import { ChangeDetectionStrategy, Component, DOCUMENT, afterNextRender, inject } from '@angular/core';
import { ConsoleDropOverlayComponent } from './console-drop-overlay.component';
import { ConsoleFleetPanelComponent } from './console-fleet-panel.component';
import { ConsoleRunBarComponent } from './console-run-bar.component';
import { ConsoleScenarioCardComponent } from './console-scenario-card.component';
import { ConsoleScenarioService } from './console-scenario.service';
import { ConsoleStatusComponent } from './console-status.component';
import { ConsoleViewerService } from './console-viewer.service';

/**
 * The id of the canvas index.html carries (the engine draws to it; the console's UI sits over it).
 */
export const CONSOLE_CANVAS_ID = 'view';

/**
 * The console's root: starts the engine on the page's canvas and lays the UI over it.
 */
@Component({
  selector: 'console-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConsoleStatusComponent, ConsoleScenarioCardComponent, ConsoleFleetPanelComponent, ConsoleRunBarComponent, ConsoleDropOverlayComponent],
  template: `
    <div class="console-ui">
      <div class="console-ui-left">
        <console-status></console-status>
        <console-scenario-card></console-scenario-card>
      </div>
      <console-fleet-panel class="console-ui-fleets"></console-fleet-panel>
      <console-run-bar class="console-ui-run-bar"></console-run-bar>
    </div>
    <console-drop-overlay></console-drop-overlay>
  `,
  styles: `
    .console-ui {
      position: fixed;
      inset: 0;
      pointer-events: none;
    }

    .console-ui-left {
      position: absolute;
      top: 12px;
      left: 12px;
      max-width: 360px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .console-ui-fleets {
      position: absolute;
      top: 12px;
      right: 12px;
      bottom: 72px;
      width: 360px;
    }

    .console-ui-run-bar {
      position: absolute;
      bottom: 12px;
      left: 50%;
      transform: translateX(-50%);
    }
  `
})
export class ConsoleComponent {
  private readonly _document = inject(DOCUMENT);
  readonly viewer = inject(ConsoleViewerService);
  readonly scenario = inject(ConsoleScenarioService);

  constructor() {
    afterNextRender(() => {
      const canvas = this._document.getElementById(CONSOLE_CANVAS_ID);

      if (canvas instanceof HTMLCanvasElement) {
        void this.viewer.start(canvas);
      }

      void this.scenario.restore();
    });
  }
}
