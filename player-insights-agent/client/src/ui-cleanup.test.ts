import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const style = (name: string) => readFileSync(new URL(`./styles/${name}`, import.meta.url), 'utf8');

describe('app-wide dropdown recipe', () => {
  it('formats every owned dropdown as Label · Value through one component', () => {
    const appSelect = source('AppSelect.tsx');
    expect(appSelect).toContain('app-select-trigger');
    expect(appSelect).toContain('app-select-separator');
    expect(appSelect).toContain('·');

    for (const name of [
      'MonitoringPage.tsx',
      'RuntimeSettingsPanel.tsx',
      'UserRoleEditor.tsx',
      'DeclaredConnectionsCard.tsx',
    ]) {
      expect(source(name), name).toContain('<AppSelect');
    }
  });

  it('shares the white field, neutral border, focus, hover and menu states', () => {
    const css = style('base.css');
    expect(css).toMatch(/\.app-select-trigger \{[^}]*height: 32px/);
    expect(css).toMatch(/\.app-select-trigger \{[^}]*background: var\(--ast-white\)/);
    expect(css).toMatch(/\.app-select-trigger \{[^}]*border: 1px solid var\(--ast-border-input\)/);
    expect(css).toMatch(/\.app-select-trigger:hover \{/);
    expect(css).toMatch(/\.app-select-trigger:focus-visible \{/);
    expect(css).toMatch(/\.app-select-content \{/);
  });
});

describe('Connections and Settings cleanup', () => {
  it('places Notebook and Apply together and stacks the pair on narrow screens', () => {
    const page = source('ConnectionsPage.tsx');
    expect(page).toMatch(/configuration-plane-row[\s\S]*<NotebookCard[\s\S]*<ApplyDeclarationCard/);
    expect(style('connections.css')).toMatch(
      /\.configuration-plane-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/
    );
    expect(style('responsive.css')).toMatch(/\.configuration-plane-row \{[^}]*grid-template-columns: 1fr/);
    expect(style('connections.css')).toMatch(
      /\.notebook-path-editor > \[data-slot='button'\] \{[^}]*width: auto[^}]*justify-self: start/
    );
  });

  it('removes narrative-only Settings panes and role copy', () => {
    expect(source('SettingsPage.tsx')).not.toContain('Deployment and resources');
    expect(source('EgressPanel.tsx')).not.toContain('What the catalog says');
    expect(source('EgressPanel.tsx')).not.toContain('/api/egress/admin/classification');
    expect(source('UserRoleEditor.tsx')).not.toContain('Adding grants the role');
    expect(source('AdminListEditor.tsx')).not.toContain('Adding grants the role');
  });
});
