/**
 * The tables this repository's data contract names.
 *
 * ONE LIST WITH `agent/preflight.py`. That module is what a release grants:
 * `DATA_GENIE_TABLES` and `DICTIONARY_GENIE_TABLES` become the DatabricksTable
 * resources on the logged model, so changing them changes what the serving
 * principal can read. This copy exists so the app can probe Unity Catalog for
 * those same names without sending a fake question to the live agent.
 *
 * Unqualified names are completed with the release catalog and schema. A name
 * that already has two dots is left alone, which is the same rule
 * `declared_tables` applies in Python.
 *
 * `shared/data-contract.test.ts` reads the Python file and fails if these
 * tuples drift.
 */
export const DATA_GENIE_TABLES = [
  'gold_player_180d_summary',
  'gold_title_daily_summary',
  'silver_gameplay_activity',
  'silver_player_profiles',
  'silver_purchases',
] as const;

export const DICTIONARY_GENIE_TABLES = ['data_dictionary'] as const;

export const DATA_CONTRACT_TABLES = [...DATA_GENIE_TABLES, ...DICTIONARY_GENIE_TABLES] as const;

/**
 * Fully-qualified data-contract tables, or none when the namespace is missing.
 *
 * Empty rather than guessed: a probe against `gold_player_180d_summary` with no
 * catalog is not a Unity Catalog name, and inventing one would ask about an
 * object this release never declared.
 */
export function qualifyDataContractTables(
  catalog: string,
  schema: string,
  tables: readonly string[] = DATA_CONTRACT_TABLES
): string[] {
  const nsCatalog = catalog.trim();
  const nsSchema = schema.trim();
  if (!nsCatalog || !nsSchema) return [];
  return [
    ...new Set(
      tables.map((table) => (table.split('.').length === 3 ? table : `${nsCatalog}.${nsSchema}.${table}`))
    ),
  ].sort();
}
