/**
 * What the Connections tab says about a notebook and about a declared asset.
 *
 * SEPARATE FROM THE COMPONENT ON PURPOSE. The tab is being redrawn against a new
 * design handoff, and the wording here is the part that must not be redrawn: it
 * carries the distinction between "the agent may consider this" and "you may read
 * this", which a customer will otherwise get backwards. Keeping it in a module with
 * its own tests means a rebuilt surface inherits the copy rather than reinventing
 * it.
 *
 * NO PROSE, NO EM DASHES. Every string here renders on a page that has had
 * narrative text stripped from nearly every surface, so these are labels and single
 * clauses, not sentences of explanation.
 */
import { DECLARABLE_KEYS, SCOPES_KEY } from '../../shared/notebook-declaration';
import type { ConnectionEntry, DeclarationComparisonRow, NotebookPanel } from './connection-model';
import type { AssetPickerSpec } from './asset-picker';

/** The badge a compared setting carries. */
export interface ComparisonBadge {
  label: string;
  /** Which of the tab's three colour treatments to use. */
  tone: 'green' | 'amber' | 'neutral';
}

/**
 * How a published setting reads on the row.
 *
 * `refused` is amber rather than red, and that is a considered choice: nothing is
 * broken. The deployment is working as designed and the published value is being
 * shown for comparison. Red on this tab means blocked, and a reader who learns it
 * can mean "working as intended" stops reading it.
 */
export function comparisonBadge(row: DeclarationComparisonRow): ComparisonBadge {
  switch (row.verdict) {
    case 'agrees':
      return { label: 'In use', tone: 'green' };
    case 'pending':
      return { label: 'Awaiting model version', tone: 'amber' };
    case 'refused':
      return { label: 'Not applied', tone: 'amber' };
    default:
      return { label: 'Not checked', tone: 'neutral' };
  }
}

/**
 * The one line a compared row owes a reader beyond its two values.
 *
 * Empty for a row that agrees: a value in use needs no explanation, and a sentence
 * on every row is how a page stops being read.
 */
export function comparisonNote(row: DeclarationComparisonRow): string {
  if (row.verdict === 'agrees' || row.verdict === 'unknown') return '';
  if (row.flow === 'refused') {
    return 'Read from the model artifact only. Publishing it here does not change what the agent may read.';
  }
  return 'Recorded. It applies when the model is logged again.';
}

/** What the notebook row says when there is no declaration to show. */
export function notebookSummary(panel: NotebookPanel | undefined): string {
  if (!panel) return 'No notebook is connected.';
  if (panel.read.declaration) {
    const count = panel.read.declaration.settings.length;
    return count === 1 ? '1 setting published' : `${count} settings published`;
  }
  return panel.read.detail || 'No notebook is connected.';
}

/**
 * Whether the notebook row should read as a fault.
 *
 * `empty` and `not-configured` are not faults. A table that exists with nothing
 * published is a missing publish, and no notebook connected is the default state of
 * every deployment. Treating either as red would make the tab cry wolf on a healthy
 * deployment, which is the failure its own spec warns about.
 */
export function notebookIsBlocked(panel: NotebookPanel | undefined): boolean {
  const failure = panel?.read.failure;
  return failure === 'refused' || failure === 'bad-location' || failure === 'unreadable';
}

/**
 * What this deployment does with an empty readable-scopes list.
 *
 * NOT AN EXPLANATION OF THE CONFLICT, deliberately. A notebook that sets the
 * scopes list to `[]` means no restriction; this deployment reads an empty one as
 * its own catalog, resolved to its configured schema. Spelling that disagreement
 * out on the page would be three sentences of prose on a tab that has had prose
 * stripped, and it would be the app narrating someone else's notebook.
 *
 * So the line states only what THIS side does. That is the fact a reader cannot
 * derive from the tab and cannot get from their notebook, and it is enough to tell
 * the two meanings apart. Which meaning should win is a decision about the notebook,
 * and belongs to whoever owns it.
 */
export const EMPTY_SCOPES_NOTE = 'Empty means the configured catalog and schema, not every catalog.';

/**
 * Which setting the line is about, in the words the rest of the tab uses for it.
 *
 * Taken from the declaration contract rather than written again here, so a line
 * that names a setting cannot end up naming it differently from the row above it.
 */
export const EMPTY_SCOPES_LABEL = DECLARABLE_KEYS[SCOPES_KEY].label;

/**
 * The empty-scopes line, or nothing.
 *
 * Shown when the scopes list reads empty on either side: the notebook published
 * the key with no value, or nothing was read for what is in use. Silent when the
 * notebook never named the key, because a line about a setting a reader has not
 * touched is the noise that stops the rest of the card being read.
 */
export function emptyScopesNote(panel: NotebookPanel | undefined): string {
  const declaration = panel?.read.declaration;
  if (!declaration) return '';
  if (declaration.emptyScopes) return EMPTY_SCOPES_NOTE;
  const row = panel?.comparison.find((entry) => entry.key === SCOPES_KEY);
  return row && !row.live ? EMPTY_SCOPES_NOTE : '';
}

/**
 * What the tab states, once, about what adding a connection means.
 *
 * The single most important string in this feature. It is asserted by a test rather
 * than trusted to survive editing.
 */
export const CONNECTION_SCOPE_NOTE =
  'Listing an asset lets the agent consider it. Reading it still depends on your own Unity Catalog grants.';

/** The heading for the list of assets the agent may consider. */
export const CONNECTION_LIST_TITLE = 'Assets the agent may consider';

/**
 * The list each addable kind browses.
 *
 * EVERY KIND BROWSES. Four of these were `null` until now, and a reader who
 * chose SQL warehouse, Volume, Vector Search index or Model endpoint got the
 * bare text box: they had to know the identifier before they could add the
 * asset, which is the exact problem the Genie space list solved. The lists
 * behind all seven already existed as `/api/browse/*` routes and as
 * `shared/browse-contract.ts` kinds; only this mapping was missing.
 */
export type AddableBrowse =
  | 'tables'
  | 'genie-spaces'
  | 'catalogs'
  | 'warehouses'
  | 'volumes'
  | 'vector-search-indexes'
  | 'serving-endpoints';

/** The kinds a reader may choose from, with the words the tab uses for them. */
export const ADDABLE_KINDS: ReadonlyArray<{
  id: string;
  kind: string;
  label: string;
  browse: AddableBrowse;
}> = [
  { id: 'table', kind: 'unity-catalog', label: 'Tables', browse: 'tables' },
  { id: 'genie-space', kind: 'genie-space', label: 'Genie spaces', browse: 'genie-spaces' },
  { id: 'catalog', kind: 'unity-catalog', label: 'Catalogs', browse: 'catalogs' },
  { id: 'sql-warehouse', kind: 'sql-warehouse', label: 'SQL warehouse', browse: 'warehouses' },
  { id: 'volume', kind: 'volume', label: 'Volume', browse: 'volumes' },
  {
    id: 'vector-search',
    kind: 'vector-search',
    label: 'Vector Search index',
    browse: 'vector-search-indexes',
  },
  { id: 'model', kind: 'model', label: 'Model endpoint', browse: 'serving-endpoints' },
];

/**
 * The browser each addable kind opens, keyed by the kind's own browse name.
 *
 * Here rather than in the card so a test can assert that every entry in
 * {@link ADDABLE_KINDS} reaches a real list without mounting React. The chains
 * are the ones the Connections fields already use: a volume is reached through
 * its catalog and schema, an index through its endpoint, and the three flat
 * lists stop at one level.
 */
export const ADD_CONNECTION_PICKERS: Record<AddableBrowse, AssetPickerSpec> = {
  tables: {
    field: 'add-table',
    levels: ['catalogs', 'schemas', 'tables'],
    pickAt: 'last',
    multi: false,
    title: 'Tables your sign-in can see',
    typeLabel: 'Or type a three-part table name',
    typeNote: '',
  },
  'genie-spaces': {
    field: 'add-genie-space',
    levels: ['genie-spaces'],
    pickAt: 'last',
    multi: false,
    title: 'Genie spaces your sign-in can see',
    typeLabel: 'Or type a Genie space ID',
    typeNote: '',
  },
  catalogs: {
    field: 'add-catalog',
    levels: ['catalogs'],
    pickAt: 'last',
    multi: false,
    title: 'Catalogs your sign-in can see',
    typeLabel: 'Or type a catalog name',
    typeNote: '',
  },
  warehouses: {
    field: 'add-sql-warehouse',
    levels: ['warehouses'],
    pickAt: 'last',
    multi: false,
    title: 'SQL warehouses your sign-in can see',
    typeLabel: 'Or type a warehouse id',
    typeNote: '',
  },
  volumes: {
    field: 'add-volume',
    levels: ['catalogs', 'schemas', 'volumes'],
    pickAt: 'last',
    multi: false,
    title: 'Volumes your sign-in can see',
    typeLabel: 'Or type a volume name',
    typeNote: '',
  },
  'vector-search-indexes': {
    field: 'add-vector-search',
    levels: ['vector-search-endpoints', 'vector-search-indexes'],
    pickAt: 'last',
    multi: false,
    title: 'Vector Search indexes your sign-in can see',
    typeLabel: 'Or type a three-part index name',
    typeNote: '',
  },
  'serving-endpoints': {
    field: 'add-model',
    levels: ['serving-endpoints'],
    pickAt: 'last',
    multi: false,
    title: 'Serving endpoints your sign-in can see',
    typeLabel: 'Or type an endpoint name',
    typeNote: '',
  },
};

/** The browser for a chosen kind, by the kind's id in {@link ADDABLE_KINDS}. */
export function pickerForAddKind(kindId: string): AssetPickerSpec | null {
  const chosen = ADDABLE_KINDS.find((entry) => entry.id === kindId);
  return chosen ? ADD_CONNECTION_PICKERS[chosen.browse] : null;
}

/**
 * The identifier a pick stores, which is not always the string the row carried.
 *
 * Volumes are the exception, and they are the reason this function exists. The
 * volumes list stores a LEAF name, because the deployment's own volume setting
 * takes one; a declared connection takes the whole `/Volumes/catalog/schema/name`
 * path, and a row holding `checkpoints` alone names nothing that can be reached.
 * The catalog and the schema are in the cursor the reader browsed through.
 *
 * Every other kind stores exactly what the row offered: a three-part table or
 * index name, a catalog name, an endpoint name, or a minted id.
 */
export function addedConnectionValue(
  kindId: string,
  picked: string,
  where: { catalog?: string; schema?: string } = {}
): string {
  const value = picked.trim();
  if (kindId !== 'volume' || !value || value.startsWith('/Volumes/')) return value;
  const catalog = (where.catalog ?? '').trim();
  const schema = (where.schema ?? '').trim();
  if (!catalog || !schema) return value;
  return `/Volumes/${catalog}/${schema}/${value}`;
}

/**
 * The name a freshly picked asset is listed under.
 *
 * The name the list showed, and never a fragment of the identifier. Deriving
 * one from the id is how this list came to print hex at the reader: a Genie
 * space id has no last segment worth reading, so splitting it produced the id
 * back again and stored it as the label.
 */
export function addedConnectionLabel(picked: string, rowLabel = ''): string {
  const named = rowLabel.trim();
  if (named && !isOpaqueAssetId(named)) return named;
  const leaf = picked.split(/[./]/).filter(Boolean).at(-1) ?? '';
  return isOpaqueAssetId(leaf) || !leaf ? '' : leaf;
}

/** What a listed asset's kind is called, in the words the rest of the tab uses. */
const KIND_LABEL: Record<string, string> = {
  'genie-space': 'Genie space',
  'sql-warehouse': 'SQL warehouse',
  'unity-catalog': 'Unity Catalog',
  volume: 'Volume',
  'vector-search': 'Vector Search index',
  model: 'Model endpoint',
};

export function connectionKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? 'Connection';
}

/** Declared assets first, withdrawn ones after, each in the order given. */
export function orderConnections(entries: readonly ConnectionEntry[]): ConnectionEntry[] {
  return [
    ...entries.filter((entry) => entry.connection.state === 'declared'),
    ...entries.filter((entry) => entry.connection.state === 'withdrawn'),
  ];
}

/** The count line for the list, with zeroes never rendered. */
export function connectionCounts(entries: readonly ConnectionEntry[]): string {
  const declared = entries.filter((entry) => entry.connection.state === 'declared').length;
  const withdrawn = entries.length - declared;
  const parts: string[] = [];
  if (declared) parts.push(`${declared} listed`);
  if (withdrawn) parts.push(`${withdrawn} removed`);
  return parts.join(' · ');
}

/**
 * The name a listed asset is known by.
 *
 * The label a reader typed, or the identifier where none was given. A row that
 * printed the raw id as its name AND again as its value said the same opaque
 * string twice and named nothing.
 */
export function connectionDisplayName(connection: { label: string; value: string; id: string }): string {
  return connection.label.trim() || connection.value.trim() || connection.id;
}

/** The identifier under the name, or '' where it would only repeat the name. */
export function connectionSecondaryId(connection: { label: string; value: string; id: string }): string {
  const value = connection.value.trim();
  return value && value !== connectionDisplayName(connection) ? value : '';
}

/**
 * An identifier with no human reading in it.
 *
 * A Genie space id and a SQL warehouse id are long hex strings the workspace
 * mints. Nothing about one tells a reader which asset it is, so a row that
 * prints one as its title has named nothing. Three-part table names, volume
 * paths and endpoint names all fail this test, correctly: they ARE readable.
 */
export function isOpaqueAssetId(value: string): boolean {
  return /^[0-9a-f]{16,}$/i.test(value.trim());
}

/** An opaque id shortened to something that fits a row without wrapping. */
export function shortenAssetId(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 16 ? `${trimmed.slice(0, 12)}\u2026` : trimmed;
}

/**
 * How one listed asset reads on its row.
 *
 * The rows above this list name their product, then show the value as a pill,
 * then the raw id beside it where the two differ. These rows did none of that:
 * they printed {@link connectionDisplayName}, which falls back to the stored
 * value, so an asset added by picking a Genie space showed a truncated hex
 * string as its whole title and nothing else.
 *
 * The order the name is looked for: the label a reader typed or the picker
 * carried over, then the stored value where the value is itself readable. When
 * both are opaque there is no name to show, and the row says what KIND of thing
 * it is and offers the shortened id as context rather than as a title.
 */
export interface ConnectionRowView {
  /** Always present. The product word, as on the connected-resources rows. */
  kindLabel: string;
  /** The pill. Empty when nothing human could be resolved. */
  name: string;
  /** The grey identifier beside the pill, or '' when it would repeat it. */
  identifier: string;
  /** The full identifier, for the row's title attribute. */
  fullIdentifier: string;
}

export function connectionRowView(connection: {
  label: string;
  value: string;
  id: string;
  kind: string;
}): ConnectionRowView {
  const kindLabel = connectionKindLabel(connection.kind);
  const label = connection.label.trim();
  const value = connection.value.trim();
  const fullIdentifier = value || connection.id;

  const named = label && !isOpaqueAssetId(label) ? label : value && !isOpaqueAssetId(value) ? value : '';
  if (named) {
    return {
      kindLabel,
      name: named,
      identifier: value && value !== named ? value : '',
      fullIdentifier,
    };
  }
  return { kindLabel, name: '', identifier: shortenAssetId(fullIdentifier), fullIdentifier };
}

/** The badge on a row added in this sitting, so a reader can see what they just did. */
export const JUST_ADDED_LABEL = 'New';

/** The label on the button that puts a withdrawn asset back. */
export const RESTORE_LABEL = 'Put back';

/** The label on the button that removes one. */
export const REMOVE_LABEL = 'Remove';

/** The accessible name and confirmation label for deleting the stored row. */
export const REMOVE_FOREVER_LABEL = 'Remove forever';

/**
 * What permanent removal says before it runs.
 *
 * A notebook-origin row can return on the next publish, so “forever” may describe
 * only this stored copy. Naming that exception in the confirmation is what keeps
 * an irreversible database delete from promising control over a separate source.
 */
export function forgetConnectionDetail(origin: 'app' | 'notebook'): string {
  if (origin === 'notebook') {
    return 'This deletes the remembered row and cannot be undone here. Publishing the notebook again may add it back.';
  }
  return 'This deletes the remembered row and cannot be undone. Add the connection again if you need it later.';
}
