import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const style = (name: string) => readFileSync(new URL(`./styles/${name}`, import.meta.url), 'utf8');

describe('app-wide dropdown recipe', () => {
  const appSelectUsers = [
    'MonitoringPage.tsx',
    'RunExplorer.tsx',
    'RuntimeSettingsPanel.tsx',
    'RuntimeTimezoneField.tsx',
    'UserRoleEditor.tsx',
    'DeclaredConnectionsCard.tsx',
    'ConnectionsPage.tsx',
    'AiGatewayConnection.tsx',
    'SpIdentityPanel.tsx',
    'RunHeaderLabelEditor.tsx',
    'OpsScopeModal.tsx',
    'BenchmarkLabChrome.tsx',
    'GenieAccuracyDiagnostics.tsx',
    'EvaluationSet.tsx',
    'EvalFlywheel.tsx',
  ];

  it('inventories every dropdown trigger through a shared primitive or documented exception', () => {
    const componentFiles = readdirSync(new URL('.', import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx'))
      .map((entry) => entry.name);

    for (const name of appSelectUsers) expect(source(name), name).toContain('<AppSelect');
    expect(source('ConversationOwnerSelect.tsx')).toContain('<AppMultiSelect');
    expect(source('ConversationPersonaSelect.tsx')).toContain('<AppMultiSelect');

    for (const name of componentFiles) {
      const component = source(name);
      expect(component, `${name} has no native select`).not.toMatch(/^\s*<select\b/m);
      expect(component, `${name} has no local Select root`).not.toMatch(/^\s*<Select\b/m);
      if (component.includes('aria-haspopup="listbox"')) {
        expect(['AppSelect.tsx', 'AppMultiSelect.tsx'], `${name} owns no local listbox trigger`).toContain(name);
      }
    }

    // Documented exceptions: search results are a persistent listbox, while
    // asset hierarchy expansion and time ranges are disclosures/segments.
    expect(source('AiGatewayConnection.tsx')).toContain('aria-label="Eligible AI Gateway resources"');
    expect(source('DeclaredConnectionsCard.tsx')).toContain('<AssetPicker');
    expect(source('MonitoringPage.tsx')).toContain('<TimeRangeSegments page="User Monitoring"');
  });

  it('shows only the concise current value and keeps category in the accessible name', () => {
    const appSelect = source('AppSelect.tsx');
    expect(appSelect).toContain('app-select-trigger');
    expect(appSelect).toContain('<span className="app-select-value">{optionTextContent(selected)}</span>');
    expect(appSelect).toContain('aria-label={`${ariaLabel}: ${accessibleValue}`}');
    expect(appSelect).not.toContain('app-select-separator');
    expect(appSelect).not.toMatch(/Role\s*·|Persona\s*·|User\s*·/);
    expect(source('conversation-owner-selection.ts')).toContain('`${chosen.length} users`');
    expect(source('conversation-persona-selection.ts')).toContain('`${chosen.length} personas`');
  });

  it('shares neutral, hover, open, focus, selected, and high-contrast states', () => {
    const css = style('base.css');
    expect(css).toMatch(/\.app-select-trigger \{[^}]*height: 32px/);
    expect(css).toMatch(/\.app-select-trigger \{[^}]*font-size: var\(--ast-fs-12\)[^}]*line-height: 1\.25/s);
    expect(css).toMatch(/\.app-select-trigger \{[^}]*background: var\(--background\)/);
    expect(css).toMatch(/\.app-select-trigger \{[^}]*border: 1px solid var\(--ast-border-input\)/);
    expect(css).toMatch(/\.app-select-trigger:hover:not\(:disabled\)/);
    expect(css).toMatch(/\.app-select-trigger\[data-state='open'\]/);
    expect(css).toMatch(/\.app-select-trigger:focus-visible \{/);
    expect(css).toMatch(/\.app-menu-content \{[^}]*background: var\(--ast-surface-menu\)/);
    expect(css).toMatch(/\.app-menu-option\[data-state='checked'\]/);
    expect(css).toMatch(/\.app-menu-check/);
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('keeps every shared option on one readable ellipsized line with its full label available', () => {
    const appSelect = source('AppSelect.tsx');
    const multiSelectMenu = source('AppMultiSelectMenu.tsx');
    const css = style('base.css');
    expect(appSelect).toContain('title={optionTitle(option)}');
    expect(appSelect).toContain('aria-label={optionAccessibleValue(option)}');
    expect(multiSelectMenu).toContain('title={option.title ?? option.label}');
    expect(multiSelectMenu).toContain('aria-label={option.ariaLabel ?? option.label}');
    expect(css).toMatch(
      /\.app-menu-option \{[^}]*min-height: 34px[^}]*padding: 6px 9px[^}]*white-space: nowrap[^}]*overflow-wrap: normal[^}]*word-break: normal/s
    );
    expect(css).toMatch(
      /\.app-menu-option-label \{[^}]*overflow: hidden[^}]*text-overflow: ellipsis[^}]*white-space: nowrap[^}]*word-break: normal/s
    );
    expect(css).not.toMatch(/\.app-menu-option(?:-label)?\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  });

  it('puts Recent runs on the same opaque primitive', () => {
    const explorer = source('RunExplorer.tsx');
    expect(explorer.match(/<AppSelect/g)).toHaveLength(2);
    expect(explorer).toContain('contentClassName="run-filter-menu"');
    expect(explorer).toContain('placeholder="Search across runs"');
    expect(explorer).not.toContain('Search conversations, prompts, or people');
  });

  it('portals non-modal menus with bounded internal scrolling and no body lock', () => {
    const appSelect = source('AppSelect.tsx');
    const multiselect = source('AppMultiSelect.tsx');
    const multiselectMenu = source('AppMultiSelectMenu.tsx');
    expect(appSelect).toContain('<PopoverContent');
    expect(multiselectMenu).toContain('<PopoverContent');
    expect(appSelect).not.toContain('document.body.style');
    expect(multiselect).not.toContain('document.body.style');
    const css = style('base.css');
    expect(css).toMatch(/html \{[^}]*scrollbar-gutter:\s*stable/s);
    expect(css).toMatch(/\[data-radix-popper-content-wrapper\] \{[^}]*min-width: 0 !important/s);
    expect(css).toMatch(/\[data-radix-popper-content-wrapper\] \{[^}]*max-width: calc\(100vw - 24px\) !important/s);
    expect(css).toMatch(
      /\.app-select-content \{[^}]*width:\s*min\(max\(var\(--radix-popover-trigger-width\), 18rem\), 24rem, calc\(100vw - 24px\)\)[^}]*overflow-y: auto[^}]*scrollbar-gutter: stable/s
    );
    expect(style('runs.css')).not.toContain('body[data-scroll-locked]');
    expect(style('connections.css')).not.toContain('body[data-scroll-locked]');
  });

  it('keeps arrows, typeahead, Escape, click-away, checks, and focus return', () => {
    for (const component of [
      source('AppSelect.tsx'),
      `${source('AppMultiSelect.tsx')}\n${source('AppMultiSelectMenu.tsx')}`,
    ]) {
      expect(component).toContain("'ArrowDown', 'ArrowUp', 'Home', 'End'");
      expect(component).toContain('typeaheadRef');
      expect(component).toContain("event.key === 'Escape'");
      expect(component).toContain('onOpenChange=');
      expect(component).toContain('triggerRef.current?.focus()');
      expect(component).toContain('role="option"');
      expect(component).toContain('aria-selected=');
    }
  });

  it('keeps the Settings resource browser on the same one-line fit contract', () => {
    const component = source('SpIdentityPanel.tsx');
    const css = style('settings.css');
    expect(component).toContain('title={`${resource.label} — ${resource.id}`}');
    expect(component).toContain('aria-label={`${resource.label} — ${resource.id}`}');
    expect(component).toContain('aria-pressed={selected?.type === resource.type && selected.id === resource.id}');
    expect(css).toMatch(
      /\.sp-resource-menu \{[^}]*width:\s*min\(max\(100%, 22rem\), 26\.25rem, calc\(100vw - 64px\)\)[^}]*scrollbar-gutter:\s*stable/s
    );
    expect(css).toMatch(
      /\.sp-resource-option \{[^}]*min-height:\s*34px[^}]*font-size:\s*var\(--ast-fs-12\)[^}]*white-space:\s*nowrap[^}]*overflow-wrap:\s*normal[^}]*word-break:\s*normal/s
    );
  });
});

describe('Connections and Settings cleanup', () => {
  it('places Notebook and Apply together and stacks the pair on narrow screens', () => {
    const page = source('ConnectionsPage.tsx');
    const pane = source('NotebookAgentSyncPane.tsx');
    expect(page).toContain("import('./NotebookAgentSyncPane')");
    expect(pane).toMatch(/configuration-plane-row[\s\S]*<NotebookCard[\s\S]*<ApplyDeclarationCard/);
    expect(style('connections.css')).toMatch(
      /\.configuration-plane-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/
    );
    expect(style('responsive-connections.css')).toMatch(/\.configuration-plane-row \{[^}]*grid-template-columns: 1fr/);
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
