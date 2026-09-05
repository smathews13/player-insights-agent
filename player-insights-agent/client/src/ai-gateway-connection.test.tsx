import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { AiGatewayCandidate } from '../../shared/ai-gateway-contract';
import { connectedResource } from '../../shared/deployment-config';
import { AiGatewayCapabilityBadges, AiGatewayConnection } from './AiGatewayConnection';
import { readConnection } from './connection-model';

function reading(mode: '' | 'mlflow' | 'openai', connected = false) {
  return readConnection({
    row: {
      resource: connectedResource('llm-gateway')!,
      configured: mode,
      configuredFrom: 'artifact',
      actual: '',
      actualObserved: false,
      intended: null,
      intendedAt: '',
      intendedBy: '',
      editable: false,
      changedByLabel: '',
      changedByNote: '',
    },
    check: connected
      ? {
          id: 'llm-gateway',
          kind: 'dependency',
          name: mode,
          label: 'AI Gateway',
          status: 'ok',
          detail: 'The gateway answered.',
          checked_with: 'fixture',
          duration_ms: 1,
          error: '',
          remedy: null,
        }
      : undefined,
    findings: [],
  });
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/\s+/g, ' ')
    .trim();
}

function render(mode: '' | 'mlflow' | 'openai', allowMutations = false, connected = false): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AiGatewayConnection
        reading={reading(mode, connected)}
        foundationModel="databricks-gpt-5"
        allowMutations={allowMutations}
        requested
        onStaged={() => Promise.resolve()}
      />
    </MemoryRouter>
  );
}

describe('AI Gateway Connections row', () => {
  it('reports an absent optional gateway as disconnected', () => {
    const markup = render('');
    const readable = text(markup);
    expect(readable).toContain('AI Gateway Direct Disconnected');
    expect(markup).toContain('aria-label="AI Gateway connection status: Disconnected"');
    expect(markup).toContain('data-connection-state="disconnected"');
    expect(markup).toContain('ast-pill--neg');
    expect(markup).not.toContain('ast-pill--pos');
    expect(readable).toContain('Current transport Direct');
    expect(readable).toContain('Direct model traffic remains active');
    expect(readable).not.toMatch(/Not checked|Blocked|hard ceiling/);
  });

  it('uses loaders instead of a stale status while the connection is checking', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <AiGatewayConnection
          reading={reading('mlflow')}
          foundationModel="databricks-gpt-5"
          allowMutations={false}
          requested
          refreshing
          onStaged={() => Promise.resolve()}
        />
      </MemoryRouter>
    );
    expect(markup).toContain('Checking AI Gateway');
    expect(markup).not.toContain('AI Gateway connection status:');
    expect(markup).not.toMatch(/>(Connected|Disconnected)</);
  });

  it('shows the current transport and model without write controls for readers', () => {
    const markup = render('mlflow', false, true);
    const readable = text(markup);
    expect(readable).toContain('Current transport MLflow');
    expect(readable).toContain('Active model databricks-gpt-5');
    expect(markup).toContain('data-connection-state="connected"');
    expect(markup).toContain('ast-pill--pos');
    expect(markup).not.toContain('ast-pill--neg');
    expect(readable).not.toMatch(/\bConnect\b|\bChange\b|Stage for agent release/);
  });

  it('offers one Connect action to an administrator', () => {
    const readable = text(render('', true));
    expect(readable.match(/\bConnect\b/g)).toHaveLength(1);
    expect(readable).not.toContain('Save and apply');
  });

  it('renders only capabilities proven by a discovered candidate', () => {
    const candidate: AiGatewayCandidate = {
      id: 'main.ai.routed',
      displayName: 'Routed',
      kind: 'model-service',
      ready: true,
      readiness: 'READY',
      compatibleModes: ['mlflow', 'openai'],
      capabilities: {
        rateLimits: true,
        budgetEnforcement: true,
        usageTracking: false,
        inferenceTable: true,
        guardrails: false,
        routingFallback: false,
      },
      enforcement: [
        {
          source: 'gateway-rate-limit',
          label: 'Rate limited',
          approximate: true,
          blocksUsage: true,
          detail: 'Returns 429 with approximate enforcement.',
          identifier: 'main.ai.routed',
        },
      ],
    };
    const readable = text(renderToStaticMarkup(<AiGatewayCapabilityBadges candidate={candidate} />));
    expect(readable).toContain('Rate limits');
    expect(readable).toContain('Budget enforcement');
    expect(readable).toContain('Inference table');
    expect(readable).toContain('approximate');
    expect(readable).not.toMatch(/Usage tracking|Guardrails|Routing \/ fallback|hard ceiling/);
  });

  it('uses a constrained keyboard-addressable editor and no banned generic footer', () => {
    const source = readFileSync(new URL('./AiGatewayConnection.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('./styles/connections.css', import.meta.url), 'utf8');
    expect(source).toContain("value: 'direct', label: 'Direct'");
    expect(source).toContain("value: 'mlflow', label: 'MLflow-compatible'");
    expect(source).toContain("value: 'openai', label: 'OpenAI-compatible'");
    expect(source).toContain('role="listbox"');
    expect(source).toContain('role="option"');
    expect(source).toContain('aria-selected={selected === item.id}');
    expect(source).toContain('aria-label="Search eligible AI Gateway resources"');
    expect(source).not.toMatch(/Deployment-owned|New model version|App redeploy/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*ai-gateway-results/);
  });
});
