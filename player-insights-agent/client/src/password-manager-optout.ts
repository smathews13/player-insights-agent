/**
 * Keeping password managers out of this app's text fields.
 *
 * A customer hit this during POC testing: 1Password read the composer question
 * box as an identity field, injected its glyph into the box and put a "Save
 * identity" prompt over the header after every question. Nothing here is a
 * credential, so the safe default is to opt every field out and require a
 * deliberate opt back in, rather than the other way round.
 *
 * Every manager wants its own attribute; `autocomplete="off"` alone is not
 * enough, because most of them deliberately ignore it (a field the user wants
 * filled is a more common case than one they do not). Verified against vendor
 * documentation on 2026-08-07:
 *
 * - 1Password  `data-1p-ignore`      developer.1password.com/docs/web/compatible-website-design
 * - LastPass   `data-lpignore`       "true"
 * - Dashlane   `data-form-type`      "other", from its Semantically Annotated Web Forms spec
 * - Bitwarden  `data-bwignore`       "true"
 *
 * These are vendor conventions, not a standard, so they do change. If the
 * popup comes back, re-check the names before assuming the wiring broke.
 */

/**
 * Spread onto a field, or onto a `<form>` whose fields should all be ignored.
 *
 * 1Password caches its verdict for a field on first focus, so these have to be
 * present in the initial render; adding them later does not reliably take.
 */
export const PASSWORD_MANAGER_OPT_OUT = {
  autoComplete: 'off',
  // Written bare in 1Password's docs; an empty value is how HTML spells a
  // present-but-valueless attribute, and presence is all it tests for.
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-form-type': 'other',
  'data-bwignore': 'true',
} as const;

/** The escape hatch, mixed into the props of every field primitive. */
export interface PasswordManagerOptOutProps {
  /**
   * Set this only on a genuine credential field, where a manager offering to
   * fill or save is the behaviour the user wants. There is no such field in
   * this app today, and adding one should be a decision someone argues for.
   */
  allowPasswordManager?: boolean;
}

/**
 * Merge the opt-out into a field's props.
 *
 * Caller props are applied last, so a single attribute can also be overridden
 * on its own (`autoComplete="one-time-code"` on an OTP box, say) without
 * giving up the rest.
 */
export function withPasswordManagerOptOut<Props extends PasswordManagerOptOutProps>(
  props: Props
): Omit<Props, 'allowPasswordManager'> {
  const { allowPasswordManager, ...rest } = props;
  if (allowPasswordManager === true) return rest;
  return { ...PASSWORD_MANAGER_OPT_OUT, ...rest };
}
