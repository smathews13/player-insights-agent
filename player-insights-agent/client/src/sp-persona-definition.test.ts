import { describe, expect, it } from 'vitest';
import {
  changeSpGrantAction,
  changeSpGrantType,
  grantsFromLegacy,
  isSpPersonaDefinitionComplete,
  newSpGrant,
} from './sp-persona-definition';

const resources = [
  { type: 'TABLE' as const, id: 'main.games.players', label: 'Players', source: 'declared' as const },
  { type: 'GENIE_SPACE' as const, id: '01efabcd', label: 'Player Genie', source: 'configured' as const },
];

describe('structured persona grant editing', () => {
  it('adds a real structured row and selects a discovered resource when available', () => {
    expect(newSpGrant(resources)).toEqual({
      resourceType: 'TABLE',
      resource: 'main.games.players',
      action: 'READ',
      privilege: 'SELECT',
    });
  });

  it('resets resource and permission to valid choices when resource type changes', () => {
    expect(changeSpGrantType('GENIE_SPACE', resources)).toEqual({
      resourceType: 'GENIE_SPACE',
      resource: '01efabcd',
      action: 'VIEW',
      privilege: 'CAN VIEW',
    });
  });

  it('maps friendly actions to canonical privileges instead of trusting free text', () => {
    const grant = newSpGrant(resources);
    expect(changeSpGrantAction(grant, 'WRITE')).toMatchObject({ action: 'WRITE', privilege: 'MODIFY' });
    expect(changeSpGrantAction(grant, 'USE')).toEqual(grant);
  });

  it('converts known combined legacy table guidance into three editable scoped grants', () => {
    expect(
      grantsFromLegacy('Governed tables — USE CATALOG, USE SCHEMA, SELECT').map((grant) => grant.resourceType)
    ).toEqual(['CATALOG', 'SCHEMA', 'TABLE']);
  });

  it('requires valid identifiers and rejects exact duplicates before submission', () => {
    const grant = newSpGrant(resources);
    expect(
      isSpPersonaDefinitionComplete({
        displayName: 'Analyst',
        description: '',
        capabilities: [],
        grants: [grant],
        legacyCapabilities: [],
      })
    ).toBe(true);
    expect(
      isSpPersonaDefinitionComplete({
        displayName: 'Analyst',
        description: '',
        capabilities: [],
        grants: [grant, grant],
        legacyCapabilities: [],
      })
    ).toBe(false);
  });
});
