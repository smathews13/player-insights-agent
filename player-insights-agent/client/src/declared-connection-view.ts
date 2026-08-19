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

/** The kinds a reader may choose from, with the words the tab uses for them. */
export const ADDABLE_KINDS: ReadonlyArray<{
  id: string;
  kind: string;
  label: string;
  browse: 'tables' | 'genie-spaces' | 'catalogs' | null;
}> = [
  { id: 'table', kind: 'unity-catalog', label: 'Tables', browse: 'tables' },
  { id: 'genie-space', kind: 'genie-space', label: 'Genie spaces', browse: 'genie-spaces' },
  { id: 'catalog', kind: 'unity-catalog', label: 'Catalogs', browse: 'catalogs' },
  { id: 'sql-warehouse', kind: 'sql-warehouse', label: 'SQL warehouse', browse: null },
  { id: 'volume', kind: 'volume', label: 'Volume', browse: null },
  { id: 'vector-search', kind: 'vector-search', label: 'Vector Search index', browse: null },
  { id: 'model', kind: 'model', label: 'Model endpoint', browse: null },
];

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

/** The label on the button that puts a withdrawn asset back. */
export const RESTORE_LABEL = 'Put back';

/** The label on the button that removes one. */
export const REMOVE_LABEL = 'Remove';
