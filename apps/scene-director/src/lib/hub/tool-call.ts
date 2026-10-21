/**
 * What every tool caller shares: the in-process Hub and the RemoteHub that
 * drives a hub in another process present the same `Call` surface, and fail
 * with a ToolError whose details keep a scene document's problem list.
 */

/**
 * A tool's arguments, as the JSON object the caller sent.
 */
export type ToolArgs = Record<string, unknown>;

/**
 * Something that runs tools by name: an in-process Hub or a RemoteHub.
 */
export interface ToolCaller {
  readonly url: string;
  Call(name: string, args?: ToolArgs): Promise<unknown>;
  Stop(): Promise<void>;
}

/**
 * The JSON-safe form of an error, as it crosses the WebSocket.
 */
export interface SerializedError {
  readonly message: string;
  readonly problems?: string[];
}

/**
 * A tool call that failed in a way the caller should read.
 */
export class ToolError extends Error {
  readonly details: SerializedError | undefined;

  constructor(message: string, details?: SerializedError) {
    super(message);
    this.name = 'ToolError';
    this.details = details;
  }
}

/**
 * A JSON-safe error, keeping a SceneError's problem list.
 *
 * @param error - Whatever was thrown.
 * @returns The message, plus the problem list when the error carries one.
 */
export function ErrorToJson(error: unknown): SerializedError {
  const problems = ErrorProblems(error);
  return { message: ErrorMessage(error), ...(problems ? { problems } : {}) };
}

/**
 * The message of anything thrown.
 *
 * @param error - Whatever was thrown.
 * @returns Its message, or its string form.
 */
export function ErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The problem list a SceneError or a ToolError carries, if any.
 *
 * @param error - Whatever was thrown.
 * @returns The problems, or undefined.
 */
export function ErrorProblems(error: unknown): string[] | undefined {
  let problems: string[] | undefined;
  if (error instanceof ToolError) problems = error.details?.problems;
  else if (error && typeof error === 'object' && 'problems' in error && Array.isArray(error.problems)) problems = error.problems.map(String);
  return problems;
}
