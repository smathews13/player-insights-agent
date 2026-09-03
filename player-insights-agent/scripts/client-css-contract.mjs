function ruleEntries(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
    selectors: selectors.trim(),
    body,
  }));
}

/**
 * The login panel is programmatically focused during authorization. Check the
 * optimized artifact rather than only source partials: Tailwind/AppKit may add a
 * ring through box-shadow, and the final cascade is the product users receive.
 */
export function assertNeutralLoginPanelCss(css) {
  const rules = ruleEntries(css).filter(({ selectors }) => selectors.includes('.ast-login-panel'));
  if (rules.length === 0) throw new Error('The compiled entry CSS is missing the neutral login-panel contract');

  for (const state of [':focus', ':focus-visible', ':focus-within', '[aria-busy=true]']) {
    if (!rules.some(({ selectors }) => selectors.includes(state))) {
      throw new Error(`The compiled login-panel contract is missing ${state}`);
    }
  }

  const chrome = rules.map(({ body }) => body).join(';');
  if (!/background:var\(--ast-surface-elevated\)/.test(chrome)) {
    throw new Error('The compiled login panel does not use the elevated neutral surface');
  }
  if (!/border:1px solid var\(--ast-border-input\)/.test(chrome)) {
    throw new Error('The compiled login panel does not use the neutral theme border');
  }
  if (!/outline:none/.test(chrome)) {
    throw new Error('The compiled login panel can still receive an outer outline');
  }
  if (!/box-shadow:[^;}]*var\(--db-ink-deep\)/.test(chrome)) {
    throw new Error('The compiled login panel is missing its neutral modal shadow');
  }

  const forbidden =
    /(?:border(?:-color)?|outline|box-shadow):[^;}]*var\(--(?:ast|db)-blue|(?:border(?:-color)?|outline|box-shadow):[^;}]*var\(--primary\)/;
  if (forbidden.test(chrome)) {
    throw new Error('The compiled login panel still contains blue or primary outer chrome');
  }
}
