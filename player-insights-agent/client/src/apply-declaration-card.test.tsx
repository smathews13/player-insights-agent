import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NOTEBOOK_REQUIRED_ACTION,
  NOTEBOOK_REQUIRED_REASON,
  applyActionState,
  modelReleaseNotebookSnippet,
  releaseVersionLine,
} from './apply-declaration-state';
import type { ModelReleaseRequest } from '../../shared/model-release';
import type { NotebookPanel } from './connection-model';
import { EXPERIMENTAL_PANE_HINT } from './ExperimentalBadge';

function notebookPanel(overrides: Partial<NotebookPanel> = {}): NotebookPanel {
  return {
    location: 'customer_catalog.agent_config.declarations',
    configuredPath: '/Workspace/Users/analyst@example.invalid/insights-agent',
    read: { declaration: null, failure: null, detail: '' },
    comparison: [],
    ...overrides,
  };
}

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

  it('uses short release steps and states the outcome', () => {
    const source = readFileSync(new URL('./ApplyDeclarationCard.tsx', import.meta.url), 'utf8');
    expect(source).toContain('Review the staged settings below.');
    expect(source).toContain('Approve the release request.');
    expect(source).toContain('Run the copied notebook cell.');
    expect(source).toContain('Outcome: a new model version with these settings, ready for deployment.');
    expect(source).not.toContain('does not change the live agent silently');
  });

  it('marks the model re-log pane as experimental and explains the warning', () => {
    const source = readFileSync(new URL('./ApplyDeclarationCard.tsx', import.meta.url), 'utf8');
    expect(source).toContain('<ExperimentalBadge />');
    expect(EXPERIMENTAL_PANE_HINT).toMatch(/may be unstable or may not work as expected/i);
  });

  it('drops the narrative filler about what is not listed here', () => {
    const shared = readFileSync(new URL('../../shared/apply-declaration.ts', import.meta.url), 'utf8');
    expect(shared).not.toContain('Nothing is waiting on a new model version from Connections or the notebook');
    expect(shared).not.toContain('Soft settings that apply immediately are not listed here');
  });
});

describe('the notebook a model version is logged from', () => {
  /**
   * The precondition, stated plainly. A staged knob is not enough on its own:
   * the release cell runs in a notebook, so with none connected the approve
   * button would hand the reader a request they cannot carry out.
   */
  it('refuses Approve and says why when no notebook is connected', () => {
    const state = applyActionState({ notebook: notebookPanel({ configuredPath: '' }), knobCount: 2 });
    expect(state.disabled).toBe(true);
    expect(state.reason).toBe(NOTEBOOK_REQUIRED_REASON);
    expect(state.reason).toMatch(/Select a notebook first/);
  });

  it('points at the control that connects one', () => {
    expect(NOTEBOOK_REQUIRED_ACTION).toContain('Browse workspace notebooks');
  });

  /** Short, factual, no em dash, and no retired product name. */
  it('keeps the precondition copy in the page register', () => {
    for (const copy of [NOTEBOOK_REQUIRED_REASON, NOTEBOOK_REQUIRED_ACTION]) {
      expect(copy).not.toMatch(/[—–]/);
      expect(copy).not.toMatch(/Player Insights/i);
      expect(copy.length).toBeLessThan(100);
    }
  });

  it('allows Approve with no warning once a notebook is connected', () => {
    const state = applyActionState({ notebook: notebookPanel(), knobCount: 2 });
    expect(state.disabled).toBe(false);
    expect(state.reason).toBe('');
  });

  /** A path from the latest published run connects a notebook just as well. */
  it('accepts the observed path when nothing was saved', () => {
    const state = applyActionState({
      notebook: notebookPanel({ configuredPath: '', observedPath: '/Shared/last-run-notebook' }),
      knobCount: 1,
    });
    expect(state.disabled).toBe(false);
    expect(state.reason).toBe('');
  });

  /**
   * An older payload carries no notebook panel at all. Refusing there would be
   * a claim about a deployment this page cannot see.
   */
  it('says nothing about notebooks when the server sent no panel', () => {
    expect(applyActionState({ knobCount: 2 })).toEqual({ disabled: false, reason: '' });
  });

  it('still refuses an empty plan, a busy read and a release in flight, without a notebook reason', () => {
    const connected = notebookPanel();
    expect(applyActionState({ notebook: connected, knobCount: 0 })).toEqual({ disabled: true, reason: '' });
    expect(applyActionState({ notebook: connected, knobCount: 2, busy: true }).disabled).toBe(true);
    for (const releaseStatus of ['approved', 'running'] as const) {
      expect(applyActionState({ notebook: connected, knobCount: 2, releaseStatus }).disabled).toBe(true);
    }
  });

  it('wires the reason to the button it disables rather than leaving it silent', () => {
    const source = readFileSync(new URL('./ApplyDeclarationCard.tsx', import.meta.url), 'utf8');
    expect(source).toContain('disabled={action.disabled}');
    expect(source).toContain("aria-describedby={action.reason ? 'apply-notebook-required' : undefined}");
    expect(source).toMatch(/action\.reason \? \(\s*<p[^>]*id="apply-notebook-required"/);
  });

  it('reads the same notebook panel the Notebook card renders', () => {
    const page = readFileSync(new URL('./ConnectionsPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('<ApplyDeclarationCard notebook={payload?.notebook}');
  });
});
