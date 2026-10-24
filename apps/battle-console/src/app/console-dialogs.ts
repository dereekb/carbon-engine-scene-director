import type { DbxPromptConfirmConfig } from '@dereekb/dbx-web';

/**
 * What the problems dialog lists: every problem normalizing, reading or staging found (and the hub's refusals), and
 * the warnings beside them.
 */
export interface ConsoleProblemsDialogData {
  readonly title: string;
  readonly problems: readonly string[];
  readonly warnings?: readonly string[];
}

/**
 * The answer to dropping the running scenario again: apply its settings live, or load it as a new run.
 */
export type ConsoleSameScenarioChoice = 'apply' | 'new';

export interface ConsoleSameScenarioDialogData {
  readonly name: string;
}

/**
 * The console's dialogs as promises: confirmations, the same-scenario choice and the problems list. Abstract so the
 * services that ask never import dbx-web's components (specs answer them; console.config.ts provides
 * ConsoleMatDialogs).
 */
export abstract class ConsoleDialogs {
  /**
   * Asks to confirm.
   *
   * @param config - The prompt.
   * @returns True when confirmed.
   */
  abstract confirm(config: DbxPromptConfirmConfig): Promise<boolean>;

  /**
   * Asks what to do with the running scenario dropped again.
   *
   * @param name - The scenario's name.
   * @returns The choice, or null for Cancel.
   */
  abstract chooseSameScenario(name: string): Promise<ConsoleSameScenarioChoice | undefined>;

  /**
   * Lists problems.
   *
   * @param data - The title, the problems and any warnings.
   */
  abstract showProblems(data: ConsoleProblemsDialogData): Promise<void>;
}
