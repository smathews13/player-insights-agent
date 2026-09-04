/**
 * The four OAuth scopes every Player Insights Agent question path needs.
 *
 * Kept separately from the deployment's broader declared list because the
 * one-click repair must add only the load-bearing set. Optional browse scopes
 * remain a deployment choice and must never turn this repair into broader
 * consent than the user asked for.
 */
export const REQUIRED_USER_API_SCOPES = [
  'serving.serving-endpoints',
  'model-serving',
  'sql',
  'dashboards.genie',
] as const;
