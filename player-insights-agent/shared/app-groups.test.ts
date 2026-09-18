import { describe, expect, it } from 'vitest';
import { appGroupOptions, appGroupsForEmail, memberEmailsForGroup, parseAppGroupsSettings } from './app-groups';

describe('Teams contract', () => {
  const settings = parseAppGroupsSettings({
    groups: [
      { id: 'trading', name: 'Trading', members: ['Ann@X.com', 'ann@x.com', 'bob@x.com'] },
      { id: 'risk', name: 'Risk', members: ['ANN@x.com'] },
    ],
  });

  it('normalizes current email membership and supports overlap', () => {
    expect(settings.groups[0].members).toEqual(['ann@x.com', 'bob@x.com']);
    expect(appGroupsForEmail(settings, 'Ann@X.com')).toEqual(['trading', 'risk']);
    expect(memberEmailsForGroup(settings, 'trading')).toEqual(['ann@x.com', 'bob@x.com']);
  });

  it('publishes stable, name-sorted filter options', () => {
    expect(appGroupOptions(settings)).toEqual([
      { id: 'risk', name: 'Risk' },
      { id: 'trading', name: 'Trading' },
    ]);
  });
});
