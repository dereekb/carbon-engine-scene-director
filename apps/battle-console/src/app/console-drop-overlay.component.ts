import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { droppedConsoleFiles } from './console-files';
import { ConsoleScenarioService } from './console-scenario.service';

/**
 * The attribute a fleet card carries (its fleet id): a lone personality dropped on it becomes that fleet's doctrine.
 */
export const CONSOLE_FLEET_DROP_ATTRIBUTE = 'data-console-fleet';

/**
 * The window-level drop: dragging files anywhere over the console shows the overlay, and the drop loads them (a zip,
 * JSON parts, fits, several files or a folder, walked through webkitGetAsEntry). The overlay takes no pointer events,
 * so the drop's target is what lies under it: a fleet card routes the drop to its fleet.
 */
@Component({
  selector: 'console-drop-overlay',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIcon],
  host: {
    '(window:dragenter)': 'dragEnter($event)',
    '(window:dragover)': 'dragOver($event)',
    '(window:dragleave)': 'dragLeave($event)',
    '(window:drop)': 'dropped($event)'
  },
  template: `
    @if (active()) {
      <div class="console-drop-overlay">
        <div class="console-drop-overlay-text">
          <mat-icon>upload_file</mat-icon>
          <span>Drop a scenario (zip, JSON, fits or a folder), or a personality on a fleet card</span>
        </div>
      </div>
    }
  `,
  styles: `
    .console-drop-overlay {
      position: fixed;
      inset: 0;
      pointer-events: none;
      border: 3px dashed var(--mat-sys-primary);
      background: rgba(8, 12, 20, 0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 900;
    }

    .console-drop-overlay-text {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 18px;
      border-radius: 8px;
      background: rgba(8, 12, 20, 0.85);
      font-size: 16px;
    }
  `
})
export class ConsoleDropOverlayComponent {
  private readonly _scenario = inject(ConsoleScenarioService);
  private _depth = 0;

  readonly active = signal(false);

  dragEnter(event: DragEvent): void {
    if (this.carriesFiles(event)) {
      this._depth += 1;
      this.active.set(true);
    }
  }

  dragOver(event: DragEvent): void {
    if (this.carriesFiles(event)) {
      // allows the drop anywhere (the canvas and the panels alike)
      event.preventDefault();

      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
    }
  }

  dragLeave(event: DragEvent): void {
    if (this.carriesFiles(event)) {
      this._depth = Math.max(0, this._depth - 1);
      this.active.set(this._depth > 0);
    }
  }

  dropped(event: DragEvent): void {
    this._depth = 0;
    this.active.set(false);

    if (event.dataTransfer && this.carriesFiles(event)) {
      event.preventDefault();
      const fleet = event.target instanceof Element ? event.target.closest(`[${CONSOLE_FLEET_DROP_ATTRIBUTE}]`)?.getAttribute(CONSOLE_FLEET_DROP_ATTRIBUTE) : undefined;
      // the items are only readable during the event: collect the entries now, read them after
      void droppedConsoleFiles(event.dataTransfer).then((files) => this._scenario.drop(files, fleet ?? undefined));
    }
  }

  private carriesFiles(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes('Files') ?? false;
  }
}
