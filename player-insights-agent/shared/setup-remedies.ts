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
export const GRANT_HOOK_PATH = 'bundle/app-db-grant.sh';

/** The supported escape hatch, as a deployer would paste it. */
export const GRANT_SCRIPT_COMMAND = [
  "TARGET=<target> PROFILE='<profile>' bundle/app-db-grant.sh",
  "databricks apps stop <app-name> --profile '<profile>'",
  "databricks apps start <app-name> --profile '<profile>'",
].join('\n');

/**
 * How the release applies this step and when it still needs an operator.
 *
 * Also covers AppKit's cache schema (`appkit`): a bare GRANT USAGE/CREATE is
 * not enough for later CREATE INDEX (needs table ownership), so the script
 * drops a misowned cache-only `appkit` and the app recreates it on next boot.
 */
export const GRANT_SCRIPT_WHY =
  'The app service principal does not exist until the app does. The canonical app release runs ' +
  `${GRANT_HOOK_PATH} before every code deploy, deriving the direct branch host and the other ` +
  'inputs from the target and live resources; a failed grant stops the release. After a Lakebase ' +
  'detach/reattach without a full release, run that hook manually and restart the app so it can ' +
  'recreate a dropped AppKit cache schema (`appkit`) as owner.';

export const GRANT_SCRIPT_REMEDY =
  `Re-run the canonical app release, or run ${GRANT_HOOK_PATH} with TARGET and PROFILE after ` +
  `a Lakebase reattach. Its underlying ${GRANT_SCRIPT_PATH} requires ` +
  `${GRANT_SCRIPT_ENV_VARS.length} resolved values (${GRANT_SCRIPT_ENV_VARS.join(', ')}). ` +
  GRANT_SCRIPT_WHY;

/**
 * Genie sharing: grant the people who use the app, not the serving principal.
 */
export const GENIE_SHARE_REMEDY =
  'Share each Genie space with the people or groups who use the app, at CAN RUN. Under ' +
  'user authorization Genie runs as the signed-in caller, not the serving endpoint principal. ' +
  'Do it in the Databricks UI, or with `databricks permissions update genie <space_id> --json`. ' +
  'The same callers also need CAN USE on the warehouse and SELECT on the curated tables. ' +
  'A redeploy will not fix it.';

/**
 * The opening the app looks for to tell a degradation caveat from an ordinary one.
 */
export const DEGRADED_ANSWER_MARKER = 'This answer is degraded:';
