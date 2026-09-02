import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ResourceTagResults,
  ResourceTagsApplyButton,
  RESOURCE_TAG_REQUEST_TIMEOUT_MS,
  resourceTagStatus,
  type TagSummary,
} from './ResourceTagsPanel';

const summary: TagSummary = {
  headline: '2 of 4 supported resources tagged',
  supportedTotal: 4,
  supportedCovered: 2,
  tagged: 1,
  alreadyCorrect: 1,
  supportedFailed: 1,
  permissionRequired: 1,
  unsupported: 1,
  notApplicable: 3,
  updatedAt: '2026-09-02T00:00:00.000Z',
  results: [
    {
      kind: 'serving-endpoint',
      name: 'player-insights-agent-with-an-intentionally-long-identifier',
      label: 'Orchestrator serving endpoint · player-insights-agent-with-an-intentionally-long-identifier',
      support: 'supported',
      billingAttribution: true,
      status: 'permission-required',
      detail: 'The signed-in administrator needs CAN_MANAGE.',
      nextAction: 'Grant CAN_MANAGE.',
      technicalDetail: 'PERMISSION_DENIED',
    },
    {
      kind: 'vector-index',
      name: 'catalog.schema.index',
      label: 'AI Search index · catalog.schema.index',
      support: 'unsupported',
      billingAttribution: false,
      status: 'unsupported',
      detail: 'Databricks exposes billing tags on the endpoint, not the index.',
      nextAction: 'Tag the endpoint.',
    },
    {
      kind: 'genie-space',
      name: 'space',
      label: 'Data Genie space · space',
      support: 'not-applicable',
      billingAttribution: false,
      status: 'not-applicable',
      detail: 'Organizational metadata does not propagate to billing.',
      nextAction: 'Use Genie billing metadata.',
    },
  ],
};

describe('compact Resource Tags results', () => {
  it('bounds the request instead of leaving Apply running forever', () => {
    expect(RESOURCE_TAG_REQUEST_TIMEOUT_MS).toBe(20_000);
  });

  it('renders the supported denominator and compact resource/support/result/action table', () => {
    const markup = renderToStaticMarkup(<ResourceTagResults summary={summary} />);
    expect(markup).toContain('2 of 4 supported resources tagged');
    expect(markup).toContain('<th>Resource</th>');
    expect(markup).toContain('<th>Support</th>');
    expect(markup).toContain('<th>Result</th>');
    expect(markup).toContain('<th>Next action</th>');
    expect(markup).toContain('Permission required');
    expect(markup).toContain('Unsupported by platform');
    expect(markup).toContain('Excluded from billing coverage');
    expect(markup).toContain('<details>');
    expect(markup.indexOf('The signed-in administrator needs CAN_MANAGE')).toBeLessThan(
      markup.indexOf('PERMISSION_DENIED')
    );
    expect(markup).toContain('title="player-insights-agent-with-an-intentionally-long-identifier"');
  });

  it('hides rows while retaining the coverage summary and reopen control', () => {
    const markup = renderToStaticMarkup(<ResourceTagResults summary={summary} hidden />);
    expect(markup).toContain('2 of 4 supported resources tagged');
    expect(markup).toContain('Show details');
    expect(markup).not.toContain('<table');
  });

  it('explains that clearing UI history leaves applied Databricks tags intact', () => {
    const markup = renderToStaticMarkup(<ResourceTagResults summary={summary} />);
    expect(markup).toContain('Clear results');
    expect(markup).toContain('not tags already applied to Databricks resources');
  });

  it('keeps a failed clear visible without discarding the result table', () => {
    const markup = renderToStaticMarkup(
      <ResourceTagResults summary={summary} clearError="Results were not cleared. The saved result is unchanged." />
    );
    expect(markup).toContain('saved result is unchanged');
    expect(markup).toContain('<table');
  });

  it('ships responsive overflow and dark/light tokenized styling for long identifiers', () => {
    const css = readFileSync(new URL('styles/settings.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.resource-tag-table-frame\s*\{[\s\S]*margin-top/);
    expect(css).toMatch(/\.resource-tag-table\s*\{[\s\S]*min-width:\s*760px/);
    expect(css).toMatch(/\.resource-tag-table td > code\s*\{[\s\S]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/@media \(max-width:\s*720px\)[\s\S]*\.resource-tag-summary/);
    expect(css).not.toMatch(/\.resource-tag-(?:summary|table)[^{]*\{[^}]*#[0-9a-f]{3,8}/i);
  });
});

describe('Resource Tags controls', () => {
  it('puts the in-button flicker left of Apply while running', () => {
    const idle = renderToStaticMarkup(<ResourceTagsApplyButton running={false} />);
    const busy = renderToStaticMarkup(<ResourceTagsApplyButton running={true} />);
    expect(idle).toContain('Apply tags');
    expect(busy).toContain('ast-flick-slot--button');
    expect(busy.indexOf('ast-flick-slot--button')).toBeLessThan(busy.indexOf('Apply tags'));
  });

  it('reports supported failures and permissions without claiming success', () => {
    expect(resourceTagStatus(false, summary, '')).toEqual({ tone: 'ast-pill--neg', label: 'Failed' });
    expect(resourceTagStatus(false, { ...summary, supportedFailed: 0 }, '')).toEqual({
      tone: 'ast-pill--warn',
      label: 'Needs access',
    });
    expect(resourceTagStatus(false, { ...summary, supportedFailed: 0, permissionRequired: 0 }, '')).toEqual({
      tone: 'ast-pill--pos',
      label: 'Applied',
    });
  });
});
