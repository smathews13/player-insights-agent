import {
  APP_SCHEMA,
  APP_SCHEMA_ENV,
  APP_TARGET_ENV,
  LAKEBASE_ENDPOINT_ENV,
  LEGACY_APP_SCHEMA,
  adoptAppSchema,
} from '../../shared/app-schema';

interface SchemaProbe {
  query(text: string, params?: unknown[]): Promise<{ rows?: Record<string, unknown>[] }>;
}

/**
 * Find an existing Player Insights Agent store owned by the unchanged Postgres role.
 *
 * Deploy from Git replaces app.yaml but does not replace the App or its service
 * principal. A bundle-specific schema name therefore disappears from the
 * environment even though the same role still owns the same tables. Prefer the
 * oldest matching owned schema: if an earlier Git deploy already created a
 * fallback beside the real store, the original store is the one whose history
 * and role roster must survive.
 */
export async function preserveOwnedAppSchema(
  lakebase: SchemaProbe,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): Promise<string> {
  const target = (env[APP_TARGET_ENV] ?? '').trim();
  const endpoint = (env[LAKEBASE_ENDPOINT_ENV] ?? '').trim();
  const authored = (env[APP_SCHEMA_ENV] ?? '').trim();
  const sourceGitDeploy = !target && Boolean(endpoint) && (!authored || authored === LEGACY_APP_SCHEMA);
  if (!sourceGitDeploy) return APP_SCHEMA;

  try {
    const result = await lakebase.query(`
      SELECT n.nspname
      FROM pg_namespace n
      JOIN pg_class c ON c.relnamespace = n.oid
      WHERE pg_get_userbyid(n.nspowner) = current_user
        AND c.relkind IN ('r', 'p')
        AND c.relname IN ('conversations', 'messages', 'admin_roles')
      GROUP BY n.oid, n.nspname
      HAVING count(DISTINCT c.relname) >= 2
      ORDER BY n.oid ASC`);
    const existing = result.rows
      ?.map((row) => (typeof row.nspname === 'string' ? row.nspname.trim() : ''))
      .find(Boolean);
    if (existing) {
      const adopted = adoptAppSchema(existing);
      console.warn(
        `[lakebase] Deploy from Git preserved the app-owned ${adopted} schema discovered under ` +
          'the unchanged service principal, so stored history and roles remain in use.'
      );
      return adopted;
    }
  } catch (error) {
    console.warn(
      '[lakebase] Could not discover an existing app-owned schema before startup; using the ' +
        `${APP_SCHEMA} Git-deploy default. ${(error as Error).message}`
    );
  }
  return APP_SCHEMA;
}
