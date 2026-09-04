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

describe('app-wide PIA loading context map', () => {
  it('maps the major surfaces to the intended variants', () => {
    expect(read('HomePage.tsx')).toContain('<PiaFlicker seat="splash" />');
    expect(read('HomePage.tsx')).toContain('<WorkingInlineRow');
    expect(read('MonitoringPage.tsx')).toContain(
      '<PiaLoader variant="panel" label="Loading user activity" className="user-profile-modal-profile-loading" />'
    );
    expect(read('MonitoringPage.tsx')).toContain(
      '<PiaLoader variant="panel" label="Loading users" className="monitoring-users-loading" />'
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

  it('uses a static engraved status mark for completed answers', () => {
    expect(read('AnswerCard.tsx')).toContain('<PiaMark size={28} tone="light" />');
    expect(read('FinalAnswer.tsx')).toContain('<PiaMark size={28} tone="light" className="final-answer-mark" />');
    expect(read('AnswerCard.tsx')).not.toMatch(/answer-card-mark[\s\S]{0,120}PiaLoader/);
    expect(read('FinalAnswer.tsx')).not.toContain('PiaFlicker');
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
      'AnswerCard.tsx',
      'BenchmarkLabOps.tsx',
      'NotebookCard.tsx',
      'ComposerBudgetStatus.tsx',
      'CostBudgets.tsx',
      'OpsPage.tsx',
    ]) {
      expect(read(host), host).toContain('PiaBusyButtonContent');
      expect(read(host), host).toMatch(/disabled=\{[^}]+\}/);
    }
    expect(read('UnityCatalogScopeExplorer.tsx')).toContain('seat="button"');
    expect(read('LakebaseMigrationPanel.tsx')).toContain('seat="button"');
  });
});
