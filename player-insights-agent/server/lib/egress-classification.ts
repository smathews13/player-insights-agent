/**
 * What Unity Catalog says about the columns of a table, and nothing else.
 *
 * ── THE DETECTOR THIS FILE REFUSES TO BE ──
 *
 * The tempting version of this feature inspects values: it looks at a result set,
 * finds something shaped like an email address or a date of birth, and reports
 * that the export contained personal data. That version is worse than nothing and
 * it is worth being precise about why. It is wrong in both directions -- a
 * pseudonymous player id it has never seen a pattern for reads as clean, and a
 * free-text note column reads as sensitive because one row mentioned a street --
 * and being wrong is not even the main problem. The main problem is that it would
 * be BELIEVED. A green tick from an automated scan is read as a clearance by the
 * next person who sees it, and the person who most needs to be careful is the one
 * it most reassures.
 *
 * So this file inspects no values. It asks the platform, which is the only party
 * in the system with an authoritative answer: Unity Catalog carries column tags,
 * column masks and row filters, the customer's own governance put them there, and
 * the governed schema already applies them at query time.
 *
 * ── THE THREE ANSWERS, AND THE FOURTH THAT DOES NOT EXIST ──
 *
 *   `classified`      The catalog carries a tag, a mask or a row filter here.
 *   `not-classified`  The catalog carries nothing that this reader can see.
 *   `not-checked`     The question could not be asked at all.
 *
 * THERE IS NO ANSWER MEANING "CONTAINS NO PERSONAL DATA", and none may be added.
 * `not-classified` is a statement about the CATALOG, not about the data: an
 * untagged table full of names is untagged, and this app has no way to know it is
 * full of names. The panel prints "Not classified" in a neutral chip for exactly
 * that reason, and `shared/egress-contract.ts` holds the wording so it cannot be
 * made more reassuring at one call site.
 *
 * There is a second reason `not-classified` cannot be read as clean, and it is
 * structural rather than cautious: Unity Catalog's `information_schema` is
 * FILTERED TO WHAT THE CALLER MAY SEE. A reader without privileges on the tags
 * gets an empty result, which is indistinguishable from a table nobody tagged.
 * The read is deliberately still made as that reader; see below.
 *
 * ── WHOSE CREDENTIALS THESE READS USE ──
 *
 * The signed-in administrator's own forwarded token, never the app's service
 * principal. Three service-principal read paths in this app were deliberately
 * closed and this file does not reopen one. No token means `not-checked`, which
 * is the honest answer and not a reason to fall back to a wider credential: an
 * app that reads the catalog with its own authority on a person's behalf is a way
 * of seeing more, and this whole capability exists to see less.
 *
 * The consequence is stated plainly and is not a defect: an administrator who
 * cannot read a table's tags is told the tags could not be read, rather than
 * being shown tags they have no grant for.
 */

import type { SqlRunner } from './admin-access';
import {
  CLASSIFICATION_LABEL,
  type ClassificationState,
  type ClassifiedColumn,
  type TableClassification,
} from '../../shared/egress-contract';

export { CLASSIFICATION_LABEL };

/**
 * The most tables one panel load classifies.
 *
 * Each catalog costs three statements against a warehouse that may be cold, and
 * the panel is a list of recent exports rather than a catalog browser. A load
 * naming more tables than this classifies the first of them and says the rest
 * were not checked, which is true and is better than a page that takes a minute.
 */
export const CLASSIFY_TABLE_LIMIT = 12;

/** Why nothing could be asked. Printed by the panel as it stands. */
export const NO_TOKEN_REASON =
  'Not checked. This session has no forwarded sign-in token, so the catalog was not asked. It is not asked ' +
  "with the app's own identity, deliberately.";

export const NO_WAREHOUSE_REASON =
  'Not checked. This deployment has no SQL warehouse configured, so the catalog could not be asked.';

/**
 * A fully-qualified name split into its three parts, or null.
 *
 * ── WHY THE SHAPE IS ENFORCED RATHER THAN ESCAPED ──
 *
 * These names reach a statement as literals, because the SQL Statement Execution
 * runner this file borrows takes a statement and no parameters. Escaping a quote
 * is the usual answer and it is the weaker one: it leaves the set of accepted
 * inputs open and relies on one function being right forever. So a name is
 * accepted only when every part matches the characters an unquoted Unity Catalog
 * identifier is made of, and anything else is refused and reported as
 * `not-checked`.
 *
 * The cost is real and small: a table whose name genuinely needs backticks is not
 * classified, and is reported as not classified rather than silently skipped.
 * These names arrive from a run's recorded sources, so the refusal is visible to
 * whoever declared the asset.
 */
export function nameParts(fullName: string): { catalog: string; schema: string; table: string } | null {
  const parts = fullName.trim().split('.');
  if (parts.length !== 3) return null;
  if (!parts.every((part) => /^[A-Za-z0-9_]+$/.test(part))) return null;
  return { catalog: parts[0], schema: parts[1], table: parts[2] };
}

function literal(value: string): string {
  return `'${value}'`;
}

/** `(a, b)` for an IN list, with every value already shape-checked. */
function inList(values: readonly string[]): string {
  return `(${values.map(literal).join(', ')})`;
}

/**
 * The three statements one catalog needs.
 *
 * `<catalog>.information_schema` rather than `system.information_schema`. The
 * per-catalog views need only privileges on objects inside that catalog, where
 * the system-wide ones sit in a catalog a reader may hold nothing on at all --
 * so asking `system` would report "not checked" for readers who can perfectly
 * well see the tags on their own tables.
 *
 * Tag NAMES only, and no `tag_value`. A tag value is a string from the
 * customer's own taxonomy and can itself be sensitive; the question this panel
 * answers is whether the column is governed, which the name settles.
 */
export function classificationStatements(
  catalog: string,
  schemas: readonly string[],
  tables: readonly string[]
): { tags: string; masks: string; filters: string } {
  const scope = `WHERE schema_name IN ${inList(schemas)} AND table_name IN ${inList(tables)}`;
  return {
    tags: `SELECT schema_name, table_name, column_name, tag_name
       FROM ${catalog}.information_schema.column_tags ${scope}`,
    masks: `SELECT schema_name, table_name, column_name
       FROM ${catalog}.information_schema.column_masks ${scope}`,
    filters: `SELECT schema_name, table_name
       FROM ${catalog}.information_schema.row_filters ${scope}`,
  };
}

/** A row's cells, trimmed, so a runner that pads them does not change a key. */
function cells(row: readonly string[]): string[] {
  return row.map((cell) => String(cell ?? '').trim());
}

function key(schema: string, table: string): string {
  return `${schema.toLowerCase()}\u0000${table.toLowerCase()}`;
}

interface Gathered {
  /** Column name to the tags on it, for one table. */
  tags: Map<string, Set<string>>;
  masked: Set<string>;
  rowFilter: boolean;
  /** Whether all three reads answered for this table's catalog. */
  answered: boolean;
}

function blank(): Gathered {
  return { tags: new Map(), masked: new Set(), rowFilter: false, answered: false };
}

/**
 * What the catalog says about each of these tables.
 *
 * ── ONE REFUSED READ DOES NOT INVENT AN ANSWER FOR THE OTHERS ──
 *
 * The three reads fail independently and a reader can hold privileges on one view
 * and not another. A catalog whose TAGS read was refused is reported as
 * `not-checked` for every table in it, even if the masks read succeeded, because
 * the interesting half is the one that did not answer and reporting
 * "not classified" on the strength of an empty masks result would be the
 * clearance this file exists not to give.
 *
 * A catalog whose reads all answered and found nothing is `not-classified`. That
 * is the one place a negative is asserted, and it is asserted about the catalog
 * rather than about the data.
 */
export async function classifyTables(
  run: SqlRunner | null,
  tables: readonly string[],
  options: { unavailable?: string } = {}
): Promise<{ classifications: TableClassification[]; blocked: string }> {
  const considered = tables.slice(0, CLASSIFY_TABLE_LIMIT);
  if (considered.length === 0) return { classifications: [], blocked: '' };
  if (!run) {
    return {
      classifications: considered.map((table) => notChecked(table, options.unavailable ?? NO_TOKEN_REASON)),
      blocked: options.unavailable ?? NO_TOKEN_REASON,
    };
  }

  // Grouped by catalog so that a deployment reading two tables in one schema
  // costs three statements rather than six.
  const byCatalog = new Map<string, { schemas: Set<string>; tables: Set<string> }>();
  const unusable: string[] = [];
  for (const table of considered) {
    const parts = nameParts(table);
    if (!parts) {
      unusable.push(table);
      continue;
    }
    const group = byCatalog.get(parts.catalog) ?? { schemas: new Set(), tables: new Set() };
    group.schemas.add(parts.schema);
    group.tables.add(parts.table);
    byCatalog.set(parts.catalog, group);
  }

  const gathered = new Map<string, Gathered>();
  for (const [catalog, group] of byCatalog) {
    const statements = classificationStatements(catalog, [...group.schemas], [...group.tables]);
    const tagRows = await run(statements.tags);
    const maskRows = await run(statements.masks);
    const filterRows = await run(statements.filters);
    const answered = tagRows.ok && maskRows.ok && filterRows.ok;
    if (!answered) {
      const refusal = [tagRows, maskRows, filterRows].find((outcome) => !outcome.ok);
      console.warn(
        `[egress] The catalog could not be asked about ${catalog}: ${refusal?.message ?? 'no message'}. ` +
          'Every table in it is reported as not checked, which is what it is. It is NOT reported as ' +
          'carrying no personal data.'
      );
    }
    // Seeded before the rows are folded in, so a table with no findings in an
    // answered catalog is distinguishable from a table in a catalog that refused.
    for (const table of group.tables) {
      for (const schema of group.schemas) {
        const entry = gathered.get(`${catalog}\u0000${key(schema, table)}`) ?? blank();
        entry.answered = answered;
        gathered.set(`${catalog}\u0000${key(schema, table)}`, entry);
      }
    }
    if (!answered) continue;

    for (const row of tagRows.rows ?? []) {
      const [schema, table, column, tag] = cells(row);
      if (!schema || !table || !column || !tag) continue;
      const entry = gathered.get(`${catalog}\u0000${key(schema, table)}`) ?? blank();
      entry.answered = true;
      const tags = entry.tags.get(column) ?? new Set<string>();
      tags.add(tag);
      entry.tags.set(column, tags);
      gathered.set(`${catalog}\u0000${key(schema, table)}`, entry);
    }
    for (const row of maskRows.rows ?? []) {
      const [schema, table, column] = cells(row);
      if (!schema || !table || !column) continue;
      const entry = gathered.get(`${catalog}\u0000${key(schema, table)}`) ?? blank();
      entry.answered = true;
      entry.masked.add(column);
      gathered.set(`${catalog}\u0000${key(schema, table)}`, entry);
    }
    for (const row of filterRows.rows ?? []) {
      const [schema, table] = cells(row);
      if (!schema || !table) continue;
      const entry = gathered.get(`${catalog}\u0000${key(schema, table)}`) ?? blank();
      entry.answered = true;
      entry.rowFilter = true;
      gathered.set(`${catalog}\u0000${key(schema, table)}`, entry);
    }
  }

  const classifications = considered.map((table): TableClassification => {
    if (unusable.includes(table)) {
      return notChecked(
        table,
        'Not checked. This name is not a plain three-part Unity Catalog name, so the catalog was not asked ' +
          'about it.'
      );
    }
    const parts = nameParts(table);
    const entry = parts ? gathered.get(`${parts.catalog}\u0000${key(parts.schema, parts.table)}`) : undefined;
    if (!entry || !entry.answered) {
      return notChecked(table, 'Not checked. The catalog did not answer about this table.');
    }
    const columns = columnsFrom(entry);
    const state: ClassificationState = columns.length > 0 || entry.rowFilter ? 'classified' : 'not-classified';
    return { table, state, columns, rowFilter: entry.rowFilter, notChecked: '' };
  });

  return { classifications, blocked: '' };
}

function notChecked(table: string, reason: string): TableClassification {
  // `rowFilter: null` and NOT false. False is the claim that there is no filter,
  // which a read that did not happen cannot support.
  return { table, state: 'not-checked', columns: [], rowFilter: null, notChecked: reason };
}

/**
 * The columns the catalog carries something on, tagged and masked folded
 * together, sorted so two loads of the same panel list them in the same order.
 */
function columnsFrom(entry: Gathered): ClassifiedColumn[] {
  const names = new Set<string>([...entry.tags.keys(), ...entry.masked]);
  return [...names].sort().map((column) => ({
    column,
    tags: [...(entry.tags.get(column) ?? [])].sort(),
    masked: entry.masked.has(column),
  }));
}
