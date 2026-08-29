import { readFileSync, readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Copy Sam asked to take off Connections, and that must not come back on
 * another client page as a paraphrase.
 *
 * The dirty-worktree notice was a server finding the page printed as an alert.
 * The table-list line was interpolated under the summary. Both were unhelpful
 * on a screen people use to see whether anything is actually connected.
 *
 * Tests are excluded: this file has to quote the retired sentences in order to
 * forbid them, and a string in an assertion is not something the app can draw.
 */

const HERE = new URL('.', import.meta.url);

const RETIRED = [
  'Something here was built from a modified working tree',
  'Release from a clean worktree.',
  'table list from',
  'modified working tree',
  'uncommitted tracked changes at build time',
  'Recorded, not applied',
];

function sources(): Map<string, string> {
  const root = fileURLToPath(HERE);
  const found = new Map<string, string>();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(tsx?|css)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    const path = `${entry.parentPath}/${entry.name}`;
    found.set(relative(root, path), readFileSync(path, 'utf8'));
  }
  return found;
}

describe('retired Connections copy stays off the client', () => {
  it('does not ship the dirty-worktree notice or the table-list line', () => {
    const hits: string[] = [];
    for (const [file, source] of sources()) {
      for (const phrase of RETIRED) {
        if (source.includes(phrase)) hits.push(`${file}: ${phrase}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
