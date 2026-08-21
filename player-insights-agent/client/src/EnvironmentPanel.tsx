import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Search } from 'lucide-react';
import type { EnvironmentInfo, EnvironmentPackage, EnvironmentVariable } from '../../shared/environment-info';
import { filterEnvironmentItems } from './environment-filter';
import { environmentInfoFromResponse } from './environment-response';
import { Badge, Button, Input } from './ui';

type EnvironmentTab = 'variables' | 'packages';
type EnvironmentRow = EnvironmentVariable | EnvironmentPackage;

function rowsForClipboard(tab: EnvironmentTab, rows: readonly EnvironmentRow[]): string {
  const headings = tab === 'variables' ? ['Key', 'Value'] : ['Package', 'Version'];
  const body = rows.map((row) => ('key' in row ? [row.key, row.value] : [row.name, row.version]));
  return [headings, ...body].map((columns) => columns.join('\t')).join('\n');
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

export function EnvironmentPanel({ initialData }: { initialData?: unknown }) {
  const normalizedInitial = initialData === undefined ? null : environmentInfoFromResponse(initialData);
  const [data, setData] = useState<EnvironmentInfo | null>(normalizedInitial);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(normalizedInitial ? 'ready' : 'loading');
  const [active, setActive] = useState<EnvironmentTab>('variables');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);

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
                  type="button"
                  role="tab"
                  aria-selected={active === 'variables'}
                  className={active === 'variables' ? 'active' : ''}
                  onClick={() => {
                    setActive('variables');
                    setCopied(false);
                  }}
                >
                  Variables ({data.variables.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={active === 'packages'}
                  className={active === 'packages' ? 'active' : ''}
                  onClick={() => {
                    setActive('packages');
                    setCopied(false);
                  }}
                >
                  Packages ({data.packages.length})
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

            <div className="environment-list" role="region" aria-label={`Filtered ${active}`} tabIndex={0}>
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
