/**
 * Which asset browser a Connections field opens, and what a pick means once it
 * is made.
 *
 * WHY THIS EXISTS. Every editable field on the Connections page took a typed
 * string. A Genie space id, a SQL warehouse id, a three-part Unity Catalog name:
 * values nobody remembers and everybody pastes, from a workspace the operator is
 * already signed in to. `shared/browse-contract.ts` and the `/api/browse/*`
 * routes list what that sign-in can see. This module is the join between the two:
 * which list a field browses, how the drill-down walks, and what string a chosen
 * row actually stores.
 *
 * IT IS PURE ON PURPOSE. The three things most likely to be got wrong here are
 * decisions rather than markup: whether a chosen row replaces the value or is
 * added to a list, whether a `data_catalogs` pick opened one schema or a whole
 * catalog, and what a reader is told when browsing is unavailable. Each of those
 * is assertable without composing a screen, and each has a test below the
 * component rather than inside it.
 *
 * WHAT IT DELIBERATELY DOES NOT MAP. `notebooks`. The browse route exists and
 * works, and no editable field on this page takes a workspace path: the row that
 * reads "Notebook declarations table" holds a TABLE, and offering a notebook
 * picker for it would be a control that cannot produce a working value. See the
 * comment on that resource in `shared/deployment-config.ts`.
 *
 * THREE OUTCOMES STAY APART, which is the contract's rule and is the whole
 * reason the fallback is honest. `ok` with no rows is an answer: the workspace
 * was asked and nothing is visible. `unavailable` is not an answer about assets
 * at all, and the copy for it says so rather than showing an empty list.
 * `failed` is a call that broke. A reader is never told they cannot see
 * something on the strength of a 403.
 */
import type { BrowseItem, BrowseKind, BrowseResponse } from '../../shared/browse-contract';
import { dataCatalogFormLabel, splitConfiguredList } from '../../shared/data-catalog-scope';

/**
 * One field's browser, as a chain of lists rather than a single one.
 *
 * `levels` reads outside in. A field whose value is a three-part table name
 * browses catalogs, then schemas, then tables; a field whose value is a Genie
 * space id browses one list and stops.
 */
export interface AssetPickerSpec {
  /** The `CONNECTED_RESOURCES` id this browses for. */
  field: string;
  /** The drill-down chain, outermost first. Never contains `notebooks`. */
  levels: readonly BrowseKind[];
  /**
   * Which levels can produce a value.
   *
   * `last` is the ordinary case: the chain exists to reach the leaf, and the
   * levels above it are navigation. `every` is `data_catalogs`, where a catalog
   * and a schema are both legitimate values that mean materially different
   * things, and hiding the catalog-level choice would hide half the field.
   */
  pickAt: 'last' | 'every';
  /**
   * Whether the field holds a comma-joined LIST rather than one value.
   *
   * It decides what a pick does to what is already there: a list gains an
   * entry, a single value is replaced. Getting this wrong silently discards a
   * declared read scope, which is why it is a field on the spec and not a guess
   * made at the call site.
   */
  multi: boolean;
  /** Heading over the browser. Says whose visibility the list is about. */
  title: string;
  /** Label on the text input that sits beside the browser, always. */
  typeLabel: string;
  /**
   * The one thing typing can do that browsing cannot, where there is one.
   *
   * Empty for most fields, because there the text input is a fallback and
   * nothing more. `catalog_denylist` takes patterns, which no list of existing
   * tables can offer, so there it is the primary route and says so.
   */
  typeNote: string;
}

const CATALOG_LEVELS: readonly BrowseKind[] = ['catalogs'];
const SCHEMA_LEVELS: readonly BrowseKind[] = ['catalogs', 'schemas'];
const TABLE_LEVELS: readonly BrowseKind[] = ['catalogs', 'schemas', 'tables'];

/**
 * Every field that gets a browser, and the browser it gets.
 *
 * The fields absent from this map are absent for a reason a reader can check:
 * `llm-gateway` is a three-value routing mode rather than an object in the
 * workspace, and `max-output-tokens` is a number. `experiment-id` IS mapped,
 * even though Apps has no MLflow scope: the picker opens to the settled
 * unavailable state and the typed box stays labelled, rather than implying there
 * was never a list to ask for.
 */
const SPECS: readonly AssetPickerSpec[] = [
  {
    field: 'catalog',
    levels: CATALOG_LEVELS,
    pickAt: 'last',
    multi: false,
    title: 'Catalogs your sign-in can see',
    typeLabel: 'Or type a catalog name',
    typeNote: '',
  },
  {
    field: 'schema',
    levels: SCHEMA_LEVELS,
    pickAt: 'last',
    multi: false,
    title: 'Schemas your sign-in can see',
    typeLabel: 'Or type a schema name',
    typeNote: '',
  },
  {
    field: 'notebook-declaration',
    levels: TABLE_LEVELS,
    pickAt: 'last',
    multi: false,
    title: 'Tables your sign-in can see',
    // Named as three parts, because the value is one and a reader who types a
    // bare table name gets a row this app cannot read.
    typeLabel: 'Or type a three-part table name',
    typeNote: '',
  },
  {
    field: 'catalog-allowlist',
    levels: SCHEMA_LEVELS,
    pickAt: 'every',
    multi: true,
    title: 'Catalogs and schemas your sign-in can see',
    typeLabel: 'Or type a catalog, or catalog.schema',
    typeNote: '',
  },
  {
    field: 'catalog-denylist',
    levels: TABLE_LEVELS,
    pickAt: 'last',
    multi: true,
    title: 'Tables your sign-in can see',
    typeLabel: 'Or type a table name or a pattern',
    typeNote: '',
  },
  {
    field: 'genie-data',
    levels: ['genie-spaces'],
    pickAt: 'last',
    multi: false,
    title: 'Genie spaces your sign-in can see',
    typeLabel: 'Or type a Genie space id',
    typeNote: '',
  },
  {
    field: 'genie-dictionary',
    levels: ['genie-spaces'],
    pickAt: 'last',
    multi: false,
    title: 'Genie spaces your sign-in can see',
    typeLabel: 'Or type a Genie space id',
    typeNote: '',
  },
  {
    field: 'sql-warehouse',
    levels: ['warehouses'],
    pickAt: 'last',
    multi: false,
    title: 'SQL warehouses your sign-in can see',
    typeLabel: 'Or type a warehouse id',
    typeNote: '',
  },
  {
    field: 'llm-endpoint',
    levels: ['serving-endpoints'],
    pickAt: 'last',
    multi: false,
    title: 'Serving endpoints your sign-in can see',
    typeLabel: 'Or type an endpoint name',
    typeNote: '',
  },
  {
    field: 'judge-endpoint',
    levels: ['serving-endpoints'],
    pickAt: 'last',
    multi: false,
    title: 'Serving endpoints your sign-in can see',
    typeLabel: 'Or type an endpoint name',
    typeNote: '',
  },
  {
    field: 'lakebase',
    levels: ['lakebase-projects', 'lakebase-branches', 'lakebase-databases'],
    pickAt: 'last',
    multi: false,
    title: 'Lakebase databases your sign-in can see',
    typeLabel: 'Or type projects/.../branches/.../databases/...',
    typeNote: '',
  },
  {
    field: 'assets-volume',
    levels: ['catalogs', 'schemas', 'volumes'],
    pickAt: 'last',
    multi: false,
    title: 'Volumes your sign-in can see',
    typeLabel: 'Or type a volume name (var.volume is the leaf name)',
    typeNote: '',
  },
  {
    field: 'semantic-index-endpoint',
    levels: ['vector-search-endpoints'],
    pickAt: 'last',
    multi: false,
    title: 'Vector Search endpoints your sign-in can see',
    typeLabel: 'Or type an endpoint name',
    typeNote: '',
  },
  {
    field: 'semantic-index',
    levels: ['vector-search-endpoints', 'vector-search-indexes'],
    pickAt: 'last',
    multi: false,
    title: 'Vector Search indexes your sign-in can see',
    typeLabel: 'Or type a three-part index name',
    typeNote: '',
  },
  {
    field: 'experiment-id',
    levels: ['experiments'],
    pickAt: 'last',
    multi: false,
    title: 'MLflow experiments',
    typeLabel: 'Type the experiment id',
    typeNote: '',
  },
];

const SPEC_BY_FIELD = new Map(SPECS.map((spec) => [spec.field, spec]));

/** Every field with a browser, for tests and for anything that wants the set. */
export const PICKER_FIELDS: readonly string[] = SPECS.map((spec) => spec.field);

/** The browser for a field, or null where the field has no list behind it. */
export function pickerForField(field: string): AssetPickerSpec | null {
  return SPEC_BY_FIELD.get(field) ?? null;
}

/**
 * Where in the chain the reader is, as the two names a deeper list needs.
 *
 * Not a level index: the index is derivable from these two and the reverse is
 * not, and the deeper routes need the names anyway. `{ '', '' }` is the top.
 */
export interface PickerCursor {
  catalog: string;
  schema: string;
}

export const PICKER_TOP: PickerCursor = { catalog: '', schema: '' };

/** How many names the cursor carries, which is how deep the chain has gone. */
export function cursorDepth(cursor: PickerCursor): number {
  if (!cursor.catalog.trim()) return 0;
  return cursor.schema.trim() ? 2 : 1;
}

/**
 * Which list to fetch at this cursor.
 *
 * Clamped to the chain, so a cursor carrying a catalog on a field whose chain is
 * one list long still asks for that one list rather than running off the end.
 */
export function cursorKind(spec: AssetPickerSpec, cursor: PickerCursor): BrowseKind {
  const depth = Math.min(cursorDepth(cursor), spec.levels.length - 1);
  return spec.levels[depth];
}

/** The route for one list at one cursor. Kind names are the route segments. */
export function browseUrl(kind: BrowseKind, cursor: PickerCursor): string {
  if (kind === 'notebooks') {
    const path = cursor.catalog.trim();
    return path ? `/api/browse/notebooks?path=${encodeURIComponent(path)}` : '/api/browse/notebooks';
  }
  if (kind === 'schemas') {
    return `/api/browse/schemas?catalog=${encodeURIComponent(cursor.catalog)}`;
  }
  if (kind === 'tables' || kind === 'volumes') {
    return (
      `/api/browse/${kind}?catalog=${encodeURIComponent(cursor.catalog)}` +
      `&schema=${encodeURIComponent(cursor.schema)}`
    );
  }
  if (kind === 'lakebase-branches') {
    return `/api/browse/lakebase-branches?project=${encodeURIComponent(cursor.catalog)}`;
  }
  if (kind === 'lakebase-databases') {
    return `/api/browse/lakebase-databases?branch=${encodeURIComponent(cursor.schema)}`;
  }
  if (kind === 'vector-search-indexes') {
    return `/api/browse/vector-search-indexes?endpoint=${encodeURIComponent(cursor.catalog)}`;
  }
  return `/api/browse/${kind}`;
}

/** One page's worth more of the same list. */
export function browsePageUrl(kind: BrowseKind, cursor: PickerCursor, pageToken: string): string {
  const base = browseUrl(kind, cursor);
  const joiner = base.includes('?') ? '&' : '?';
  return `${base}${joiner}page_token=${encodeURIComponent(pageToken)}`;
}

/** The dotted segments of a value, trimmed, empties dropped. */
function dottedParts(value: string): string[] {
  return value
    .split('.')
    .map((part) => part.trim().replace(/^`+|`+$/g, ''))
    .filter(Boolean);
}

/**
 * Where the browser opens, given what the field already holds.
 *
 * A field whose value is `analytics.player.sessions` opens on the tables in
 * `analytics.player`, because a reader who came to change a table almost always
 * wants a sibling of the one that is there. A field whose value says nothing
 * about a catalog falls back to the catalog the deployment is configured with,
 * which is the case the `schema` field is in: its value is a bare schema name,
 * so the catalog has to come from the row beside it.
 *
 * A LIST FIELD ALWAYS OPENS AT THE TOP, and that is about blast radius rather
 * than convenience. `data_catalogs` offers a whole catalog and a single schema as
 * two different picks, and opening already inside a catalog would show only the
 * narrower one. A reader adding a read scope must see both.
 *
 * Lakebase opens inside an already-chosen project/branch when the draft holds a
 * full `projects/.../databases/...` name. Vector Search index browse always
 * opens at the endpoint list: the index name alone does not name its endpoint.
 */
export function initialCursor(spec: AssetPickerSpec, input: { current?: string; catalog?: string }): PickerCursor {
  if (spec.multi) return PICKER_TOP;
  const current = (input.current ?? '').trim();

  if (spec.levels[0] === 'notebooks') {
    if (!current.startsWith('/')) return PICKER_TOP;
    const parent = current.slice(0, current.lastIndexOf('/')) || '/';
    return { catalog: parent, schema: '' };
  }

  if (spec.levels[0] === 'lakebase-projects') {
    const match = /^projects\/([^/]+)\/branches\/([^/]+)(?:\/databases\/[^/]+)?$/.exec(current);
    if (match) {
      return {
        catalog: `projects/${match[1]}`,
        schema: `projects/${match[1]}/branches/${match[2]}`,
      };
    }
    return PICKER_TOP;
  }

  if (spec.levels[0] !== 'catalogs' || spec.levels.length === 1) return PICKER_TOP;
  const parts = dottedParts(current);
  if (parts.length >= 2) {
    return {
      catalog: parts[0],
      schema: spec.levels.length >= 3 ? (parts[1] ?? '') : '',
    };
  }
  const catalog = (input.catalog ?? '').trim();
  return catalog ? { catalog, schema: '' } : PICKER_TOP;
}

/**
 * The trail back out, innermost last, so a reader can leave a catalog they
 * opened.
 *
 * The first entry is always the top of the chain. Without it, a browser that
 * opened inside a configured catalog is a browser the reader cannot get out of,
 * which is exactly the state the `schema` field's picker starts in.
 */
export function cursorTrail(
  spec: AssetPickerSpec,
  cursor: PickerCursor
): Array<{ label: string; cursor: PickerCursor }> {
  if (spec.levels[0] === 'notebooks') {
    const path = cursor.catalog.trim();
    const trail: Array<{ label: string; cursor: PickerCursor }> = [
      { label: 'Notebook home', cursor: PICKER_TOP },
      { label: 'Workspace root', cursor: { catalog: '/', schema: '' } },
    ];
    if (!path) return trail;
    const parts = path.split('/').filter(Boolean);
    let built = '';
    for (const part of parts) {
      built += `/${part}`;
      trail.push({ label: part, cursor: { catalog: built, schema: '' } });
    }
    return trail;
  }
  if (spec.levels.length <= 1) return [];

  if (spec.levels[0] === 'lakebase-projects') {
    const trail: Array<{ label: string; cursor: PickerCursor }> = [{ label: 'All projects', cursor: PICKER_TOP }];
    const project = cursor.catalog.trim();
    if (!project) return trail;
    const projectLabel = project.startsWith('projects/') ? project.slice('projects/'.length) : project;
    trail.push({ label: projectLabel, cursor: { catalog: project, schema: '' } });
    const branch = cursor.schema.trim();
    if (branch) {
      const branchLabel = branch.includes('/branches/')
        ? branch.slice(branch.lastIndexOf('/branches/') + '/branches/'.length)
        : branch;
      trail.push({ label: branchLabel, cursor: { catalog: project, schema: branch } });
    }
    return trail;
  }

  if (spec.levels[0] === 'vector-search-endpoints') {
    const trail: Array<{ label: string; cursor: PickerCursor }> = [{ label: 'All endpoints', cursor: PICKER_TOP }];
    const endpoint = cursor.catalog.trim();
    if (endpoint) trail.push({ label: endpoint, cursor: { catalog: endpoint, schema: '' } });
    return trail;
  }

  if (spec.levels[0] !== 'catalogs') return [];
  const trail: Array<{ label: string; cursor: PickerCursor }> = [{ label: 'All catalogs', cursor: PICKER_TOP }];
  const catalog = cursor.catalog.trim();
  if (!catalog) return trail;
  trail.push({ label: catalog, cursor: { catalog, schema: '' } });
  const schema = cursor.schema.trim();
  if (schema) trail.push({ label: `${catalog}.${schema}`, cursor: { catalog, schema } });
  return trail;
}

/** Opening a row: the cursor it moves to. */
export interface PickerOpen {
  kind: 'open';
  label: string;
  cursor: PickerCursor;
}

/** Taking a row: the string it stores, and what that string costs. */
export interface PickerPick {
  kind: 'pick';
  label: string;
  value: string;
  /**
   * The blast radius of this pick, where it has one a reader must see.
   *
   * Only `data_catalogs` fills it, with the two labels from
   * `shared/data-catalog-scope.ts`, so a page and a picker cannot come to
   * disagree about what a whole-catalog entry grants.
   */
  note: string;
}

export type PickerAction = PickerOpen | PickerPick;

/**
 * The name a `data_catalogs` schema entry is stored under.
 *
 * The schemas browse carries the two-part name on `secondary` precisely for
 * this: `data_catalogs` takes `catalog.schema`, and assembling one from a cursor
 * and a row is how a picker ends up storing a name the workspace does not use.
 * The assembly is only the fallback, for a workspace answer that omitted
 * `full_name`.
 */
export function twoPartName(cursor: PickerCursor, item: BrowseItem): string {
  const carried = item.secondary.trim();
  if (carried.includes('.')) return carried;
  return `${cursor.catalog.trim()}.${item.id.trim()}`;
}

/**
 * What one row offers at this cursor: opening it, taking it, or both.
 *
 * Both is the `data_catalogs` case at the catalog level, and it is the reason
 * this returns a list rather than a single action. A catalog row there is
 * simultaneously a whole-catalog read scope and a door to the schemas inside it,
 * and a picker that chose one for the reader would either hide the wider grant
 * or make the narrower one unreachable.
 */
export function rowActions(spec: AssetPickerSpec, cursor: PickerCursor, item: BrowseItem): PickerAction[] {
  const kind = cursorKind(spec, cursor);
  const depth = spec.levels.indexOf(kind);
  const last = depth === spec.levels.length - 1;
  const actions: PickerAction[] = [];

  if (kind === 'notebooks' && item.expandable) {
    return [
      {
        kind: 'open',
        label: 'Open',
        cursor: { catalog: item.id.trim(), schema: '' },
      },
    ];
  }

  if (!last) {
    actions.push({
      kind: 'open',
      label: 'Open',
      cursor:
        kind === 'catalogs' || kind === 'lakebase-projects' || kind === 'vector-search-endpoints'
          ? { catalog: item.id.trim(), schema: '' }
          : { catalog: cursor.catalog, schema: item.id.trim() },
    });
  }

  if (last || spec.pickAt === 'every') {
    if (spec.field === 'catalog-allowlist' && kind === 'catalogs') {
      actions.push({
        kind: 'pick',
        label: 'Whole catalog',
        value: item.id.trim(),
        note: dataCatalogFormLabel('whole-catalog'),
      });
    } else if ((spec.field === 'catalog-allowlist' || spec.field === 'add-schema') && kind === 'schemas') {
      actions.push({
        kind: 'pick',
        label: 'This schema',
        value: twoPartName(cursor, item),
        note: dataCatalogFormLabel('single-schema'),
      });
    } else {
      actions.push({ kind: 'pick', label: 'Use', value: item.id.trim(), note: '' });
    }
  }

  return actions;
}

/**
 * The field's new value after a pick.
 *
 * A single value is replaced. A list gains the entry, at the end, and gains it
 * once: picking something already declared is a no-op rather than a duplicate,
 * because a `data_catalogs` naming one catalog twice is a value somebody has to
 * go and clean up later.
 */
export function applyPick(spec: AssetPickerSpec, current: string, value: string): string {
  const picked = value.trim();
  if (!spec.multi) return picked;
  if (!picked) return current;
  const entries = splitConfiguredList(current);
  if (entries.includes(picked)) return entries.join(', ');
  return [...entries, picked].join(', ');
}

/** Whether a list field already holds this entry, so a row can say so. */
export function alreadyHeld(spec: AssetPickerSpec, current: string, value: string): boolean {
  const picked = value.trim();
  if (!picked) return false;
  if (spec.multi) return splitConfiguredList(current).includes(picked);
  return current.trim() === picked;
}

/**
 * Kinds whose id is not their name, so a row has to print both.
 *
 * A SQL warehouse id and a Genie space id are opaque strings, and the settings
 * row stores the id while the operator recognises the title. Everywhere else the
 * id IS the name: a catalog, a schema, a serving endpoint. The distinction is
 * kept as data rather than as a comparison of the two strings, because a
 * warehouse whose name happens to equal its id would otherwise read as an
 * unnamed one.
 */
const OPAQUE_ID_KINDS: readonly BrowseKind[] = ['warehouses', 'genie-spaces', 'experiments'];

export function namesOpaqueIds(kind: BrowseKind): boolean {
  return OPAQUE_ID_KINDS.includes(kind);
}

/**
 * Said in place of a name the workspace did not report.
 *
 * The alternative is a row whose only label is an opaque id, which is what the
 * fields did before there was a picker at all. If the id is all there is, the
 * row says the name is missing rather than passing the id off as one.
 */
export const NO_NAME_REPORTED = 'no name reported';

/** What one row prints: a name, the id under it, and the workspace's aside. */
export interface PickerRowText {
  primary: string;
  /** The stored identifier, when it differs from the name. Empty otherwise. */
  identifier: string;
  secondary: string;
}

export function pickerRowText(kind: BrowseKind, item: BrowseItem): PickerRowText {
  const label = item.label.trim();
  const id = item.id.trim();
  const aside = item.secondary.trim();
  if (label && label !== id) return { primary: label, identifier: id, secondary: aside };
  if (namesOpaqueIds(kind)) {
    return {
      primary: id,
      identifier: '',
      secondary: aside ? `${NO_NAME_REPORTED}, ${aside}` : NO_NAME_REPORTED,
    };
  }
  return { primary: id, identifier: '', secondary: aside };
}

/** Rows whose name, id or aside contains the query. Case-insensitive. */
export function filterItems(items: readonly BrowseItem[], query: string): BrowseItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) =>
    [item.label, item.id, item.secondary].some((part) => part.toLowerCase().includes(needle))
  );
}

/** Running warehouses first, preserving the API's order within each state. */
export function orderPickerItems(kind: BrowseKind, items: readonly BrowseItem[]): BrowseItem[] {
  if (kind !== 'warehouses') return [...items];
  return [...items].sort((left, right) => {
    const leftRunning = left.secondary.trim().toUpperCase() === 'RUNNING';
    const rightRunning = right.secondary.trim().toUpperCase() === 'RUNNING';
    return Number(rightRunning) - Number(leftRunning);
  });
}

/**
 * THE HEADING OVER AN UNAVAILABLE LIST, and it is an offer rather than a fault.
 *
 * The three `catalog.*:read` scopes and `workspace.workspace:read` are optional
 * on this app: no ask needs them, a deployment may leave them off its OAuth
 * config, and the login gate and the Identity card both draw them neutrally for
 * that reason. Browsing is the one thing they turn on. So the prompt says how to
 * turn it on and does not imply anything is broken.
 */
export const BROWSE_GRANT_PROMPT = 'Grant these to enable browsing';

/**
 * Heading when Apps itself has no scope for this family.
 *
 * Not an offer to grant something, because there is nothing Apps will accept.
 */
export const BROWSE_APPS_NO_SCOPE_PROMPT = 'Browsing is not available for this asset';

/**
 * The chip beside the scope, and it is the contract's own word.
 *
 * NOT "Missing", which is the red pill the gate uses for a required scope, and
 * NOT "Not granted", which the gate and the Identity card earn by comparing the
 * token's scope claim against what the app declares. This surface read
 * `scope_not_carried`, whose sentence is "your sign-in does not carry X", so the
 * chip is that and nothing more. Neutral pill, on the gate's precedent.
 */
export const BROWSE_UNAVAILABLE_CHIP = 'Not carried';

/**
 * How browsing gets turned on, covering both things that produce this outcome.
 *
 * `scope_not_carried` is deliberately one reason in the contract because the
 * picker only needs one branch, and that means this line may not assert which of
 * the two happened: an app that never declared the permission, or a sign-in
 * taken before it did. Naming both is honest and neither is a guess.
 *
 * The first clause is the one that keeps the prompt from reading as a fault.
 */
export const BROWSE_GRANT_ACTION = '';

/**
 * The fallback, said as a fallback and not as a verdict about the workspace.
 *
 * The second sentence is the load-bearing one. Without it, a reader meets an
 * empty browser and concludes the assets are not there, which is the one thing
 * a refusal never established.
 */
export const BROWSE_TYPE_INSTEAD = 'Type the value instead. Nothing was established about which assets exist.';

/** The chip on a list the app could not read. Distinct from a refusal. */
export const BROWSE_FAILED_CHIP = 'Not read';

/**
 * Said under an empty list, because an empty list is an ANSWER.
 *
 * The workspace was asked and reported nothing visible. That is a different
 * statement from browsing being unavailable, and the two must not read the same:
 * one means "there is nothing here", the other means "nobody looked".
 */
const NOTHING_VISIBLE: Readonly<Record<BrowseKind, string>> = {
  catalogs: 'No catalogs are visible to your sign-in.',
  schemas: 'No schemas are visible to your sign-in in this catalog.',
  tables: 'No tables are visible to your sign-in in this schema.',
  volumes: 'No volumes are visible to your sign-in in this schema.',
  // Mapped for exhaustiveness rather than for use: no field browses notebooks.
  notebooks: 'Nothing is visible to your sign-in in this directory.',
  warehouses: 'No SQL warehouses are visible to your sign-in.',
  'genie-spaces': 'No Genie spaces are visible to your sign-in.',
  'serving-endpoints': 'No serving endpoints are visible to your sign-in.',
  'vector-search-endpoints': 'No Vector Search endpoints are visible to your sign-in.',
  'vector-search-indexes': 'No Vector Search indexes are visible to your sign-in on this endpoint.',
  'lakebase-projects': 'No Lakebase projects are visible to your sign-in.',
  'lakebase-branches': 'No branches are visible to your sign-in in this project.',
  'lakebase-databases': 'No databases are visible to your sign-in in this branch.',
  experiments: 'No MLflow experiments are visible to your sign-in.',
};

export function browseEmptyNote(kind: BrowseKind): string {
  return NOTHING_VISIBLE[kind];
}

/**
 * A fetch that threw, in the shape the contract already has for it.
 *
 * The picker has one branch for "the call did not produce a list", and a network
 * error is that. Synthesising a `failed` here rather than inventing a fourth
 * client-side state is what keeps the component's four branches the contract's
 * three plus loading.
 */
export function browseTransportFailure(kind: BrowseKind, error: string): BrowseResponse {
  return {
    status: 'failed',
    kind,
    detail: 'This list could not be fetched from the app, so nothing was established about it.',
    error,
  };
}
