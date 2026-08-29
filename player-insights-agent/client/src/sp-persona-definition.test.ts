import { describe, expect, it } from 'vitest';
import { DEFAULT_SP_PERSONA_TEMPLATES } from '../../shared/default-sp-persona-templates';
import {
  activeSpPersonaUnresolved,
  changeSpGrantAction,
  changeSpGrantType,
  canSuggestSpPermissions,
  duplicateSpPersonaGrantRow,
  grantsFromLegacy,
  isSpPersonaDraftDirty,
  isSpPersonaDefinitionComplete,
  mergeSuggestedSpGrants,
  newSpGrant,
  removeSpPersonaGrantRow,
  resourceMatchesSpPersonaSelector,
  resolveSpPersonaTemplateVariant,
  spPersonaTemplateUseBlock,
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

  it('enables suggestions only for a stated purpose and available inventory', () => {
    expect(canSuggestSpPermissions('', 2)).toBe(false);
    expect(canSuggestSpPermissions('   ', 2)).toBe(false);
    expect(canSuggestSpPermissions('Read player metrics', 0)).toBe(false);
    expect(canSuggestSpPermissions('Read player metrics', 2)).toBe(true);
  });

  it('stages a selected suggestion without duplicates', () => {
    const read = newSpGrant(resources);
    const write = changeSpGrantAction(read, 'WRITE');
    expect(mergeSuggestedSpGrants([read], [read, write])).toEqual({ grants: [read, write], overflowCount: 0 });
  });

  it('rejects an over-cap suggestion without partially applying or truncating it', () => {
    const suggested = Array.from({ length: 25 }, (_, index) => ({
      resourceType: 'TABLE' as const,
      resource: `main.games.table_${index}`,
      action: 'READ' as const,
      privilege: 'SELECT',
    }));
    expect(mergeSuggestedSpGrants([], suggested)).toEqual({ grants: [], overflowCount: 1 });
  });

  it('resolves only unique or explicit all-match configured resources and deduplicates grants', () => {
    const variant = {
      id: 'least-privilege',
      label: 'least privilege',
      description: 'Read only.',
      leastPrivilege: true,
      grants: [
        {
          resourceType: 'TABLE' as const,
          action: 'READ' as const,
          privilege: 'SELECT',
          selector: {
            match: 'all' as const,
            sources: ['declared' as const],
            idSuffixes: ['players'],
            choiceLabel: 'Curated player tables',
          },
        },
        {
          resourceType: 'TABLE' as const,
          action: 'READ' as const,
          privilege: 'SELECT',
          selector: {
            match: 'all' as const,
            sources: ['declared' as const],
            idSuffixes: ['players'],
            choiceLabel: 'Duplicate selector',
          },
        },
      ],
    };
    const resolved = resolveSpPersonaTemplateVariant(variant, resources);
    expect(resolved.grants).toEqual([newSpGrant(resources)]);
    expect(resolved.unresolved).toEqual([]);
  });

  it('uses exact suffixes and whole label segments without binding similarly named tables', () => {
    const selector = {
      match: 'all' as const,
      sources: ['declared' as const],
      idSuffixes: ['silver_player_profiles'],
      choiceLabel: 'Curated player profiles',
    };
    expect(
      [
        'main.games.silver_player_profiles',
        'main.games.silver_player_profiles_backup',
        'main.games.player',
        'main.games.game_events',
      ].filter((id) => resourceMatchesSpPersonaSelector({ type: 'TABLE', id, label: id, source: 'declared' }, selector))
    ).toEqual(['main.games.silver_player_profiles']);
    expect(
      resourceMatchesSpPersonaSelector(
        { type: 'TABLE', id: 'main.games.metrics', label: 'Curated Player Table', source: 'declared' },
        { match: 'all', labelSegments: ['curated', 'table'], choiceLabel: 'Curated tables' }
      )
    ).toBe(true);
    expect(
      resourceMatchesSpPersonaSelector(
        { type: 'TABLE', id: 'main.games.metrics', label: 'Curated Player Metadata', source: 'declared' },
        { match: 'all', labelSegments: ['curated', 'table'], choiceLabel: 'Curated tables' }
      )
    ).toBe(false);
  });

  it('resolves public defaults only to exact curated table suffixes and preserves semantic variants', () => {
    const configured = [
      { type: 'SQL_WAREHOUSE' as const, id: 'warehouse-1', label: 'SQL warehouse', source: 'configured' as const },
      { type: 'CATALOG' as const, id: 'main', label: 'App catalog', source: 'configured' as const },
      { type: 'SCHEMA' as const, id: 'main.games', label: 'App schema', source: 'configured' as const },
      { type: 'GENIE_SPACE' as const, id: 'data', label: 'Data Genie space', source: 'configured' as const },
      {
        type: 'GENIE_SPACE' as const,
        id: 'dictionary',
        label: 'Dictionary Genie space',
        source: 'configured' as const,
      },
      {
        type: 'SERVING_ENDPOINT' as const,
        id: 'astrolabe',
        label: 'Orchestrator serving endpoint',
        source: 'configured' as const,
      },
      {
        type: 'VECTOR_SEARCH_INDEX' as const,
        id: 'main.games.semantic',
        label: 'Vector Search index',
        source: 'configured' as const,
      },
      ...[
        'gold_player_180d_summary',
        'gold_title_daily_summary',
        'silver_gameplay_activity',
        'silver_player_profiles',
        'silver_purchases',
        'silver_player_profiles_backup',
      ].map((name) => ({
        type: 'TABLE' as const,
        id: `main.games.${name}`,
        label: name,
        source: 'declared' as const,
      })),
    ];
    for (const template of DEFAULT_SP_PERSONA_TEMPLATES) {
      const semantic = template.variants.find((variant) => variant.id === 'semantic-discovery');
      if (!semantic) throw new Error('Default template must provide semantic discovery.');
      const resolved = resolveSpPersonaTemplateVariant(semantic, configured);
      expect(resolved.unresolved).toEqual([]);
      expect(resolved.overflow).toEqual([]);
      expect(resolved.grants).toContainEqual(
        expect.objectContaining({ resourceType: 'VECTOR_SEARCH_INDEX', resource: 'main.games.semantic' })
      );
      expect(resolved.grants.map((grant) => grant.resource)).not.toContain('main.games.silver_player_profiles_backup');
    }
  });

  it('preserves fixed semantic grants and reports exact overflow instead of truncating broad expansions', () => {
    const tables = Array.from({ length: 30 }, (_, index) => ({
      type: 'TABLE' as const,
      id: `main.games.curated_${index}`,
      label: `Curated Table ${index}`,
      source: 'declared' as const,
    }));
    const semantic = {
      type: 'VECTOR_SEARCH_INDEX' as const,
      id: 'main.games.semantic_index',
      label: 'Semantic Index',
      source: 'configured' as const,
    };
    const resolved = resolveSpPersonaTemplateVariant(
      {
        id: 'expanded',
        label: 'expanded',
        description: 'Read-only expansion.',
        leastPrivilege: false,
        grants: [
          {
            resourceType: 'TABLE',
            action: 'READ',
            privilege: 'SELECT',
            selector: {
              match: 'all',
              labelSegments: ['curated', 'table'],
              choiceLabel: 'Curated analysis tables',
            },
          },
          {
            resourceType: 'VECTOR_SEARCH_INDEX',
            action: 'READ',
            privilege: 'SELECT',
            selector: { match: 'single', ids: [semantic.id], choiceLabel: 'Semantic index' },
          },
        ],
      },
      [...tables, semantic]
    );
    expect(resolved.grants).toEqual([
      { resourceType: 'VECTOR_SEARCH_INDEX', resource: semantic.id, action: 'READ', privilege: 'SELECT' },
      { resourceType: 'TABLE', resource: '', action: 'READ', privilege: 'SELECT' },
    ]);
    expect(resolved.overflow).toEqual([
      {
        rowId: 'intent-0',
        choiceLabel: 'Curated analysis tables',
        candidateCount: 30,
        selectableCount: 23,
        requiredGrantCount: 31,
        grantLimit: 24,
        overflowCount: 7,
      },
    ]);
    expect(resolved.unresolved[0]).toMatchObject({ rowId: 'intent-0', reason: 'overflow', candidateCount: 30 });
  });

  it('stages unresolved choices instead of guessing among configured resources', () => {
    const variant = {
      id: 'least-privilege',
      label: 'least privilege',
      description: 'Read only.',
      leastPrivilege: true,
      grants: [
        {
          resourceType: 'GENIE_SPACE' as const,
          action: 'USE' as const,
          privilege: 'CAN RUN',
          selector: { match: 'single' as const, choiceLabel: 'Approved Genie space' },
        },
      ],
    };
    const twoSpaces = [
      ...resources,
      { type: 'GENIE_SPACE' as const, id: '02efabcd', label: 'Other Genie', source: 'declared' as const },
    ];
    const resolved = resolveSpPersonaTemplateVariant(variant, twoSpaces);
    expect(resolved.grants[0]).toMatchObject({ resourceType: 'GENIE_SPACE', resource: '', privilege: 'CAN RUN' });
    expect(resolved.unresolved).toEqual([
      {
        rowId: 'intent-0',
        resourceType: 'GENIE_SPACE',
        choiceLabel: 'Approved Genie space',
        candidateCount: 2,
        reason: 'selection',
      },
    ]);
    expect(
      isSpPersonaDefinitionComplete({
        displayName: 'Fictional analyst',
        description: '',
        capabilities: [],
        grants: resolved.grants,
        legacyCapabilities: [],
      })
    ).toBe(false);
  });

  it('keeps unresolved guidance attached to stable rows through duplicate, insert, remove, reorder, and edit', () => {
    const unresolved = [
      {
        rowId: 'a',
        resourceType: 'TABLE' as const,
        choiceLabel: 'First table',
        candidateCount: 2,
        reason: 'selection' as const,
      },
      {
        rowId: 'c',
        resourceType: 'GENIE_SPACE' as const,
        choiceLabel: 'Genie',
        candidateCount: 0,
        reason: 'selection' as const,
      },
    ];
    const afterFirst = duplicateSpPersonaGrantRow(['a', 'b', 'c'], unresolved, 0, 'a-copy');
    expect(afterFirst.rowIds).toEqual(['a', 'a-copy', 'b', 'c']);
    expect(afterFirst.unresolved.map((item) => item.rowId)).toEqual(['a', 'c', 'a-copy']);
    const afterMiddle = duplicateSpPersonaGrantRow(afterFirst.rowIds, afterFirst.unresolved, 2, 'b-copy');
    expect(afterMiddle.unresolved.map((item) => item.rowId)).toEqual(['a', 'c', 'a-copy']);
    const afterLast = duplicateSpPersonaGrantRow(afterMiddle.rowIds, afterMiddle.unresolved, 4, 'c-copy');
    expect(afterLast.unresolved.map((item) => item.rowId)).toEqual(['a', 'c', 'a-copy', 'c-copy']);
    const afterRemove = removeSpPersonaGrantRow(afterLast.rowIds, afterLast.unresolved, 0);
    expect(afterRemove.rowIds).toEqual(['a-copy', 'b', 'b-copy', 'c', 'c-copy']);
    expect(afterRemove.unresolved.map((item) => item.rowId)).toEqual(['c', 'a-copy', 'c-copy']);

    const blankTable = { resourceType: 'TABLE' as const, resource: '', action: 'READ' as const, privilege: 'SELECT' };
    const blankGenie = {
      resourceType: 'GENIE_SPACE' as const,
      resource: '',
      action: 'USE' as const,
      privilege: 'CAN RUN',
    };
    expect(
      activeSpPersonaUnresolved(
        [blankTable, blankTable, blankTable, blankGenie, blankGenie],
        afterRemove.rowIds,
        afterRemove.unresolved
      ).map((item) => item.rowId)
    ).toEqual(['a-copy', 'c', 'c-copy']);
    expect(
      activeSpPersonaUnresolved(
        [blankGenie, { ...blankTable, resource: 'main.games.players' }],
        ['c', 'a-copy'],
        afterRemove.unresolved
      ).map((item) => item.rowId)
    ).toEqual(['c']);
  });

  it('blocks profile replacement during existing edits or dirty create drafts, but permits clean drafts and cancel', () => {
    expect(spPersonaTemplateUseBlock('definition-1', true)).toBe('Finish or cancel the current edit first.');
    expect(spPersonaTemplateUseBlock(null, true)).toBe('Cancel staged changes before using an example profile.');
    expect(spPersonaTemplateUseBlock(null, false)).toBeNull();
    expect(
      spPersonaTemplateUseBlock(
        null,
        isSpPersonaDraftDirty({
          displayName: '',
          description: '',
          capabilities: [],
          grants: [],
          legacyCapabilities: [],
        })
      )
    ).toBeNull();
  });

  it('treats applied profiles and later edits as dirty until cancelled or saved', () => {
    expect(
      isSpPersonaDraftDirty({
        displayName: '',
        description: '',
        capabilities: [],
        grants: [],
        legacyCapabilities: [],
      })
    ).toBe(false);
    expect(
      isSpPersonaDraftDirty({
        displayName: 'Editable example',
        description: '',
        capabilities: [],
        grants: [],
        legacyCapabilities: [],
      })
    ).toBe(true);
  });
});
