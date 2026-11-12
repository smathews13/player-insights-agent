/**
 * The tables this repository expects the served model version to declare.
 *
 * Read out of `agent/preflight.py`, which is where the data contract lives: one
 * declaration feeds `log_model.py`'s DatabricksTable resources, the runtime
 * preflight, and the bundle's own static check. Reading it here is a fourth
 * reader of the same declaration rather than a fourth copy of it.
 *
 * RETURNS NULL RATHER THAN GUESSING. If the tuples cannot be found, or the file
 * is not there, the caller reports the manifest check as unknown. A parser that
 * silently produced an empty list would make MANIFEST_COVERS_DATA_CONTRACT pass
 * against a model that declares nothing, which is exactly backwards.
 */

/** A `NAME = ("a", "b")` literal tuple, or null when it is not there. */
function literalTuple(source: string, name: string): string[] | null {
  const match = new RegExp(`^${name}\\s*=\\s*\\(([^)]*)\\)`, 'm').exec(source);
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

export interface Namespace {
  catalog: string;
  schema: string;
}

/**
 * Fully-qualified expected tables, sorted.
 *
 * An entry that already carries two dots is left alone, the same rule
 * `declared_tables` applies in `agent/preflight.py`: qualifying a qualified name
 * again yields a five-part identifier, which is unusable rather than merely
 * wrong.
 */
export function expectedManifestTables(preflightSource: string, namespace: Namespace): string[] | null {
  const data = literalTuple(preflightSource, 'DATA_GENIE_TABLES');
  const dictionary = literalTuple(preflightSource, 'DICTIONARY_GENIE_TABLES');
  if (data === null && dictionary === null) return null;
  if (!namespace.catalog || !namespace.schema) return null;
  const qualified = [...(data ?? []), ...(dictionary ?? [])].map((table) =>
    table.split('.').length === 3 ? table : `${namespace.catalog}.${namespace.schema}.${table}`
  );
  return [...new Set(qualified)].sort();
}
