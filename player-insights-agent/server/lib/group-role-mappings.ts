import { APP_SCHEMA } from '../../shared/app-schema';
import type { Role } from '../../shared/user-roster-contract';
import { columnText, normalizeAdminEmail, type AdminStore } from './admin-identity';

export const GROUP_ROLE_MAPPINGS_TABLE = `${APP_SCHEMA}.group_role_mappings`;
export const GROUP_ROLE_MAPPINGS_DDL = `CREATE TABLE IF NOT EXISTS ${GROUP_ROLE_MAPPINGS_TABLE} (
  group_name TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'consumer')),
  added_by TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

export interface StoredGroupRoleMapping {
  groupName: string;
  role: Extract<Role, 'admin' | 'consumer'>;
  setBy: string;
  setAt: string;
}

export async function readGroupRoleMappings(store: AdminStore): Promise<StoredGroupRoleMapping[]> {
  const result = await store.query(
    `SELECT group_name, role, added_by, added_at FROM ${GROUP_ROLE_MAPPINGS_TABLE} ORDER BY added_at ASC`
  );
  return result.rows.flatMap((row) => {
    const groupName = columnText(row.group_name).trim();
    const role = columnText(row.role).trim().toLocaleLowerCase();
    if (!groupName || (role !== 'admin' && role !== 'consumer')) return [];
    return [
      {
        groupName,
        role,
        setBy: normalizeAdminEmail(columnText(row.added_by)),
        setAt: row.added_at instanceof Date ? row.added_at.toISOString() : columnText(row.added_at),
      },
    ];
  });
}

export async function writeGroupRoleMapping(
  store: AdminStore,
  input: { groupName: string; role: Extract<Role, 'admin' | 'consumer'>; actor: string }
): Promise<void> {
  await store.query(
    `INSERT INTO ${GROUP_ROLE_MAPPINGS_TABLE} (group_name, role, added_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (group_name) DO UPDATE
       SET role = EXCLUDED.role,
           added_by = EXCLUDED.added_by,
           added_at = NOW()`,
    [input.groupName.trim(), input.role, normalizeAdminEmail(input.actor)]
  );
}
