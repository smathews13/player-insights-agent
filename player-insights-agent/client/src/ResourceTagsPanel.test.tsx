import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ResourceTagResults,
  ResourceTagsApplyButton,
  RESOURCE_TAG_REQUEST_TIMEOUT_MS,
  resourceTagStatus,
  type TagSummary,
} from './ResourceTagsPanel';

describe('Astrolabe resource tag results', () => {
  it('bounds the interactive request instead of leaving the button Applying forever', () => {
    expect(RESOURCE_TAG_REQUEST_TIMEOUT_MS).toBe(20_000);
  });

  it('leads with actionable counts and keeps raw Databricks JSON behind disclosure', () => {
    const summary: TagSummary = {
      headline:
        '3 of 7 resources correctly tagged · 1 not supported by Databricks · ' +
        '3 need workspace grants · 0 failed after retries.',
      total: 7,
      correct: 3,
      tagged: 1,
      alreadyCorrect: 2,
      notSupported: 1,
      permissionRequired: 3,
      failed: 0,
      results: [
        {
          label: 'App · player-insights-agent',
          status: 'permission-required',
          detail:
            'Workspace admin action: grant service principal 071769f1-5623-45b6-a172-c8b8060adff1 ' +
            'CAN_MANAGE on app “player-insights-agent” so it can change the app tag assignments.',
          technicalDetail:
            'Response from server (Forbidden)\n' +
            '{"error_code":"PERMISSION_DENIED","message":"User does not have permission to apply tag assignment changes."}',
        },
        {
          label: 'Vector Search index · catalog.schema.index',
          status: 'not-supported',
          detail:
            'Databricks does not expose custom tags for Vector Search indexes. Nothing needs to be fixed on this index; ' +
            'Astrolabe tags its endpoint instead.',
        },
      ],
    };

    const markup = renderToStaticMarkup(<ResourceTagResults summary={summary} />);

    expect(markup).toContain('3 of 7 resources correctly tagged');
    expect(markup).toContain('3 need workspace grants');
    expect(markup).toContain('Nothing needs to be fixed');
    expect(markup).toContain('CAN_MANAGE on app');
    expect(markup).toContain('<details>');
    expect(markup).toContain('<summary>Technical details</summary>');
    expect(markup.indexOf('CAN_MANAGE on app')).toBeLessThan(markup.indexOf('PERMISSION_DENIED'));
  });

  it('puts the in-button Astrolabe flicker left of Apply while the repair is running', () => {
    const idle = renderToStaticMarkup(<ResourceTagsApplyButton running={false} />);
    const busy = renderToStaticMarkup(<ResourceTagsApplyButton running={true} />);
    expect(idle).toContain('Apply tags');
    expect(idle).not.toContain('data-variant="outline"');
    expect(idle).not.toContain('ast-flick-slot--button');
    expect(busy).toContain('ast-flick-slot--button');
    expect(busy).toContain('Apply tags');
    expect(busy.indexOf('ast-flick-slot--button')).toBeLessThan(busy.indexOf('Apply tags'));
  });

  it('reports partial failures and permission requirements instead of claiming Applied', () => {
    const summary = (overrides: Partial<TagSummary>): TagSummary => ({
      headline: '',
      total: 1,
      correct: 0,
      tagged: 0,
      alreadyCorrect: 0,
      notSupported: 0,
      permissionRequired: 0,
      failed: 0,
      results: [],
      ...overrides,
    });

    expect(resourceTagStatus(false, summary({ failed: 1 }), '')).toEqual({
      tone: 'ast-pill--neg',
      label: 'Failed',
    });
    expect(resourceTagStatus(false, summary({ permissionRequired: 1 }), '')).toEqual({
      tone: 'ast-pill--warn',
      label: 'Needs access',
    });
    expect(resourceTagStatus(false, summary({ correct: 1 }), '')).toEqual({
      tone: 'ast-pill--pos',
      label: 'Applied',
    });
  });
});
