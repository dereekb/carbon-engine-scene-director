import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DbxButtonComponent, DbxFileUploadButtonComponent, type DbxFileUploadFilesChangedEvent } from '@dereekb/dbx-web';
import { CONSOLE_DROP_ACCEPT, pickedConsoleFiles } from './console-files';
import { ConsoleScenarioService, type ConsoleScenarioState } from './console-scenario.service';
import { ConsoleViewerService } from './console-viewer.service';

const CONSOLE_SCENARIO_STATE_TEXT: Record<ConsoleScenarioState, string> = {
  none: 'No scenario: drop one anywhere, or Load',
  loading: 'Staging…',
  loaded: 'Running',
  restored: 'Restored from the last visit',
  failed: 'The last load failed'
};

/**
 * The current scenario: its name, description and state, the warnings staging gave, Load (the files picker) and Reset
 * (with a confirmation: re-stage the scenario with your settings; a scene no scenario built restarts its timeline).
 */
@Component({
  selector: 'console-scenario-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DbxButtonComponent, DbxFileUploadButtonComponent],
  template: `
    <div class="console-scenario-card console-panel" data-ui>
      <div class="console-scenario-title">{{ title() }}</div>
      @if (scenario()?.description; as description) {
        <div class="console-scenario-description">{{ description }}</div>
      }
      <div class="console-scenario-state">{{ stateText() }}</div>
      @if (warnings().length) {
        <ul class="console-scenario-warnings">
          @for (warning of warnings(); track $index) {
            <li>{{ warning }}</li>
          }
        </ul>
      }
      <div class="console-scenario-actions">
        <dbx-file-upload-button class="console-scenario-load" text="Load" icon="upload_file" [multiple]="true" [accept]="accept" [disabled]="!running() || busy()" (filesChanged)="picked($event)"></dbx-file-upload-button>
        <dbx-button class="console-scenario-reset" text="Reset" icon="restart_alt" [stroked]="true" [disabled]="!running() || busy() || !hasScene()" (buttonClick)="reset()"></dbx-button>
      </div>
    </div>
  `,
  styles: `
    .console-scenario-title {
      font-size: 15px;
      font-weight: 500;
    }

    .console-scenario-description,
    .console-scenario-state {
      font-size: 12px;
      opacity: 0.8;
      margin-top: 2px;
    }

    .console-scenario-warnings {
      margin: 4px 0 0;
      padding-left: 16px;
      font-size: 11px;
      color: var(--mat-sys-tertiary);
    }

    .console-scenario-actions {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
  `
})
export class ConsoleScenarioCardComponent {
  private readonly _viewer = inject(ConsoleViewerService);
  private readonly _scenario = inject(ConsoleScenarioService);

  readonly accept = CONSOLE_DROP_ACCEPT;
  readonly scenario = this._scenario.scenario;
  readonly warnings = this._scenario.warnings;
  readonly busy = this._scenario.busy;
  readonly running = computed(() => this._viewer.state() === 'running');
  readonly hasScene = computed(() => this._viewer.scene() != null);
  readonly title = computed(() => {
    const scenario = this.scenario();
    return scenario ? (scenario.name ?? scenario.id) : (this._viewer.sceneName() ?? 'Battle console');
  });
  readonly stateText = computed(() => (this.scenario() == null && this.hasScene() && this._scenario.state() === 'none' ? 'A scene no scenario built: Reset restarts its timeline' : CONSOLE_SCENARIO_STATE_TEXT[this._scenario.state()]));

  picked(event: DbxFileUploadFilesChangedEvent): void {
    void this._scenario.drop(pickedConsoleFiles(event.matchResult.accepted));
  }

  reset(): void {
    void this._scenario.reset();
  }
}
