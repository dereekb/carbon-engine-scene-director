import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatOption, MatSelect } from '@angular/material/select';
import { MatTooltip } from '@angular/material/tooltip';
import { ConsoleViewerService } from './console-viewer.service';

/**
 * The rates the run bar offers (time_control rate).
 */
export const CONSOLE_RUN_RATES: readonly number[] = [0.25, 0.5, 1, 2, 4];

/**
 * How far back the run bar's back button jumps, scene seconds (as ← on the page).
 */
export const CONSOLE_RUN_BACK_SECONDS = 10;

/**
 * The run bar: play / pause, the rate and back 10 s (time_control), and the director camera (auto_camera), each one
 * page tool call through ViewerApi.Call.
 */
@Component({
  selector: 'console-run-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconButton, MatIcon, MatSelect, MatOption, MatTooltip],
  template: `
    <div class="console-run-bar" data-ui>
      <button mat-icon-button type="button" (click)="togglePause()" [disabled]="!running()" [matTooltip]="paused() ? 'Play (Space)' : 'Pause (Space)'">
        <mat-icon>{{ paused() ? 'play_arrow' : 'pause' }}</mat-icon>
      </button>
      <button mat-icon-button type="button" (click)="back()" [disabled]="!running()" matTooltip="Back 10 s">
        <mat-icon>replay_10</mat-icon>
      </button>
      <mat-select class="console-run-rate" [value]="rate()" (valueChange)="setRate($event)" [disabled]="!running()" aria-label="Rate">
        @for (option of rates; track option) {
          <mat-option [value]="option">x{{ option }}</mat-option>
        }
      </mat-select>
      <button mat-icon-button type="button" (click)="toggleDirector()" [disabled]="!running()" [matTooltip]="director() ? 'Free camera' : 'Director camera'">
        <mat-icon>{{ director() ? 'videocam' : 'videocam_off' }}</mat-icon>
      </button>
      @if (error(); as text) {
        <span class="console-run-error">{{ text }}</span>
      }
    </div>
  `,
  styles: `
    .console-run-bar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 6px;
      background: rgba(8, 12, 20, 0.78);
      border: 1px solid rgba(120, 150, 190, 0.25);
      pointer-events: auto;
    }

    .console-run-rate {
      width: 72px;
    }

    .console-run-error {
      color: #ff8a80;
      font-size: 12px;
    }
  `
})
export class ConsoleRunBarComponent {
  readonly viewer = inject(ConsoleViewerService);
  readonly rates = CONSOLE_RUN_RATES;

  readonly running = computed(() => this.viewer.state() === 'running');
  readonly paused = computed(() => this.viewer.time()?.paused ?? false);
  readonly rate = computed(() => this.viewer.time()?.rate ?? 1);
  readonly director = signal(false);
  readonly error = signal<string | undefined>(undefined);

  togglePause(): void {
    void this.call('time_control', { pause: !this.paused() });
  }

  back(): void {
    void this.call('time_control', { back: CONSOLE_RUN_BACK_SECONDS });
  }

  setRate(rate: number): void {
    void this.call('time_control', { rate });
  }

  toggleDirector(): void {
    const on = !this.director();
    void this.call('auto_camera', { on }).then((ok) => ok && this.director.set(on));
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<boolean> {
    const api = this.viewer.api;
    let ok = false;

    if (api) {
      try {
        await api.Call(tool, args);
        this.error.set(undefined);
        ok = true;
      } catch (error) {
        this.error.set(error instanceof Error ? error.message : String(error));
      }

      this.viewer.flush();
    }

    return ok;
  }
}
