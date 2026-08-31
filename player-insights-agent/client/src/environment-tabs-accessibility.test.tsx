import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EnvironmentInfo } from '../../shared/environment-info';
import { EnvironmentPanel } from './EnvironmentPanel';
import { environmentTabKeyTarget } from './environment-tab-state';

const SOURCE = readFileSync(new URL('./EnvironmentPanel.tsx', import.meta.url), 'utf8');
const STATE = readFileSync(new URL('./environment-tab-state.ts', import.meta.url), 'utf8');
const INFO: EnvironmentInfo = {
  runtime: { python: '3.11', node: '22' },
  variables: [{ key: 'SAFE', value: 'yes' }],
  packages: [{ name: 'react', version: '19.2.4' }],
};

describe('environment tabs', () => {
  it('maps fake keyboard input to the roving tab target', () => {
    expect(environmentTabKeyTarget('variables', 'ArrowRight')).toBe('packages');
    expect(environmentTabKeyTarget('variables', 'ArrowUp')).toBe('packages');
    expect(environmentTabKeyTarget('packages', 'Home')).toBe('variables');
    expect(environmentTabKeyTarget('variables', 'End')).toBe('packages');
    expect(environmentTabKeyTarget('variables', 'Enter')).toBeNull();
  });

  it('renders connected tabs and a labelled panel with one tab stop', () => {
    const html = renderToStaticMarkup(<EnvironmentPanel initialData={INFO} initialAgentModel={{}} />);
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*aria-controls="([^"]+)"[^>]*tabindex="0"/);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
    expect(html).toMatch(/role="tabpanel"[^>]*aria-labelledby="[^"]+-variables-tab"/);
  });

  it('moves focus with Arrow, Home, and End handlers', () => {
    expect(STATE).toContain("key === 'ArrowRight' || key === 'ArrowDown'");
    expect(STATE).toContain("key === 'ArrowLeft' || key === 'ArrowUp'");
    expect(STATE).toContain("key === 'Home'");
    expect(STATE).toContain("key === 'End'");
    expect(SOURCE).toContain('.current?.focus()');
    expect(SOURCE).toContain('event.preventDefault()');
  });
});
