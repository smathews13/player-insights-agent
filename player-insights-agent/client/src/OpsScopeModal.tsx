import { Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  OpsScopeAsset,
  OpsScopeFilter,
  OpsScopePage,
  OpsScopePrincipal,
  OpsScopeStatus,
} from '../../shared/ops-scope-contract';
import { AppSelect } from './AppSelect';
import { PiaLoadingLabel } from './PiaLoadingLabel';
import { Dialog } from './Dialog';
import { Button, Input } from './ui';

const CLIENT_TIMEOUT_MS = 12_000;
const SEARCH_DELAY_MS = 250;

function abortReasonName(signal: AbortSignal): string {
  const reason = (signal as { readonly reason?: unknown }).reason;
  return reason instanceof Error ? reason.name : '';
}

function ScopeStatus({ status }: { status: OpsScopeStatus }) {
  return (
    <span className="ops-scope-status" data-scope-status={status}>
      {status === 'in' ? 'In scope' : status === 'out' ? 'Out of scope' : 'Unavailable'}
    </span>
  );
}

export function CheckScopesButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <Button
      variant="default"
      data-variant="default"
      size="sm"
      type="button"
      className="ops-scope-check-button"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={onClick}
    >
      {busy ? <PiaLoadingLabel as="span" seat="button" announce={false} label="Checking…" /> : 'Check all scopes'}
    </Button>
  );
}

function PrincipalAvailability({ principal }: { principal: OpsScopePrincipal | null }) {
  if (!principal) return null;
  return (
    <span data-principal-availability={principal.availability}>
      {principal.label}
      {principal.provenance === 'obo' ? ' (OBO)' : ''}
      {principal.availability === 'unavailable' ? ' — unavailable; retry' : ''}
    </span>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 4 }, (_, index) => (
        <tr className="ops-scope-skeleton-row" key={index} aria-hidden="true">
          <td>
            {index === 0 ? (
              <PiaLoadingLabel as="span" seat="button" announce label="Checking…" />
            ) : (
              <span className="ops-scope-skeleton-line" />
            )}
          </td>
          <td>
            <span className="ops-scope-skeleton-line" />
          </td>
          <td>
            <span className="ops-scope-skeleton-pill" />
          </td>
          <td>
            <span className="ops-scope-skeleton-pill" />
          </td>
        </tr>
      ))}
    </>
  );
}

export function OpsScopeModal({
  rows,
  page,
  search,
  filter,
  busy,
  loadingMore,
  failure,
  onSearch,
  onFilter,
  onMore,
  onRetry,
  onClose,
}: {
  rows: readonly OpsScopeAsset[];
  page: OpsScopePage | null;
  search: string;
  filter: OpsScopeFilter;
  busy: boolean;
  loadingMore: boolean;
  failure: string;
  onSearch: (value: string) => void;
  onFilter: (value: OpsScopeFilter) => void;
  onMore: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const completedEmpty =
    !busy &&
    !failure &&
    rows.length === 0 &&
    !page?.moreResults &&
    page?.user.availability === 'available' &&
    page.app.availability === 'available';
  return (
    <Dialog
      labelledBy="ops-scope-dialog-title"
      describedBy="ops-scope-dialog-description"
      overlayClassName="ops-scope-dialog-overlay"
      contentClassName="ops-scope-dialog"
      ariaBusy={busy || loadingMore}
      onDismiss={onClose}
    >
      <div className="ops-scope-dialog-head">
        <div>
          <h2 id="ops-scope-dialog-title">Catalog scopes</h2>
          <p id="ops-scope-dialog-description">
            Read-only comparison of assets visible through each credential. This does not grant access.
          </p>
        </div>
        <button type="button" className="ops-scope-dialog-close" aria-label="Close Catalog scopes" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="ops-scope-provenance">
        <span>
          User scope: <PrincipalAvailability principal={page?.user ?? null} />
        </span>
        <span>
          App scope: <PrincipalAvailability principal={page?.app ?? null} />
        </span>
        {page?.user.availability === 'unavailable' || page?.app.availability === 'unavailable' ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Retry unavailable
          </Button>
        ) : null}
      </div>
      <div className="ops-scope-filters">
        <label className="run-search monitoring-search ops-scope-search">
          <Search aria-hidden="true" />
          <Input
            value={search}
            aria-label="Search catalog scopes"
            placeholder="Search assets"
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
        <label className="ops-scope-type-filter">
          <span>Type</span>
          <AppSelect<OpsScopeFilter>
            label="Asset type"
            ariaLabel="Catalog scope asset type"
            value={filter}
            onValueChange={onFilter}
            options={[
              { value: 'all', label: 'All asset types' },
              { value: 'catalog', label: 'Catalogs' },
              { value: 'schema', label: 'Schemas' },
              { value: 'table', label: 'Tables' },
            ]}
          />
        </label>
      </div>
      <div className="ops-scope-table-scroll">
        <table className="ops-table ops-scope-table">
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col">Type</th>
              <th scope="col">User scope</th>
              <th scope="col">App scope</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.type}:${row.asset}`}>
                <th scope="row">{row.asset}</th>
                <td>{row.type}</td>
                <td>
                  <ScopeStatus status={row.userScope} />
                </td>
                <td>
                  <ScopeStatus status={row.appScope} />
                </td>
              </tr>
            ))}
            {busy && rows.length === 0 ? <SkeletonRows /> : null}
          </tbody>
        </table>
      </div>
      {failure ? (
        <div className="ops-scope-dialog-state" role="alert">
          <span>{failure}</span>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
      {completedEmpty ? <p className="ops-scope-empty">No matching catalog assets.</p> : null}
      {page?.capped ? (
        <p className="ops-scope-more-note">More results exist. Narrow the search or type to continue.</p>
      ) : null}
      <div className="ops-scope-pagination">
        <span>{rows.length.toLocaleString()} assets loaded</span>
        {page?.nextCursor ? (
          <Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={onMore}>
            {loadingMore ? (
              <PiaLoadingLabel as="span" seat="button" announce={false} label="Checking…" />
            ) : (
              'More results'
            )}
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- stateful control is shared with the Ops admin rail
export function useOpsScopeCheck() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<OpsScopeAsset[]>([]);
  const [page, setPage] = useState<OpsScopePage | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<OpsScopeFilter>('all');
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef('');
  const filterRef = useRef<OpsScopeFilter>('all');
  const cursorRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    },
    []
  );

  const load = async (reset: boolean) => {
    controllerRef.current?.abort();
    const request = requestRef.current + 1;
    requestRef.current = request;
    const controller = new AbortController();
    controllerRef.current = controller;
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
      CLIENT_TIMEOUT_MS
    );
    setFailure('');
    if (reset) {
      setBusy(true);
      setRows([]);
      setPage(null);
      cursorRef.current = null;
    } else {
      setLoadingMore(true);
    }
    const params = new URLSearchParams({ limit: '50', type: filterRef.current });
    if (searchRef.current.trim()) params.set('q', searchRef.current.trim());
    if (!reset && cursorRef.current) params.set('cursor', cursorRef.current);
    try {
      const response = await fetch(`/api/ops/scopes?${params.toString()}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as OpsScopePage & { detail?: unknown };
      if (!response.ok) {
        throw new Error(typeof body.detail === 'string' ? body.detail : 'The scope page could not finish.');
      }
      if (request !== requestRef.current) return;
      setPage(body);
      cursorRef.current = body.nextCursor;
      setRows((current) => {
        const merged = new Map((reset ? [] : current).map((row) => [`${row.type}:${row.asset}`, row]));
        for (const row of body.assets) merged.set(`${row.type}:${row.asset}`, row);
        return [...merged.values()];
      });
    } catch (error) {
      if (request !== requestRef.current || abortReasonName(controller.signal) === 'AbortError') return;
      setFailure(
        abortReasonName(controller.signal) === 'TimeoutError'
          ? 'The scope page timed out. Retry the comparison.'
          : error instanceof Error
            ? error.message
            : 'The scope page could not finish.'
      );
    } finally {
      clearTimeout(timeout);
      if (request === requestRef.current) {
        controllerRef.current = null;
        setBusy(false);
        setLoadingMore(false);
      }
    }
  };

  const openScopes = () => {
    setOpen(true);
    if (!busy && !loadingMore) void load(true);
  };
  const closeScopes = () => {
    requestRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = null;
    setBusy(false);
    setLoadingMore(false);
    setOpen(false);
  };
  const changeSearch = (value: string) => {
    setSearch(value);
    searchRef.current = value;
    requestRef.current += 1;
    controllerRef.current?.abort();
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => void load(true), SEARCH_DELAY_MS);
  };
  const changeFilter = (value: OpsScopeFilter) => {
    setFilter(value);
    filterRef.current = value;
    requestRef.current += 1;
    controllerRef.current?.abort();
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    void load(true);
  };
  const working = busy || loadingMore;

  return {
    button: <CheckScopesButton busy={working} onClick={openScopes} />,
    modal: open ? (
      <OpsScopeModal
        rows={rows}
        page={page}
        search={search}
        filter={filter}
        busy={busy}
        loadingMore={loadingMore}
        failure={failure}
        onSearch={changeSearch}
        onFilter={changeFilter}
        onMore={() => void load(false)}
        onRetry={() => void load(true)}
        onClose={closeScopes}
      />
    ) : null,
  };
}
