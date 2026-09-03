import { describe, expect, it } from 'vitest';

import { assertNeutralLoginPanelCss } from './client-css-contract.mjs';

const NEUTRAL =
  '.ast-login-panel,.ast-login-panel:focus,.ast-login-panel:focus-visible,.ast-login-panel:focus-within,.ast-login-panel[aria-busy=true]{background:var(--ast-surface-elevated);border:1px solid var(--ast-border-input);outline:none;box-shadow:0 18px 48px color-mix(in oklab,var(--db-ink-deep) 16%,transparent)}';

describe('compiled login panel chrome', () => {
  it('accepts neutral default, focus-within, and loading chrome', () => {
    expect(() => assertNeutralLoginPanelCss(NEUTRAL)).not.toThrow();
  });

  it.each([
    'border-color:var(--primary)',
    'outline:2px solid var(--ast-blue)',
    'box-shadow:0 0 0 2px var(--db-blue-600)',
  ])('rejects a compiled outer-panel %s', (declaration) => {
    expect(() => assertNeutralLoginPanelCss(`${NEUTRAL}.ast-login-panel:focus-within{${declaration}}`)).toThrow(
      /blue or primary outer chrome/
    );
  });
});
