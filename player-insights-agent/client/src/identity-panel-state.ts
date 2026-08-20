import { useEffect, useState } from 'react';
import type { Identity } from './app-types';
import type { AnalyticalExecution } from './analytical-execution';

export interface PanelIdentity extends Identity {
  accessDecision?: { mode: string; decidedAt: string; detail: string } | null;
  servingPrincipal?: { id: string; observedAt: string } | null;
  analyticalExecution?: AnalyticalExecution | null;
}

export interface DeploymentIdentity {
  identity: PanelIdentity | null;
  failed: boolean;
}

export function useDeploymentIdentity(enabled = true): DeploymentIdentity {
  const [identity, setIdentity] = useState<PanelIdentity | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch('/api/identity')
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((body: PanelIdentity) => {
        if (live) setIdentity(body);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [enabled]);

  return { identity, failed };
}

export function questionsRunAs(identity: PanelIdentity | null): string {
  if (!identity) return '';
  if (identity.analyticalExecution?.mode === 'app_service_principal') {
    return identity.executionIdentity ?? '';
  }
  return identity.signedInAs ?? '';
}
