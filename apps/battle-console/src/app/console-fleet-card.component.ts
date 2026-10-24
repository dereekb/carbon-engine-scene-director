import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatOption, MatSelect } from '@angular/material/select';
import { MatTooltip } from '@angular/material/tooltip';
import { DbxButtonComponent } from '@dereekb/dbx-web';
import type { Maybe } from '@dereekb/util';
import { DEFAULT_FLEET_DOCTRINE, fromFleetSettingsFormValue, toFleetCardView, toFleetCommandCall, toFleetSettingsFormValue, toFleetTargetRows, type FleetCommand } from '@scene-director/battle';
import { BUILT_IN_FLEET_PERSONALITY_NAMES } from '@scene-director/scene';
import type { FleetView } from '@scene-director/viewer-engine/api';
import { openConsoleFleetSettingsDialog } from './console-fleet-settings';
import { ConsoleScenarioService } from './console-scenario.service';
import { ConsoleViewerService } from './console-viewer.service';

/**
 * The command bar's buttons, in order (packages/battle commands.ts makes each one's tool call).
 */
export const CONSOLE_FLEET_BAR: readonly { readonly command: FleetCommand; readonly text: string; readonly icon: string; readonly tip: string }[] = [
  { command: 'engage', text: 'Engage', icon: 'swords', tip: 'Hand the fleet back to its FC brain and engage now' },
  { command: 'hold-position', text: 'Hold', icon: 'anchor', tip: 'Hold position (calls and free fire go on)' },
  { command: 'pull-range', text: 'Pull range', icon: 'open_in_full', tip: 'Kite at the ideal range' },
  { command: 'dive-close', text: 'Dive', icon: 'close_fullscreen', tip: 'Brawl close, prop mods on' },
  { command: 'retreat', text: 'Retreat', icon: 'turn_left', tip: 'Align to the out (the settings’ retreat, or away)' },
  { command: 'warp-out', text: 'Warp out', icon: 'rocket_launch', tip: 'Warp to the out' },
  { command: 'hold-fire', text: 'Hold fire', icon: 'block', tip: 'Cease fire (Engage releases it)' }
];

/**
 * One fleet's card: the FC and its state, alive, engaged, the primary and HP; the command bar (disabled while arriving
 * or without a brain); the target list (call a primary, clear it); Settings (the FC settings dialog); a doctrine picker
 * for a fleet with no brain. A lone personality file dropped on the card becomes its doctrine.
 */
@Component({
  selector: 'console-fleet-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DbxButtonComponent, MatSelect, MatOption, MatTooltip],
  // CONSOLE_FLEET_DROP_ATTRIBUTE: the window drop routes a lone personality to this fleet
  host: { '[attr.data-console-fleet]': 'fleet().id' },
  template: `
    <div class="console-fleet-card console-panel" data-ui [attr.data-fleet]="card().id">
      <div class="console-fleet-head">
        <span class="console-fleet-title">{{ card().title }}</span>
        @if (card().team) {
          <span class="console-fleet-team">{{ card().team }}</span>
        }
        <span class="console-fleet-alive">{{ card().aliveText }}</span>
      </div>
      <div class="console-fleet-line">FC {{ card().fc }}: {{ card().stateText }}</div>
      <div class="console-fleet-line">
        {{ card().engaged ? 'Engaged' : 'Not engaged' }}@if (card().stance) {, {{ card().stance }}}@if (card().held) {, holding fire}@if (card().freeFire) {, free fire}
      </div>
      <div class="console-fleet-line">Primary {{ card().primary ?? 'none' }}@if (hasHealth()) { · HP {{ card().healthPercent }}%}</div>
      @if (card().manual.length) {
        <div class="console-fleet-line console-fleet-manual">You hold: {{ card().manual.join(', ') }}</div>
      }
      @if (card().offerDoctrine) {
        <div class="console-fleet-doctrine">
          <mat-select class="console-fleet-doctrine-select" [value]="doctrine()" (valueChange)="doctrine.set($event)" aria-label="Doctrine">
            @for (name of doctrines(); track name) {
              <mat-option [value]="name">{{ name }}</mat-option>
            }
          </mat-select>
          <dbx-button class="console-fleet-doctrine-apply" text="Give a doctrine" [stroked]="true" (buttonClick)="giveDoctrine()"></dbx-button>
        </div>
      } @else {
        <div class="console-fleet-bar" [matTooltip]="card().commandsBlocked ?? ''">
          @for (button of bar; track button.command) {
            <dbx-button [class]="'console-fleet-command console-fleet-' + button.command" [text]="button.text" [icon]="button.icon" [stroked]="true" [disabled]="blocked()" [matTooltip]="button.tip" (buttonClick)="run(button.command)"></dbx-button>
          }
        </div>
      }
      @if (targets().length) {
        <table class="console-fleet-targets">
          @for (row of targets(); track row.id) {
            <tr [class.console-fleet-target-called]="row.called === 'primary'" [class.console-fleet-target-out]="!row.inReach">
              <td>{{ row.id }}</td>
              <td>{{ row.role }}</td>
              <td>{{ row.distanceText }}</td>
              <td>{{ row.healthPercent }}%</td>
              <td>
                @if (row.called === 'primary') {
                  <button type="button" class="console-fleet-target-clear" [disabled]="blocked()" (click)="run('clear-call')">Clear</button>
                } @else {
                  <button type="button" class="console-fleet-target-call" [disabled]="blocked()" (click)="run('call-primary', row.id)">Call</button>
                }
              </td>
            </tr>
          }
        </table>
      }
      <div class="console-fleet-foot">
        <dbx-button class="console-fleet-settings" text="Settings" icon="tune" (buttonClick)="openSettings()"></dbx-button>
        @if (error(); as text) {
          <span class="console-fleet-error">{{ text }}</span>
        }
      </div>
    </div>
  `,
  styles: `
    .console-fleet-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }

    .console-fleet-title {
      font-size: 15px;
      font-weight: 500;
    }

    .console-fleet-team,
    .console-fleet-alive {
      font-size: 12px;
      opacity: 0.75;
    }

    .console-fleet-alive {
      margin-left: auto;
    }

    .console-fleet-line {
      font-size: 12px;
    }

    .console-fleet-manual {
      color: var(--mat-sys-tertiary);
    }

    .console-fleet-bar,
    .console-fleet-doctrine,
    .console-fleet-foot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      margin-top: 6px;
    }

    .console-fleet-doctrine-select {
      width: 140px;
    }

    .console-fleet-targets {
      width: 100%;
      margin-top: 6px;
      font-size: 11px;
      border-collapse: collapse;
    }

    .console-fleet-targets td {
      padding: 1px 4px;
    }

    .console-fleet-target-called {
      color: var(--mat-sys-primary);
    }

    .console-fleet-target-out {
      opacity: 0.55;
    }

    .console-fleet-targets button {
      font-size: 11px;
      padding: 0 6px;
      cursor: pointer;
    }

    .console-fleet-error {
      color: var(--mat-sys-error);
      font-size: 12px;
    }
  `
})
export class ConsoleFleetCardComponent {
  private readonly _viewer = inject(ConsoleViewerService);
  private readonly _scenario = inject(ConsoleScenarioService);
  private readonly _matDialog = inject(MatDialog);

  readonly fleet = input.required<FleetView>();
  readonly bar = CONSOLE_FLEET_BAR;

  readonly card = computed(() => toFleetCardView(this.fleet()));
  readonly targets = computed(() => toFleetTargetRows(this.fleet()));
  readonly blocked = computed(() => this.card().commandsBlocked != null);
  readonly hasHealth = computed(() => this.card().healthPercent != null);
  readonly settings = computed(() => this._scenario.scenario()?.sides.find((side) => side.fleet === this.fleet().id)?.settings);
  readonly doctrines = computed(() => [...new Set([...BUILT_IN_FLEET_PERSONALITY_NAMES, ...Object.keys(this._scenario.scenario()?.personalities ?? {})])]);
  readonly doctrine = signal(DEFAULT_FLEET_DOCTRINE);
  readonly error = signal<Maybe<string>>(undefined);

  /**
   * Runs a command button (or a target row's Call / Clear) through ViewerApi.Call.
   *
   * @param command - The command.
   * @param target - Call-primary's hostile.
   */
  async run(command: FleetCommand, target?: string): Promise<void> {
    const api = this._viewer.api;

    if (api) {
      try {
        const call = toFleetCommandCall({ command, fleet: this.fleet(), target, retreat: this.settings()?.retreat, fleets: this._viewer.fleets() });
        await api.Call(call.tool, call.args);
        this.error.set(undefined);
      } catch (error) {
        this.error.set(error instanceof Error ? error.message : String(error));
      }

      this._viewer.flush();
    }
  }

  /**
   * Opens the FC settings; Apply sends them live (patch_scene) and merges them into the console's scenario.
   */
  async openSettings(): Promise<void> {
    const fleet = this.fleet();
    const value = await openConsoleFleetSettingsDialog(this._matDialog, { fleet: fleet.name ?? fleet.id, doctrines: this.doctrines(), value: toFleetSettingsFormValue(this.settings()) });

    if (value) {
      await this._scenario.applyFleetSettings(fleet.id, fromFleetSettingsFormValue(value));
    }
  }

  /**
   * Gives a fleet with no brain the picked doctrine (set_personalities and update_fleet set personality).
   */
  async giveDoctrine(): Promise<void> {
    await this._scenario.applyFleetSettings(this.fleet().id, { personality: this.doctrine() });
  }
}
