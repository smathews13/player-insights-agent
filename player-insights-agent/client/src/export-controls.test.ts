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
    expect(source.match(/label: 'Download PNG'/g)).toHaveLength(1);
  });

  it('uses accessible menus and live success/error feedback', () => {
    expect(source).toContain('aria-haspopup="menu"');
    expect(source).toContain('role="menuitem"');
    expect(source).toContain("outcome.tone === 'error' ? 'alert' : 'status'");
  });

  it('puts answer export beside feedback and whole-conversation export after the transcript', () => {
    expect(answerCard.indexOf('<AnswerExportMenu')).toBeGreaterThan(answerCard.indexOf('className="feedback"'));
    expect(home).toContain('<ConversationExportMenu');
    expect(home.indexOf('<ConversationExportMenu')).toBeGreaterThan(home.indexOf('messages.map'));
    expect(home).toContain('className="conversation-export-footer"');
    expect(home).not.toContain('className="conversation-export"');
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
