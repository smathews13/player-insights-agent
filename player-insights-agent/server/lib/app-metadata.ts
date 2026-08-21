/**
 * The app's own record, asked of the workspace that is running it.
 *
 * WHY THIS EXISTS. The Build and telemetry card carried two commit hashes. The
 * design asks it for nine facts, and six of them -- the host somebody is on, the
 * app's description, its compute, its tags, when it was last released and by
 * whom -- are not in the settings payload, not in the orchestrator's report, and
 * not in the process environment. They are the Apps record, and only the Apps
 * API has them.
 *
 * Read AS THE APPLICATION, for the same reason `experiment-probe.ts` is: the
 * question is "what is this deployment", not "what may the reader see", and the
 * app is the one identity guaranteed to be able to answer about itself. Nothing
 * here is a claim about anybody's grants and no verdict below says otherwise.
 *
 * IT NEVER THROWS AND IT NEVER GUESSES. A failure resolves to
 * `answered: false` and the card renders no rows, because `/api/settings` is one
 * of the diagnostics that has to keep answering while the rest of the app is
 * refusing. And a field the workspace did not report stays empty rather than
 * being filled from a plausible neighbour: this card's whole value is that an
 * operator can trust it against the workspace UI.
 */
import {
  NO_APP_FACTS,
  NO_EXPORTER_READING,
  type AppCompute,
  type AppFacts,
  type AppServing,
  type ExporterReading,
} from '../../shared/app-facts';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import { readExporter, type ExporterReader } from './ops-telemetry';

/** Where the app is asked about, named once. */
export const APPS_PATH = '/api/2.0/apps';

/** The variable Apps sets to this app's own name, which is how it finds itself. */
export const APP_NAME_ENV = 'DATABRICKS_APP_NAME';

/**
 * The exporter address, from the standard OpenTelemetry variable rather than one
 * of our own. An operator wiring a collector into this app sets the name the
 * OpenTelemetry SDKs already read; inventing a second name would mean a
 * deployment could be exporting while this row said it was not.
 */
export const OTEL_ENDPOINT_ENV = 'OTEL_EXPORTER_OTLP_ENDPOINT';

/**
 * What each Apps compute size gets, as Databricks publishes it.
 *
 * A LOOKUP, NOT A FORMULA. An unrecognised size resolves to `null` and the card
 * prints the size's name alone, because the row is read by somebody reconciling
 * a bill: a vCPU count extrapolated from the size above it would be a number
 * this app invented, presented in the same type as one the workspace reported.
 */
const COMPUTE_ENVELOPES: Readonly<Record<string, { vcpus: number; memoryGb: number; dbuPerHour: number }>> = {
  MEDIUM: { vcpus: 2, memoryGb: 6, dbuPerHour: 0.5 },
};

/** What came back, in the three shapes the facts are read from. */
export type AppRead =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'refused'; status: number; message: string }
  | { kind: 'no-response'; message: string };

/** A workspace read of one app by name. Injected, so nothing here holds a client. */
export type AppReader = (name: string) => Promise<AppRead>;

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A record the API nests, or nothing, so a missing branch reads as absent. */
function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * A workspace folder URL whose path still says exactly what Apps reported.
 *
 * THE PATH FORM, NOT `/browse/folders/<id>`. The browser's own URL identifies a
 * folder by a numeric directory id this app has not asked for and would have to
 * make a second workspace call to learn; the documented shareable form is
 * `#workspace` followed by the full path, which is precisely the string Apps
 * already handed us. `encodeURI` rather than a per-segment `encodeURIComponent`
 * so a home folder's `user@example.com` survives as itself, as the documented
 * examples spell it, while a space in a folder name is still escaped.
 *
 * Anything that is not a `/Workspace/...` path resolves to no link at all. An
 * Apps deployment can report a source this app has no browser route for, and a
 * link built out of hope is worse than a row that is not drawn.
 */
function workspaceFolderUrl(host: string, path: string): string {
  const base = normalizeWorkspaceHost(host);
  const source = textOf(path);
  if (!base || !source.startsWith('/Workspace/')) return '';
  return `${base}/#workspace${encodeURI(source)}`;
}

/**
 * The tags the workspace reports, however it reports them.
 *
 * Apps has carried tags as a list of `{key, value}` pairs and as a plain map in
 * different workspace versions, and a version with neither is the common case.
 * All three are read here rather than in the card, so an unfamiliar shape
 * produces no chips instead of `[object Object]`.
 */
export function appTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => (typeof entry === 'string' ? entry.trim() : textOf(objectOf(entry).value) || textOf(objectOf(entry).key)))
      .filter(Boolean);
  }
  const map = objectOf(raw);
  return Object.values(map).map(textOf).filter(Boolean);
}

/**
 * What the workspace reports about the app serving, verbatim.
 *
 * READ RATHER THAN ASSUMED, which is the entire change. The endpoint badge was
 * hardcoded green, so a crashed app on stopped compute drew the same row as a
 * healthy one. Both states are in the record this app already fetched and
 * threw away.
 *
 * Nothing is normalised or mapped to a verdict here. A workspace version that
 * reports a state this app has never heard of should surface that word, not be
 * bucketed into a guess -- the card is read against the workspace UI, and the
 * two agreeing letter for letter is what makes it worth reading.
 */
export function appServing(body: Record<string, unknown>): AppServing {
  const app = objectOf(body.app_status);
  const compute = objectOf(body.compute_status);
  return {
    app: textOf(app.state),
    compute: textOf(compute.state),
    // The app's own sentence first: when both are unhappy, the application's
    // message is the one that names what went wrong.
    message: textOf(app.message) || textOf(compute.message),
  };
}

/** The compute, where the workspace named a size for it. */
export function appCompute(raw: unknown): AppCompute | null {
  const size = textOf(raw);
  if (!size) return null;
  return { size, envelope: COMPUTE_ENVELOPES[size.toUpperCase()] ?? null };
}

/**
 * The card's facts, out of one read. Pure, so every rule about what counts as
 * reported is assertable without a workspace.
 *
 * `answered` is about the READ, not about the app: a refusal and a timeout both
 * leave the page unable to say anything, and the card treats them the same way
 * -- it draws nothing. The distinction between them matters to a log, which is
 * where {@link readAppFacts} leaves it.
 */
export function appFacts(input: {
  read: AppRead;
  workspaceHost?: string;
  otelExporter?: string;
  otelExport?: ExporterReading;
}): AppFacts {
  const otelExporter = textOf(input.otelExporter);
  // Carried through a failed read as well. The count is taken from the
  // telemetry tables and does not depend on the Apps API answering, so
  // discarding it here would report "nothing measured" about a measurement
  // that was made.
  const otelExport = input.otelExport ?? NO_EXPORTER_READING;
  if (input.read.kind !== 'ok') return { ...NO_APP_FACTS, otelExporter, otelExport };

  const body = input.read.body;
  // The running deployment, which is the one whose creation time is the uptime
  // and whose creator is the deployer. `create_time` on the app itself is when
  // the app was first made, which is a different and much less useful fact.
  const deployment = objectOf(body.active_deployment);
  const gitSource = objectOf(deployment.git_source);
  const gitBacked = Object.keys(gitSource).length > 0;
  const sourcePath = gitBacked ? textOf(gitSource.source_code_path) : textOf(deployment.source_code_path);
  const appName = textOf(body.name);
  const workspaceHost = normalizeWorkspaceHost(input.workspaceHost);
  const gitRef = textOf(gitSource.branch) || textOf(gitSource.tag) || textOf(gitSource.commit);
  return {
    url: textOf(body.url),
    answered: true,
    description: textOf(body.description),
    compute: appCompute(body.compute_size),
    tags: appTags(body.tags),
    deployedAt: textOf(deployment.create_time) || textOf(body.update_time),
    deployedBy: textOf(deployment.creator) || textOf(body.updater),
    source: {
      path: sourcePath,
      // Git deployments are managed from the app's own workspace page. Uploaded
      // deployments link to the exact input folder Apps reports, never to the
      // generated deployment artifact or to a bundle path inferred elsewhere.
      workspaceUrl:
        gitBacked && workspaceHost && appName
          ? `${workspaceHost}/apps/${encodeURIComponent(appName)}`
          : workspaceFolderUrl(workspaceHost, sourcePath),
      gitRef,
    },
    serving: appServing(body),
    otelExporter,
    otelExport,
  };
}

/**
 * Production reader: the Apps API on the app's own service-principal
 * credentials, which Apps injects into the container.
 *
 * Never throws. Every failure becomes a `refused` or a `no-response`, including
 * the synchronous throw a `WorkspaceClient` makes on a machine with no workspace
 * configuration at all, which is every local run.
 */
export const workspaceAppReader: AppReader = async (name) => {
  try {
    const { WorkspaceClient } = await import('@databricks/sdk-experimental');
    const client = new WorkspaceClient({});
    const body = (await client.apiClient.request({
      path: `${APPS_PATH}/${encodeURIComponent(name)}`,
      method: 'GET',
      headers: new Headers({ Accept: 'application/json' }),
      raw: false,
    })) as Record<string, unknown>;
    return { kind: 'ok', body: body ?? {} };
  } catch (error) {
    const shape = (error ?? {}) as { statusCode?: unknown; status?: unknown; message?: unknown };
    const status = Number(shape.statusCode ?? shape.status ?? 0);
    const message = textOf(shape.message) || 'the call did not complete';
    if (Number.isFinite(status) && status >= 400) return { kind: 'refused', status, message };
    return { kind: 'no-response', message };
  }
};

/**
 * The facts, or the empty set.
 *
 * An app that does not know its own name -- which is every run outside Apps --
 * asks nothing and reports nothing. The exporter address is still read, because
 * it comes from the environment rather than from the workspace and is the one
 * fact a local run can honestly state.
 */
export async function readAppFacts(input: {
  name?: string;
  workspaceHost?: string;
  otelExporter?: string;
  read?: AppReader;
  readExport?: ExporterReader;
} = {}): Promise<AppFacts> {
  const name = (input.name ?? process.env[APP_NAME_ENV] ?? '').trim();
  const workspaceHost = input.workspaceHost ?? process.env.DATABRICKS_HOST ?? '';
  const otelExporter = (input.otelExporter ?? process.env[OTEL_ENDPOINT_ENV] ?? '').trim();
  // Counted before the name is checked, because the two are independent: the
  // exporter writes to the telemetry schema whether or not this process knows
  // what app it is, and a local run that can reach the warehouse can still say
  // truthfully what is in those tables.
  let otelExport: ExporterReading = NO_EXPORTER_READING;
  try {
    otelExport = await readExporter({ read: input.readExport });
  } catch (error) {
    console.warn('[settings] The exporter tables could not be counted:', (error as Error).message);
  }
  if (!name) return { ...NO_APP_FACTS, otelExporter, otelExport };
  let read: AppRead;
  try {
    read = await (input.read ?? workspaceAppReader)(name);
  } catch (error) {
    read = { kind: 'no-response', message: (error as Error).message };
  }
  if (read.kind !== 'ok') {
    console.warn(`[settings] The workspace could not be asked about the app ${name}:`, read.message);
  }
  return appFacts({ read, workspaceHost, otelExporter, otelExport });
}
