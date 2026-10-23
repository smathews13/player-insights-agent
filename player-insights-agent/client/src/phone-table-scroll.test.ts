import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * These tables have no phone layout of their own: their rows do not stack and
 * their headers do not wrap. AppKit's `Table` puts them in a container that
 * scrolls sideways, which is what keeps them from widening the page on a phone.
 * A bare `<table>` with the same class has no such container.
 */
const SCROLLED_TABLES: Record<string, string> = {
  'MonitoringPage.tsx': 'monitoring-table',
  'BenchmarkLab.tsx': 'bench-sheet',
  'BenchmarkLabChrome.tsx': 'bench-sheet',
  'EvaluationSet.tsx': 'bench-sheet',
  'GenieAccuracyDiagnostics.tsx': 'bench-sheet',
};

describe('tables without a phone layout scroll sideways', () => {
  for (const [file, className] of Object.entries(SCROLLED_TABLES)) {
    it(`${file} renders .${className} through AppKit's Table`, () => {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source).toContain(`<Table className="${className}">`);
      expect(source).not.toContain(`<table className="${className}">`);
    });
  }
});
