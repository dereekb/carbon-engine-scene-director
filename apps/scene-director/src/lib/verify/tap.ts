/**
 * verify-page's report: each check's line as it finishes, in the default format (`ok    ` / `FAIL  ` / `skip  ` and a
 * closing tally) or, with `--tap`, as the TAP version 13 stream dbx-claude's test suites parse (sd-dev-env):
 *
 *   TAP version 13
 *   ok 1 - the tab connects to the hub
 *   not ok 2 - export: a 2 s beat writes 20 frames
 *   # expected 20 frames, got 18
 *   ok 3 - record: the encoder warms up # SKIP no GPU adapter
 *   1..3
 *
 * A run that cannot proceed ends with `Bail out! <reason>` (a stderr line in the default mode) and no plan line.
 */

import type { Maybe } from '@dereekb/util';

/**
 * Every check passed (skips included).
 */
export const VERIFY_EXIT_PASSED = 0;
/**
 * At least one check failed.
 */
export const VERIFY_EXIT_FAILED = 1;
/**
 * The run could not proceed: tools-core unreachable, a setup failure, an error outside a check, an `--only` that matched
 * nothing.
 */
export const VERIFY_EXIT_BAILED = 2;

export const TAP_VERSION_LINE = 'TAP version 13';

/**
 * How one check ended.
 */
export type VerifyOutcome = { readonly kind: 'ok'; readonly detail?: Maybe<string> } | { readonly kind: 'fail'; readonly message: string } | { readonly kind: 'skip'; readonly reason: string };

/**
 * Text on one line: every run of whitespace holding a line break becomes one space.
 *
 * @param text - Any text.
 * @returns The text without line breaks, trimmed.
 */
export function OneLine(text: string): string {
  return text.replaceAll(/\s*[\r\n]+\s*/gu, ' ').trim();
}

/**
 * A label as a TAP description: one line, with `\` and `#` escaped (TAP reads a bare `#` as a directive).
 *
 * @param label - The check's label.
 * @returns The escaped description.
 */
export function TapDescription(label: string): string {
  return OneLine(label).replaceAll('\\', String.raw`\\`).replaceAll('#', String.raw`\#`);
}

/**
 * A TAP diagnostic line.
 *
 * @param text - The diagnostic.
 * @returns `# <text>` on one line.
 */
export function TapDiagnostic(text: string): string {
  return `# ${OneLine(text)}`;
}

/**
 * One check's TAP lines: its point, then its detail or failure message as a diagnostic.
 *
 * @param number - The point's number, from 1.
 * @param label - The check's label.
 * @param outcome - How it ended.
 * @returns The point line and its diagnostic, if any.
 */
export function TapPoint(number: number, label: string, outcome: VerifyOutcome): string[] {
  const description = TapDescription(label);
  let lines: string[];
  switch (outcome.kind) {
    case 'ok':
      lines = [`ok ${number} - ${description}`, ...(outcome.detail ? [TapDiagnostic(outcome.detail)] : [])];
      break;
    case 'fail':
      lines = [`not ok ${number} - ${description}`, ...(OneLine(outcome.message) ? [TapDiagnostic(outcome.message)] : [])];
      break;
    case 'skip':
      lines = [`ok ${number} - ${description} # SKIP ${OneLine(outcome.reason)}`];
      break;
  }
  return lines;
}

/**
 * The TAP plan line that closes a completed run.
 *
 * @param count - The points written.
 * @returns `1..<count>`.
 */
export function TapPlan(count: number): string {
  return `1..${count}`;
}

/**
 * The TAP line for a run that cannot proceed.
 *
 * @param reason - Why.
 * @returns `Bail out! <reason>` on one line.
 */
export function TapBailOut(reason: string): string {
  return `Bail out! ${OneLine(reason)}`;
}

/**
 * One check's line in the default format.
 *
 * @param label - The check's label.
 * @param outcome - How it ended.
 * @returns `ok    <label> - <detail>`, `FAIL  <label> - <message>` or `skip  <label> - <reason>`.
 */
export function PlainLine(label: string, outcome: VerifyOutcome): string {
  let line: string;
  switch (outcome.kind) {
    case 'ok':
      line = outcome.detail ? `ok    ${label} - ${outcome.detail}` : `ok    ${label}`;
      break;
    case 'fail':
      line = `FAIL  ${label} - ${outcome.message}`;
      break;
    case 'skip':
      line = `skip  ${label} - ${outcome.reason}`;
      break;
  }
  return line;
}

/**
 * Where a report writes: stdout carries the results (and, with `--tap`, only the TAP stream); stderr the default mode's
 * bail line.
 */
export interface VerifyReportConfig {
  readonly tap: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/**
 * Writes each check's result the moment it ends, counts them, and closes the run with a plan line (or tally) or a bail.
 */
export class VerifyReport {
  readonly tap: boolean;
  private readonly out: (line: string) => void;
  private readonly err: (line: string) => void;
  private started = false;
  private points = 0;
  private passed = 0;
  private failures = 0;
  private skips = 0;

  constructor(config: VerifyReportConfig) {
    this.tap = config.tap;
    this.out = config.out;
    this.err = config.err;
  }

  /**
   * The checks reported so far.
   *
   * @returns Their count.
   */
  get count(): number {
    return this.points;
  }

  /**
   * The checks that failed so far.
   *
   * @returns Their count.
   */
  get failed(): number {
    return this.failures;
  }

  /**
   * Opens the stream once setup is done: the TAP version line (nothing in the default mode). Idempotent.
   */
  Start(): void {
    if (!this.started && this.tap) this.out(TAP_VERSION_LINE);
    this.started = true;
  }

  /**
   * Writes one check's result now.
   *
   * @param label - The check's label.
   * @param outcome - How it ended.
   */
  Point(label: string, outcome: VerifyOutcome): void {
    this.Start();
    this.points += 1;
    if (outcome.kind === 'ok') this.passed += 1;
    else if (outcome.kind === 'fail') this.failures += 1;
    else this.skips += 1;
    if (this.tap) TapPoint(this.points, label, outcome).forEach(this.out);
    else this.out(PlainLine(label, outcome));
  }

  /**
   * Writes a note that is not a check (the renderer, the SDE build, page errors): `info  <text>`, or a TAP diagnostic.
   *
   * @param text - The note.
   */
  Info(text: string): void {
    if (this.tap) this.out(TapDiagnostic(`info ${text}`));
    else this.out(`info  ${text}`);
  }

  /**
   * Closes a completed run: the TAP plan line, or the default mode's tally.
   *
   * @returns The exit code: 1 when a check failed, else 0.
   */
  End(): number {
    this.Start();
    if (this.tap) this.out(TapPlan(this.points));
    else this.out(`${this.passed} ok, ${this.failures} FAIL, ${this.skips} skip`);
    return this.failures ? VERIFY_EXIT_FAILED : VERIFY_EXIT_PASSED;
  }

  /**
   * Ends a run that cannot proceed: `Bail out! <reason>` after the version line, or a stderr line in the default mode.
   *
   * @param reason - Why the run stops.
   * @returns The exit code, 2.
   */
  BailOut(reason: string): number {
    if (this.tap) {
      this.Start();
      this.out(TapBailOut(reason));
    } else {
      this.err(`verify-page cannot run: ${OneLine(reason)}`);
    }
    return VERIFY_EXIT_BAILED;
  }
}
