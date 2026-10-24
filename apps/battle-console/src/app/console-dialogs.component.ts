import { ChangeDetectionStrategy, Component, Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { AbstractDialogDirective, DbxButtonComponent, DbxDialogContentDirective, DbxPromptConfirmDialogComponent, type DbxPromptConfirmConfig } from '@dereekb/dbx-web';
import { firstValueFrom } from 'rxjs';
import { ConsoleDialogs, type ConsoleProblemsDialogData, type ConsoleSameScenarioChoice, type ConsoleSameScenarioDialogData } from './console-dialogs';

/**
 * Lists every problem at once.
 */
@Component({
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DbxDialogContentDirective, DbxButtonComponent],
  template: `
    <dbx-dialog-content class="console-problems" data-ui>
      <h3>{{ data.title }}</h3>
      <ul class="console-problems-list">
        @for (problem of data.problems; track $index) {
          <li>{{ problem }}</li>
        }
      </ul>
      @if (data.warnings?.length) {
        <p class="console-problems-warnings-title">Warnings</p>
        <ul class="console-problems-warnings">
          @for (warning of data.warnings; track $index) {
            <li>{{ warning }}</li>
          }
        </ul>
      }
      <dbx-button text="Close" [stroked]="true" (buttonClick)="close()"></dbx-button>
    </dbx-dialog-content>
  `,
  styles: `
    .console-problems-list li {
      color: var(--mat-sys-error);
    }

    .console-problems-warnings li {
      opacity: 0.8;
    }
  `
})
export class ConsoleProblemsDialogComponent extends AbstractDialogDirective<void, ConsoleProblemsDialogData> {}

/**
 * The running scenario dropped again: "Apply settings to the running battle" (the default, no restart; setup changes
 * wait for Reset), "Load as a new run", or Cancel.
 */
@Component({
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DbxDialogContentDirective, DbxButtonComponent],
  template: `
    <dbx-dialog-content class="console-same-scenario" data-ui>
      <h3>{{ data.name }} is running</h3>
      <p>Apply its settings to the running battle (setup changes wait for Reset), or load it as a new run?</p>
      <div class="console-dialog-actions">
        <dbx-button class="console-same-scenario-apply" text="Apply settings to the running battle" [raised]="true" color="primary" (buttonClick)="close('apply')"></dbx-button>
        <dbx-button class="console-same-scenario-new" text="Load as a new run" [stroked]="true" (buttonClick)="close('new')"></dbx-button>
        <dbx-button text="Cancel" (buttonClick)="close()"></dbx-button>
      </div>
    </dbx-dialog-content>
  `
})
export class ConsoleSameScenarioDialogComponent extends AbstractDialogDirective<ConsoleSameScenarioChoice, ConsoleSameScenarioDialogData> {}

/**
 * The console's dialogs on MatDialog: DbxPromptConfirmDialogComponent for confirmations, and the two dialogs above.
 */
@Injectable()
export class ConsoleMatDialogs extends ConsoleDialogs {
  private readonly _matDialog = inject(MatDialog);

  /**
   * Asks to confirm.
   *
   * @param config - The prompt.
   * @returns True when confirmed.
   */
  override async confirm(config: DbxPromptConfirmConfig): Promise<boolean> {
    const confirmed: unknown = await firstValueFrom(DbxPromptConfirmDialogComponent.openDialog(this._matDialog, config).afterClosed());
    return confirmed === true;
  }

  /**
   * Asks what to do with the running scenario dropped again.
   *
   * @param name - The scenario's name.
   * @returns The choice, or null for Cancel.
   */
  override async chooseSameScenario(name: string): Promise<ConsoleSameScenarioChoice | undefined> {
    const choice: unknown = await firstValueFrom(this._matDialog.open(ConsoleSameScenarioDialogComponent, { data: { name } }).afterClosed());
    return choice === 'apply' || choice === 'new' ? choice : undefined;
  }

  /**
   * Lists problems.
   *
   * @param data - The title, the problems and any warnings.
   */
  override async showProblems(data: ConsoleProblemsDialogData): Promise<void> {
    await firstValueFrom(this._matDialog.open(ConsoleProblemsDialogComponent, { data }).afterClosed());
  }
}
