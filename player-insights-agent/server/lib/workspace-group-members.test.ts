import { describe, expect, it, vi } from 'vitest';
import {
  listWorkspaceGroups,
  readWorkspaceGroup,
  readWorkspaceGroupMembers,
  SCIM_GROUPS_PATH,
} from './workspace-group-members';

describe('workspace group discovery', () => {
  it('lists visible groups in display-name order', async () => {
    const reader = vi.fn(() =>
      Promise.resolve({
        Resources: [
          { id: '2', displayName: 'Zeta team' },
          { id: '1', displayName: 'Alpha team' },
        ],
      })
    );

    await expect(listWorkspaceGroups(reader)).resolves.toEqual({
      groups: [
        { id: '1', displayName: 'Alpha team' },
        { id: '2', displayName: 'Zeta team' },
      ],
      readable: true,
      detail: '',
    });
  });

  it('confirms only an exact group name and resolves its human members', async () => {
    const reader = vi.fn((path: string) => {
      if (path === SCIM_GROUPS_PATH) {
        return Promise.resolve({ Resources: [{ id: 'group-1', displayName: 'Existing Team' }] });
      }
      if (path === `${SCIM_GROUPS_PATH}/group-1`) {
        return Promise.resolve({
          members: [
            { value: 'user-2', display: 'Second User' },
            { value: 'user-1', display: 'First User' },
          ],
        });
      }
      if (path.endsWith('/user-1')) return Promise.resolve({ userName: 'first@example.com', displayName: 'First' });
      if (path.endsWith('/user-2')) return Promise.resolve({ userName: 'second@example.com', displayName: 'Second' });
      throw new Error(`Unexpected path: ${path}`);
    });

    await expect(readWorkspaceGroup('existing team', reader)).resolves.toMatchObject({
      groupName: 'Existing Team',
      groupId: 'group-1',
      exists: true,
      readable: true,
    });
    await expect(readWorkspaceGroupMembers('Existing Team', reader)).resolves.toEqual({
      groupName: 'Existing Team',
      readable: true,
      detail: '',
      members: [
        { email: 'first@example.com', displayName: 'First' },
        { email: 'second@example.com', displayName: 'Second' },
      ],
    });
  });

  it('does not present a missing group as an empty valid group', async () => {
    await expect(
      readWorkspaceGroupMembers('missing-team', () => Promise.resolve({ Resources: [] }))
    ).resolves.toMatchObject({
      groupName: 'missing-team',
      members: [],
      readable: false,
    });
  });
});
