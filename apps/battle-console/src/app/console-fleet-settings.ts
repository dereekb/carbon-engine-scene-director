import type { MatDialog } from '@angular/material/dialog';
import { DbxForgeActionDialogComponent, dbxForgeNumberField, dbxForgeTextField, dbxForgeToggleField, dbxForgeValueSelectionField } from '@dereekb/dbx-form';
import type { Maybe } from '@dereekb/util';
import { FLEET_SETTINGS_FIRE_MODES, type FleetSettingsFormValue } from '@scene-director/battle';
import { AUTO_REPAIR_POLICIES, FLEET_ENGAGE_RULES, FLEET_PROP_MOD_RULES, FLEET_STANCES, FLEET_TARGET_PREFERENCES, FLEET_TARGET_ROLES, FLEET_TARGET_SWITCHES } from '@scene-director/scene';
import { firstValueFrom } from 'rxjs';

const FIRE_MODE_LABELS: Record<(typeof FLEET_SETTINGS_FIRE_MODES)[number], string> = {
  focus: 'Focus (the FC calls)',
  free: 'Free fire',
  'focus-free': 'Focus + free fire'
};

const REACH_CHOICES = [
  { value: 'lock', label: 'Lock range' },
  { value: 'optimal', label: 'Optimal' },
  { value: 'falloff', label: 'Falloff' },
  { value: 'metres', label: 'Metres (below)' }
];

function selectionOptions(values: readonly string[]): { value: string; label: string }[] {
  return values.map((value) => ({ value, label: value }));
}

/**
 * Opens a fleet's FC settings: the doctrine base and its overrides (movement, opening fire, calls and free fire, the
 * target priority, reach, queue and switch), logi, the retreat and the advanced command and pilot traits. Blank fields
 * inherit the doctrine base.
 *
 * @param matDialog - The dialog service.
 * @param config - The fleet's name, the doctrines to offer and the current value.
 * @param config.fleet - The fleet's name, for the header.
 * @param config.doctrines - The doctrine bases (built-ins, the scenario's templates).
 * @param config.value - The fleet's current settings as a form value.
 * @returns The submitted value, or null when the dialog was closed.
 */
export async function openConsoleFleetSettingsDialog(matDialog: MatDialog, config: { readonly fleet: string; readonly doctrines: readonly string[]; readonly value: FleetSettingsFormValue }): Promise<Maybe<FleetSettingsFormValue>> {
  const ref = DbxForgeActionDialogComponent.openDialogWithForm<FleetSettingsFormValue>(matDialog, {
    header: `${config.fleet}: FC settings`,
    initialValue: config.value,
    submitButtonConfig: { text: 'Apply' },
    // openDialogWithForm's default 300px max height shows three of the form's fields at a time.
    dialog: { panelClass: 'console-fleet-settings-dialog', maxHeight: '85vh' },
    config: {
      fields: [
        dbxForgeValueSelectionField<string>({ key: 'doctrine', label: 'Doctrine', props: { options: selectionOptions(config.doctrines) } }),
        dbxForgeValueSelectionField<string>({ key: 'stance', label: 'Stance', props: { options: selectionOptions(FLEET_STANCES), addClearOption: 'Doctrine' } }),
        dbxForgeValueSelectionField<string>({ key: 'range', label: 'Range', props: { options: REACH_CHOICES, addClearOption: 'Doctrine' } }),
        dbxForgeNumberField({ key: 'rangeMetres', label: 'Range (m)', min: 0 }),
        dbxForgeValueSelectionField<string>({ key: 'propMods', label: 'Prop mods', props: { options: selectionOptions(FLEET_PROP_MOD_RULES), addClearOption: 'Doctrine' } }),
        dbxForgeValueSelectionField<string>({ key: 'engage', label: 'Opens fire', props: { options: selectionOptions(FLEET_ENGAGE_RULES), addClearOption: 'Doctrine' } }),
        dbxForgeValueSelectionField<string>({ key: 'fire', label: 'Fire', props: { options: FLEET_SETTINGS_FIRE_MODES.map((value) => ({ value, label: FIRE_MODE_LABELS[value] })), addClearOption: 'Doctrine' } }),
        dbxForgeTextField({ key: 'priority', label: 'Target priority', hint: `Roles in order, comma separated: ${FLEET_TARGET_ROLES.join(', ')}` }),
        dbxForgeValueSelectionField<string>({ key: 'prefer', label: 'Prefer', props: { options: selectionOptions(FLEET_TARGET_PREFERENCES), addClearOption: 'Doctrine' } }),
        dbxForgeValueSelectionField<string>({ key: 'reach', label: 'Calls reach', props: { options: REACH_CHOICES, addClearOption: 'Doctrine' } }),
        dbxForgeNumberField({ key: 'reachMetres', label: 'Calls reach (m)', min: 0 }),
        dbxForgeNumberField({ key: 'queue', label: 'Queue (called targets after the primary)', min: 0, max: 10 }),
        dbxForgeValueSelectionField<string>({ key: 'switch', label: 'Switch', props: { options: selectionOptions(FLEET_TARGET_SWITCHES), addClearOption: 'Doctrine' } }),
        dbxForgeValueSelectionField<string>({
          key: 'logiFormation',
          label: 'Logi',
          props: {
            options: [
              { value: 'follow', label: 'Follow the FC' },
              { value: 'loose', label: 'On their own' }
            ],
            addClearOption: 'As staged'
          }
        }),
        dbxForgeToggleField({ key: 'autoRepair', label: 'Logi auto-repair' }),
        dbxForgeValueSelectionField<string>({ key: 'autoRepairPolicy', label: 'Auto-repair picks', props: { options: selectionOptions(AUTO_REPAIR_POLICIES), addClearOption: 'Default' } }),
        dbxForgeTextField({ key: 'retreat', label: 'Retreat to', hint: 'away, a station, gate or celestial name, or x, y, z metres' }),
        dbxForgeNumberField({ key: 'ability', label: 'Advanced: command ability (0 to 1)', min: 0, max: 1 }),
        dbxForgeNumberField({ key: 'backups', label: 'Advanced: backup FCs', min: 0, max: 5 }),
        dbxForgeNumberField({ key: 'handover', label: 'Advanced: handover (s)', min: 0 }),
        dbxForgeNumberField({ key: 'reaction', label: 'Advanced: pilots’ reaction (s)', min: 0 })
      ]
    }
  });

  return (await firstValueFrom(ref.afterClosed())) ?? undefined;
}
