/**
 * Every condition a release is certified against, and for each one, honestly,
 * whether anything can actually observe it.
 *
 * The catalogue is a data structure rather than a document because a document
 * describing checks drifts from the checks. Everything a report or a runbook
 * needs to say about a check is a field here, and the runner cannot emit a
 * result for a code this file does not define.
 *
 * FOUR STATUSES, NOT TWO. `unknown` and `unverifiable` exist because this
 * deployment has repeatedly been damaged by a green tick that meant "nobody
 * asked". The bundle's own preflight check already draws the same distinction in
 * prose and says why; this makes it a value the aggregation has to handle.
 *
 *   pass          observed, and the observation is what we wanted.
 *   fail          observed, and it is wrong.
 *   unknown       the check ran and could not establish an answer THIS TIME.
 *                 A workspace that could not be reached, an app with no
 *                 deployment yet, a probe that is not built. Transient or
 *                 pending, not evidence of health.
 *   unverifiable  there is no observation that could establish it AT ALL. Not
 *                 today, not with more effort in this file. The only way to a
 *                 PASS is a human stating what they did (see `attestation`).
 *
 * A certificate is PASS only when every required check is `pass`, or is
 * `unverifiable` with a matching attestation. Anything else is FAIL or
 * INCOMPLETE. See `certificate.ts`.
 */
import type { ReleaseTuple } from './release-identity.ts';

export type CheckStatus = 'pass' | 'fail' | 'unknown' | 'unverifiable';

export type CheckSeverity =
  /** A release cannot be certified while this is not passing. */
  | 'required'
  /** Worth reporting and never worth blocking on. */
  | 'advisory';

export type Observability =
  /** A read-only control-plane call or one of the app's own public routes. */
  | 'api'
  /**
   * No API answers it and none can. A human states what they observed, against
   * a named release digest, and that statement is the evidence.
   */
  | 'attestation'
  /**
   * A browser has to render something and a person has to look at it. Browser
   * automation is not run from this repository, so these are reported as
   * unverifiable rather than quietly dropped from the catalogue: the plan asks
   * for a browser gate and this is where the absence of one is recorded.
   */
  | 'browser'
  /**
   * Automatable in principle, but the thing it would observe does not exist
   * yet. Reported `unknown` with the reason, so the gap is visible in every
   * report rather than in a backlog nobody reads.
   */
  | 'unbuilt';

export type CheckLayer =
  | 'identity'
  | 'configuration'
  | 'storage'
  | 'evidence'
  | 'transport'
  | 'client';

export interface CheckDefinition {
  code: string;
  title: string;
  layer: CheckLayer;
  severity: CheckSeverity;
  observability: Observability;
  /** What a `pass` actually establishes. Deliberately narrow. */
  passMeans: string;
  /** What to do about a `fail`, or about an `unknown` that will not clear. */
  remedy: string;
  /**
   * Why nothing can observe this, for anything that is not `api`. Present on
   * exactly the non-`api` entries, which `catalogue.test.ts` enforces, so a
   * check cannot be quietly downgraded to unverifiable without saying why.
   */
  notObservable?: string;
}

export const CHECKS: CheckDefinition[] = [
  // --- Release identity ------------------------------------------------------
  {
    code: 'RELEASE_IDENTITY_COMPLETE',
    title: 'The release identifies itself',
    layer: 'configuration',
    severity: 'required',
    observability: 'api',
    passMeans:
      'The target, app, app build commit, serving endpoint, model, model version and model build ' +
      'commit are all known, so this certificate names one specific release rather than a family.',
    remedy:
      'Read the report for which field is unknown. An unstamped app build means the release was ' +
      'built outside bundle/app-release.sh; an unstamped model predates the build stamp and needs ' +
      're-logging.',
  },
  {
    code: 'BUILD_STAMPS_REPRODUCIBLE',
    title: 'Neither half was built from a modified tree',
    layer: 'configuration',
    severity: 'required',
    observability: 'api',
    passMeans:
      'Neither build stamp carries +dirty, so both artefacts can be reproduced from a commit. ' +
      'A dirty artefact cannot be rolled back to, because there is no commit that rebuilds it.',
    remedy: 'Commit or revert the working tree and release again.',
  },
  {
    code: 'APP_MODEL_BUILD_MATCH',
    title: 'App and orchestrator came from the same commit',
    layer: 'configuration',
    // Advisory on purpose. The two deploy separately and a mismatch is the
    // normal state between releases; the app already reports it as a warning on
    // the Connections page. It becomes a real problem only when the answer
    // contract changed, which no automated check here can see.
    severity: 'advisory',
    observability: 'api',
    passMeans: 'The app and the served model version were built from the same commit.',
    remedy: 'Release both from the same commit when the answer contract has changed.',
  },

  // --- Attachments and scopes ------------------------------------------------
  {
    code: 'APP_RESOURCE_ATTACHMENTS',
    title: 'Both env-var-bearing resources are attached',
    layer: 'configuration',
    severity: 'required',
    observability: 'api',
    passMeans:
      'postgres, serving-endpoint and sql-warehouse are attached to the live app, so the ' +
      'environment variables they populate resolve. Without them the app starts, answers HTTP 200 ' +
      'and serves representative data.',
    remedy:
      'Deploy the bundle, or recover the whole spec with bundle/app-spec.sh --apply. Re-run the ' +
      'Postgres grants afterwards: detaching the postgres resource DROPS the role they hang off.',
  },
  {
    code: 'OAUTH_SCOPES_AS_AUTHORED',
    title: 'The live app declares the scopes the bundle authored',
    layer: 'configuration',
    severity: 'required',
    observability: 'api',
    passMeans:
      'The live user_api_scopes list equals the set the bundle authors for this target. A partial ' +
      '`apps update` replaces that list wholesale, so a dropped scope is a real failure mode.',
    remedy: 'TARGET=<target> bundle/app-spec.sh --apply, which sends the complete spec.',
  },
  {
    code: 'OAUTH_SCOPES_IN_EFFECT',
    title: 'Every declared scope is in effect',
    layer: 'configuration',
    severity: 'required',
    observability: 'api',
    passMeans:
      'Nothing the app declares is missing from effective_user_api_scopes. Scopes are read when ' +
      'the app STARTS, so a deploy that adds one leaves it inert with the new set written down.',
    remedy: 'databricks apps stop <app>, then databricks apps start <app>. A redeploy will not do it.',
  },
  {
    code: 'OAUTH_SCOPE_CONSENT_PROVEN',
    title: 'A human has signed in with exactly these scopes',
    layer: 'identity',
    severity: 'required',
    observability: 'attestation',
    passMeans:
      'A named person reached the app after this exact scope set was in effect. That is the only ' +
      'evidence that consent succeeds, and it is what this check exists for.',
    remedy:
      'Sign in to the app yourself after the restart, then record it: ' +
      'bundle/certify-release.sh --attest OAUTH_SCOPE_CONSENT_PROVEN --by <you> --note "<what you saw>"',
    notObservable:
      'effective_user_api_scopes is not proof. It is what the platform computes FOR THE APP, and ' +
      'it listed serving.serving-endpoints-data-plane throughout a total sign-in outage on two ' +
      'workspaces. Consent is all or nothing and the loop happens AHEAD of the app, so the ' +
      'container records nothing at all, not even a rejected request. There is no API that ' +
      'answers whether a user can consent, and no log that records that they could not.',
  },

  // --- Storage ---------------------------------------------------------------
  {
    code: 'POSTGRES_SCHEMA_OWNERSHIP',
    title: 'The app owns the schema it maintains',
    layer: 'storage',
    severity: 'required',
    observability: 'api',
    passMeans:
      'Every object in the app schema is owned by the app service principal, so its boot DDL ' +
      'applies. Grants do not substitute: Postgres checks ownership before deciding that ' +
      'ADD COLUMN IF NOT EXISTS is a no-op.',
    remedy:
      'Export what you need, DROP SCHEMA player_insights CASCADE, restart the app so it recreates ' +
      'the schema as its own, and stop pointing local development at the deployed branch.',
  },
  {
    code: 'LAKEBASE_STORAGE_READABLE',
    title: 'The app can read its own store',
    layer: 'storage',
    severity: 'required',
    observability: 'api',
    passMeans:
      'The app read THROUGH its own schema, not a bare SELECT 1, so the grants on player_insights ' +
      'are present and the app picked them up. A psql session proves neither.',
    remedy:
      'Re-run bundle/app-release.sh --apply, which resolves the direct branch host and gates its ' +
      'code deploy on bundle/app-db-grant.sh. After Lakebase detach/reattach without a full ' +
      'release, run that hook with TARGET and PROFILE, then restart the app so a dropped appkit ' +
      'cache schema is recreated.',
  },

  // --- The model and its manifest -------------------------------------------
  {
    code: 'SERVED_VERSION_UNAMBIGUOUS',
    title: 'One model version takes all the traffic',
    layer: 'configuration',
    severity: 'required',
    observability: 'api',
    passMeans:
      'Exactly one served entity holds 100% of traffic, so an observed answer can be attributed ' +
      'to a version. A split makes every other check in this certificate ambiguous.',
    remedy: 'Finish the traffic switch, then re-certify. Allow ~60s or you will measure the old version.',
  },
  {
    code: 'MANIFEST_COVERS_DATA_CONTRACT',
    title: 'Every table the Genie spaces curate is in the served manifest',
    layer: 'evidence',
    severity: 'required',
    observability: 'api',
    // A SUBSET, not an equality, and the first run of this check against the
    // live demo workspace is why. The manifest is enumerated from
    // var.catalog_allowlist at log time, so it is legitimately WIDER than the
    // data contract in agent/preflight.py: version 19 declared four raw and
    // validation tables the contract does not name. The bundle's static check
    // reached the same conclusion from its own side and calls the surplus
    // "harmless, just over-granted". An equality check here would have failed every
    // correct release, which is the fastest way to teach people to skip a gate.
    passMeans:
      'Every table a Genie space curates is inside the served version\u2019s Unity Catalog ' +
      'dependencies, which is the reach automatic authentication passthrough grants. A table ' +
      'missing from it fails every Genie call that touches it, and the SQL fallback then ' +
      'answers anyway, so nothing looks wrong.',
    remedy:
      'Add the table to the model\u2019s readable scopes and re-log. The missing direction is the ' +
      'dangerous one; a surplus is reported and does not block.',
  },
  {
    code: 'EXECUTION_IDENTITY_AS_DECLARED',
    title: 'The served version runs as the identity the target declares',
    layer: 'identity',
    // REQUIRED, which it could not be until the target declared an intent.
    // Whether the policy is ON is not by itself a defect: the flag on
    // bundle/agent-release.sh defaults off and most targets legitimately run
    // passthrough, so gating on the policy alone marked a correct deployment
    // FAIL forever, and a permanently red check is one people learn to scroll
    // past. What IS a defect is the disagreement, and that is only visible once
    // var.execution_identity says what the release meant to do. Held against
    // what the served version was actually logged with, which is why the
    // variable must never be wired into agent-release.sh: a value compared
    // against itself is a check that cannot fail.
    severity: 'required',
    // Nearly written off as unattestable, and it is worth saying why it is not.
    // The serving endpoint payload carries no auth field of any kind and a Unity
    // Catalog model version reports only its table dependencies, so both of the
    // obvious places to look answer nothing. The fact survives one step further
    // back: `log_model.py` passes the release decision in `model_config`, and
    // MLflow records every model_config entry as a param on the logging run,
    // which the version names in `run_id`. Read-only, and authoritative, because
    // it is the same value the artifact carries.
    observability: 'api',
    passMeans:
      'What the target declares in var.execution_identity is what the MLflow run behind the ' +
      'served version was logged with. Under user-authorization, Genie and SQL execute as the ' +
      'signed-in user rather than as the version\u2019s passthrough principal.',
    remedy:
      'If the declaration is right, log a new version with bundle/agent-release.sh, which applies ' +
      'the policy unconditionally: it is baked into the artifact and cannot be turned on for a ' +
      'version that already exists. If the deployment is right, change the declaration.',
  },
  {
    code: 'IDENTITY_CONTRACT_PAIRED',
    title: 'The app build and the served version agree on who runs the query',
    layer: 'identity',
    severity: 'required',
    // THE MOST CONSEQUENTIAL CHECK IN THIS CATALOGUE, and the one most worth
    // reading before changing.
    //
    // agent/execution_identity.py fails closed IN BOTH DIRECTIONS. A version
    // logged with the policy refuses a request that declares no identity mode,
    // and a version logged without one refuses a request that asks to run as the
    // signed-in user. So the app build and the model version are two halves of
    // one contract, and either half alone is a deployment that refuses every
    // question with IDENTITY_REQUIRED while both halves look correct in
    // isolation. There is no fallback left to soften it: the app's
    // service-principal path was deleted rather than disabled.
    //
    // The app side is read from the repository at the app's own build commit
    // rather than from the running app, because no route reports it. That is
    // sound exactly as far as the build stamp is: it describes the commit the
    // deployed bytes were built from, which is why a dirty tree fails
    // BUILD_STAMPS_REPRODUCIBLE before this is believed.
    observability: 'api',
    passMeans:
      'The identity mode the app build sends with every ask is one the served version accepts. ' +
      'The re-log and the app deploy that change this are one release, in either direction.',
    remedy:
      'Pair them. An app build that sends signed_in_user needs a version logged by ' +
      'bundle/agent-release.sh, which now always logs the policy; a version logged before that ' +
      'became unconditional has to be re-logged, because the policy cannot be added afterwards. ' +
      'Deploying one without the other refuses every question.',
  },

  // --- The live app, through its own public routes ---------------------------
  {
    code: 'AGENT_ENDPOINT_REACHABLE',
    title: 'The app can invoke the orchestrator',
    layer: 'transport',
    severity: 'required',
    observability: 'api',
    passMeans:
      'The app invoked the serving endpoint and it answered. It does NOT mean the answer was ' +
      'useful: the endpoint stopped reporting its dependencies, so nothing behind it is covered.',
    remedy:
      'Check the serving-endpoint attachment and that the endpoint is not in a failed update. ' +
      'databricks serving-endpoints get <endpoint>.',
  },
  {
    code: 'CONFIGURATION_DRIFT_CLEAR',
    title: 'Nothing in use disagrees with what was configured',
    layer: 'configuration',
    severity: 'required',
    observability: 'api',
    passMeans:
      'The app\u2019s own drift report carries no blocking finding, so no resource the running ' +
      'system demonstrably used differs from the one this deployment was configured with.',
    remedy: 'Open the Connections page. Each finding carries the command that applies it.',
  },

  // --- The parts that are not built yet -------------------------------------
  {
    code: 'SIGNED_USER_ASK_CANARY',
    title: 'A signed-in user gets a terminal answer',
    layer: 'identity',
    severity: 'required',
    observability: 'unbuilt',
    passMeans:
      'One deterministic question asked through the same public route a user uses, as the ' +
      'certifying person\u2019s own identity, terminated in exactly one of plan, clarification, ' +
      'answer or unavailable.',
    remedy: 'Not implemented yet. See notObservable.',
    notObservable:
      'The terminal response contract is being introduced by another workstream and the ask route ' +
      'does not yet emit it. A probe written against the current shape would assert today\u2019s ' +
      'accident rather than the contract, and would have to be rewritten the week the contract ' +
      'lands. Reported unknown until the contract exists.',
  },
  {
    code: 'DENIED_USER_NO_FALLBACK',
    title: 'A denied user stays denied',
    layer: 'identity',
    severity: 'required',
    observability: 'unbuilt',
    passMeans:
      'A least-privileged persona with no grant on the data receives an explicit authorization ' +
      'failure, and nothing is executed as the app service principal on its behalf.',
    remedy: 'Not implemented yet. See notObservable.',
    notObservable:
      'It needs a second credential for a persona that is deliberately denied, and this repository ' +
      'has no such persona. Running it as the operator proves nothing, because an admin passes. ' +
      'Creating the personas is step 1 of the signed-in-user workstream, not of this one.',
  },
  {
    code: 'GENIE_EVIDENCE_ATTRIBUTABLE',
    title: 'Genie evidence carries its own attribution',
    layer: 'evidence',
    severity: 'required',
    observability: 'unbuilt',
    passMeans:
      'A Genie answer arrived with parseable generated SQL and referenced assets inside the ' +
      'manifest, so the figures in it are attributable.',
    remedy: 'Not implemented yet. See notObservable.',
    notObservable:
      'There is no machine-readable attribution to check. The common evidence gateway that would ' +
      'produce one is a separate workstream. Asserting attribution from answer prose would be a ' +
      'check that passes on a well-written fabrication.',
  },
  {
    code: 'CLIENT_RENDERS_UNAVAILABLE',
    title: 'The deployed client renders failure as failure',
    layer: 'client',
    severity: 'required',
    observability: 'browser',
    passMeans:
      'The deployed React client renders answer, denial, timeout and unavailable states as ' +
      'themselves, with no plausible substitute row, figure or trace link.',
    remedy:
      'Read the component and its unit tests, drive the API states by hand, and record what you ' +
      'saw with --attest.',
    notObservable:
      'It requires a rendered page. Browser automation is not run from this repository, so no ' +
      'gate here can start one. The unit tests around the unavailable states cover the logic and ' +
      'not the rendering, so this stays unverifiable rather than being marked passed by proxy.',
  },
];

const BY_CODE = new Map(CHECKS.map((check) => [check.code, check]));

export function checkDefinition(code: string): CheckDefinition | undefined {
  return BY_CODE.get(code);
}

export const REQUIRED_CODES = CHECKS.filter((c) => c.severity === 'required').map((c) => c.code);

/**
 * Whether a human statement is admissible for this check.
 *
 * Only where nothing can observe it. An `api` check that FAILED cannot be
 * attested past, and neither can one that came back `unknown`: a check that
 * could have answered and did not is a reason to run it again, and letting a
 * signature stand in for it turns the whole certificate into paperwork.
 */
export function acceptsAttestation(code: string): boolean {
  const definition = BY_CODE.get(code);
  if (!definition) return false;
  return definition.observability === 'attestation' || definition.observability === 'browser';
}

/**
 * The status a check with no probe reports, derived from the catalogue.
 *
 * Kept here rather than in each probe so that the report and the aggregation
 * cannot disagree about what an unbuilt check means.
 */
export function statusWithoutProbe(code: string): CheckStatus {
  const definition = BY_CODE.get(code);
  if (!definition) return 'unknown';
  switch (definition.observability) {
    case 'attestation':
    case 'browser':
      return 'unverifiable';
    case 'unbuilt':
    case 'api':
      return 'unknown';
  }
}

/** Codes that no API will ever answer, for the report's own honesty section. */
export function unobservableCodes(): string[] {
  return CHECKS.filter((c) => c.observability !== 'api').map((c) => c.code);
}

/**
 * A short line naming the release a report is about. Here rather than in the
 * runner so that a report and a stored certificate label the same tuple the
 * same way.
 */
export function releaseLabel(tuple: ReleaseTuple): string {
  const app = tuple.appBuildSha ? tuple.appBuildSha.slice(0, 12) : 'unknown';
  const model = tuple.modelVersion || 'unknown';
  return `${tuple.target || 'unknown target'} app@${app} model@v${model}`;
}
