import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ConsoleFleetCardComponent } from './console-fleet-card.component';
import { ConsoleViewerService } from './console-viewer.service';

/**
 * The right-side panel: a card per fleet in the live scene (ConsoleViewerService.fleets, 4 Hz).
 */
@Component({
  selector: 'console-fleet-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConsoleFleetCardComponent],
  template: `
    <div class="console-fleet-panel">
      @for (fleet of viewer.fleets(); track fleet.id) {
        <console-fleet-card [fleet]="fleet"></console-fleet-card>
      }
    </div>
  `,
  styles: `
    /* the cards take the pointer (console-panel); the space between them leaves drags to the canvas, and the wheel
       over a card still scrolls this column */
    :host {
      display: block;
      overflow-y: auto;
      pointer-events: none;
    }

    .console-fleet-panel {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
  `
})
export class ConsoleFleetPanelComponent {
  readonly viewer = inject(ConsoleViewerService);
}
