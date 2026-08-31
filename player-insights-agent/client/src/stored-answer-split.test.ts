import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOME = readFileSync(join(ROOT, 'HomePage.tsx'), 'utf8');
const BOUNDARY = readFileSync(join(ROOT, 'StoredAnswerBoundary.tsx'), 'utf8');
const LOADER = readFileSync(join(ROOT, 'stored-answer-loader.ts'), 'utf8');
const ASK_CSS = readFileSync(join(ROOT, 'styles/ask.css'), 'utf8');
const RESPONSIVE = readFileSync(join(ROOT, 'styles/responsive.css'), 'utf8');

function staticClientGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(path, 'utf8');
    const imports = source.matchAll(/^\s*import(?!\s+type\b)[\s\S]*?\sfrom\s+['"](\.[^'"]+)['"];?/gm);
    for (const match of imports) {
      const target = match[1];
      for (const extension of ['.ts', '.tsx']) {
        const resolved = join(dirname(path), `${target}${extension}`);
        if (existsSync(resolved)) {
          visit(resolved);
          break;
        }
      }
    }
  };
  visit(entry);
  return seen;
}

describe('Home stored-answer split', () => {
  it('does not reach answer Markdown, evidence or trace renderers through an eager import', () => {
    const graph = [...staticClientGraph(join(ROOT, 'HomePage.tsx'))];
    for (const heavy of [
      'AnswerCard.tsx',
      'DataEntityLinks.tsx',
      'answer-markdown.ts',
      'AnswerEvidence.tsx',
      'TraceTimeline.tsx',
    ]) {
      expect(
        graph.some((path) => path.endsWith(heavy)),
        `${heavy} is eager from Home`
      ).toBe(false);
    }
    expect(HOME).not.toMatch(/from ['"]\.\/AnswerCard['"]/);
    expect(LOADER).toContain("import('./StoredAnswerRenderer')");
  });

  it('preloads on conversation hover, focus, selection and before an active answer', () => {
    expect(HOME).toContain('onMouseEnter={() => startStoredAnswerRendererPreload()}');
    expect(HOME).toContain('onFocus={() => startStoredAnswerRendererPreload()}');
    expect(HOME).toMatch(/const selectConversation[\s\S]*startStoredAnswerRendererPreload/);
    const ask = HOME.slice(HOME.indexOf('async function ask'), HOME.indexOf('function startNewConversation'));
    expect(ask.indexOf('startStoredAnswerRendererPreload()')).toBeGreaterThan(-1);
    expect(ask.indexOf('startStoredAnswerRendererPreload()')).toBeLessThan(ask.indexOf('await askStreaming'));
    expect(ask).not.toMatch(/await\s+startStoredAnswerRendererPreload/);
    expect(HOME).toMatch(/if \(loading\) startStoredAnswerRendererPreload\(\)/);
  });

  it('keeps geometry, raw content, and a retry instead of a blank answer', () => {
    expect(BOUNDARY).toContain('Formatting saved answer…');
    expect(BOUNDARY).toContain('{rawContent}');
    expect(BOUNDARY).toContain('role="alert"');
    expect(BOUNDARY).toContain('Retry answer');
    expect(BOUNDARY).toContain('lazyStoredAnswerRenderer()');
    expect(ASK_CSS).toMatch(/\.conversation-main \.stored-answer-loading\s*\{[^}]*min-height:/);
  });

  it('cancels stale conversation pages and exposes older history accessibly on mobile', () => {
    expect(HOME).toContain('conversationLoadControllerRef.current?.abort()');
    expect(HOME).toContain('olderMessagesControllerRef.current?.abort()');
    expect(HOME).toContain('data-message-pagination="older"');
    expect(HOME).toContain('aria-live="polite"');
    expect(HOME).toContain('Loading older messages');
    expect(RESPONSIVE).toMatch(
      /@media \(max-width: 480px\)[\s\S]*\.message-pagination > button\s*\{[^}]*width:\s*100%/
    );
  });
});
