/**
 * The Lakebase resource attached to the running Databricks App and an optional
 * replacement an administrator has staged for a bundle-managed redeploy.
 *
 * The two are intentionally separate. Selecting a database in Connections does
 * not rebuild AppKit's pool: Databricks Apps injects the Postgres environment at
 * deployment startup, and only a resource update plus restart can change it.
 */

export interface LakebaseBinding {
  project: string;
  branch: string;
  database: string;
  endpoint: string;
  schema: string;
}

export interface DesiredLakebaseBinding {
  project: string;
  branch: string;
  database: string;
  revision: number;
  updatedAt: string;
  updatedBy: string;
}

export interface LakebaseRedeployPlan {
  status: 'active' | 'redeploy_required';
  active: LakebaseBinding;
  desired: DesiredLakebaseBinding | null;
  /** Exact when targetKnown is true; otherwise preserves the required placeholder. */
  command: string;
  target: string;
  targetKnown: boolean;
  appSettingsUrl: string;
  detail: string;
}

export function isLakebaseRedeployPlan(value: unknown): value is LakebaseRedeployPlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<LakebaseRedeployPlan>;
  const active = plan.active as Partial<LakebaseBinding> | undefined;
  const desired = plan.desired as Partial<DesiredLakebaseBinding> | null | undefined;
  return (
    (plan.status === 'active' || plan.status === 'redeploy_required') &&
    Boolean(active && typeof active.project === 'string' && typeof active.branch === 'string') &&
    typeof active?.database === 'string' &&
    typeof active?.endpoint === 'string' &&
    typeof active?.schema === 'string' &&
    (desired === null ||
      Boolean(
        desired &&
          typeof desired.project === 'string' &&
          typeof desired.branch === 'string' &&
          typeof desired.database === 'string' &&
          typeof desired.revision === 'number' &&
          typeof desired.updatedAt === 'string' &&
          typeof desired.updatedBy === 'string'
      )) &&
    typeof plan.command === 'string' &&
    typeof plan.target === 'string' &&
    typeof plan.targetKnown === 'boolean' &&
    typeof plan.appSettingsUrl === 'string' &&
    typeof plan.detail === 'string'
  );
}
