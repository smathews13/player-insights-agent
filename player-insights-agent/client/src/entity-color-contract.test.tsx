import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DEFAULT_ENTITY_STYLES, RUNTIME_ENTITY_KINDS, contrastRatio } from '../../shared/runtime-settings';
import { Entity, EntityParts } from './Entity';
import { partial } from './styles/stylesheet';

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

describe('light entity color contract', () => {
  it('ships the approved opaque pair for every entity kind', () => {
    expect(DEFAULT_ENTITY_STYLES).toEqual({
      catalog: { foreground: '#1a5b8f', background: '#e8f1fa' },
      schema: { foreground: '#4c5c68', background: '#eef2f5' },
      table: { foreground: '#0e1720', background: '#e2e8ed' },
      column: { foreground: '#4c5c68', background: '#f2f5f8' },
      quote: { foreground: '#4c5c68', background: '#f2f5f8' },
      tag: { foreground: '#0e1720', background: '#e8f1fa' },
    });
    for (const kind of RUNTIME_ENTITY_KINDS) {
      const style = DEFAULT_ENTITY_STYLES[kind];
      expect(contrastRatio(style.foreground, style.background), kind).toBeGreaterThanOrEqual(4.5);
      expect(style.background).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('renders every kind through the shared Entity primitive', () => {
    const markup = RUNTIME_ENTITY_KINDS.map((kind) =>
      renderToStaticMarkup(
        <Entity kind={kind} className="sample">
          {kind}
        </Entity>
      )
    ).join('');
    for (const kind of RUNTIME_ENTITY_KINDS) {
      expect(markup).toContain(`class="entity-token entity-${kind} sample"`);
      expect(markup).toContain(`data-entity-part="${kind}"`);
    }
    expect(renderToStaticMarkup(<EntityParts text="catalog.schema.table" entity="catalog.schema.table" />)).toContain(
      'class="entity-separator">.</span>'
    );
  });

  it('uses one implementation across prose, sources, Connections, Run Explorer, and Settings', () => {
    expect(source('InlineEntityText.tsx')).toContain("import { Entity, EntityParts } from './Entity'");
    expect(source('DataEntityLinks.tsx')).toContain("import { Entity, EntityParts } from './Entity'");
    expect(source('ConnectionsPage.tsx')).toContain('EntityParts');
    expect(source('StepResult.tsx')).toContain('EntityParts');
    expect(source('RuntimeSettingsPanel.tsx')).toContain('<Entity');
    expect(source('InlineEntityText.tsx')).not.toContain('function EntityParts');
    expect(source('DataEntityLinks.tsx')).not.toContain('function EntityParts');
  });

  it('keeps source headers and Run Explorer from repainting entity tokens', () => {
    const answerBody = partial('answer-body.css');
    const runs = partial('runs.css');
    expect(answerBody).toContain('.source-name-short:not(.entity-token)');
    expect(runs).not.toMatch(/\.final-answer \.entity-(?:token|catalog)[^{]*\{[^}]*(?:color|background):/);
  });

  it('applies the approved borders, weights, and shared chip geometry', () => {
    const tokens = partial('astrolabe-tokens.css');
    const answer = partial('answer.css');
    for (const [kind, border, weight] of [
      ['catalog', '--ast-info-border', 500],
      ['schema', '--ast-neutral-border', 400],
      ['table', '--ast-hairline-strong', 600],
      ['column', 'transparent', 400],
      ['quote', 'transparent', 400],
      ['tag', 'transparent', 400],
    ] as const) {
      expect(tokens).toMatch(new RegExp(`--ast-entity-${kind}-border:\\s*(?:var\\(${border}\\)|${border})`));
      expect(tokens).toContain(`--ast-entity-${kind}-weight: ${weight}`);
    }
    expect(answer).toMatch(/\.entity-token\s*\{[^}]*padding:\s*2px 8px[^}]*border-radius:\s*var\(--ast-radius-pill\)/s);
    expect(answer).toMatch(/\.entity-separator\s*\{[^}]*color:\s*var\(--ast-ink-tertiary\)/s);
  });
});
