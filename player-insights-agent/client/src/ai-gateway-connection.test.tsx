import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { AiGatewayCandidate } from '../../shared/ai-gateway-contract';
import { connectedResource } from '../../shared/deployment-config';
import { AiGatewayCapabilityBadges, AiGatewayConnection } from './AiGatewayConnection';
import { readConnection } from './connection-model';

function reading(configured: boolean, connected = false) {
  return readConnection({
    row: {
      resource: connectedResource('llm-gateway')!,
      configured: configured ? 'catalog.schema.gateway_model' : '',
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
          name: 'catalog.schema.gateway_model',
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

function render(configured: boolean, enabled = false, connected = false): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AiGatewayConnection
        reading={reading(configured, connected)}
        foundationModel="databricks-gpt-5"
        gatewayMode={configured ? 'mlflow' : ''}
        enabled={enabled}
        allowMutations={false}
        requested
        onStaged={() => Promise.resolve()}
      />
    </MemoryRouter>
  );
}

describe('AI Gateway Connections row', () => {
  it('reports an absent optional gateway as disconnected', () => {
    const markup = render(false);
    const readable = text(markup);
    expect(readable).toContain('AI Gateway Direct Not configured');
    expect(markup).toContain('aria-label="AI Gateway state: Not configured"');
    expect(markup).toContain('data-connection-state="not-configured"');
    expect(markup).toContain('ast-pill--neutral');
    expect(markup).not.toContain('ast-pill--pos');
    expect(readable).toContain('Configured transport None');
    expect(readable).toContain('No Unity Catalog AI Gateway model service is configured');
    expect(readable).not.toMatch(/Not checked|Blocked|hard ceiling/);
  });

  it('uses loaders instead of a stale status while the connection is checking', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <AiGatewayConnection
          reading={reading(true)}
          foundationModel="databricks-gpt-5"
          gatewayMode="mlflow"
          enabled={false}
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
    const markup = render(true, true, true);
    const readable = text(markup);
    expect(readable).toContain('AI Gateway catalog.schema.gateway_model Enabled');
    expect(readable).toContain('Configured transport MLflow');
    expect(readable).toContain('Gateway model service catalog.schema.gateway_model');
    expect(readable).toContain('Direct model databricks-gpt-5');
    expect(markup).toContain('data-connection-state="enabled"');
    expect(markup).toContain('ast-pill--pos');
    expect(markup).not.toContain('ast-pill--neg');
    expect(readable).not.toMatch(/\bConnect\b|\bChange\b|Stage for agent release/);
  });

  it('shows configured but disabled as neutral rather than unreachable', () => {
    const markup = render(true, false, true);
    expect(text(markup)).toContain('AI Gateway catalog.schema.gateway_model Disabled');
    expect(markup).toContain('data-connection-state="disabled"');
    expect(markup).toContain('ast-pill--neutral');
  });

  it('does not call a configured Gateway unreachable when its generic metadata probe is intentionally absent', () => {
    const markup = render(true, true, false);
    expect(text(markup)).toContain('AI Gateway catalog.schema.gateway_model Enabled');
    expect(text(markup)).toContain('Connection Configured');
    expect(markup).toContain('data-connection-state="enabled"');
    expect(markup).toContain('ast-pill--pos');
    expect(text(markup)).not.toContain('Unreachable');
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
