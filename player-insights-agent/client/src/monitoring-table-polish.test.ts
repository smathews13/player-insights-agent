import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const BASE_CSS = read('./styles/base.css');
const MONITORING_CSS = read('./styles/monitoring.css');
const RESPONSIVE_CSS = read('./styles/responsive-monitoring.css');
const MONITORING_SOURCE = read('./MonitoringPage.tsx');
const METRICS_SOURCE = read('../../server/lib/user-spend-metrics.ts');

describe('Monitoring tool columns', () => {
  it('keeps the shared tool icon and its label or count in one unbroken inline group', () => {
    expect(BASE_CSS).toMatch(
      /\.tool-calls-label\s*\{[^}]*display:\s*inline-flex[^}]*min-width:\s*max-content[^}]*white-space:\s*nowrap[^}]*overflow-wrap:\s*normal/s
    );
    expect(MONITORING_CSS).toMatch(/\.monitoring-col-tools\s*\{[^}]*min-width:\s*72px/s);
    expect(MONITORING_CSS).toMatch(
      /\.user-profile-modal-tools-column,[\s\S]*?white-space:\s*nowrap[\s\S]*?overflow-wrap:\s*normal/s
    );
    expect(MONITORING_SOURCE).toContain('className="monitoring-numeric monitoring-tool-cell"');
    expect(MONITORING_SOURCE).toContain('className="user-profile-modal-tools-column"');
  });

  it('keeps compact Tools and Feedback labels intact while other content owns truncation', () => {
    expect(RESPONSIVE_CSS).toMatch(
      /td\.user-profile-modal-tools-column,[\s\S]*?white-space:\s*nowrap[\s\S]*?overflow-wrap:\s*normal/s
    );
    expect(MONITORING_CSS).toMatch(/\.monitoring-question-text\s*\{[^}]*overflow:\s*hidden/s);
    expect(MONITORING_CSS).toMatch(
      /\.monitoring-organization-option-content > span:last-child\s*\{[^}]*text-overflow:\s*ellipsis/s
    );
  });
});

describe('attributable spend copy', () => {
  it('shows Share of app spend without the redundant attributable subtitle', () => {
    expect(METRICS_SOURCE).toContain("subtitle: ''");
    expect(MONITORING_SOURCE).toContain("appShare.state === 'value' ? { ...appShare, subtitle: '' } : appShare");
    expect(`${METRICS_SOURCE}\n${MONITORING_SOURCE}`).not.toContain('of attributable');
  });
});
