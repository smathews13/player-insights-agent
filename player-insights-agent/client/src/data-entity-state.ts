import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { readPreflightOnce } from './agent-readiness';
import { ENTITY_PARAM, entityRowId, trackedTables } from './data-entities';
import { useRuntimeEntityStyles } from './runtime-entity-styles';

let trackedRequest: Promise<string[]> | null = null;
let workspaceRequest: Promise<string> | null = null;

export function useTrackedTables(): string[] {
  useRuntimeEntityStyles();
  const [tables, setTables] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    trackedRequest ??= readPreflightOnce().then(trackedTables).catch(() => []);
    void trackedRequest.then((names) => {
      if (live) setTables(names);
    });
    return () => {
      live = false;
    };
  }, []);
  return tables;
}

export function useWorkspaceHost(): string {
  const [host, setHost] = useState('');
  useEffect(() => {
    let live = true;
    workspaceRequest ??= fetch('/api/architecture')
      .then((response) => response.json() as Promise<{ workspaceHost?: unknown } | null>)
      .then((payload) => (typeof payload?.workspaceHost === 'string' ? payload.workspaceHost : ''))
      .catch(() => '');
    void workspaceRequest.then((value) => {
      if (live) setHost(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return host;
}

export function useRequestedEntity(): string {
  const [params] = useSearchParams();
  return (params.get(ENTITY_PARAM) ?? '').trim();
}

export function isRequestedEntity(name: string, requested: string): boolean {
  return !!requested && requested.toLowerCase() === name.trim().toLowerCase();
}

export function entityRowProps(name: string, requested: string) {
  const highlighted = isRequestedEntity(name, requested);
  return {
    id: entityRowId(name),
    'data-entity': name,
    'data-highlighted': highlighted ? 'true' : undefined,
    'aria-current': highlighted ? ('location' as const) : undefined,
    className: highlighted ? 'bg-accent text-accent-foreground font-medium' : undefined,
  };
}
