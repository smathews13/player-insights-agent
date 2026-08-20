import { ASSIGNABLE_ROLES, type Role } from '../../shared/user-roster-contract';
import { roleWord, type RosterEntry } from './user-roster';

export function roleOptions(entry: RosterEntry): { value: Role; label: string }[] {
  return [
    { value: entry.role, label: roleWord(entry.role) },
    ...ASSIGNABLE_ROLES.filter((role) => entry.assignable.includes(role)).map((role) => ({
      value: role,
      label: roleWord(role),
    })),
  ];
}
