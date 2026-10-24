/**
 * Whether a key belongs to the page's UI rather than to the scene: the engine's keys (Space, [ ], ←, H, L, C, D) skip
 * a key event whose target or focused element sits inside an element marked `data-ui`, or is form-like (a native
 * control, an editable element, or an element whose ARIA role takes keys: an Angular Material `mat-select` is a
 * `combobox` div, which a native-element check misses).
 */

/**
 * The selector a UI host matches: elements marked `data-ui`, native controls, editable elements and key-taking roles.
 */
export const UI_FOCUS_SELECTOR = [
  '[data-ui]',
  'input',
  'textarea',
  'select',
  'button',
  '[contenteditable]:not([contenteditable="false"])',
  ...['textbox', 'searchbox', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'menu', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'radio', 'checkbox', 'switch', 'tab', 'button', 'gridcell', 'treeitem'].map((role) => `[role="${role}"]`)
].join(', ');

/**
 * The minimal element shape the check reads (DOM `Element`), so node specs can pass a stand-in.
 */
export interface UiFocusElement {
  closest(selector: string): unknown;
}

/**
 * Whether a key event is the UI's: its target, or the focused element, is inside a UI host.
 *
 * @param target - The event's target.
 * @param focused - The document's active element.
 * @returns True when the engine's keys should ignore the event.
 */
export function IsUiKeyEvent(target: unknown, focused: unknown): boolean {
  return IsUiElement(target) || IsUiElement(focused);
}

/**
 * Whether an element sits inside a UI host (UI_FOCUS_SELECTOR).
 *
 * @param element - Any value; non-elements are not UI.
 * @returns True when it or an ancestor matches.
 */
export function IsUiElement(element: unknown): boolean {
  const closest = element != null && typeof element === 'object' ? (element as Partial<UiFocusElement>).closest : null;
  return typeof closest === 'function' && closest.call(element, UI_FOCUS_SELECTOR) != null;
}
