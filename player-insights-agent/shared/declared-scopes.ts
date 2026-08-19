/**
 * The `user_api_scopes` this deployment declares, as the container was told them.
 *
 * Read by two things that must not import each other: `session-freshness.ts`
 * compares them against the presented sign-in for the strip above every page,
 * and `dependency-probes.ts` compares them against the scope a refusal named,
 * which is the fact that separates a sign-in behind the app from a permission
 * the app never asked for. Here, with no dependencies, so neither has to reach
 * through the other for it.
 */

/** The environment variable the release resolves from `var.app_user_api_scopes`. */
export const DECLARED_SCOPES_VAR = 'PLAYER_INSIGHTS_USER_API_SCOPES';

/**
 * The scopes this deployment declares, or null when it was not told.
 *
 * NULL IS NOT AN EMPTY LIST. Unset means this build does not know what it asks
 * for, and the honest report of that is `undetermined`; an empty list would mean
 * it asks for nothing, which would make every session look current. The scope
 * list is target-layered -- the shared default a customer/T2 target inherits and
 * the example override carry different sets -- so this cannot be a constant in the
 * source: a literal list would tell a reader of one deployment that their
 * sign-in is missing permissions the app never asked for on theirs.
 */
export function declaredUserApiScopes(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = (env[DECLARED_SCOPES_VAR] ?? '').trim();
  if (!raw) return null;
  const scopes = raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return scopes.length ? scopes : null;
}
