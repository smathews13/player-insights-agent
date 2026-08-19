/**
 * How a `data_catalogs` / `catalog_denylist` value is read on the Connections
 * page.
 *
 * WHAT THIS CORRECTS. Both values already ride the settings path as
 * `catalog-allowlist` and `catalog-denylist` rows, but the page printed them as
 * a truncated string (or "5 entries", or "not set"). That hid the one fact a
 * customer needs from `data_catalogs`: whether each entry opened a WHOLE
 * catalog (every non-system schema) or a SINGLE `catalog.schema`. Those are
 * different blast radii. An empty denylist is the default and was reading the
 * same as an unset value, which is wrong.
 *
 * The server still ships a single string on `configured` (comma-joined entries).
 * This module is the shared reading of that string, so the page and its tests
 * cannot invent a second vocabulary for the same two forms.
 *
 * Pure: no React, no DOM. The page decides how to draw; this decides what the
 * values mean.
 */

/** What one `data_catalogs` entry grants. */
export type DataCatalogForm = 'whole-catalog' | 'single-schema';

/** One entry, with the form a reader needs to see beside the name. */
export interface DataCatalogEntry {
  /** The catalog, or `catalog.schema`, as declared. */
  name: string;
  form: DataCatalogForm;
}

/**
 * The label drawn beside a whole-catalog entry.
 *
 * Matches the bundle variable's own description: a bare catalog name includes
 * all of its non-system schemas. Short enough to sit on one line with the name.
 */
export const WHOLE_CATALOG_LABEL = 'every non-system schema';

/**
 * The label drawn beside a `catalog.schema` entry.
 *
 * The contrast with {@link WHOLE_CATALOG_LABEL} is the point of showing the
 * list at all.
 */
export const SINGLE_SCHEMA_LABEL = 'this schema only';

/** Copy for an empty `data_catalogs`. Not "not set": empty is a real state. */
export const EMPTY_DATA_CATALOGS =
  'No declared read scope. The agent can query nothing.';

/**
 * Copy for an empty `catalog_denylist`.
 *
 * The default, and not a problem. Must not read as a warning or as "not set".
 */
export const EMPTY_CATALOG_DENYLIST = 'Nothing excluded.';

/** The form label a reader sees beside one entry. */
export function dataCatalogFormLabel(form: DataCatalogForm): string {
  return form === 'whole-catalog' ? WHOLE_CATALOG_LABEL : SINGLE_SCHEMA_LABEL;
}

/**
 * Classify one entry the way `agent/preflight.py` does: one part is a whole
 * catalog, two parts is one schema. Anything else is not a form we can name.
 */
export function classifyDataCatalogEntry(raw: string): DataCatalogEntry | null {
  const name = raw.trim().replace(/^`+|`+$/g, '');
  if (!name) return null;
  const parts = name.split('.');
  if (parts.length === 1 && parts[0]) {
    return { name, form: 'whole-catalog' };
  }
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { name, form: 'single-schema' };
  }
  return null;
}

/**
 * Split a configured value into the entries the page can label.
 *
 * Accepts the comma-joined form `app-settings.ts` writes for a list. Skips
 * blank segments. An entry that is not `catalog` or `catalog.schema` is dropped
 * rather than guessed at: inventing a form for a three-part name would be a
 * wrong claim about blast radius.
 */
export function parseDataCatalogEntries(configured: string): DataCatalogEntry[] {
  const entries: DataCatalogEntry[] = [];
  for (const segment of splitConfiguredList(configured)) {
    const entry = classifyDataCatalogEntry(segment);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * The denylist patterns, once each, in the order they arrived.
 *
 * Empty string and whitespace-only segments are dropped, so an empty default
 * and a value of only commas both read as "nothing excluded".
 */
export function parseCatalogDenylist(configured: string): string[] {
  return splitConfiguredList(configured);
}

/**
 * Comma-separated segments, trimmed, empties dropped.
 *
 * Exported because the pickers write these values as well as read them: adding
 * one entry to `data_catalogs` means splitting what is there, and a picker that
 * split it its own way would be a second reading of the same string.
 */
export function splitConfiguredList(configured: string): string[] {
  if (!configured.trim()) return [];
  const parts: string[] = [];
  for (const segment of configured.split(',')) {
    const trimmed = segment.trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts;
}
