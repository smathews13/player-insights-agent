/**
 * Who this deployment is connected as, and what that identity was shown to
 * reach.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui';
import { KeyRound } from 'lucide-react';
import { isOpaqueId, withoutRepeatedPrincipal } from './execution-identity';

interface PanelIdentity {
  signedInAs?: string;
  /** The app's own principal, from `DATABRICKS_CLIENT_ID`. */
  executionIdentity?: string;
  executionMode?: string;
  accessDecision?: { mode: string; decidedAt: string; detail: string } | null;
  /**
   * The endpoint's own principal. Only ever set by a re-verification through
   * `/api/access-verification`; the endpoint stopped reporting it when the
   * dependency checks were retired, so on most loads this is null.
   */
  servingPrincipal?: { id: string; observedAt: string } | null;
}

function when(iso: string | undefined) {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleString();
}

/**
 * One principal.
 *
 * Prints the value in full. This is the surface that exists to record it, and
 * the banner abbreviates precisely so that this can be the one place a reader
 * finds the whole thing. An absent value says what its absence means instead of
 * rendering an empty row, because a blank beside a label reads as a bug and
 * "not observed yet" is a fact about the deployment.
 */
function PrincipalRow({
  label,
  value,
  what,
  missing,
  observed,
}: {
  label: string;
  value: string | null | undefined;
  what: string;
  missing: string;
  observed?: string | null;
}) {
  const id = value?.trim();
  return (<div className="identity-row">
      <p className="identity-row-label">{label}</p>
      {id ? (<p className="identity-row-value">
          <code>{id}</code>
          {/* Says which kind of thing it is looking at, so a reader is not left
              deciding whether an opaque string is a name they should recognise. */}
          {isOpaqueId(id) ? <span className="identity-row-kind">client id</span> : null}
        </p>
      ) : (<p className="identity-row-missing">{missing}</p>
      )}
      <p className="identity-row-what">
        {what}
        {observed ? ` Last reported ${observed}.` : ''}
      </p>
    </div>
  );
}

/**
 * @param checkedAs The principal the preflight report says its checks ran under,
 *   when it resolved one. Carried in rather than fetched because the page that
 *   renders this already holds the report, and a second read of it here would
 *   let the two surfaces disagree about which identity did the work.
 */
export function IdentityPanel({ checkedAs }: { checkedAs?: string } = {}) {
  const [identity, setIdentity] = useState<PanelIdentity | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/identity')
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((body: PanelIdentity) => {
        if (live) setIdentity(body);
      })
      .catch(() => {
        // A panel that cannot say who it is connected as says that, rather than
        // staying blank and letting the absence read as "nothing is connected".
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  if (failed) {
    return (<Card data-testid="identity-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" /> Identity and permissions
          </CardTitle>
          <CardDescription>
            Could not read this deployment's identity. Reload the page; if it persists, the app server is not
            answering <code>/api/identity</code>.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!identity) return null;

  const serving = identity.servingPrincipal?.id ?? null;
  /*
   * The paragraph that used to sit under the banner, verbatim from the server
   * except for one substitution: it names the executing principal in full, and
   * that id is printed in its own field above. One full identifier per screen,
   * so the sentence gets the short form and the field stays the record.
   */
  const detail = withoutRepeatedPrincipal(identity.accessDecision?.detail ?? '', serving);

  return (<Card data-testid="identity-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" /> Identity and permissions
        </CardTitle>
        <CardDescription>
          Which service principals this deployment is connected as, and what the last access check established.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {/* The sentence the Sources page led with, kept because it is the point
            of this whole panel: the grants that decide what an answer can read
            are not the reader's own. It moved here when the two pages merged,
            rather than staying as a banner saying it a second time. */}
        <p className="text-muted-foreground">
          <strong>Identity is intentionally separated.</strong>
          {identity.signedInAs ? ` You are signed in as ${identity.signedInAs}.` : ''} Every dependency check ran as{' '}
          {checkedAs || 'the Player Insights service principal'}, the identity the agent actually uses, not with
          your personal Unity Catalog grants.
        </p>
        <div className="identity-grid">
          <PrincipalRow
            label="Orchestrator"
            value={serving}
            what="Runs the questions. This is the identity Genie and SQL see, whoever asked."
            missing="Not available. The endpoint's identity is only knowable from inside it, and it no longer reports on itself, so nothing here can fill this in. An answer says which identity read the data for it."
            observed={when(identity.servingPrincipal?.observedAt)}
          />
          <PrincipalRow
            label="App"
            value={identity.executionIdentity}
            what="Authenticates this web app and its writes. Not the identity that reaches your data."
            missing="Not configured. The app is running without a client id in its environment."
          />
        </div>

        {detail ? (<div className="identity-permissions" data-testid="identity-permissions">
            <p className="identity-row-label">Last access check</p>
            <p>{detail}</p>
            {identity.accessDecision?.decidedAt ? (<p className="identity-row-what">Decided {when(identity.accessDecision.decidedAt)}.</p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
