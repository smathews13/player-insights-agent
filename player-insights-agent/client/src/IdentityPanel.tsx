/**
 * Who this deployment runs as, as four facts and no sentences.
 *
 * WHAT THIS CARD USED TO BE, because the change is a deletion and the deletions
 * are the point. It opened with "Which service principals this deployment is
 * connected as, and what the last access check established", which is a caption
 * describing a card the reader is already looking at. Under it came a paragraph
 * beginning "Dependency checks and your own access are separate", a "Questions"
 * line reading "Questions run as the signed-in user", two principal rows each
 * carrying two or three sentences of explanation and, where a principal was
 * absent, a four-sentence account of why it could not be known. The row that
 * summarised all of it read `Connected as  not reported · questions run as the
 * signed-in user`.
 *
 * Every one of those sentences was true. Together they were nine lines of prose
 * around three identifiers, and the reader they were written for reads the top
 * and stops. So the facts stay and the prose goes: which identity questions run
 * as, which client id authenticates the app, and -- where they were reported --
 * the endpoint's principal and when the last access check was decided. Each is a
 * value, a chip or a timestamp.
 *
 * "THE SIGNED-IN USER" IS NEVER THE ANSWER HERE. It is a category, not an
 * identity, and this is the one surface on the app whose job is to name the
 * identity. The reader's own address is in the payload; printing the category
 * instead was the page declining to answer its own question.
 *
 * AND THE BADGE IS THE HEADER'S BADGE. Whether the forwarded sign-in reached
 * this app is decided in `oauth-badge.ts` and drawn by `OAuthBadge.tsx`, which is
 * the same chip the header carries. A second badge here with rules of its own is
 * how two surfaces come to disagree about one sign-in, and the rules are subtle:
 * green is about authentication, and what the token is PERMITTED to do is a
 * different question with its own surface.
 *
 * An absent value renders NOTHING. Not "not reported", not "Not available", and
 * not a paragraph explaining the absence: a row that is not there is read as a
 * fact that was not established, where four sentences about why are read as a
 * fault. The one exception is the client id, because an app with no client id
 * cannot authenticate, and that is a state rather than a silence.
 *
 * AND THE ACCESS-CHECK ROW IS GONE. It printed when the access screen last
 * decided something, and that screen no longer runs: the row was on its way to
 * reporting a stale decision, or none, on a page whose own probes had just
 * answered. Whether a dependency is reachable is measured by the rows below this
 * card, under the reader's own sign-in, and this card must not imply that
 * anybody's access is unverified because a retired screen did not run.
 *
 * THE PROSE CAME BACK ONCE AND HAS GONE AGAIN. Between then and now the card
 * grew two full permission lists -- twenty-six monospace chips -- and a washed
 * three-line box telling the reader to sign in again. Both were added for a real
 * reason and both outgrew it: the lists were the working for a subtraction the
 * server already publishes as `missingScopes`, and two of the box's three lines
 * are now stated by What to fix, once, at the top of the same page. What is left
 * is the difference as a row and the action as a line, which is the shape of
 * every other fact here.
 */
import { Lock } from 'lucide-react';
import { Card } from './ui';
import { OAuthBadge } from './OAuthBadge';
import { UserIdentityChip } from './UserIdentityChip';
import { CopyButton, NOT_SET, StatusBadge } from './StatusBadge';
import {
  questionsRunAs,
  useDeploymentIdentity,
  type DeploymentIdentity,
} from './identity-panel-state';
// WHETHER to say it, decided away from this file. The condition is the part
// that must not vary between the surfaces that state it, and a card that
// decided for itself would eventually offer a fresh sign-in to somebody whose
// sign-in is fine -- which sends them round the loop this exists to end.
import { staleSignInNotice } from '../../shared/stale-sign-in';
import {
  OPTIONAL_USER_API_SCOPES,
  isOptionalUserApiScope,
  requiredMissingScopes,
} from '../../shared/optional-user-api-scopes';

/**
 * The `/api/identity` payload, as this card reads it.
 *
 * Extends `Identity` rather than restating a subset of it, because the OAuth
 * badge is handed this object whole and decides its state from `identitySource`
 * and `session`. A local shape that happened to omit either would draw a neutral
 * badge on a deployment whose sign-in had failed.
 */
/** A stamp as a reader's own local time, or '' when there is nothing to show. */
function when(iso: string | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString();
}

/** What one read of `/api/identity` established, or that it could not be read. */
/**
 * Whose grants the next question would be computed with, named.
 *
 * `app_service_principal` is the state a laptop with no Apps proxy in front of it
 * reports, and there the honest answer is the app's own client id rather than a
 * reader's address that nothing forwarded. Every other mode resolves to the
 * reader, because that is what on-behalf-of execution means, and the mode string
 * itself is never printed: it is an internal identifier and this row is read by
 * somebody deciding whether an answer could have used grants they do not have.
 */
/** One label-and-value line. Nothing renders when there is no value. */
function Fact({ label, wrap, children }: { label: string; wrap?: boolean; children: React.ReactNode }) {
  return (<div className="identity-fact" data-wrap={wrap ? 'true' : undefined}>
      <p className="identity-fact-label">{label}</p>
      <div className="identity-fact-value">{children}</div>
    </div>
  );
}

/**
 * A permission list, as chips.
 *
 * A LIST IS HERE BECAUSE THE SERVER SENDS READERS HERE. Three branches of
 * `scope-refusal.ts` end by saying this card lists what the sign-in carries and
 * what the app asks for, so the shortfall cannot be deleted or the remedy points
 * at nothing.
 *
 * WHAT WENT, AND WHY IT WAS TWO LISTS. It used to draw both in full: thirteen
 * chips for what the sign-in carries beside thirteen for what the app asks,
 * twenty-six monospace strings, five of them tinted, on a card whose subject is
 * two identifiers. It was by a wide margin the largest thing on the tab, and the
 * comparison it invited -- read both lists, spot the difference -- is arithmetic
 * the server had already done: `missingScopes` IS the difference. So the card
 * draws the answer and not the working.
 *
 * A declared permission the sign-in does not carry takes the amber rung rather
 * than the red one, for the reason the rest of the page does: the sign-in
 * authenticates fine and the shortfall may equally be an app that was never
 * restarted after the permission was added. Named in `title` as well as tinted,
 * because a colour is not a fact a screen reader can read.
 */
function ScopeList({
  scopes,
  missing,
  optional,
}: {
  scopes: readonly string[];
  missing?: ReadonlySet<string>;
  optional?: boolean;
}) {
  if (scopes.length === 0) return <span className="identity-fact-when">none</span>;
  return (
    <span className="identity-scopes">
      {scopes.map((scope) => {
        const absent = missing?.has(scope) ?? false;
        const title = absent
          ? `${scope} — this sign-in does not carry it`
          : optional
            ? `${scope} — optional (Connections / Ops catalog probes)`
            : scope;
        return (
          <span
            key={scope}
            className="identity-scope"
            data-absent={absent ? 'true' : undefined}
            data-optional={optional ? 'true' : undefined}
            title={title}
          >
            {scope}
          </span>
        );
      })}
    </span>
  );
}

/**
 * @param checkedAs The principal the preflight report says its checks ran under,
 *   when it resolved one. Carried in rather than fetched because the page that
 *   renders this already holds the report, and a second read of it here would
 *   let the two surfaces disagree about which identity did the work.
 * @param read A read the caller has already made, for the same reason. When it
 *   is absent this card makes its own, so a caller that only wants the card
 *   keeps working unchanged.
 * @param remedyStatedElsewhere Whether something else on the page already tells
 *   this reader to sign in again -- in practice, whether What to fix rendered.
 *
 *   THIS IS THE GATE ON SAYING IT TWICE, and it is a parameter rather than a read
 *   because the caller already holds the answer. What to fix draws when any check
 *   is not `ok`, and a reader whose sign-in is short of a declared permission
 *   normally has several: the panel then states the action once, over all of
 *   them, a few inches above this card. Repeating it here is the redundancy the
 *   last pass removed.
 *
 *   But the two conditions are not the same condition. A permission can be
 *   missing while nothing is blocked -- nothing this app probes happens to need
 *   the missing scope -- and then What to fix does not render at all and the
 *   action is on no surface. That is the hole this closes.
 *
 *   DEFAULTS TO FALSE, which is to say "nobody else is saying it". A card
 *   composed on its own has no panel beside it, so silence would be the wrong
 *   assumption: the failure this whole block exists to prevent is a reader who
 *   can see the shortfall and cannot see that ten seconds of their own would
 *   clear it.
 */
export function IdentityCard({
  checkedAs,
  read,
  remedyStatedElsewhere = false,
}: { checkedAs?: string; read?: DeploymentIdentity; remedyStatedElsewhere?: boolean } = {}) {
  const own = useDeploymentIdentity(!read);
  const { identity, failed } = read ?? own;

  // The endpoint's principal where a verification observed one, and the report's
  // where it resolved one. Two names for one fact, so the row prints whichever
  // exists and never both.
  const orchestrator = identity?.servingPrincipal?.id ?? checkedAs ?? '';
  const observedAt = when(identity?.servingPrincipal?.observedAt);
  const runsAs = questionsRunAs(identity);
  const runsAsPerson = identity?.analyticalExecution?.mode !== 'app_service_principal';
  const clientId = identity?.executionIdentity?.trim() ?? '';
  const session = identity?.session;
  const allMissing = session?.missingScopes ?? [];
  const requiredMissing = requiredMissingScopes(allMissing);
  const missingScopes = new Set(requiredMissing);
  const optionalMissing = new Set(allMissing.filter(isOptionalUserApiScope));
  /**
   * Whether this reader is being told to sign in again, and null wherever the
   * evidence does not support telling them.
   *
   * Kept separate from `missingScopes` above, which gates the shortfall ROW. The
   * row is evidence and is safe to show whenever there is a shortfall; this is an
   * instruction, and an instruction needs the narrower gate.
   *
   * And suppressed outright where the page already carries it, which is the
   * common case. Two gates, because they answer two questions: whether telling
   * this reader to sign in again is TRUE, and whether it has already been said.
   */
  const stale = remedyStatedElsewhere ? null : staleSignInNotice(session);

  return (<Card className="deployment-card deployment-card-identity" data-testid="identity-panel">
      <div className="deployment-card-head">
        <p className="deployment-card-title">
          <Lock className="size-3.5" aria-hidden="true" />
          Identity
        </p>
      </div>
      <div className="deployment-card-body">
        {failed ? (// One line, in the shape of every other value on the card: a chip that
        // says what state this is in. The four-sentence recovery instruction it
        // replaces told a reader to reload the page, which they can see for
        // themselves, and named the route, which they cannot act on.
        <Fact label="Identity">
            <StatusBadge value="could not be read" tone="blocked" />
          </Fact>
        ) : (<>
            {/* The badge first, because it is the fact that qualifies the name
                beside it: an address the app is only assuming is worth less than
                one a sign-in it read presented. Both come from the same read. */}
            {runsAs ? (<Fact label="Questions run as">
                <OAuthBadge identity={identity} />
                {runsAsPerson
                  ? <UserIdentityChip identity={runsAs} compact className="identity-principal" />
                  : <span className="identity-principal">{runsAs}</span>}
              </Fact>
            ) : null}
            <Fact label="App client id">
              {/* Red on an absence, which is the one place this card treats a
                  missing value as a state rather than as silence. An app with no
                  client id in its environment cannot authenticate its own writes,
                  so the absence IS the finding. */}
              <StatusBadge
                value={clientId || NOT_SET}
                tone={clientId ? 'reachable' : 'blocked'}
                testId="identity-client-id"
              />
              {clientId ? <CopyButton value={clientId} label="Copy the app client id" /> : null}
            </Fact>
            {orchestrator ? (<Fact label="Orchestrator">
                <StatusBadge value={orchestrator} tone="plain" />
                <CopyButton value={orchestrator} label="Copy the orchestrator principal" />
                {observedAt ? <span className="identity-fact-when">{observedAt}</span> : null}
              </Fact>
            ) : null}
            {/* THE SHORTFALL AS A ROW, which is what the two full lists became.
                A reader arriving here off a 403 wants to know which permission
                is short; they were given both lists and left to diff twenty-six
                strings by eye to find out. This is the same finding, already
                computed by the server, in the shape of every other fact on the
                card. */}
            {missingScopes.size > 0 ? (
              <Fact label="Missing permissions" wrap>
                <ScopeList scopes={[...missingScopes]} missing={missingScopes} />
              </Fact>
            ) : null}
            {/* Always listed, never hidden — including when this deploy left them
                off user_api_scopes. Optional Missing only when declared+absent. */}
            <Fact label="Optional permissions" wrap>
              <ScopeList
                scopes={[...OPTIONAL_USER_API_SCOPES]}
                missing={optionalMissing.size > 0 ? optionalMissing : undefined}
                optional
              />
            </Fact>
            {/* THE ONE THING A READER CAN DO, in one line, and only where nothing
                else on the page is saying it.

                It used to be three lines in a washed box: what happened, what to
                do, and what not to try instead. All three are stated by What to
                fix, once, over every refusal they explain, a few inches above
                this card -- so on the common path this block is silent and the
                panel does the talking.

                It is not deleted, because the two conditions differ. What to fix
                renders off BLOCKED CHECKS and this renders off a MISSING
                PERMISSION, and a deployment can have the second without the
                first: nothing this app probes needs the scope that is short. On
                that deployment the panel is not on screen and the action would be
                on no surface at all, which is how a reader ends up looking for a
                grant for something ten seconds of their own would fix.

                Two gates, then. `staleSignInNotice` decides whether telling them
                is TRUE -- a reader who holds every declared permission and is
                refused a GRANT is told nothing, because a private window hands
                them the same permissions and the same refusal -- and
                `remedyStatedElsewhere` decides whether it has already been
                said. */}
            {stale ? (<Fact label="To fix">
                <span className="identity-stale-do" data-testid="identity-stale">
                  {stale.action}
                </span>
              </Fact>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}
