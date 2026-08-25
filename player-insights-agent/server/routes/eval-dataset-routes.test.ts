import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAdminRoute } from '../lib/admin-roles';

describe('evaluation dataset route permissions', () => {
  it('admin-gates the write and keeps the Genie run on the benchmark prefix', () => {
    expect(isAdminRoute('/api/benchmarks/dataset')).toBe(true);
    expect(isAdminRoute('/api/admin/benchmarks/dataset')).toBe(true);
    expect(isAdminRoute('/api/benchmarks/genie-accuracy')).toBe(true);
    expect(isAdminRoute('/api/benchmarks/flywheel')).toBe(true);
    expect(isAdminRoute('/api/admin/benchmarks/promote')).toBe(true);
    expect(isAdminRoute('/api/admin/benchmarks/align-guidelines')).toBe(true);
    expect(isAdminRoute('/api/admin/benchmarks/dataset/curate')).toBe(true);
    const source = fs.readFileSync(path.join(__dirname, 'eval-dataset-routes.ts'), 'utf8');
    expect(source).toContain("app.get('/api/benchmarks/dataset'");
    expect(source).toContain("app.put('/api/admin/benchmarks/dataset'");
    expect(source).toContain("app.post('/api/benchmarks/genie-accuracy'");
    expect(source).toContain("app.post('/api/admin/benchmarks/promote'");
    expect(source).toContain("app.post('/api/admin/benchmarks/last-suite'");
    expect(source).toContain("app.post('/api/admin/benchmarks/align-guidelines'");
    expect(source).toContain("app.post('/api/admin/benchmarks/dataset/curate'");
  });

  it('Ask uses the promoted endpoint without changing Connections', () => {
    const source = fs.readFileSync(path.join(__dirname, 'insights-routes.ts'), 'utf8');
    expect(source).toContain('resolveAskEndpoint');
    expect(source).toContain('The endpoint is the promoted winner when Benchmarking saved one');
  });
});
