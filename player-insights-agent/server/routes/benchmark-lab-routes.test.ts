import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAdminRoute } from '../lib/admin-roles';

describe('benchmark lab v3 routes', () => {
  it('admin-gates the lab workspace and apply path', () => {
    expect(isAdminRoute('/api/benchmarks/lab')).toBe(true);
    expect(isAdminRoute('/api/admin/benchmarks/lab/apply-candidate')).toBe(true);
    expect(isAdminRoute('/api/admin/benchmarks/lab/version')).toBe(true);
    expect(isAdminRoute('/api/admin/benchmarks/lab/align-preview')).toBe(true);
    const source = fs.readFileSync(path.join(__dirname, 'benchmark-lab-routes.ts'), 'utf8');
    expect(source).toContain("app.get('/api/benchmarks/lab'");
    expect(source).toContain('lastGenieRun');
    expect(source).toContain('readEvalDatasetEnvelope');
    expect(source).toContain("app.post('/api/admin/benchmarks/lab/version'");
    expect(source).toContain("app.post('/api/admin/benchmarks/lab/apply-candidate'");
    expect(source).toContain("app.post('/api/admin/benchmarks/lab/align-preview'");
    expect(source).toContain("app.post('/api/admin/benchmarks/lab/align-commit'");
    expect(source).toContain("app.post('/api/admin/benchmarks/lab/cancel-run'");
    expect(source).toContain('promotePromptAlias');
    expect(source).toContain('wroteGenieInstructions: false');
    expect(source).toContain('connectionsChanged: false');
    expect(source).toContain('CANCEL_RUN_NOTE');
    expect(source).not.toContain('https://example.com/review');
    expect(source).toContain('Preview only. Nothing is saved until review.');
  });

  it('does not write Genie space instructions or Connections on apply', () => {
    const source = fs.readFileSync(path.join(__dirname, 'benchmark-lab-routes.ts'), 'utf8');
    const shared = fs.readFileSync(path.join(__dirname, '../../shared/benchmark-lab-v3.ts'), 'utf8');
    expect(shared).toContain('This app does not write space instructions');
    const apply = source.slice(source.indexOf('apply-candidate'));
    expect(apply).toContain('wroteGenieInstructions: false');
    expect(apply).toContain('connectionsChanged: false');
    expect(apply).not.toContain('/api/settings/connections');
  });

  it('is registered next to the existing evaluation routes', () => {
    const server = fs.readFileSync(path.join(__dirname, '../server.ts'), 'utf8');
    expect(server).toContain('setupBenchmarkLabRoutes');
    expect(server).toContain("import('./routes/benchmark-lab-routes')");
  });
});
