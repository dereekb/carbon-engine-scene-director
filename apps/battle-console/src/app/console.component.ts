import { ChangeDetectionStrategy, Component, DOCUMENT, afterNextRender, inject } from '@angular/core';
import { ConsoleRunBarComponent } from './console-run-bar.component';
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
  imports: [ConsoleStatusComponent, ConsoleRunBarComponent],
  template: `
    <div class="console-ui">
      <console-status class="console-ui-status"></console-status>
      <console-run-bar class="console-ui-run-bar"></console-run-bar>
    </div>
  `,
  styles: `
    .console-ui {
      position: fixed;
      inset: 0;
      pointer-events: none;
    }

    .console-ui-status {
      position: absolute;
      top: 12px;
      left: 12px;
      max-width: 420px;
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

  constructor() {
    afterNextRender(() => {
      const canvas = this._document.getElementById(CONSOLE_CANVAS_ID);

      if (canvas instanceof HTMLCanvasElement) {
        void this.viewer.start(canvas);
      }
    });
  }
}
