import { describe, expect, it } from 'vitest';
import { IsUiElement, IsUiKeyEvent, UI_FOCUS_SELECTOR } from './ui-focus';

/**
 * An element stand-in that matches when any of its own selectors is in the asked list (closest walks no ancestors here).
 */
function Element(...matches: string[]): { closest(selector: string): unknown } {
  return { closest: (selector: string) => (selector.split(', ').some((each) => matches.includes(each)) ? {} : null) };
}

describe('IsUiKeyEvent', () => {
  it('skips keys inside a data-ui host, a native control or a key-taking role (a mat-select is a combobox)', () => {
    expect(IsUiElement(Element('[data-ui]'))).toBe(true);
    expect(IsUiElement(Element('input'))).toBe(true);
    expect(IsUiElement(Element('[role="combobox"]'))).toBe(true);
    expect(IsUiElement(Element('[role="slider"]'))).toBe(true);
    expect(IsUiElement(Element('canvas'))).toBe(false);
  });

  it('reads the target or the focused element, and ignores non-elements', () => {
    expect(IsUiKeyEvent(Element('canvas'), Element('[role="listbox"]'))).toBe(true);
    expect(IsUiKeyEvent(Element('button'), null)).toBe(true);
    expect(IsUiKeyEvent(null, undefined)).toBe(false);
    expect(IsUiKeyEvent({}, 'body')).toBe(false);
    expect(UI_FOCUS_SELECTOR).toContain('[contenteditable]');
  });
});
