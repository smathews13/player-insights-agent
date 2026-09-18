import { appTable } from '../../shared/app-schema';
import { DEFAULT_APP_GROUPS_SETTINGS, parseAppGroupsSettings, type AppGroupsSettings } from '../../shared/app-groups';
import type { LakebaseReader } from './lakebase-store';
import {
  readVersionedSettings,
  writeVersionedSettingsPatch,
  type VersionedSettings,
  type VersionedSettingsStore,
} from './versioned-settings-store';

export const APP_GROUPS_TABLE = appTable('app_groups');
export const APP_GROUPS_DDL = `CREATE TABLE IF NOT EXISTS ${APP_GROUPS_TABLE} (
  id TEXT PRIMARY KEY,
  settings JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
)`;

const STORE: VersionedSettingsStore<AppGroupsSettings> = {
  table: APP_GROUPS_TABLE,
  key: 'effective',
  defaults: DEFAULT_APP_GROUPS_SETTINGS,
  prepare: parseAppGroupsSettings,
  parse: parseAppGroupsSettings,
};

export function readAppGroupsSettings(client: LakebaseReader): Promise<VersionedSettings<AppGroupsSettings>> {
  return readVersionedSettings(client, STORE);
}

export function writeAppGroupsSettings(
  client: LakebaseReader,
  patch: unknown,
  revision: number,
  updatedBy: string
): Promise<VersionedSettings<AppGroupsSettings>> {
  return writeVersionedSettingsPatch(client, STORE, patch, revision, updatedBy);
}
