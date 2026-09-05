import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('.', import.meta.url);

function read(name: string): string {
  return readFileSync(new URL(name, ROOT), 'utf8');
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.(?:tsx|css)$/.test(name) || /\.test\./.test(name)) return [];
    return [path];
  });
}

function buttonBlocks(source: string): string[] {
  return [...source.matchAll(/<(Button|BenchButton|button)\b[\s\S]*?<\/\1>/g)].map((match) => match[0]);
}

describe('app-wide PIA loading context map', () => {
  it('maps the major surfaces to the intended variants', () => {
    expect(read('HomePage.tsx')).toContain('<PiaFlicker seat="splash" />');
    expect(read('HomePage.tsx')).toContain('<WorkingInlineRow');
    expect(read('MonitoringPage.tsx')).toContain(
      '<PiaLoader variant="compact" label="Loading user activity" className="user-profile-modal-profile-loading" />'
    );
    expect(read('MonitoringPage.tsx')).toContain(
      '<PiaLoader variant="compact" label="Loading users" className="monitoring-users-loading" />'
    );
    expect(read('RunExplorer.tsx')).toContain('<PiaLoader variant="compact" label="Loading run details"');
    expect(read('ConnectionsPage.tsx')).toContain('<PiaLoadingLabel seat="compact" label="Loading connections"');
    for (const settingsHost of [
      'RuntimeSettingsPanel.tsx',
      'EnvironmentPanel.tsx',
      'EgressPanel.tsx',
      'SpIdentityPanel.tsx',
    ]) {
      expect(read(settingsHost), settingsHost).toContain('PiaLoader');
    }
  });

  it('uses face-only compact marks for local pane and card loading', () => {
    const localHosts = [
      ['OpsPage.tsx', '<PiaLoader variant="compact" label="Loading spend and budgets"'],
      ['OpsPage.tsx', '<PiaLoader variant="compact" label="Loading resource costs"'],
      ['HomePage.tsx', '<PiaLoaderMark variant="compact" />'],
      ['MonitoringPage.tsx', '<PiaFlicker seat="compact" />'],
      ['MonitoringPage.tsx', '<PiaLoader variant="compact" label="Loading user activity"'],
      ['MonitoringPage.tsx', '<PiaLoader variant="compact" label="Loading users"'],
      ['ConnectionsPage.tsx', '<PiaLoadingLabel seat="compact" label="Loading connections"'],
      ['SpIdentityPanel.tsx', '<PiaLoader variant="compact" label="Reading SP persona configurations"'],
      ['RunExplorer.tsx', '<PiaLoader variant="compact" label="Loading run details"'],
    ] as const;
    for (const [host, loader] of localHosts) {
      expect(read(host), host).toContain(loader);
    }

    const loader = read('PiaLoader.tsx');
    expect(loader).toContain("const compactFace = variant === 'compact' || variant === 'inline'");
    expect(loader).toContain('<CompactFaceMark />');
    expect(loader).toContain('<SwapMark detailed />');
  });

  it('reserves full panel choreography for initialization contexts', () => {
    const panelHosts = sourceFiles(new URL('.', ROOT).pathname)
      .filter((path) => path.endsWith('.tsx'))
      .filter((path) => readFileSync(path, 'utf8').includes('variant="panel"'))
      .map((path) => path.slice(path.lastIndexOf('/') + 1))
      .sort();
    expect(panelHosts).toEqual(['AppSessionRecovery.tsx', 'Layout.tsx', 'StartupBoundary.tsx']);
  });

  it('uses a static engraved status mark for completed answers', () => {
    expect(read('AnswerCard.tsx')).toContain('<PiaAvatar size={28} tone="light" />');
    expect(read('FinalAnswer.tsx')).toContain('<PiaAvatar size={28} tone="light" className="final-answer-mark" />');
    expect(read('AnswerCard.tsx')).not.toMatch(/answer-card-mark[\s\S]{0,120}PiaLoader/);
    expect(read('FinalAnswer.tsx')).not.toContain('PiaFlicker');
  });

  it('uses the canonical static avatar in representative PIA identity hosts', () => {
    expect(read('HomePage.tsx')).toContain('<PiaAvatar size={24} />');
    expect(read('HomePage.tsx')).toContain('<PiaAvatar size={32} />');
    expect(read('PlanCard.tsx')).toContain('<PiaAvatar size={32} />');
    expect(read('AIAnalysisCaveat.tsx')).toContain('<PiaAvatar size={14} />');
    expect(read('Layout.tsx')).toContain('<PiaLockup as="h1" seat="header" name="full" tone="dark" />');
    const runtime = sourceFiles(new URL('.', ROOT).pathname)
      .filter((path) => path.endsWith('.tsx') && !path.endsWith('/PiaMark.tsx'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    expect(runtime).not.toContain('<PiaMark');
    expect(read('PiaLoader.tsx')).toContain('pia-loader-mark');
  });

  it('leaves no native spinner or retired ad hoc loader remnants', () => {
    const sources = sourceFiles(new URL('.', ROOT).pathname)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    for (const remnant of [
      'LoaderCircle',
      'refresh-spin',
      'asset-picker-spinner',
      'monitoring-users-loading-icon',
      '@keyframes ast-spin',
      '@keyframes ast-dot-run',
    ]) {
      expect(sources, remnant).not.toContain(remnant);
    }
  });

  it('keeps canonical loader CSS eager once while route placement stays lazy', () => {
    const index = read('index.css');
    expect(index.match(/@import '\.\/styles\/pia-loader\.css';/g)).toHaveLength(1);
    const routeSheets = sourceFiles(new URL('./styles/routes/', ROOT).pathname)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    expect(routeSheets).not.toContain('pia-loader.css');
    expect(routeSheets).not.toContain('@keyframes pia-');
  });

  it('uses fixed-size in-button loaders with disabled busy semantics', () => {
    for (const host of [
      'AccessGate.tsx',
      'AdminListEditor.tsx',
      'AnswerCard.tsx',
      'AssetPicker.tsx',
      'BenchmarkLabChrome.tsx',
      'BenchmarkLabOps.tsx',
      'NotebookCard.tsx',
      'ComposerBudgetStatus.tsx',
      'ConnectionsPage.tsx',
      'CostBudgets.tsx',
      'DeclaredConnectionsCard.tsx',
      'EvalFlywheel.tsx',
      'EvaluationSet.tsx',
      'FirstOpenGate.tsx',
      'GenieAccuracyDiagnostics.tsx',
      'HomePage.tsx',
      'LakebaseBindingManager.tsx',
      'LakebaseMigrationPanel.tsx',
      'OpsPage.tsx',
      'OpsScopeModal.tsx',
      'RefreshControl.tsx',
      'ResourceTagsPanel.tsx',
      'SettingsPage.tsx',
      'UnityCatalogScopeExplorer.tsx',
      'UserRoleEditor.tsx',
    ]) {
      expect(read(host), host).toContain('PiaBusyButtonContent');
      expect(read(host), host).toMatch(/disabled=\{[^}]+\}/);
    }
  });

  it('rejects noncanonical indicators and incomplete semantics inside busy buttons', () => {
    const entries = sourceFiles(new URL('.', ROOT).pathname).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return buttonBlocks(source).map((button) => ({ path, button }));
    });
    const busyButtons = entries.filter(({ button }) => button.slice(0, button.indexOf('>')).includes('aria-busy='));

    expect(busyButtons.length).toBeGreaterThan(20);
    for (const { path, button } of busyButtons) {
      expect(button, path).toContain('PiaBusyButtonContent');
      expect(button, path).toContain('disabled=');
      expect(button, path).not.toMatch(
        /PiaFlicker\s+seat="button"|PiaLoadingLabel[\s\S]*?seat="button"|PiaLoaderMark\s+variant="button"/
      );
      expect(button, path).not.toMatch(/\?\s*['"`][^'"`]*(?:…|\.\.\.)['"`]\s*:/);
    }
  });
});
