import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { OpsScopePayload, OpsScopeStatus } from '../../shared/ops-scope-contract';
import { AstrolabeLoadingLabel } from './AstrolabeLoadingLabel';
import { Dialog } from './Dialog';
import { Button, Input } from './ui';

const PAGE_SIZE = 50;

function ScopeStatus({ status }: { status: OpsScopeStatus }) {
  return (
    <span className="ops-scope-status" data-scope-status={status}>
      {status === 'in' ? 'In scope' : 'Out of scope'}
    </span>
  );
}

export function CheckScopesButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" type="button" className="ops-scope-check-button" onClick={onClick}>
      Check scopes
    </Button>
  );
}

export function OpsScopeModal({
  payload,
  busy = false,
  failure = '',
  onClose,
}: {
  payload: OpsScopePayload | null;
  busy?: boolean;
  failure?: string;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle
      ? (payload?.assets ?? []).filter(
          (row) => row.asset.toLowerCase().includes(needle) || row.type.toLowerCase().includes(needle)
        )
      : (payload?.assets ?? []);
  }, [payload, search]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const activePage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE);

  return (
    <Dialog
      labelledBy="ops-scope-dialog-title"
      describedBy="ops-scope-dialog-description"
      overlayClassName="ops-scope-dialog-overlay"
      contentClassName="ops-scope-dialog"
      ariaBusy={busy}
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
      {busy ? (
        <div className="ops-scope-dialog-state" role="status">
          <AstrolabeLoadingLabel as="span" announce label="Checking catalog scopes" />
        </div>
      ) : failure ? (
        <p className="ops-scope-dialog-state" role="alert">
          {failure}
        </p>
      ) : payload ? (
        <>
          <div className="ops-scope-provenance">
            <span>User scope: {payload.user.label} (OBO)</span>
            <span>App scope: {payload.app.label}</span>
          </div>
          <label className="run-search monitoring-search ops-scope-search">
            <Search aria-hidden="true" />
            <Input
              value={search}
              aria-label="Search catalog scopes"
              placeholder="Search assets"
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
          </label>
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
              </tbody>
            </table>
          </div>
          {rows.length === 0 ? <p className="ops-scope-empty">No matching catalog assets.</p> : null}
          <div className="ops-scope-pagination" aria-label="Catalog scope pages">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={activePage === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
            >
              Previous
            </Button>
            <span>
              Page {activePage + 1} of {pageCount}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={activePage >= pageCount - 1}
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            >
              Next
            </Button>
          </div>
        </>
      ) : null}
    </Dialog>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- stateful control is shared with the Ops health header
export function useOpsScopeCheck() {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<OpsScopePayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  const openScopes = () => {
    setOpen(true);
    if (payload || busy) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setFailure('');
    void fetch('/api/ops/scopes', { headers: { accept: 'application/json' }, signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as OpsScopePayload & { detail?: unknown };
        if (!response.ok) {
          throw new Error(typeof body.detail === 'string' ? body.detail : `The server answered ${response.status}.`);
        }
        setPayload(body);
      })
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setFailure(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          controllerRef.current = null;
          setBusy(false);
        }
      });
  };
  const closeScopes = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setBusy(false);
    setOpen(false);
  };

  return {
    button: <CheckScopesButton onClick={openScopes} />,
    modal: open ? <OpsScopeModal payload={payload} busy={busy} failure={failure} onClose={closeScopes} /> : null,
  };
}
