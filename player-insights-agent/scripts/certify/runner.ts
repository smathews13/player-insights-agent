/**
 * Everything the certification decides, given everything it observed.
 *
 * Pure. The IO that produces `Observations` lives in `observe.ts`, so the rules
 * can be tested against a fabricated deployment without a workspace, and so a
 * run against a real one can be replayed from its recorded observations.
 *
 * THE CATALOGUE IS THE LOOP, NOT THIS FILE. Every required check in
 * `catalogue.ts` gets a result, and a check with no probe gets the honest
 * outcome the catalogue prescribes. Adding a code to the catalogue and
 * forgetting to run it therefore produces a visible `unknown` rather than
 * silence, which is the whole reason the aggregation counts a missing result as
 * unresolved.
 */
import { CHECKS } from './catalogue.ts';
import { issueCertificate, type Attestation, type Certificate, type CheckResult } from './certificate.ts';
import {
  probeAgentEndpoint,
  probeAttachments,
  probeBuildMatch,
  probeBuildStamps,
  probeDrift,
  probeManifestCoverage,
  probeOwnership,
  probeReleaseIdentity,
  probeScopesAsAuthored,
  probeScopesInEffect,
  probeServedVersion,
  probeStorage,
  probeDeclaredIdentity,
  probeIdentityContract,
  loggedAuthPolicy,
  manifestTables,
  runParam,
  servedVersion,
  unprobed,
  type AppRecord,
  type EndpointRecord,
  type ModelRunRecord,
  type ModelVersionRecord,
  type OwnershipRun,
  type PreflightRecord,
  type SettingsRecord,
  type StorageRecord,
} from './probes.ts';
import { emptyTuple, type ReleaseTuple } from './release-identity.ts';

export interface Observations {
  target: string;
  /** Who ran the live checks. Certification is not anonymous. */
  issuedBy: string;
  /** `databricks apps get`, or null when it could not be read. */
  app: AppRecord | null;
  /** `databricks serving-endpoints get`. */
  endpoint: EndpointRecord | null;
  /** The Unity Catalog model version behind the live traffic route. */
  modelVersion: ModelVersionRecord | null;
  /** The MLflow run that logged that version, which carries the release decisions. */
  modelRun: ModelRunRecord | null;
  /** Fully-qualified model name, from the bundle. */
  modelName: string;
  /** `user_api_scopes` the bundle authors for this target. */
  authoredScopes: string[] | null;
  /** `var.execution_identity`: what this target says it INTENDS to run as. */
  declaredIdentity: string | null;
  /**
   * Whether the app build sends an identity mode, read from its build commit.
   *
   * Null is "not established", which is not the same as an app that sends none:
   * the second half of the identity contract.
   */
  appIdentityMode: boolean | null;
  /** What the repository expects the manifest to be, or null when unresolved. */
  expectedTables: string[] | null;
  /** The app's own routes, each null when it did not answer. */
  settings: SettingsRecord | null;
  storage: StorageRecord | null;
  preflight: PreflightRecord | null;
  /** How `scripts/check-db-ownership.mjs` answered, or null when not run. */
  ownership: OwnershipRun | null;
}

/**
 * The release the observations describe.
 *
 * Assembled from what was observed rather than from what was asked for. The app
 * build stamp comes from the RUNNING app rather than from the local git
 * checkout, and the model version from the traffic route rather than from the
 * newest version in the registry: a tuple built out of intentions would certify
 * the release somebody meant to make.
 */
export function observedTuple(observations: Observations): ReleaseTuple {
  const endpointResource = (observations.app?.resources ?? []).find((resource) => resource.name === 'serving-endpoint');
  return {
    ...emptyTuple(),
    target: observations.target,
    appName: observations.app?.name ?? '',
    appBuildSha: observations.settings?.appBuildSha ?? '',
    servingEndpoint: endpointResource?.serving_endpoint?.name ?? observations.endpoint?.name ?? '',
    modelName: observations.modelName,
    modelVersion: servedVersion(observations.endpoint),
    // The logging run first, the app second. The app can only report a model
    // stamp while the orchestrator still sends its configuration with every
    // answer, and the served version stopped doing that, which is why the first
    // live run of this left the field empty and failed RELEASE_IDENTITY_COMPLETE
    // against a deployment that was in fact stamped.
    modelBuildSha: runParam(observations.modelRun, 'build_sha') ?? observations.settings?.modelBuildSha ?? '',
    declaredScopes: [...(observations.app?.user_api_scopes ?? [])].sort(),
    manifestTables: manifestTables(observations.modelVersion),
    userAuthPolicy: loggedAuthPolicy(observations.modelRun),
  };
}

/** Every check result, in catalogue order so two reports can be diffed. */
export function runChecks(observations: Observations, tuple: ReleaseTuple): CheckResult[] {
  const probed = new Map<string, CheckResult>(
    [
      probeReleaseIdentity(tuple),
      probeBuildStamps(tuple),
      probeBuildMatch(tuple),
      probeAttachments(observations.app),
      probeScopesAsAuthored(observations.app, observations.authoredScopes),
      probeScopesInEffect(observations.app),
      probeOwnership(observations.ownership),
      probeStorage(observations.storage),
      probeServedVersion(observations.endpoint),
      probeManifestCoverage(observations.modelVersion, observations.expectedTables),
      probeDeclaredIdentity(observations.declaredIdentity, observations.modelRun),
      probeIdentityContract(observations.appIdentityMode, observations.modelRun),
      probeAgentEndpoint(observations.preflight),
      probeDrift(observations.settings),
    ].map((outcome) => [outcome.code, outcome])
  );
  return CHECKS.map((definition) => probed.get(definition.code) ?? unprobed(definition.code));
}

export function certify(input: {
  observations: Observations;
  attestations: Attestation[];
  mode: 'shadow' | 'blocking';
  now?: Date;
  ttlMs?: number;
}): Certificate {
  const tuple = observedTuple(input.observations);
  return issueCertificate({
    tuple,
    checks: runChecks(input.observations, tuple),
    attestations: input.attestations,
    mode: input.mode,
    issuedBy: input.observations.issuedBy,
    now: input.now,
    ttlMs: input.ttlMs,
  });
}
