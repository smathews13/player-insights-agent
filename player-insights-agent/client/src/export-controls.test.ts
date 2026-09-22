import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { downloadExportBlob } from './export-files';

describe('export controls contract', () => {
  const source = readFileSync(new URL('./ExportMenu.tsx', import.meta.url), 'utf8');
  const actionSource = readFileSync(new URL('./export-actions.ts', import.meta.url), 'utf8');
  const answerCard = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');
  const reportCard = readFileSync(new URL('./ReportCard.tsx', import.meta.url), 'utf8');
  const dashboardCard = readFileSync(new URL('./DashboardCard.tsx', import.meta.url), 'utf8');
  const home = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
  const answerCss = readFileSync(new URL('./styles/answer.css', import.meta.url), 'utf8');
  const answerBodyCss = readFileSync(new URL('./styles/answer-body.css', import.meta.url), 'utf8');

  it('offers the supported export formats on answers, reports, and conversations', () => {
    // Copy/Download Markdown: answer, report, and conversation.
    expect(source.match(/label: 'Copy Markdown'/g)).toHaveLength(3);
    expect(source.match(/label: 'Download Markdown'/g)).toHaveLength(3);
    // Download PDF: answer and conversation. Tables have one direct CSV export.
    expect(source.match(/label: 'Download PDF'/g)).toHaveLength(2);
    expect(source).not.toContain("label: 'Copy TSV'");
    // The only PNG download is the standalone chart image.
    expect(source.match(/label: 'Download PNG'/g)).toHaveLength(1);
    // Self-contained HTML (page and slide) for answers, reports, and conversations.
    expect(source.match(/label: 'Download HTML'/g)).toHaveLength(3);
    expect(source.match(/label: 'Download HTML for slides'/g)).toHaveLength(3);
    // Canonical JSON for an answer, report, conversation, and single chart.
    expect(source.match(/label: 'Download JSON'/g)).toHaveLength(4);
  });

  it('uses accessible menus and live success/error feedback', () => {
    expect(source).toContain('aria-haspopup="menu"');
    expect(source).toContain('role="menuitem"');
    expect(source).toContain("outcome.tone === 'error' ? 'alert' : 'status'");
  });

  it('gives every standard export option a uniformly aligned icon', () => {
    expect(source.match(/\{\s*label: '[^']+',\s*icon: \w+,\s*run:/g)).toHaveLength(19);
    expect(source).toContain('icon={<ActionIcon aria-hidden="true" />}');
    expect(answerCss).toMatch(/\.export-menu-content \[role='menuitem'\]\s*\{[^}]*display:\s*flex[^}]*width:\s*100%/s);
    expect(answerCss).toMatch(
      /\.export-menu-content \[role='menuitem'\] \.pia-button-state__idle,[\s\S]*?justify-content:\s*flex-start/
    );
    expect(answerCss).toMatch(
      /\.export-menu-content \[role='menuitem'\] svg\s*\{[^}]*width:\s*16px[^}]*height:\s*16px[^}]*flex:\s*none/s
    );
  });

  it('offers icon-labelled radio choices for either 31-day cost export', () => {
    const pdf = source.indexOf('Cost report PDF (last 31 days)');
    const projection = source.indexOf('Dev + Prod projection (last 31 days)');
    expect(pdf).toBeGreaterThan(-1);
    expect(projection).toBeGreaterThan(pdf);
    expect(source).toContain('role="radiogroup"');
    expect(source.match(/type="radio"/g)).toHaveLength(2);
    expect(source).toContain('<FileText aria-hidden="true" />');
    expect(source).toContain('<TrendingUp aria-hidden="true" />');
    expect(source).toContain('label="Export selected"');
    expect(actionSource).toContain('downloadDevProdCostProjectionPdf');
    expect(actionSource).toContain("costBriefPdf(brief, 'dev-prod-projection')");
  });

  it('keeps export controls at the bottom of answer and report cards', () => {
    expect(answerCard.indexOf('<AnswerExportMenu')).toBeGreaterThan(answerCard.indexOf('className="feedback"'));
    expect(reportCard).toContain('<ReportExportMenu report={report} />');
    expect(home).not.toContain('<ConversationExportMenu');
    expect(home).not.toContain('conversation-export-toolbar');
  });

  it('right-aligns answer export without a trailing dots icon', () => {
    const answerMenu = source.slice(
      source.indexOf('export function AnswerExportMenu'),
      source.indexOf('export function ReportExportMenu')
    );
    expect(answerMenu).toContain('triggerLabel="Export answer"');
    expect(answerMenu).toContain('showMoreIcon={false}');
    expect(answerBodyCss).toMatch(/\.feedback > \.export-menu\s*\{[^}]*margin-left:\s*auto/s);
  });

  it('keeps dashboard download structural and outside the answer export dropdown', () => {
    const dashboardButton = source.slice(
      source.indexOf('export function DashboardExportButton'),
      source.indexOf('export function ReportExportMenu')
    );
    expect(dashboardButton).toContain('label="Download HTML Dashboard"');
    expect(dashboardCard).toContain('<DashboardExportButton dashboard={dashboard} />');
    expect(answerCard).not.toContain('DashboardExportButton');
    expect(actionSource).toContain('downloadDashboardHtml');
    expect(actionSource).toContain('dashboard.html');
  });

  it('exports each table directly as CSV without opening an options menu', () => {
    const tableMenu = source.slice(
      source.indexOf('export function TableExportMenu'),
      source.indexOf('export function ChartExportMenu')
    );
    expect(tableMenu).toContain('label="Export CSV"');
    expect(tableMenu).toContain('downloadTableCsv(table, name)');
    expect(tableMenu).not.toContain('<ActionsMenu');
    expect(tableMenu).not.toContain('<MoreHorizontal');
    expect(actionSource).toContain('serializeTableCsv(table)');
    expect(actionSource).toContain("safeExportFilename(name, 'csv')");
  });

  it('keeps serializers, file operations, and binary generation behind lazy boundaries', () => {
    expect(source).toContain("import('./export-actions')");
    expect(source).not.toMatch(/^import (?!type).*export-serializers/m);
    expect(source).not.toMatch(/^import .*export-files/m);
    expect(source).not.toMatch(/^import .*export-binary/m);
    expect(actionSource).toContain("await import('./export-binary')");
    expect(actionSource).not.toMatch(/^import .*export-binary/m);
  });
});

describe('download lifecycle', () => {
  it('clicks a temporary link and revokes the Blob URL', () => {
    vi.useFakeTimers();
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    const anchor = { href: '', download: '', hidden: false, click, remove };
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { append },
    });
    const createObjectURL = vi.fn(() => 'blob:export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    downloadExportBlob(new Blob(['export']), 'safe.md');
    vi.runAllTimers();

    expect(anchor.download).toBe('safe.md');
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:export');
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
