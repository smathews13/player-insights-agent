import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { downloadExportBlob } from './export-files';

describe('export controls contract', () => {
  const source = readFileSync(new URL('./ExportMenu.tsx', import.meta.url), 'utf8');
  const actionSource = readFileSync(new URL('./export-actions.ts', import.meta.url), 'utf8');
  const answerCard = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');
  const home = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');

  it('offers exactly the required answer, conversation and table actions', () => {
    expect(source.match(/label: 'Copy Markdown'/g)).toHaveLength(2);
    expect(source.match(/label: 'Download Markdown'/g)).toHaveLength(2);
    expect(source.match(/label: 'Download PDF'/g)).toHaveLength(3);
    expect(source.match(/label: 'Copy TSV'/g)).toHaveLength(1);
    // Two PNG downloads: the table image and the standalone chart image.
    expect(source.match(/label: 'Download PNG'/g)).toHaveLength(2);
    // Answer gains self-contained HTML (page and slide) exports.
    expect(source.match(/label: 'Download HTML'/g)).toHaveLength(1);
    expect(source.match(/label: 'Download HTML for slides'/g)).toHaveLength(1);
    // Canonical JSON for the whole answer and for a single chart.
    expect(source.match(/label: 'Download JSON'/g)).toHaveLength(2);
  });

  it('uses accessible menus and live success/error feedback', () => {
    expect(source).toContain('aria-haspopup="menu"');
    expect(source).toContain('role="menuitem"');
    expect(source).toContain("outcome.tone === 'error' ? 'alert' : 'status'");
  });

  it('keeps the answer-card export as the only transcript export surface', () => {
    expect(answerCard.indexOf('<AnswerExportMenu')).toBeGreaterThan(answerCard.indexOf('className="feedback"'));
    expect(home).not.toContain('<ConversationExportMenu');
    expect(home).not.toContain('conversation-export-footer');
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
