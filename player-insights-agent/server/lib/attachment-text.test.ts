import { describe, expect, it } from 'vitest';

import { fitAttachmentText } from './attachment-text';

const file = (filename: string, size: number) => ({ filename, extracted_text: 'x'.repeat(size) });

describe('fitAttachmentText', () => {
  it('is byte for byte what it always was when everything fits', () => {
    const rows = [file('a.md', 10), file('b.txt', 20)];
    const expected = `## a.md\n${'x'.repeat(10)}\n\n## b.txt\n${'x'.repeat(20)}`;
    expect(fitAttachmentText(rows, 80_000)).toMatchObject({ text: expected, cut: [] });
  });

  it('keeps the newest files whole and shortens the oldest, in upload order', () => {
    const rows = [file('brief.md', 45_000), file('notes.txt', 30_000), file('latest-results.csv', 20_000)];
    const { text, cut } = fitAttachmentText(rows, 80_000);
    expect(text.startsWith('## brief.md')).toBe(true);
    expect(text).toContain(`## notes.txt\n${'x'.repeat(30_000)}`);
    expect(text).toContain(`## latest-results.csv\n${'x'.repeat(20_000)}`);
    expect(text.length).toBeLessThanOrEqual(80_000);
    expect(text.indexOf('## notes.txt')).toBeLessThan(text.indexOf('## latest-results.csv'));
    expect(cut).toEqual(['brief.md']);
  });

  it('names every file it lost whole', () => {
    const rows = [file('one.md', 50_000), file('two.md', 50_000), file('three.md', 50_000)];
    const { text, cut } = fitAttachmentText(rows, 80_000);
    expect(text).toContain('## three.md');
    expect(text.length).toBeLessThanOrEqual(80_000);
    expect(cut).toContain('one.md');
    expect(cut).toContain('two.md');
  });

  it('shortens a single file over the limit', () => {
    const { text, cut } = fitAttachmentText([file('big.txt', 100_000)], 80_000);
    expect(text).toHaveLength(80_000);
    expect(cut).toEqual(['big.txt']);
  });

  it('is empty for no files', () => {
    expect(fitAttachmentText([], 80_000)).toEqual({ text: '', cut: [], files: [] });
  });

  it('says what reached the agent of each file, in upload order', () => {
    const rows = [
      file('older-notes.txt', 31_000),
      { ...file('brief.md', 50_000), truncated: true },
      file('notes.txt', 20_000),
    ];
    const { cut, files } = fitAttachmentText(rows, 80_000);
    expect(cut).toEqual(['older-notes.txt']);
    expect(files[0]).toMatchObject({ filename: 'older-notes.txt', truncated: false, original_chars: 31_000 });
    expect(files.slice(1)).toEqual([
      { filename: 'brief.md', truncated: true, original_chars: null, kept_chars: 50_000 },
      { filename: 'notes.txt', truncated: false, original_chars: 20_000, kept_chars: 20_000 },
    ]);
    expect(files[0].kept_chars).toBeLessThan(31_000);
  });

  it('counts a file left out whole as nothing kept', () => {
    const rows = [file('one.md', 50_000), file('two.md', 50_000), file('three.md', 50_000)];
    const { files } = fitAttachmentText(rows, 80_000);
    expect(files[0].kept_chars).toBe(0);
    expect(files[2].kept_chars).toBe(50_000);
  });
});
