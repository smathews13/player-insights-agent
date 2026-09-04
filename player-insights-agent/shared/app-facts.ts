/**
 * What the deployment says about itself, as the Build and telemetry card reads it.
 *
 * The card used to carry two commit hashes and nothing else, so a reader who
 * wanted to know which host they were on, what compute it runs on, or when it
 * was last released had to leave the app for the workspace UI. Those facts are
 * the app's own record, and this is the shape they arrive in.
 *
 * EVERY FIELD IS ALLOWED TO BE ABSENT, and absence is the normal case rather
 * than an error. The Apps API answers with what a given workspace version knows
 * about; a fact this app cannot get an answer for renders no row at all, which
 * reads as a fact that was not established. The alternative -- a row reading
 * "not reported" for six of nine facts -- is the prose this page had removed.
 *
 * Shared rather than declared twice, because the server assembles it and the
 * client draws it, and a duplicated payload shape in this repository has already
 * let one side add a field the other silently dropped.
 */

/**
 * One telemetry table the exporter writes, as it was counted.
 *
 * `firstAt` and `lastAt` are the extremes of the rows that are actually there,
 * and they are carried rather than derived so the card can state the span the
 * figures cover. Telemetry does not backfill, so that span begins at the deploy
 * that switched telemetry on and never reaches further back, however old the
 * app is.
 */
export interface ExporterTable {
  /** The table's own name: `otel_spans`, `otel_metrics`. */
  table: string;
  rows: number;
  /** Extremes of the rows counted, ISO-ish, both '' for an empty table. */
  firstAt: string;
  lastAt: string;
}

/**
 * What was found when the exporter's tables were counted.
 *
 * FOUR STATES, AND ONLY ONE OF THEM IS A CLAIM ABOUT THE EXPORTER. `exporting`
 * and `silent` are findings from rows that were counted. `unreadable` is the
 * read failing, and it carries the platform's words rather than being folded
 * into `silent` -- a failed count is not a count of zero, and this app has
 * twice shipped a surface that made exactly that substitution.
 * `unmeasured` is the honest state before anything has been looked at.
 */
export type ExporterState = 'unmeasured' | 'exporting' | 'silent' | 'unreadable';

export interface ExporterReading {
  state: ExporterState;
  /** One entry per table counted. Empty unless the count succeeded. */
  tables: ExporterTable[];
  /** Why the count failed, in the platform's words. Empty otherwise. */
  error: string;
  /** The catalog and schema counted, so the row can name what it read. */
  schema: string;
}

/** Nothing has been counted, which is not the same as counting nothing. */
export const NO_EXPORTER_READING: ExporterReading = {
  state: 'unmeasured',
  tables: [],
  error: '',
  schema: '',
};

/**
 * What the workspace says about the app actually serving, as it says it.
 *
 * TWO STATES, BECAUSE THE PLATFORM REPORTS TWO. `app` is the application
 * process (`RUNNING`, `CRASHED`, `DEPLOYING`); `compute` is the container under
 * it (`ACTIVE`, `STOPPED`). An app can be reported running on compute that has
 * stopped, and collapsing them would pick one of the two to believe.
 *
 * EVERY FIELD MAY BE EMPTY, and empty means the workspace did not say -- never
 * that the answer was no. The endpoint badge used to be hardcoded green with no
 * reading at all behind it; the whole point of carrying these is that the
 * absence of an answer is now distinguishable from a good one.
 */
export interface AppServing {
  /** `app_status.state`, verbatim, or '' where the workspace did not report it. */
  app: string;
  /** `compute_status.state`, verbatim, or ''. */
  compute: string;
  /** The platform's own sentence, for the row that has to explain a bad state. */
  message: string;
}

/** Nothing was reported about serving, which is not a report of trouble. */
export const NO_APP_SERVING: AppServing = { app: '', compute: '', message: '' };

/** The compute an app runs on, where the workspace reports a size for it. */
export interface AppCompute {
  /** The size's own name, as the workspace spells it: `MEDIUM`, `LARGE`. */
  size: string;
  /**
   * The published envelope for that size, or null where this app has no figure
   * for the name the workspace gave. NEVER interpolated from a neighbouring
   * size: a DBU rate is a billing claim, and a wrong one on a page an operator
   * trusts is worse than a missing one.
   */
  envelope: { vcpus: number; memoryGb: number; dbuPerHour: number } | null;
}

/**
 * The public repository this product is published from.
 *
 * A PRODUCT FACT, NOT A READING, which is why it is a constant rather than
 * something derived from `git_source`: the internal remote a deployment was
 * built from is not the repository a reader should be sent to, and the login
 * gate has always named this one. Stated once here so the gate and the
 * Connections tab cannot come to name two different repositories.
 */
export const PUBLIC_SOURCE_REPO_URL = 'https://github.com/smathews13/player-insights-agent';

/** Where the source of the running deployment can be opened, per live metadata. */
export interface AppSource {
  /** The live deployment's workspace source path, or its Git subdirectory. */
  path: string;
  /**
   * The workspace destination for that source: the app's own page where Apps
   * manages a Git connection, or the folder browser for an uploaded deploy.
   * Empty when the workspace reported no path this app can build a link from.
   */
  workspaceUrl: string;
  /** Branch, tag or commit, where the running deployment came from Git. */
  gitRef: string;
}

export interface AppFacts {
  /** The app's URL, whole. The card renders the host and copies this. */
  url: string;
  /** Whether the workspace answered about the app at all. */
  answered: boolean;
  /** The app's own description string. */
  description: string;
  compute: AppCompute | null;
  /** Whatever the workspace reports as tags. Empty on a version that has none. */
  tags: string[];
  /** When the running deployment was created, ISO, and who created it. */
  deployedAt: string;
  deployedBy: string;
  /** Source links derived from the active deployment, never from bundle defaults. */
  source: AppSource;
  /**
   * Whether the workspace reports the app as serving.
   *
   * The endpoint badge was tinted green unconditionally -- the same defect as
   * the exporter row and as the badge that read OK on a deleted MLflow
   * experiment. It is a reading now, and an unanswered read tints nothing.
   */
  serving: AppServing;
  /**
   * Where spans and metrics are exported, from the standard OpenTelemetry
   * variable. Empty where nothing is configured, which is most deployments.
   */
  otelExporter: string;
  /**
   * What the exporter's tables actually hold, counted rather than assumed.
   *
   * The card used to state, in a comment and in its choice of tone, that these
   * tables are empty on every deployment of this app. That was false: appkit
   * bundles the OpenTelemetry Node SDK with auto-instrumentation, so an exporter
   * runs whether or not anything in this source initialises one. The row now
   * says what a count found, and `unmeasured` when no count was taken.
   */
  otelExport: ExporterReading;
}

/** The state a page starts in: nothing asked, so nothing claimed. */
export const NO_APP_FACTS: AppFacts = {
  url: '',
  answered: false,
  description: '',
  compute: null,
  tags: [],
  deployedAt: '',
  deployedBy: '',
  source: { path: '', workspaceUrl: '', gitRef: '' },
  serving: NO_APP_SERVING,
  otelExporter: '',
  otelExport: NO_EXPORTER_READING,
};
