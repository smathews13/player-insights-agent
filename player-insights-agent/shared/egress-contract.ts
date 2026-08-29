/**
 * Every way data leaves this app, what may be done about each, and the record of
 * it having happened.
 *
 * ── WHY THE REGISTRY IS A CONSTANT AND NOT A DATABASE TABLE ──
 *
 * The set of ways out of an app is a fact about the BUILD, not about the
 * deployment. A row an administrator could add would be a claim that the app
 * watches something it has no code to watch, and a row they could delete would
 * hide a path that still works. So the paths are declared here, in source, and
 * the only thing a deployment stores is whether each is permitted.
 *
 * ── THE FIELD THAT KEEPS THIS HONEST ──
 *
 * {@link EgressPath.enforcement} is the whole reason this file is worth reading.
 * A control panel that lists ten switches and applies two is worse than no panel
 * at all: it reads as coverage, it gets shown to somebody making a decision, and
 * the two it does not apply are the ones they stop worrying about. So every path
 * carries what the app can ACTUALLY do about it, in three values, and the panel
 * renders that word beside every row:
 *
 *   `enforced`      Turning it off removes the affordance. The switch does what
 *                   its label says.
 *   `stored`        The preference is recorded and NOTHING READS IT YET. The
 *                   affordance is still on screen. This is not a bug being
 *                   confessed to, it is a path whose control lives in a file
 *                   another lane owns, and the panel says so rather than
 *                   implying the switch bites.
 *   `uncontrollable` The app cannot stop it and will not pretend to. These paths
 *                   carry NO SWITCH -- an off switch that cannot be honoured is
 *                   the specific lie this field exists to prevent.
 *
 * A path may only move from `stored` to `enforced` in the same change that wires
 * it. Moving the word without wiring it is the one edit to this file that would
 * make the panel dishonest.
 *
 * ── WHAT THE RECORD MAY HOLD ──
 *
 * See {@link EgressEvent}. It says that an export happened, never what was in
 * it. There is no payload field, no value field, no byte count of content, and
 * no filename. An egress log full of the data it is watching is the leak it was
 * built to prevent, and the absence of those fields is the only enforcement of
 * that rule which survives somebody adding a feature in a hurry.
 */

/* ── The paths ─────────────────────────────────────────────────────────────── */

/**
 * One way out, by the name the record and the controls both use.
 *
 * Stable strings, because they are written into rows. Renaming one orphans every
 * event already recorded under it, so add rather than rename.
 */
export type EgressChannel =
  | 'chart-image'
  | 'generated-sql'
  | 'result-figures'
  | 'step-payload'
  | 'identifier'
  | 'grant-statement'
  | 'answer-prose'
  | 'workspace-link'
  | 'text-selection'
  | 'screen-capture';

/**
 * The coarse kind of thing that left, so a log can be read down a column.
 *
 * Narrower than the channel on purpose: an admin scanning a day wants to know
 * that four result sets and one chart image left, without reading ten path
 * names. `link` is in here because a link is a route to data rather than the
 * data, and collapsing it into the others would overstate what happened.
 */
export type EgressShape = 'image' | 'statement' | 'result-set' | 'identifier' | 'prose' | 'link';

/** What the app can actually do about a path. See the file header. */
export type EgressEnforcement = 'enforced' | 'stored' | 'uncontrollable';

export interface EgressPath {
  channel: EgressChannel;
  /** Short, sentence case, names the thing and not the mechanism. */
  label: string;
  shape: EgressShape;
  enforcement: EgressEnforcement;
  /**
   * Whether this path is permitted on a deployment that has stored nothing.
   *
   * Chosen against what leaves with no record and no governance rather than
   * against convenience. A path whose enforcement is `uncontrollable` still
   * declares one, and it is always true: the app cannot stop it, so recording it
   * as off would be a stored value contradicting observable behaviour.
   */
  allowedByDefault: boolean;
  /**
   * Where the affordance is, in the words a reader of the panel would use.
   *
   * One short phrase, no sentence. This is the only place the panel says
   * anything beyond a label and a state, and it is here because "generated SQL"
   * appears on three surfaces and an admin turning it off is entitled to know
   * which.
   */
  where: string;
  /**
   * Whether anything in the app actually CALLS the recorder for this path.
   *
   * ── THE FIELD THAT STOPS AN EMPTY LOG FROM LYING ──
   *
   * Separate from {@link EgressPath.enforcement}, and the separation is the
   * point: a path can be enforced and unreported, or reported and unenforced.
   * They are different questions and a panel that answered one for the other
   * would be wrong in the most reassuring direction.
   *
   * A log with no rows in it reads as "nothing has left". That is only true if
   * something would have said so. Where nothing reports, the empty log means
   * nothing whatsoever, and the panel has to say THAT rather than print a
   * comfortable zero. So the affordance that leads to a `reportEgress` call
   * flips this to true in the same change that adds the call, exactly the way
   * `enforcement` moves.
   *
   * `uncontrollable` paths are false and stay false. There is no click to hang a
   * report on: the app never learns that somebody selected an answer.
   */
  reported: boolean;
}

/**
 * Every path, in the order the panel lists controllable ones: switches first,
 * heaviest first. Uncontrollable paths stay in the registry (the build still
 * cannot stop them) but are not drawn on Settings.
 *
 * ── HOW THE ORDER WAS CHOSEN ──
 *
 * Descending by what leaves. A chart image and a result set are the data; a SQL
 * statement is the app's account of how it asked; an identifier names
 * infrastructure.
 */
export const EGRESS_PATHS: readonly EgressPath[] = [
  {
    channel: 'chart-image',
    label: 'Chart image download',
    shape: 'image',
    // Wired. Plotly's mode bar carries "download plot as PNG" unless the config
    // removes it, and the config is one object every chart in the app is drawn
    // with, so the switch reaches all of them. Enforced IN THE BROWSER, which is
    // the weaker of the two kinds: the reader already has the figure, so this
    // closes the button and not the possibility. Compare `workspace-link`, where
    // the value never leaves the server.
    enforcement: 'enforced',
    // OFF. A PNG of a chart is a data extract that leaves with no record of what
    // was in it, nobody asked for the affordance, and Plotly offered it by
    // default rather than by decision.
    allowedByDefault: false,
    reported: false,
    where: 'Chart mode bar, on an answer',
  },
  /*
   * ── THESE TWO CARRIED A SWITCH FOR AN AFFORDANCE THAT DOES NOT EXIST ──
   *
   * The first enumeration named them from the panels the values are DISPLAYED
   * in, and assumed a copy button because every other panel in the app has one.
   * A second pass looked for the button instead of reasoning about it, and there
   * is none: `StepResult.tsx` has exactly two buttons and both expand a section,
   * there is no `navigator.clipboard` and no download anywhere near either
   * panel, and the app has no `Blob`, `createObjectURL` or `download` attribute
   * in it at all.
   *
   * So the rows are `uncontrollable`, which takes their switches away. A switch
   * over a path with no affordance is the same lie as a switch over a path
   * nothing honours -- worse, in fact, because turning it off would appear to
   * work forever. What actually carries these values out is selection and
   * screenshot, which are already listed below under their own names.
   *
   * They stay in the registry rather than being deleted. They are real shapes of
   * data on real screens, an administrator asking "can somebody take the rows?"
   * deserves the answer rather than silence, and the day somebody adds a copy
   * button here is the day this comment tells them what to change.
   */
  {
    channel: 'result-figures',
    label: 'Result figures',
    shape: 'result-set',
    enforcement: 'uncontrollable',
    allowedByDefault: true,
    reported: false,
    where: 'Step details, figure breakdown',
  },
  {
    channel: 'step-payload',
    label: 'Step input and output',
    shape: 'result-set',
    enforcement: 'uncontrollable',
    allowedByDefault: true,
    reported: false,
    where: 'Agent map, step payload panel',
  },
  {
    channel: 'generated-sql',
    label: 'Generated SQL copy',
    shape: 'statement',
    enforcement: 'stored',
    // ON. The statement is the app's account of what it asked, it carries no
    // rows, and copying it into an editor is how somebody checks an answer they
    // were given. Turning this off costs verifiability and saves no data.
    allowedByDefault: true,
    reported: true,
    where: 'Run details, agent map',
  },
  {
    channel: 'workspace-link',
    label: 'Workspace and MLflow links',
    shape: 'link',
    // The only one wired today, and it is wired on the server: the URL is not
    // sent to the browser at all when this is off, so there is no link to
    // suppress in a component somebody else owns.
    enforcement: 'enforced',
    // ON. A link is how a reader gets from a figure to the object it came from,
    // which is the provenance the rest of the app is built to show.
    allowedByDefault: true,
    reported: false,
    where: 'Monitoring drawer, run details',
  },
  {
    channel: 'identifier',
    label: 'Identifier copy',
    shape: 'identifier',
    enforcement: 'stored',
    // ON. A run id, a trace id, a warehouse id and a commit hash name
    // infrastructure. None of them is a person and none is a row.
    allowedByDefault: true,
    reported: true,
    where: 'Run header, run details, Connections',
  },
  {
    channel: 'grant-statement',
    label: 'Grant statement copy',
    shape: 'statement',
    enforcement: 'stored',
    // ON. The statement is printed BECAUSE the app could not run it, and the
    // person reading it is the one who has to. Withholding it strands a refusal
    // with no remedy.
    allowedByDefault: true,
    reported: true,
    where: 'Administrators, roster, Connections',
  },
  {
    channel: 'answer-prose',
    label: 'Answer text',
    shape: 'prose',
    // An answer is prose on a page. Selecting it is the browser's, not ours.
    enforcement: 'uncontrollable',
    allowedByDefault: true,
    reported: false,
    where: 'Every answer',
  },
  {
    channel: 'text-selection',
    label: 'Selection and ordinary copy',
    shape: 'prose',
    enforcement: 'uncontrollable',
    allowedByDefault: true,
    reported: false,
    where: 'Every surface',
  },
  {
    channel: 'screen-capture',
    label: 'Screenshots and re-typing',
    shape: 'image',
    enforcement: 'uncontrollable',
    allowedByDefault: true,
    reported: false,
    where: 'Outside the app',
  },
];

const BY_CHANNEL: ReadonlyMap<EgressChannel, EgressPath> = new Map(EGRESS_PATHS.map((path) => [path.channel, path]));

/** One path, or null for a channel this build does not know. */
export function egressPath(channel: string): EgressPath | null {
  return BY_CHANNEL.get(channel as EgressChannel) ?? null;
}

/** Whether a string names a path this build knows about. */
export function isEgressChannel(value: unknown): value is EgressChannel {
  return typeof value === 'string' && BY_CHANNEL.has(value as EgressChannel);
}

/**
 * The paths an administrator is offered a switch for.
 *
 * `uncontrollable` paths are excluded HERE rather than filtered at the one place
 * that draws them, so a second surface cannot reach its own conclusion and offer
 * a switch for a screenshot.
 */
export function controllablePaths(): readonly EgressPath[] {
  return EGRESS_PATHS.filter((path) => path.enforcement !== 'uncontrollable');
}

/**
 * The paths something in the app actually reports.
 *
 * Empty remains legitimate for a build with no producers. In this build the
 * generated-SQL, identifier and grant-statement copy paths report; the image and
 * link enforcement paths do not.
 */
export function reportingPaths(): readonly EgressPath[] {
  return EGRESS_PATHS.filter((path) => path.reported);
}

/** Whether any path at all reports, which is what makes an empty log readable. */
export function anythingReports(): boolean {
  return EGRESS_PATHS.some((path) => path.reported);
}

/* ── The controls ──────────────────────────────────────────────────────────── */

/** Whether each path is permitted, by channel. Complete: every channel present. */
export type EgressControls = Readonly<Record<EgressChannel, boolean>>;

/** What a deployment that has stored nothing permits. */
export function defaultEgressControls(): EgressControls {
  const controls = {} as Record<EgressChannel, boolean>;
  for (const path of EGRESS_PATHS) controls[path.channel] = path.allowedByDefault;
  return controls;
}

/**
 * The stored rows folded onto the defaults, ignoring anything unrecognised.
 *
 * A row naming a channel this build has never heard of is DROPPED rather than
 * carried, because the only thing that could have written it is a newer build,
 * and an older one honouring a switch it cannot apply is the dishonesty at the
 * top of this file arriving through the database instead of through the source.
 *
 * An `uncontrollable` path's stored row is ignored for the same reason: nothing
 * can enforce it, so reading it back as off would put a false state on screen.
 */
export function egressControlsFrom(rows: readonly { channel: string; allowed: boolean }[]): EgressControls {
  const controls = { ...defaultEgressControls() } as Record<EgressChannel, boolean>;
  for (const row of rows) {
    const path = egressPath(row.channel);
    if (!path || path.enforcement === 'uncontrollable') continue;
    controls[path.channel] = row.allowed;
  }
  return controls;
}

/**
 * Whether one path is permitted right now.
 *
 * An `uncontrollable` path always answers true, whatever is stored. That is not
 * a loophole, it is the honest reading: the app cannot stop a screenshot, so
 * answering false here would make every caller behave as though it had.
 */
export function egressAllowed(controls: EgressControls, channel: EgressChannel): boolean {
  const path = egressPath(channel);
  if (!path) return false;
  if (path.enforcement === 'uncontrollable') return true;
  return controls[channel];
}

/** What the panel sends when an administrator moves one switch. */
export interface EgressControlChange {
  channel: EgressChannel;
  allowed: boolean;
}

/* ── The record ────────────────────────────────────────────────────────────── */

/**
 * What became of an attempt.
 *
 * `refused` exists because it is the most interesting row in the table. Nothing
 * in the browser is asked politely: a client running an old bundle, or one whose
 * affordance was put back by hand, will still report an export through a channel
 * this deployment has turned off. The server records the attempt and refuses to
 * mark it as having succeeded, which is the only way an administrator finds out.
 */
export type EgressOutcome = 'left' | 'refused';

/**
 * One export, as the record holds it.
 *
 * ── READ THE FIELD LIST AS A LIST OF PROHIBITIONS ──
 *
 * There is no `payload`, no `value`, no `content`, no `rows`, no `filename` and
 * no `bytes`. Every one of those was considered and every one of them would make
 * this table a copy of the data it exists to watch. `itemCount` is a COUNT and
 * never a sample: "eleven figures left" says the shape without saying the
 * figures.
 *
 * `runId` and `conversationId` are pointers into records the app already holds
 * under the reader's own permissions. They are how an administrator finds out
 * WHAT was exported, if they are entitled to: they open the run. That indirection
 * is the design, not an inconvenience, because it means this table grants
 * nothing on its own and the answer stays conditioned on the asker's grants the
 * way Monitoring already conditions it.
 */
export interface EgressEvent {
  id: string;
  /** ISO 8601, as the row recorded it. */
  occurredAt: string;
  /** Who did it. The signed-in address, never a display name the app invented. */
  actor: string;
  channel: EgressChannel;
  shape: EgressShape;
  outcome: EgressOutcome;
  /**
   * The app surface it happened on, as one of the app's own route names.
   *
   * Free text on the wire and clamped on the way in, because a client can name a
   * page this build does not have and that is not a reason to lose the row.
   */
  surface: string;
  /** The run it came from, or null where the export was not about one run. */
  runId: string | null;
  conversationId: string | null;
  /**
   * How many things went, where that is countable and known.
   *
   * Null rather than zero for "not counted". A chart image is one image and says
   * 1; a copied identifier says 1; a figure breakdown says how many figures. An
   * export of nothing is not an export, so zero is never a legitimate value and
   * is read back as null.
   */
  itemCount: number | null;
}

/** What the app can establish about one read of its egress event ledger. */
export type EgressEventReadState = 'read' | 'unavailable' | 'not-migrated';

/**
 * Deployment-local storage provenance shown to administrators.
 *
 * These are logical Lakebase names and retention semantics only. Connection
 * details and credentials never belong in this payload.
 */
export interface EgressStorageMetadata {
  store: 'Lakebase (Postgres)';
  eventsTable: string;
  controlsTable: string;
  retained: string;
  retention: string;
  identityScope: string;
}

/** One fixed-query page of recent event metadata. */
export interface EgressEventsPayload {
  events: readonly EgressEvent[];
  readState: EgressEventReadState;
  pageSize: number;
  nextCursor: string | null;
  readAt: string;
  storage: EgressStorageMetadata;
}

/**
 * What a client sends to record one export. The server decides the rest.
 *
 * `surface` is optional so that wiring an affordance is genuinely one line. Left
 * out, the recorder fills it from the route the click happened on, which is what
 * the field is for and is more reliable than a string typed at each call site --
 * a hand-written surface goes stale the moment a component is reused on a second
 * page, and it goes stale silently.
 */
export interface EgressReport {
  channel: EgressChannel;
  surface?: string;
  runId?: string | null;
  conversationId?: string | null;
  itemCount?: number | null;
}

export interface EgressControlsPayload {
  controls: EgressControls;
  /**
   * Whether the stored rows could be read. False means these are the DEFAULTS
   * and the panel says so: an administrator looking at a switch needs to know
   * whether it is showing their decision or the build's.
   */
  stored: boolean;
  paths: readonly EgressPath[];
  storage: EgressStorageMetadata;
}

/* ── What the catalog says, and what it does not ───────────────────────────── */

/**
 * Whether the platform has anything to say about a table's columns.
 *
 * ── THE ONE RULE THIS TYPE EXISTS TO ENFORCE ──
 *
 * THERE IS NO VALUE MEANING "NO PERSONAL DATA". The app cannot establish that,
 * and a word for it would be read as a clearance by the first person who saw it.
 * The three values are "the catalog says something", "the catalog says nothing"
 * and "we could not ask", and the second two are DIFFERENT: one is a fact about
 * the table's governance and the other is a fact about this request.
 *
 * `classified` does not mean "contains personal data" either. It means Unity
 * Catalog carries a tag, a column mask or a row filter on this table, and the
 * panel shows what and how many. What that tag MEANS is the customer's own
 * taxonomy and this app does not interpret it.
 */
export type ClassificationState = 'classified' | 'not-classified' | 'not-checked';

/** One column the catalog carries something on. */
export interface ClassifiedColumn {
  column: string;
  /**
   * The tag names Unity Catalog holds on this column.
   *
   * Names only, never values. A tag VALUE can itself be a sensitive string on a
   * customer's own taxonomy, and this panel has no need of it: an administrator
   * asking whether a table is governed is answered by the tag being present.
   */
  tags: readonly string[];
  masked: boolean;
}

/**
 * What the platform says about one table.
 *
 * Every field is separately absent-able, because the two reads behind them fail
 * independently: column tags come from a SQL statement and masks come from the
 * table's own metadata, and one answering while the other does not is ordinary.
 */
export interface TableClassification {
  table: string;
  state: ClassificationState;
  columns: readonly ClassifiedColumn[];
  /** Null where it was not read. Never defaulted to false. */
  rowFilter: boolean | null;
  /** Why nothing was established, or '' when something was. */
  notChecked: string;
}

/**
 * The words the panel prints for each state.
 *
 * Here rather than in the component so that the one word which must never appear
 * is absent from a place a reviewer can check, and so a second surface cannot
 * word it more reassuringly.
 */
export const CLASSIFICATION_LABEL: Readonly<Record<ClassificationState, string>> = {
  classified: 'Classified',
  'not-classified': 'Not classified',
  'not-checked': 'Not checked',
};

/**
 * The pill family each state renders in.
 *
 * `not-classified` is NEUTRAL and deliberately not positive. A green chip on a
 * table nobody has classified is this panel awarding a clearance it has no
 * grounds for, which is the whole failure mode the honesty rules above are
 * written against.
 */
export const CLASSIFICATION_TONE: Readonly<Record<ClassificationState, 'info' | 'neutral' | 'warn'>> = {
  classified: 'info',
  'not-classified': 'neutral',
  'not-checked': 'warn',
};

export interface EgressClassificationPayload {
  tables: readonly TableClassification[];
  /** Why none of them could be read, or '' when the reads ran. */
  blocked: string;
  readAt: string;
}
