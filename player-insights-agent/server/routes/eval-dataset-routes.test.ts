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
    expect(isAdminRoute('/api/benchmarks/live-scores')).toBe(true);
    expect(isAdminRoute('/api/admin/benchmarks/live-monitoring')).toBe(true);
    expect(isAdminRoute('/api/admin/benchmarks/prompt-registry')).toBe(true);
    expect(isAdminRoute('/api/admin/benchmarks/review-app')).toBe(true);
    expect(isAdminRoute('/api/admin/benchmarks/score-thread')).toBe(true);
    expect(isAdminRoute('/api/admin/benchmarks/cancel')).toBe(true);
    expect(isAdminRoute('/api/admin/benchmarks/rollback')).toBe(true);
    expect(isAdminRoute('/api/admin/benchmarks/compare-history')).toBe(true);
    expect(isAdminRoute('/api/admin/benchmarks/known-failure')).toBe(true);
    const source = fs.readFileSync(path.join(__dirname, 'eval-dataset-routes.ts'), 'utf8');
    expect(source).toContain("app.get('/api/benchmarks/dataset'");
    expect(source).toContain("app.put('/api/admin/benchmarks/dataset'");
    expect(source).toContain('snapshotWorkingCopy');
    expect(source).toContain("app.post('/api/benchmarks/genie-accuracy'");
    expect(source).toContain("app.post('/api/admin/benchmarks/promote'");
    expect(source).toContain("app.post('/api/admin/benchmarks/last-suite'");
    expect(source).toContain("app.post('/api/admin/benchmarks/align-guidelines'");
    expect(source).toContain("app.post('/api/admin/benchmarks/dataset/curate'");
    expect(source).toContain("app.get('/api/benchmarks/live-scores'");
    expect(source).toContain("app.post('/api/admin/benchmarks/live-monitoring'");
    expect(source).toContain("app.put('/api/admin/benchmarks/prompt-registry'");
    expect(source).toContain("app.post('/api/admin/benchmarks/review-app'");
    expect(source).toContain("app.post('/api/admin/benchmarks/score-thread'");
    expect(source).toContain("app.post('/api/admin/benchmarks/cancel'");
    expect(source).toContain("app.post('/api/admin/benchmarks/rollback'");
    expect(source).toContain('requestBenchmarkCancel');
    expect(source).toContain('approver_required');
    expect(source).toContain('promoteTargetCaption');
    expect(source).not.toContain('writeGenieSpace');
    expect(source).not.toContain('/api/settings/connections');
    expect(source).toContain('startLabelingSession');
    expect(source).toContain('promotePromptAlias');
    expect(source).toContain('alignGuidelinesToHumans');
  });

  it('scores Genie accuracy by executed results and gates missing SQL', () => {
    const source = fs.readFileSync(path.join(__dirname, 'eval-dataset-routes.ts'), 'utf8');
    expect(source).toContain('suiteKind');
    expect(source).toContain('MissingSqlGateError');
    expect(source).toContain("error: 'missing_sql_gate'");
    expect(source).toContain('createSqlExecutor');
    expect(source).toContain('writeLastGenieRun');
    expect(source).toContain('lastGenieRun');
    expect(source).toContain('caseIds');
  });

  it('Ask uses the promoted endpoint without changing Connections', () => {
    const source = fs.readFileSync(path.join(__dirname, 'insights-routes.ts'), 'utf8');
    expect(source).toContain('resolveAskEndpoint');
    expect(source).toContain('The endpoint is the promoted winner when Benchmarking saved one');
    expect(source).toContain('resolveAskGuidance');
    expect(source).toContain('evalGuidance');
  });

  it('scores sampled Ask turns after the answer is stored, without awaiting them', () => {
    const source = fs.readFileSync(path.join(__dirname, 'insights-routes.ts'), 'utf8');
    expect(source).toContain('scheduleLiveAskScore');
    expect(source).toContain('loadConversationTurns');
    expect(source).toContain('never awaited');
    expect(source).toContain('void readBenchmarkSettings');
  });
});
