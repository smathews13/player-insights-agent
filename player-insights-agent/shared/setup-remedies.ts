/**
 * The two setup steps that fail silently, and the exact words that fix them.
 */

/**
 * The environment variables `scripts/grant-app-db-access.mjs` requires.
 */
export const GRANT_SCRIPT_ENV_VARS = [
  'DATABRICKS_CONFIG_PROFILE',
  'PGHOST',
  'PGDATABASE',
  'PGUSER',
  'APP_PG_ROLE',
] as const;

export const GRANT_SCRIPT_PATH = 'scripts/grant-app-db-access.mjs';

/** The invocation, as a deployer would paste it. */
export const GRANT_SCRIPT_COMMAND = [
  'cd player-insights-agent',
  `${GRANT_SCRIPT_ENV_VARS.map((name) => `${name}=<value>`).join(' \\\n  ')} \\`,
  `  node ${GRANT_SCRIPT_PATH}`,
].join('\n');

/**
 * Why this step cannot have been done for the deployer.
 */
export const GRANT_SCRIPT_WHY =
  'The app service principal does not exist until the app does, so this grant cannot be made ' +
  'by the bundle and is not made by a redeploy. It is a one-off manual step after first create.';

export const GRANT_SCRIPT_REMEDY =
  `Run ${GRANT_SCRIPT_PATH} once, with all ` +
  `${GRANT_SCRIPT_ENV_VARS.length} variables set (${GRANT_SCRIPT_ENV_VARS.join(', ')}): ` +
  `none of them has a default. ${GRANT_SCRIPT_WHY}`;

/**
 * Genie sharing, which is UI-only.
 */
export const GENIE_SHARE_REMEDY =
  'Open each Genie space in the Databricks UI, choose Share, and add the agent serving ' +
  'principal with CAN RUN. There is no CLI or bundle equivalent: Genie sharing is UI-only, ' +
  'so a redeploy will not fix it.';

/**
 * The opening the app looks for to tell a degradation caveat from an ordinary one.
 */
export const DEGRADED_ANSWER_MARKER = 'This answer is degraded:';
