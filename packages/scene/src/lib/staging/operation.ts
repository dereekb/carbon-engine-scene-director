import type { JsonObject } from '../json';
import type { FleetOperationContext } from '../fleets';
import { applyAddShips } from './add-ships';
import { applyStageEngagement } from './engagement';

/**
 * The patch operations that stage ships: `add_ships` and `stage_engagement`.
 */
export const STAGING_OPERATIONS: ReadonlySet<string> = new Set(['add_ships', 'stage_engagement']);

/**
 * Applies one staging operation (see STAGING_OPERATIONS) to a draft. Pure and synchronous, like every patch
 * operation: the add_ships and stage_engagement tools resolve hull names, compositions, celestials and radii first.
 *
 * @param operation - The operation, with its "op".
 * @param context - The draft and where problems and warnings go.
 */
export function applyStagingOperation(operation: JsonObject, context: FleetOperationContext): void {
  if (operation['op'] === 'add_ships') applyAddShips(operation, context);
  else if (operation['op'] === 'stage_engagement') applyStageEngagement(operation, context);
  else context.problems.push(`${context.where}: unknown op "${String(operation['op'])}"`);
}
