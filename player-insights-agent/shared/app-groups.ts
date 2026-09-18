import { z } from 'zod';

export const APP_GROUPS_MAX = 50;
export const APP_GROUP_MEMBERS_MAX = 1000;

export const AppGroupSchema = z.strictObject({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  members: z.array(z.string().trim().min(1).max(320)).max(APP_GROUP_MEMBERS_MAX),
});

export const AppGroupsSettingsSchema = z.strictObject({
  groups: z.array(AppGroupSchema).max(APP_GROUPS_MAX),
});
export const AppGroupsPatchSchema = AppGroupsSettingsSchema.partial();

export type AppGroup = z.infer<typeof AppGroupSchema>;
export type AppGroupsSettings = z.infer<typeof AppGroupsSettingsSchema>;
export interface AppGroupOption {
  id: string;
  name: string;
}

export const DEFAULT_APP_GROUPS_SETTINGS: AppGroupsSettings = { groups: [] };

export function normalizeMemberEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function parseAppGroupsSettings(value: unknown): AppGroupsSettings {
  const parsed = AppGroupsSettingsSchema.parse(value);
  const ids = new Set<string>();
  return {
    groups: parsed.groups.flatMap((group) => {
      const id = group.id.trim();
      if (ids.has(id)) return [];
      ids.add(id);
      return [
        {
          id,
          name: group.name.trim(),
          members: [...new Set(group.members.map(normalizeMemberEmail).filter(Boolean))],
        },
      ];
    }),
  };
}

export function appGroupsForEmail(settings: AppGroupsSettings, email: string): string[] {
  const normalized = normalizeMemberEmail(email);
  return normalized
    ? settings.groups.filter((group) => group.members.includes(normalized)).map((group) => group.id)
    : [];
}

export function memberEmailsForGroup(settings: AppGroupsSettings, groupId: string): string[] {
  return settings.groups.find((group) => group.id === groupId.trim())?.members ?? [];
}

export function appGroupOptions(settings: AppGroupsSettings): AppGroupOption[] {
  return settings.groups
    .map(({ id, name }) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
