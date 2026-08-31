import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Copy, Search } from 'lucide-react';
import type { EnvironmentInfo, EnvironmentPackage, EnvironmentVariable } from '../../shared/environment-info';
import { AgentCodeRow } from './AgentCodeRow';
import { filterEnvironmentItems } from './environment-filter';
import { environmentInfoFromResponse } from './environment-response';
import { environmentTabKeyTarget, type EnvironmentTab } from './environment-tab-state';
import { Badge, Button, Input } from './ui';

type EnvironmentRow = EnvironmentVariable | EnvironmentPackage;

function rowsForClipboard(tab: EnvironmentTab, rows: readonly EnvironmentRow[]): string {
  const headings = tab === 'variables' ? ['Key', 'Value'] : ['Package', 'Version'];
  const body = rows.map((row) => ('key' in row ? [row.key, row.value] : [row.name, row.version]));
  return [headings, ...body].map((columns) => columns.join('\t')).join('\n');
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

export function EnvironmentPanel({
  initialData,
  initialAgentModel,
}: {
  initialData?: unknown;
  initialAgentModel?: unknown;
}) {
  const normalizedInitial = initialData === undefined ? null : environmentInfoFromResponse(initialData);
  const [data, setData] = useState<EnvironmentInfo | null>(normalizedInitial);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(normalizedInitial ? 'ready' : 'loading');
  const [active, setActive] = useState<EnvironmentTab>('variables');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const tabBaseId = useId();
  const variableTab = useRef<HTMLButtonElement>(null);
  const packageTab = useRef<HTMLButtonElement>(null);

  const activateFromKey = (current: EnvironmentTab, event: KeyboardEvent<HTMLButtonElement>) => {
    const target = environmentTabKeyTarget(current, event.key);
    if (!target) return;
    event.preventDefault();
    setActive(target);
    setCopied(false);
    (target === 'variables' ? variableTab : packageTab).current?.focus();
  };

  useEffect(() => {
    if (initialData !== undefined) return;
    let current = true;
    fetch('/api/environment')
      .then(async (response) => {
        if (!response.ok) throw new Error('Runtime details are not available just now.');
        return environmentInfoFromResponse(await response.json());
      })
      .then((payload) => {
        if (!current) return;
        setData(payload);
        setState('ready');
      })
      .catch(() => {
        if (current) setState('failed');
      });
    return () => {
      current = false;
    };
  }, [initialData]);

  const visible = useMemo(() => {
    if (!data) return [];
    return active === 'variables'
      ? filterEnvironmentItems(data.variables, query)
      : filterEnvironmentItems(data.packages, query);
  }, [active, data, query]);

  return (
    <div className="settings-pane environment-pane">
      <div className="settings-pane-heading">
        <h3>Environment</h3>
      </div>

      {/* Above the variables rather than inside them. What version of the agent
          is answering, and where its source is, is not an environment variable
          of THIS process -- the app container is never told it -- and burying it
          in a hundred-row table is how a fact stops being read. */}
      <AgentCodeRow initialData={initialAgentModel} />

      {data ? (
        <>
          <div className="environment-runtime" aria-label="Runtime versions">
            <Badge variant="outline">Python {data.runtime.python || 'unavailable'}</Badge>
            <Badge variant="outline">Node.js {data.runtime.node || 'unavailable'}</Badge>
          </div>

          <div className="environment-browser">
            <div className="environment-toolbar">
              <div className="environment-tabs" role="tablist" aria-label="Environment details">
                <button
                  ref={variableTab}
                  id={`${tabBaseId}-variables-tab`}
                  type="button"
                  role="tab"
                  aria-selected={active === 'variables'}
                  aria-controls={`${tabBaseId}-variables-panel`}
                  tabIndex={active === 'variables' ? 0 : -1}
                  className={active === 'variables' ? 'active' : ''}
                  onKeyDown={(event) => activateFromKey('variables', event)}
                  onClick={() => {
                    setActive('variables');
                    setCopied(false);
                  }}
                >
                  Variables ({data.variables.length})
                </button>
                <button
                  ref={packageTab}
                  id={`${tabBaseId}-packages-tab`}
                  type="button"
                  role="tab"
                  aria-selected={active === 'packages'}
                  aria-controls={`${tabBaseId}-packages-panel`}
                  tabIndex={active === 'packages' ? 0 : -1}
                  className={active === 'packages' ? 'active' : ''}
                  onKeyDown={(event) => activateFromKey('packages', event)}
                  onClick={() => {
                    setActive('packages');
                    setCopied(false);
                  }}
                >
                  Installed packages ({data.packages.length})
                </button>
              </div>
              <div className="environment-tools">
                <label className="environment-search">
                  <Search aria-hidden="true" />
                  <Input
                    aria-label={`Search ${active}`}
                    placeholder="Search..."
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setCopied(false);
                    }}
                  />
                </label>
                <Button
                  variant="ghost"
                  size="icon"
                  type="button"
                  aria-label={`Copy filtered ${active}`}
                  title={`Copy filtered ${active}`}
                  onClick={() => {
                    void copyText(rowsForClipboard(active, visible)).then(() => {
                      setCopied(true);
                    });
                  }}
                >
                  {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                </Button>
              </div>
            </div>
            <div
              id={`${tabBaseId}-${active}-panel`}
              role="tabpanel"
              aria-labelledby={`${tabBaseId}-${active}-tab`}
              tabIndex={0}
            >
              {active === 'packages' ? (
                <p className="settings-status">
                  Live container inventory — includes app, transitive, and Databricks base-image packages. Read-only
                  here.
                </p>
              ) : null}

              <div className="environment-list" role="region" aria-label={`Filtered ${active}`}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{active === 'variables' ? 'Key' : 'Package'}</th>
                      <th scope="col">{active === 'variables' ? 'Value' : 'Version'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => (
                      <tr key={'key' in row ? row.key : row.name}>
                        <td>{'key' in row ? row.key : row.name}</td>
                        <td>{'key' in row ? row.value : row.version}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {visible.length === 0 ? <p className="environment-empty">No matches.</p> : null}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {state === 'loading' ? <p className="settings-status">Loading environment.</p> : null}
      {state === 'failed' ? (
        <p className="settings-status settings-error" role="alert">
          Runtime details are not available just now.
        </p>
      ) : null}
    </div>
  );
}
