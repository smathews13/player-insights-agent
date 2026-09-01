import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Pencil, Search } from 'lucide-react';
import type {
  AiGatewayCandidate,
  AiGatewayDiscovery,
  AiGatewayMode,
  AiGatewaySummary,
} from '../../shared/ai-gateway-contract';
import { gatewayTransport } from '../../shared/ai-gateway-contract';
import type { ConnectionReading } from './connection-model';
import { AppSelect } from './AppSelect';
import { BrandIcon } from './BrandIcon';
import { Badge, Button, Input } from './ui';

const CAPABILITIES: Array<[keyof AiGatewayCandidate['capabilities'], string]> = [
  ['rateLimits', 'Rate limits'],
  ['budgetEnforcement', 'Budget enforcement'],
  ['usageTracking', 'Usage tracking'],
  ['inferenceTable', 'Inference table'],
  ['guardrails', 'Guardrails'],
  ['routingFallback', 'Routing / fallback'],
];

export function AiGatewayCapabilityBadges({ candidate }: { candidate: AiGatewayCandidate | null }) {
  if (!candidate) return null;
  return (
    <>
      <div className="ai-gateway-capabilities" aria-label="Live AI Gateway capabilities">
        {CAPABILITIES.filter(([key]) => candidate.capabilities[key]).map(([key, label]) => (
          <Badge key={key} variant="outline">
            {label}
          </Badge>
        ))}
      </div>
      {candidate.enforcement.map((enforcement) => (
        <p className="connection-row-tier-note" key={enforcement.source}>
          <strong>{enforcement.label}</strong> · {enforcement.detail} <code>{enforcement.identifier}</code>
        </p>
      ))}
    </>
  );
}

function localSummary(reading: ConnectionReading, model: string): AiGatewaySummary {
  const mode: AiGatewayMode =
    reading.row.configured === 'mlflow' || reading.row.configured === 'openai' ? reading.row.configured : '';
  return {
    active: { mode, model, transport: gatewayTransport(mode) },
    staged: null,
    configurationState: 'active',
    detail: mode ? 'The running model version reports this Gateway route.' : 'Direct model traffic remains active.',
    validatedAt: '',
    revision: '0',
    candidate: null,
    rollback: 'Stage Direct with the existing foundation endpoint, then use the normal confirmed agent release.',
  };
}

export function AiGatewayConnection({
  reading,
  foundationModel,
  allowMutations,
  requested,
  onStaged,
}: {
  reading: ConnectionReading;
  foundationModel: string;
  allowMutations: boolean;
  requested: boolean;
  onStaged: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(requested);
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(() => localSummary(reading, foundationModel));
  const [mode, setMode] = useState<AiGatewayMode>('');
  const [search, setSearch] = useState('');
  const [discovery, setDiscovery] = useState<AiGatewayDiscovery | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const loadSummary = useCallback(async () => {
    if (!allowMutations) {
      setSummary(localSummary(reading, foundationModel));
      return;
    }
    const response = await fetch('/api/admin/ai-gateway/summary');
    if (!response.ok) return;
    const next = (await response.json()) as AiGatewaySummary;
    setSummary(next);
  }, [allowMutations, foundationModel, reading]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    if (!editing) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        setBusy(true);
        try {
          const params = new URLSearchParams({ mode, q: search.trim() });
          const response = await fetch(`/api/admin/ai-gateway/candidates?${params}`, { signal: controller.signal });
          const body = (await response.json().catch(() => null)) as AiGatewayDiscovery | null;
          if (body) setDiscovery(body);
        } catch (error) {
          if ((error as Error).name !== 'AbortError') setMessage('Gateway discovery is unavailable.');
        } finally {
          if (!controller.signal.aborted) setBusy(false);
        }
      })();
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [editing, mode, search]);

  const candidate = useMemo(
    () => discovery?.items.find((item) => item.id === selected) ?? summary.candidate,
    [discovery, selected, summary.candidate]
  );
  const staged = summary.staged;
  const configured = Boolean(summary.active.mode || staged);
  const collapsedValue = staged
    ? staged.mode
      ? candidate?.displayName || staged.model
      : 'Direct'
    : summary.active.mode
      ? candidate?.displayName || summary.active.model || summary.active.transport
      : 'Not connected';

  const beginEdit = () => {
    const initial = staged ?? summary.active;
    setMode(initial.mode);
    setSelected(initial.model);
    setSearch('');
    setMessage('');
    setEditing(true);
  };

  const stage = async () => {
    if (!selected) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/admin/ai-gateway/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, candidateId: selected, expectedRevision: summary.revision }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        detail?: string;
        revision?: string;
      };
      if (!response.ok) {
        setMessage(body.detail ?? 'The Gateway pair was not staged.');
        return;
      }
      setMessage(body.detail ?? 'Staged for agent release.');
      setEditing(false);
      await Promise.all([loadSummary(), onStaged()]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="connection-row ai-gateway-row"
      id="connection-llm-gateway"
      data-testid="connection-llm-gateway"
      data-open={open ? 'true' : undefined}
      aria-current={requested ? 'location' : undefined}
    >
      <button
        type="button"
        className="connection-row-summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <BrandIcon product="mosaic-ai" className="connection-row-product" />
        <span className="connection-row-label">AI Gateway</span>
        <span className="connection-row-value" aria-live="polite">
          <span className="ast-pill ast-pill--neutral" title={collapsedValue}>
            {collapsedValue}
          </span>
        </span>
        {staged ? <span className="connection-row-state">Staged for agent release</span> : null}
        {allowMutations ? (
          <Pencil className="size-3.5 shrink-0 connection-row-affordance" data-affordance="write" />
        ) : null}
      </button>

      {open ? (
        <div className="connection-row-detail">
          <dl className="connection-details">
            <div className="connection-detail">
              <dt>Current transport</dt>
              <dd>{summary.active.transport}</dd>
            </div>
            {summary.active.model ? (
              <div className="connection-detail">
                <dt>Active model</dt>
                <dd title={summary.active.model}>{summary.active.model}</dd>
              </div>
            ) : null}
            {staged ? (
              <div className="connection-detail">
                <dt>Candidate</dt>
                <dd title={staged.model}>
                  {staged.transport} · {candidate?.displayName || staged.model}
                </dd>
              </div>
            ) : null}
            <div className="connection-detail">
              <dt>Configuration</dt>
              <dd>
                {summary.configurationState === 'staged' ? 'Staged for agent release' : summary.configurationState}
              </dd>
            </div>
            {summary.validatedAt ? (
              <div className="connection-detail">
                <dt>Validated</dt>
                <dd>{new Date(summary.validatedAt).toLocaleString()}</dd>
              </div>
            ) : null}
          </dl>

          <AiGatewayCapabilityBadges candidate={candidate ?? null} />

          <p className="connection-row-tier-note">{summary.detail}</p>
          {configured ? <p className="connection-row-tier-note">Rollback: {summary.rollback}</p> : null}

          {!editing && allowMutations ? (
            <div className="connection-row-tier-actions">
              <Button variant="outline" size="sm" onClick={beginEdit}>
                <Pencil className="size-3.5" /> {configured ? 'Change' : 'Connect'}
              </Button>
            </div>
          ) : null}

          {editing ? (
            <div className="connection-row-editor ai-gateway-editor">
              <AppSelect
                label="Transport"
                ariaLabel="AI Gateway transport"
                value={mode || 'direct'}
                options={[
                  { value: 'direct', label: 'Direct' },
                  { value: 'mlflow', label: 'MLflow-compatible' },
                  { value: 'openai', label: 'OpenAI-compatible' },
                ]}
                onValueChange={(value) => {
                  setMode(value === 'direct' ? '' : (value as AiGatewayMode));
                  setSelected(value === 'direct' ? summary.active.model : '');
                  setDiscovery(null);
                }}
              />
              <div className="run-search ai-gateway-search">
                <Search aria-hidden="true" />
                <Input
                  type="search"
                  aria-label="Search eligible AI Gateway resources"
                  placeholder="Search model services and endpoints"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              {selected ? (
                <p className="connection-row-tier-note">
                  Selected: <code>{selected}</code>
                </p>
              ) : null}
              {discovery?.status === 'ok' ? (
                <div className="ai-gateway-results" role="listbox" aria-label="Eligible AI Gateway resources">
                  {discovery.items.map((item) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected === item.id}
                      key={`${item.kind}:${item.id}`}
                      disabled={!item.ready}
                      onClick={() => setSelected(item.id)}
                    >
                      <span>{item.displayName}</span>
                      <code>{item.id}</code>
                      <span>{item.ready ? item.readiness : `Unavailable · ${item.readiness}`}</span>
                    </button>
                  ))}
                  {!busy && discovery.items.length === 0 ? <p>No eligible resources match.</p> : null}
                </div>
              ) : null}
              {discovery && discovery.status !== 'ok' ? (
                <p className="connection-row-tier-note" role="alert">
                  {discovery.detail}
                </p>
              ) : null}
              {message ? (
                <p className="connection-row-tier-note" role="status">
                  {message}
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button size="sm" disabled={busy || !selected} onClick={() => void stage()}>
                  {busy ? 'Validating…' : 'Stage for agent release'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
