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
import { ExpiringLruCache } from './expiring-lru';
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

/** Where a folder's numeric id is asked for, by the path Apps reported. */
export const WORKSPACE_STATUS_PATH = '/api/2.0/workspace/get-status';

/**
 * A workspace path turned into the numeric folder id, or '' for anything that
 * did not resolve. Injected, so the rules below are assertable without a
 * workspace and so a refusal is a missing id rather than an exception.
 */
export type FolderIdResolver = (path: string) => Promise<string>;

/**
 * The prefix of a Workspace path. Anything else -- a repo-relative path from a
 * Git deployment, a volume, a bare name -- is not a folder this app can resolve.
 */
const WORKSPACE_PREFIX = '/Workspace/';

/**
 * The workspace the app is in, read off the app's own URL.
 *
 * Apps publishes at `<app-name>-<workspace-id>.<cloud>.databricksapps.com`, so
 * the id is already in a field this module fetches -- which matters, because
 * NOTHING HANDS THE CONTAINER A WORKSPACE ID. `DATABRICKS_WORKSPACE_ID` is unset
 * on Apps (`ops-routes.ts` reads it off a response header for the same reason),
 * and a literal here would be a real customer workspace id in a repository that
 * is published.
 *
 * The `databricksapps.com` suffix is required rather than assumed: without it
 * this would mine digits out of any host that happened to end a label with
 * some, and a wrong `?o=` sends a reader to a workspace switch they cannot make.
 */
export function workspaceIdFromAppUrl(url: string): string {
  return /^https?:\/\/[^./]*?-(\d{6,})\.[^/]*databricksapps\.com/i.exec(textOf(url))?.[1] ?? '';
}

/** `?o=<workspace id>`, where one was established. */
function withWorkspace(url: string, workspaceId: string): string {
  const org = textOf(workspaceId);
  return org ? `${url}?o=${encodeURIComponent(org)}` : url;
}

/**
 * The browser's own URL for a workspace folder.
 *
 * `/browse/folders/<id>?o=<workspace>`, WHICH IS THE FORM SAM ASKED FOR and the
 * one the workspace UI puts in the address bar. It briefly rendered as
 * `#workspace/<path>` instead, on the argument that a path needs no second
 * workspace call -- true, and beside the point: the row exists to be followed,
 * and the pattern an operator can paste back to somebody else is this one.
 *
 * The id is never derived from the path. It comes from
 * {@link workspaceFolderIdResolver} asking the workspace what the folder is, so
 * an unresolvable path produces no link rather than a folder id that is a guess.
 */
export function browseFolderUrl(input: { host: string; folderId: string; workspaceId: string }): string {
  const base = normalizeWorkspaceHost(input.host);
  const id = textOf(input.folderId);
  if (!base || !id) return '';
  return withWorkspace(`${base}/browse/folders/${encodeURIComponent(id)}`, input.workspaceId);
}

/**
 * The app's own workspace page, which is where a Git deployment's source is
 * managed rather than held.
 *
 * A Git-sourced app has NO workspace folder: Apps reports a repository, a branch
 * and a path inside that repository, and materialises nothing an operator can
 * open. This page is the honest destination for it -- it names the repository,
 * the resolved commit and the source path -- and it is the fallback for an
 * uploaded deployment whose folder id could not be resolved.
 */
export function appPageUrl(input: { host: string; appName: string; workspaceId: string }): string {
  const base = normalizeWorkspaceHost(input.host);
  const name = textOf(input.appName);
  if (!base || !name) return '';
  return withWorkspace(`${base}/apps/${encodeURIComponent(name)}`, input.workspaceId);
}

/**
 * The workspace folder the RUNNING deployment was made from, where it has one.
 *
 * `active_deployment.source_code_path` and nothing else. Not
 * `deployment_artifacts.source_code_path`, which is the snapshot the platform
 * copied into the app's own service-principal home and which nobody edits, and
 * not the Git deployment's own `source_code_path`, which is relative to a
 * repository and names no workspace object at all.
 *
 * NOTHING AT ALL FOR A GIT DEPLOYMENT, even when the record still carries a
 * workspace path beside the repository. That path is where a bundle deploy last
 * put files; it is not what a Git-sourced app runs, and an operator sent there
 * is reading code that is not serving. Which of the two is live is exactly what
 * this row is for.
 */
export function sourceFolderPath(body: Record<string, unknown>): string {
  const deployment = objectOf(body.active_deployment);
  if (Object.keys(objectOf(deployment.git_source)).length > 0) return '';
  const path = textOf(deployment.source_code_path);
  return path.startsWith(WORKSPACE_PREFIX) ? path : '';
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
      .map((entry) =>
        typeof entry === 'string' ? entry.trim() : textOf(objectOf(entry).value) || textOf(objectOf(entry).key)
      )
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
  /**
   * The numeric id of {@link sourceFolderPath}, where the workspace resolved
   * one. Passed in rather than fetched here so this stays a pure function:
   * `readAppFacts` owns the second call and the cache in front of it.
   */
  sourceFolderId?: string;
  /** Overrides the id read off the app's own URL. For tests and for a caller that already knows. */
  workspaceId?: string;
}): AppFacts {
  const otelExporter = textOf(input.otelExporter);
  // Carried through a failed read as well. The count is taken from the
  // telemetry tables and does not depend on the Apps API answering, so
  // discarding it here would report "nothing measured" about a measurement
  // that was made.
  const otelExport = input.otelExport ?? NO_EXPORTER_READING;
  if (input.read.kind !== 'ok') return { ...NO_APP_FACTS, otelExporter, otelExport };

  const body = input.read.body;
  const appUrl = textOf(body.url);
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
  const workspaceId = textOf(input.workspaceId) || workspaceIdFromAppUrl(appUrl);
  // Never for a Git deployment, whatever id it was handed: see
  // `sourceFolderPath` for why a workspace path on a Git-sourced app is the
  // wrong folder rather than a second-best one.
  const folderUrl = gitBacked
    ? ''
    : browseFolderUrl({ host: workspaceHost, folderId: input.sourceFolderId ?? '', workspaceId });
  return {
    url: appUrl,
    answered: true,
    description: textOf(body.description),
    compute: appCompute(body.compute_size),
    tags: appTags(body.tags),
    deployedAt: textOf(deployment.create_time) || textOf(body.update_time),
    deployedBy: textOf(deployment.creator) || textOf(body.updater),
    source: {
      path: sourcePath,
      // THE FOLDER WINS WHENEVER THE WORKSPACE RESOLVED ONE. That is the
      // uploaded and the bundle-deployed case, and it is the link Sam asked
      // for: `/browse/folders/<id>?o=<workspace>`, pointing at the folder that
      // actually holds what is serving -- never at the generated snapshot in
      // the service principal's home, and never at a bundle path inferred here
      // instead of read.
      //
      // The app's own page is the fallback, and only where Apps named a source
      // at all. It is the whole answer for a Git deployment, which has no
      // workspace folder to open; it also covers an uploaded folder this app was
      // refused the id for. A deployment that reported no source gets no link,
      // because a row that goes somewhere unrelated is worse than a row that is
      // not drawn.
      workspaceUrl: folderUrl || (sourcePath ? appPageUrl({ host: workspaceHost, appName, workspaceId }) : ''),
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
 * Folder ids already resolved, kept briefly and with a global cardinality cap.
 *
 * A deployment's source folder does not move while the app runs, and
 * `/api/settings` is read on every visit to the Connections tab: without this,
 * one link on one card would cost a workspace call per page load.
 */
export const FOLDER_ID_CACHE_MAX_ENTRIES = 256;
export const FOLDER_ID_CACHE_TTL_MS = 60 * 60_000;
const knownFolderIds = new ExpiringLruCache<string>(FOLDER_ID_CACHE_MAX_ENTRIES, FOLDER_ID_CACHE_TTL_MS);

/** For tests, which must not inherit an id resolved by an earlier case. */
export function forgetFolderIds(): void {
  knownFolderIds.clear();
}

/**
 * Production resolver: the workspace API on the app's own service-principal
 * credentials.
 *
 * Never throws and never guesses. A refusal, a deleted folder and a workspace
 * that cannot be reached all return '', and the caller falls back to the app's
 * own page -- which is a destination that exists -- rather than to a folder id
 * this app made up. The warning names the path, because "the App source row
 * points at the app page instead of the folder" is otherwise invisible.
 */
export const workspaceFolderIdResolver: FolderIdResolver = async (path) => {
  const wanted = path.trim();
  if (!wanted) return '';
  const cached = knownFolderIds.get(wanted);
  if (cached !== undefined) return cached;
  let id = '';
  try {
    const { WorkspaceClient } = await import('@databricks/sdk-experimental');
    const client = new WorkspaceClient({});
    const body = (await client.apiClient.request({
      path: WORKSPACE_STATUS_PATH,
      method: 'GET',
      query: { path: wanted },
      headers: new Headers({ Accept: 'application/json' }),
      raw: false,
    })) as Record<string, unknown>;
    // `object_id` is the number the browser's own folder URL carries.
    // `resource_id` is the same value as a string on the versions that send it.
    const found = (body ?? {}).object_id ?? (body ?? {}).resource_id;
    id = typeof found === 'number' ? String(found) : textOf(found);
  } catch (error) {
    console.warn(
      `[settings] The workspace could not resolve the folder id for ${wanted} ` +
        `(${(error as Error).message}), so the App source row points at the app's own page.`
    );
  }
  // Cached either way, but only for the bounded TTL. Retrying a refusal per page
  // load is waste; retaining it forever would hide a later grant.
  knownFolderIds.set(wanted, id);
  return id;
};

/**
 * The facts, or the empty set.
 *
 * An app that does not know its own name -- which is every run outside Apps --
 * asks nothing and reports nothing. The exporter address is still read, because
 * it comes from the environment rather than from the workspace and is the one
 * fact a local run can honestly state.
 */
export async function readAppFacts(
  input: {
    name?: string;
    workspaceHost?: string;
    otelExporter?: string;
    read?: AppReader;
    readExport?: ExporterReader;
    resolveFolderId?: FolderIdResolver;
  } = {}
): Promise<AppFacts> {
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
  // ASKED ONLY WHERE THERE IS A FOLDER TO ASK ABOUT. A Git deployment reports a
  // repository-relative path, which names no workspace object, so this second
  // call is not made for it at all.
  const folderPath = read.kind === 'ok' ? sourceFolderPath(read.body) : '';
  let sourceFolderId = '';
  if (folderPath) {
    try {
      sourceFolderId = await (input.resolveFolderId ?? workspaceFolderIdResolver)(folderPath);
    } catch (error) {
      console.warn(`[settings] The folder id for ${folderPath} could not be read:`, (error as Error).message);
    }
  }
  return appFacts({ read, workspaceHost, otelExporter, otelExport, sourceFolderId });
}
