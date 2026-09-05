/**
 * Whether the MLflow experiment the traces land in actually exists.
 *
 * THE ONE DEPENDENCY THAT CANNOT BE ASKED ABOUT AS THE READER, and this file is
 * the exception that fact forces. Every other check in this app runs on the
 * signed-in user's forwarded token, deliberately, because the question those
 * checks answer is about that person's own grants. Databricks Apps validates
 * `user_api_scopes` against a fixed list, and that list has no MLflow family at
 * all: `mlflow`, `mlflow.experiments`, `mlflow.experiments:read`,
 * `mlflow-experiments`, `experiments`, `experiments:read`, `ml` and
 * `ml.experiments:read` are each rejected by the Apps API with "not a valid
 * scope". So a user-token probe of the experiment cannot be built, and adding an
 * `experiment-id` subject to `dependency-probes.ts` would resolve to an empty
 * scope and correctly fail `user-api-scopes.test.ts`.
 *
 * IT WAS BADGED `Nothing to reach` INSTEAD, which was worse than saying nothing.
 * That badge means the app both resolves and applies the value and there is no
 * remote end -- true of a warehouse id the app only ever passes on, and false
 * here, on a card that says in the next line that the experiment receives the
 * trace of every run and offers a link to open it. A mistyped or deleted
 * experiment id rendered a dead link under a badge claiming there was nothing
 * there to be wrong.
 *
 * So it is read AS THE APPLICATION, which is the identity that writes the traces
 * in the first place, and every verdict below says so in as many words. The app's
 * read establishes that the experiment exists and that the trace has somewhere to
 * land. It establishes nothing about whether the reader can open it, and a check
 * that let anyone believe otherwise would be the same defect wearing green.
 *
 * The app already reads the workspace as itself for the one other question a
 * forwarded token cannot answer -- what a named person is entitled to, in
 * `monitoring-grants.ts` -- so the identity is not new here, only its use.
 */
import type { PreflightCheck } from '../routes/insights-routes';
import { withDeadline } from './deadline';

/** Where the experiment is asked about, named once. */
export const EXPERIMENT_PATH = '/api/2.0/mlflow/experiments/get';

/** Where a workspace experiment PATH is resolved to its id, named once. */
export const EXPERIMENT_BY_NAME_PATH = '/api/2.0/mlflow/experiments/get-by-name';
/** A metadata read must not hold the automatic Architecture check open indefinitely. */
export const EXPERIMENT_PROBE_TIMEOUT_MS = 5_000;

/**
 * What came back, in the three shapes a verdict is decided from.
 *
 * The same division the user-token probes make: an answer, a refusal carrying the
 * workspace's own code and message, and no answer at all. Kept separate from
 * `ProbeOutcome` because that type is threaded through the scope machinery this
 * check must not touch.
 */
export type ExperimentRead =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'refused'; status: number; code: string; message: string }
  | { kind: 'no-response'; message: string };

/** A workspace API GET as the application. Injected, so nothing here holds a client. */
export type ExperimentReader = (experimentId: string) => Promise<ExperimentRead>;

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The experiment record, wherever the API nested it. */
function experimentOf(body: Record<string, unknown>): Record<string, unknown> {
  return (body.experiment as Record<string, unknown> | undefined) ?? body;
}

/** The numeric id the experiment reports for itself, or '' when it names none. */
export function experimentIdOf(body: Record<string, unknown>): string {
  return textOf(experimentOf(body).experiment_id);
}

/** What the experiment says about itself, for the detail line. */
function describes(body: Record<string, unknown>): string {
  const experiment = experimentOf(body);
  const name = textOf(experiment.name);
  const stage = textOf(experiment.lifecycle_stage);
  if (name && stage) return `${name}, ${stage}`;
  return name || stage;
}

/**
 * The lifecycle stage of an experiment that still accepts runs.
 *
 * MLflow SOFT-DELETES, and that is why this is read rather than assumed. A
 * deleted experiment is still fetched successfully -- HTTP 200, the full record,
 * `lifecycle_stage: 'deleted'` -- so a probe that treats any answer as a pass
 * reports "traces have somewhere to land" about an experiment that raises on
 * every write. The stage was already being read for the detail line and printed
 * there; it just was not being acted on, so the one screen that exists to say
 * where the traces went showed green while every run's trace was being dropped.
 */
export const ACTIVE_STAGE = 'active';

/**
 * The verdict, as a check the pages already know how to draw.
 *
 * No IO, so every rule about what counts as connected is testable without a
 * workspace. Missing configuration is a failed operational connection: the
 * Architecture node says every run should trace here, and an empty identifier
 * means there is nowhere for that trace to land.
 */
export function experimentVerdict(input: {
  experimentId: string;
  read: ExperimentRead;
  durationMs?: number;
}): PreflightCheck {
  const experimentId = input.experimentId.trim();

  const base = {
    id: 'experiment-id',
    kind: 'observability',
    name: experimentId,
    label: 'MLflow experiment',
    checked_with: `Read as the application, not as you: GET ${EXPERIMENT_PATH}`,
    duration_ms: input.durationMs ?? 0,
    error: '',
    remedy: null,
  } satisfies Omit<PreflightCheck, 'status' | 'detail'>;

  if (!experimentId) {
    return {
      ...base,
      status: 'failed',
      detail:
        'No MLflow experiment is configured. The application cannot resolve a trace destination until an experiment id or path is configured.',
      error: 'no MLflow experiment is configured',
    };
  }

  if (input.read.kind === 'no-response') {
    return {
      ...base,
      status: 'unverified',
      detail: 'The workspace could not be asked about the experiment, so nothing was established either way.',
      error: input.read.message,
    };
  }

  if (input.read.kind === 'refused') {
    const { status, code, message } = input.read;
    const refusal = `HTTP ${status}${code ? ` ${code}` : ''}`;
    return {
      ...base,
      // FAILED RATHER THAN UNVERIFIED, and the difference is the identity. A
      // refusal of the reader's token leaves open whether the object is fine and
      // the person is short a grant; this call was made as the application that
      // writes the traces, so a refusal or a missing experiment means the trace
      // has nowhere to land -- a fact about the deployment, not about anybody's
      // permissions.
      status: 'failed',
      detail: `${refusal}: ${message || 'the workspace gave no message'}. Read as the application, not as you.`,
      error: message || refusal,
    };
  }

  const observedId = experimentIdOf(input.read.body);
  const observed = describes(input.read.body);
  const displayName = textOf(experimentOf(input.read.body).name);
  const stage = textOf(experimentOf(input.read.body).lifecycle_stage);
  if (!observedId) {
    return {
      ...base,
      display_name: displayName || undefined,
      status: 'unverified',
      detail:
        'The workspace answered without an experiment identifier, so the configured trace destination was not verified.',
      error: 'the experiment response did not identify an experiment',
    };
  }
  if (observedId !== experimentId) {
    return {
      ...base,
      display_name: displayName || undefined,
      status: 'failed',
      detail:
        'The workspace returned a different experiment than the configured trace destination. The application cannot safely treat that response as connected.',
      error: 'the experiment response did not match the configured identifier',
    };
  }
  if (stage && stage.toLowerCase() !== ACTIVE_STAGE) {
    return {
      ...base,
      display_name: displayName || undefined,
      // FAILED, on the same reasoning as a refusal: the identity that was
      // answered is the one that writes the traces, and it cannot write to
      // this. Reported as a fact about the deployment rather than about
      // anybody's permissions, because restoring the experiment is the fix and
      // no grant changes it.
      status: 'failed',
      detail: `Read as the application, not as you${observed ? `: ${observed}` : ''}. The experiment exists but is ${stage}, not ${ACTIVE_STAGE}, so runs cannot be logged to it and the trace of every run is being dropped. Restore it in the workspace, or point PLAYER_INSIGHTS_EXPERIMENT_ID at one that is live.`,
      error: `the experiment is ${stage}`,
    };
  }
  return {
    ...base,
    display_name: displayName || undefined,
    status: 'ok',
    detail: `Read as the application, not as you${observed ? `: ${observed}` : ''}. Traces have somewhere to land; whether you can open it is your own grant.`,
  };
}

/**
 * Production reader: the workspace API on the app's own service-principal
 * credentials, which Apps injects into the container.
 *
 * `new WorkspaceClient({})` resolves those from the environment. Never throws:
 * every failure becomes a `no-response` or a `refused`, because a check that
 * threw would take down the settings route, and the settings route is what
 * somebody opens to find out why the rest of the app is misbehaving.
 */
export const workspaceExperimentReader: ExperimentReader = async (experimentId) => {
  try {
    const { WorkspaceClient } = await import('@databricks/sdk-experimental');
    const client = new WorkspaceClient({});
    const body = (await client.apiClient.request({
      path: EXPERIMENT_PATH,
      method: 'GET',
      query: { experiment_id: experimentId },
      headers: new Headers({ Accept: 'application/json' }),
      raw: false,
    })) as Record<string, unknown>;
    return { kind: 'ok', body: body ?? {} };
  } catch (error) {
    return readFailure(error);
  }
};

/**
 * A workspace experiment PATH resolved to its numeric id, as the application.
 * Injected, so the resolution can be tested without a workspace.
 */
export type ExperimentIdResolver = (experimentPath: string) => Promise<string>;

/**
 * Production resolver: get-by-name on the app's own service-principal
 * credentials -- the same identity and MLflow API `bundle/app-release.sh` used to
 * resolve the id at release time, moved into the app so a "From Git" deploy that
 * never runs the release gets a working deep link too.
 *
 * Read AS THE APPLICATION for the reason {@link workspaceExperimentReader} is:
 * the Apps API accepts no MLflow `user_api_scopes` spelling, so a forwarded-token
 * resolve cannot be built (see the file header). Never throws and never fails
 * loudly -- an empty string is returned for a path that does not resolve, because
 * the one caller runs on the Monitoring hot path and already renders an empty id
 * as "not configured". A denial and a missing experiment are not told apart here:
 * both leave the deep link unset, which is the same outcome and the honest one.
 */
export const workspaceExperimentIdResolver: ExperimentIdResolver = async (experimentPath) => {
  const path = experimentPath.trim();
  if (!path) return '';
  try {
    const { WorkspaceClient } = await import('@databricks/sdk-experimental');
    const client = new WorkspaceClient({});
    const body = (await client.apiClient.request({
      path: EXPERIMENT_BY_NAME_PATH,
      method: 'GET',
      query: { experiment_name: path },
      headers: new Headers({ Accept: 'application/json' }),
      raw: false,
    })) as Record<string, unknown>;
    return experimentIdOf(body ?? {});
  } catch {
    return '';
  }
};

/**
 * A thrown SDK error, read back into a refusal where it carries one.
 *
 * The SDK raises rather than returning a status, so the status has to be
 * recovered from the error to tell "the experiment is not there" from "the call
 * never completed". Anything without a status is the second: unknown, not denied.
 */
export function readFailure(error: unknown): ExperimentRead {
  const shape = (error ?? {}) as { statusCode?: unknown; status?: unknown; errorCode?: unknown; message?: unknown };
  const status = Number(shape.statusCode ?? shape.status ?? 0);
  const message = textOf(shape.message) || 'the call did not complete';
  if (Number.isFinite(status) && status >= 400) {
    return { kind: 'refused', status, code: textOf(shape.errorCode), message };
  }
  return { kind: 'no-response', message };
}

/**
 * The experiment check. Missing configuration is a completed failed check, so
 * Architecture never settles on an indeterminate experiment state.
 */
export async function checkExperimentAsApp(
  experimentId: string,
  read: ExperimentReader = workspaceExperimentReader,
  timeoutMs = EXPERIMENT_PROBE_TIMEOUT_MS
): Promise<PreflightCheck> {
  const id = experimentId.trim();
  const started = Date.now();
  if (!id) {
    return experimentVerdict({
      experimentId: id,
      read: { kind: 'no-response', message: 'no MLflow experiment is configured' },
      durationMs: 0,
    });
  }
  // Awaited inside the try rather than caught off the promise: the client is
  // constructed on the way in, and it throws synchronously when the workspace
  // configuration is absent -- which is every local run. A rejection handler
  // alone lets that escape and takes the whole settings request with it.
  let outcome: ExperimentRead;
  try {
    outcome = await withDeadline(
      read(id),
      timeoutMs,
      `The MLflow experiment lookup did not answer within ${timeoutMs} ms.`
    );
  } catch (error) {
    outcome = readFailure(error);
  }
  return experimentVerdict({ experimentId: id, read: outcome, durationMs: Date.now() - started });
}
