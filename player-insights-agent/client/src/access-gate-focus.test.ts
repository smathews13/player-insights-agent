import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIALOG_FOCUSABLE, dialogTabTarget } from './dialog-state';

const ACCESS_GATE = readFileSync(new URL('./AccessGate.tsx', import.meta.url), 'utf8');
const DIALOG = readFileSync(new URL('./Dialog.tsx', import.meta.url), 'utf8');

describe('shared dialog focus geometry', () => {
  it('wraps only at the ends and enters from the dialog container', () => {
    const controls = ['first', 'middle', 'last'];
    expect(dialogTabTarget(controls, 'last', 'forward')).toBe('first');
    expect(dialogTabTarget(controls, 'first', 'backward')).toBe('last');
    expect(dialogTabTarget(controls, 'middle', 'forward')).toBeNull();
    expect(dialogTabTarget(controls, null, 'forward')).toBe('first');
    expect(dialogTabTarget(controls, null, 'backward')).toBe('last');
    expect(dialogTabTarget([], null, 'forward')).toBeNull();
  });

  it('covers native controls, disclosures and explicit tab stops without disabled controls', () => {
    expect(DIALOG_FOCUSABLE).toContain('button:not([disabled])');
    expect(DIALOG_FOCUSABLE).toContain('summary');
    expect(DIALOG_FOCUSABLE).toContain('input:not([disabled])');
    expect(DIALOG_FOCUSABLE).toContain('[tabindex]:not([tabindex="-1"])');
  });

  it('keeps modal behavior in one exported primitive', () => {
    expect(ACCESS_GATE).toContain("import { Dialog } from './Dialog'");
    expect(ACCESS_GATE).toContain('dismissOnEscape={false}');
    expect(ACCESS_GATE).toContain('onEscape={() => skip.current?.focus()}');
    expect(ACCESS_GATE).not.toContain('querySelectorAll<HTMLElement>');
    expect(DIALOG).toContain("'aria-modal': 'true'");
    expect(DIALOG).toContain('hideBackground(portalContainer)');
    expect(DIALOG).toContain('<PortalContainerProvider container={portalContainer}>');
    expect(DIALOG).toContain('lockDocumentScroll()');
    expect(DIALOG).toContain('restoreTo instanceof HTMLElement && restoreTo.isConnected');
  });
});
