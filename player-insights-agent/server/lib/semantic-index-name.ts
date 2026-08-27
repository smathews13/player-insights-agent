/**
 * The Vector Search index name this release searches when the flag is `true`.
 *
 * ONE SPELLING WITH `agent/semantic_layer.py` `index_name`. The agent derives
 * `{catalog}.{schema}.semantic_layer_index` at log time; Connections used to
 * leave the flag as `true` and then report the index as "not set" because there
 * was no three-level name to GET.
 */

export const SEMANTIC_LAYER_INDEX = 'semantic_layer_index';

export const DERIVE_SEMANTIC_INDEX = 'true';

export function derivedSemanticIndexName(catalog: string, schema: string): string {
  const nsCatalog = catalog.trim();
  const nsSchema = schema.trim();
  if (!nsCatalog || !nsSchema) return '';
  return `${nsCatalog}.${nsSchema}.${SEMANTIC_LAYER_INDEX}`;
}

/**
 * A configured index value turned into something the workspace can be asked
 * about, or '' when this release has no index.
 *
 * `true` becomes the derived three-level name when catalog and schema are
 * known. A name that already has two dots is kept. Anything else, including a
 * `true` with no namespace, is returned unchanged so the existing "flag not a
 * name" follow-up can still explain it.
 */
export function resolveSemanticIndexValue(
  raw: string,
  catalog: string,
  schema: string
): string {
  const value = raw.trim();
  if (!value || value.toLowerCase() === 'false') return '';
  if (value.toLowerCase() === DERIVE_SEMANTIC_INDEX) {
    return derivedSemanticIndexName(catalog, schema) || value;
  }
  return value;
}
