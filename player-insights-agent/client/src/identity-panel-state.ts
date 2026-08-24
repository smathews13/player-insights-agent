import { useEffect, useRef, useState } from 'react';
import type { Identity } from './app-types';
import type { AnalyticalExecution } from './analytical-execution';
import { forgetIdentityRequest, identityRequest } from './app-state';

export interface PanelIdentity extends Identity {
  accessDecision?: { mode: string; decidedAt: string; detail: string } | null;
  servingPrincipal?: { id: string; observedAt: string } | null;
  analyticalExecution?: AnalyticalExecution | null;
}

export interface DeploymentIdentity {
  identity: PanelIdentity | null;
  failed: boolean;
}

/**
 * The deployment's own view of the identity payload, sharing the session's read.
 *
 * THIS USED TO CALL `fetch('/api/identity')` ITSELF, which made opening
 * Connections a second round trip for a payload the shell had already read on
 * first paint -- and identity is not a cheap read, it goes to Lakebase for the
 * role. `identityRequest` is the module-scoped promise the shell uses, so by the
 * time this page mounts the answer is usually already there and the panel fills
 * without a request at all.
 *
 * It reads the RAW body rather than `identityFromResponse`, because the panel
 * needs three fields the shell's `Identity` does not carry: the access decision,
 * the serving principal and the analytical execution mode.
 *
 * `checkedAt` is how the page keeps its refresh contract despite the sharing. A
 * shared promise is a session-long answer, so without this a reader who pressed
 * Refresh after changing an execution setting would be shown the identity from
 * before the change, on the page whose whole job is stating current facts. Pass
 * the freshness stamp and a MOVE in it drops the shared answer and re-reads.
 * Only a move: the stamp arriving for the first time (empty to set, on the first
 * payload of a mount) is not a refresh, and treating it as one would restore the
 * duplicate read this exists to remove.
 */
export function useDeploymentIdentity(enabled = true, checkedAt = ''): DeploymentIdentity {
  const [identity, setIdentity] = useState<PanelIdentity | null>(null);
  const [failed, setFailed] = useState(false);
  const seenStamp = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;

    const previous = seenStamp.current;
    seenStamp.current = checkedAt;
    const refreshed = previous !== null && previous !== '' && checkedAt !== '' && checkedAt !== previous;
    if (refreshed) forgetIdentityRequest();

    identityRequest()
      .then((body) => {
        if (live) setIdentity(body as PanelIdentity);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [enabled, checkedAt]);

  return { identity, failed };
}

export function questionsRunAs(identity: PanelIdentity | null): string {
  if (!identity) return '';
  if (identity.analyticalExecution?.mode === 'app_service_principal') {
    return identity.executionIdentity ?? '';
  }
  return identity.signedInAs ?? '';
}
