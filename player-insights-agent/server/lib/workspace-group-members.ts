import type { GroupMember, GroupMembersResponse, WorkspaceGroupsResponse } from '../../shared/user-roster-contract';
import { workspaceControlPlaneReader, type ControlPlaneReader } from './control-plane-identity';

export const SCIM_GROUPS_PATH = '/api/2.0/preview/scim/v2/Groups';
const MAX_GROUP_MEMBERS = 500;
const USER_READ_CONCURRENCY = 12;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalized(value: unknown): string {
  return text(value).toLocaleLowerCase();
}

function resources(body: unknown): Record<string, unknown>[] {
  const rows = record(body).Resources;
  return Array.isArray(rows) ? rows.map(record) : [];
}

function scimFilterLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface WorkspaceGroupRead {
  groupName: string;
  groupId: string;
  exists: boolean;
  readable: boolean;
}

export async function listWorkspaceGroups(
  reader: ControlPlaneReader = workspaceControlPlaneReader
): Promise<WorkspaceGroupsResponse> {
  try {
    const listing = await reader(SCIM_GROUPS_PATH, { count: '500', startIndex: '1' });
    const groups = resources(listing)
      .map((group) => ({ id: text(group.id), displayName: text(group.displayName) }))
      .filter((group) => group.id && group.displayName)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
    return { groups, readable: true, detail: '' };
  } catch {
    return {
      groups: [],
      readable: false,
      detail: 'Workspace groups could not be listed with this deployment’s permissions.',
    };
  }
}

export async function readWorkspaceGroup(
  groupName: string,
  reader: ControlPlaneReader = workspaceControlPlaneReader
): Promise<WorkspaceGroupRead> {
  const requested = groupName.trim();
  if (!requested) return { groupName: '', groupId: '', exists: false, readable: true };
  try {
    const listing = await reader(SCIM_GROUPS_PATH, {
      filter: `displayName eq ${scimFilterLiteral(requested)}`,
      count: '100',
    });
    const group = resources(listing).find((candidate) => normalized(candidate.displayName) === normalized(requested));
    return {
      groupName: text(group?.displayName) || requested,
      groupId: text(group?.id),
      exists: Boolean(text(group?.id)),
      readable: true,
    };
  } catch {
    return { groupName: requested, groupId: '', exists: false, readable: false };
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  visit: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await visit(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function readWorkspaceGroupMembers(
  groupName: string,
  reader: ControlPlaneReader = workspaceControlPlaneReader
): Promise<GroupMembersResponse> {
  const requested = groupName.trim();
  if (!requested) return { groupName: '', members: [], readable: false, detail: 'No workspace group was named.' };
  try {
    const found = await readWorkspaceGroup(requested, reader);
    if (!found.readable) {
      return {
        groupName: requested,
        members: [],
        readable: false,
        detail: 'Workspace membership could not be read with this app deployment’s permissions.',
      };
    }
    if (!found.groupId) {
      return {
        groupName: requested,
        members: [],
        readable: false,
        detail: `The workspace group ${requested} was not found.`,
      };
    }
    const body = record(await reader(`${SCIM_GROUPS_PATH}/${encodeURIComponent(found.groupId)}`));
    const allMembers = Array.isArray(body.members) ? body.members.map(record) : [];
    const rawMembers = allMembers.slice(0, MAX_GROUP_MEMBERS);
    const resolved = await mapWithConcurrency(rawMembers, USER_READ_CONCURRENCY, async (member) => {
      const memberId = text(member.value);
      const memberLabel = text(member.display);
      if (!memberId) return null;
      try {
        const user = record(await reader(`/api/2.0/preview/scim/v2/Users/${encodeURIComponent(memberId)}`));
        const email = text(user.userName);
        if (!email) return null;
        return { email, displayName: text(user.displayName) || memberLabel || email } satisfies GroupMember;
      } catch {
        return memberLabel.includes('@')
          ? ({ email: memberLabel, displayName: memberLabel } satisfies GroupMember)
          : null;
      }
    });
    const deduplicated = new Map<string, GroupMember>();
    for (const member of resolved) {
      if (member) deduplicated.set(normalized(member.email), member);
    }
    const members = [...deduplicated.values()].sort(
      (left, right) => left.displayName.localeCompare(right.displayName) || left.email.localeCompare(right.email)
    );
    const unresolved = rawMembers.length - members.length;
    return {
      groupName: requested,
      members,
      readable: true,
      detail:
        allMembers.length > MAX_GROUP_MEMBERS
          ? `Showing the first ${MAX_GROUP_MEMBERS} members.`
          : unresolved > 0
            ? `${unresolved} nested group or unreadable member ${unresolved === 1 ? 'was' : 'were'} omitted.`
            : '',
    };
  } catch {
    return {
      groupName: requested,
      members: [],
      readable: false,
      detail: 'Workspace membership could not be read with this app deployment’s permissions.',
    };
  }
}
