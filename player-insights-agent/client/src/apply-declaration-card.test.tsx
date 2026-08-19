import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { modelReleaseNotebookSnippet, releaseVersionLine } from './ApplyDeclarationCard';
import type { ModelReleaseRequest } from '../../shared/model-release';

const release: ModelReleaseRequest = {
  id: 'request-123',
  status: 'succeeded',
  requestedBy: 'admin@example.com',
  requestedAt: '2026-08-18T00:00:00Z',
  declaration: {
    source: 'connections-apply',
    revision: 'sha256:abc',
    settings: { warehouse_id: 'wh-1' },
  },
  declarationRevision: 'sha256:abc',
  target: 'customer',
  endpointName: 'endpoint',
  modelName: 'catalog.schema.model',
  vFrom: '7',
  vTo: '8',
  preflightAtRequest: null,
  preflightResult: {
    status: 'ok',
    checkedAt: '2026-08-18T00:10:00Z',
    ok: 4,
    failed: 0,
    unverified: 0,
  },
  startedAt: '2026-08-18T00:01:00Z',
  completedAt: '2026-08-18T00:10:00Z',
  claimedBy: 'admin@example.com',
  completedBy: 'admin@example.com',
  errorSummary: null,
};

describe('Connections Apply release request', () => {
  it('generates the exact notebook call from the approved request', () => {
    const snippet = modelReleaseNotebookSnippet(release, 'https://app.example');
    expect(snippet).toContain('apply_model_version(');
    expect(snippet).toContain('request_id="request-123"');
    expect(snippet).toContain('app_url="https://app.example"');
    expect(releaseVersionLine(release)).toBe('version 7 → 8');
  });

  it('posts the canonical admin request, polls status, and hides controls from consumers', () => {
    const source = readFileSync(new URL('./ApplyDeclarationCard.tsx', import.meta.url), 'utf8');
    expect(source).toContain("fetch('/api/admin/model-releases', { method: 'POST' })");
    expect(source).toContain("fetch('/api/admin/model-releases?limit=1')");
    expect(source).toContain('if (!isAdmin) return null');
    expect(source).toContain('release.preflightResult');
    expect(source).toContain('window.setInterval');
  });
});
