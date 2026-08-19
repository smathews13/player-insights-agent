/**
 * Who administers this deployment, and whether the role actually works for them.
 *
 * TWO FACTS PER ROW, NEVER MERGED. The role is a name on a list. The access is a
 * pair of Unity Catalog grants, on the app's telemetry schema and on the billing
 * system tables, which are what Monitoring and Ops read. An admin without those
 * grants opens two empty pages, so a row that showed only the role would be
 * telling a reader the appointment worked when it half did.
 *
 * The states are decided in admin-list.ts and the words come from the server, so
 * this file is markup, ARIA and the fetch calls. The three things it is careful
 * about:
 *
 *   - The access state is asked for in a POST on load, because reconciling makes
 *     grants and a GET must not. Until it answers, rows say "Not checked", which
 *     is this app's words for not yet everywhere and is not "no access".
 *   - A refusal prints the statement somebody with authority runs, in the same
 *     copyable panel Connections uses, because the refusal is the app saying it
 *     lacks the authority and the reader is the one who can fix it.
 *   - Removing somebody says what access went back with the role, which is only
 *     what this app granted. Access a person held for another reason is left
 *     alone and the row says so.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Trash2, UserPlus } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from './ui';
import { BrandIcon } from './BrandIcon';
import {
  accessFor,
  addedOn,
  canSubmit,
  linkTargetFor,
  listSummary,
  namesNoObject,
  needsAttention,
  originLabel,
  stateWord,
  type AccessObject,
  type AccessResult,
  type AdminListEntry,
} from './admin-list';
import { OpenInDatabricks } from './DataEntityLinks';
import { reportEgress } from './egress-policy';
import type { AdminEditorPayload } from '../../shared/admin-contract';

/**
 * A statement in the shape Connections prints one: mono, on the code wash,
 * selectable whole, with the copy affordance beside it rather than over it.
 *
 * Deliberately the same panel and the same words. An admin who meets a refused
 * grant here and the same refused grant on the Ops page is looking at one problem,
 * and two presentations of it would read as two.
 */
export function CopyableCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (<div className="connections-command">
      <pre className="connections-code" aria-label={label}>
        {command}
      </pre>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(command);
          // A grant statement is printed BECAUSE the app could not run it, so
          // this path is permitted by default and copying it is the remedy
          // working. Recorded all the same: it names Unity Catalog objects and
          // a principal, and an administrator reading the log is entitled to
          // see that somebody took one. Here rather than at the four call
          // sites, so the roster editor is covered without being edited.
          reportEgress({ channel: 'grant-statement', itemCount: 1 });
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Copy className="size-3.5" /> {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

/**
 * One Unity Catalog object, named and openable.
 *
 * The name is mono because it is an identifier and the app sets identifiers in mono
 * everywhere else. The link is beside the name rather than on it, which is the
 * pattern Architecture and Connections settled on: leaving the app is its own
 * control, so one tab stop does not sometimes land in another origin.
 *
 * `OpenInDatabricks` renders nothing when no link can be built -- no
 * `DATABRICKS_HOST` in the container -- so the name still appears on a deployment
 * that cannot be linked out of. That is the point of it returning null rather than
 * a disabled-looking control.
 */
function AccessObjectName({ object }: { object: AccessObject }) {
  return (<span className="admin-access-object">
      <code className="admin-access-object-name" title={object.name}>{object.name}</code>
      <OpenInDatabricks name={object.name} object={linkTargetFor(object)} />
    </span>
  );
}

/**
 * One access target under one person: what it is, what it is for, and its state.
 *
 * WHAT CHANGED AND WHY. This row used to print a label, a state word, and a
 * sentence -- and the label was the phrase "Telemetry schema" or "Billing tables",
 * naming nothing. A reader could not check the access, could not go and look at the
 * data, and could not tell what the row was about. Worse, the sentence was the same
 * under both targets of every person, so the card spent two lines per row saying
 * nothing specific.
 *
 * Now: the objects are spelled out and linked, one line says what the access is
 * for, and the explanatory sentence appears only when it adds something the state
 * word and the names do not already carry. The states stay distinct -- already
 * held, granted just now and refused are three different facts -- and a refusal
 * still carries the exact statement somebody with authority runs.
 */
export function AccessLine({ result }: { result: AccessResult }) {
  const attention = needsAttention(result.state);
  return (<div className={`admin-access${attention ? ' admin-access-attention' : ''}`}>
      <div className="admin-access-head">
        <span className="admin-access-label">{result.label}</span>
        <span className="admin-uc-icon"><BrandIcon product="unity-catalog" size={12} /></span>
        {namesNoObject(result) ? <span className="admin-access-empty">not set</span> : (
          <span className="admin-access-objects">
            {result.objects.map((object, index) => (
              <Fragment key={object.name}>
                {index > 0 ? <span className="admin-access-separator"> · </span> : null}
                <AccessObjectName object={object} />
              </Fragment>
            ))}
          </span>
        )}
        <span className={`admin-access-state admin-access-state-${result.state}`}>{stateWord(result.state)}</span>
      </div>
      {/* Only when it adds something. Empty for 'already-held', where the state
          word beside a spelled-out name is the whole fact. */}
      {result.summary ? <p className="admin-access-summary">{result.summary}</p> : null}
      {result.note ? <p className="admin-access-note">{result.note}</p> : null}
      {result.grant ? (<CopyableCommand
          command={result.grant.statement}
          label={`Grant ${result.grant.privilege} on ${result.grant.object}`}
        />
      ) : null}
    </div>
  );
}

/**
 * The list itself, as a function of the payload and nothing else.
 *
 * Split from the editor below so the rows can be rendered in a test without a
 * fetch, a router or an effect. That matters more here than it usually does: the
 * claims worth defending are about what a row SAYS in each of the five access
 * states, and asserting them against the source of a component nobody rendered is
 * how this repository has shipped screens that were wrong while every test passed.
 */
export function AdminRows({
  payload,
  busy,
  onRemove,
}: {
  payload: AdminEditorPayload;
  busy: boolean;
  onRemove: (entry: AdminListEntry) => void;
}) {
  return (<>
      <p className="admin-list-note">
        {listSummary({
          entries: payload.entries,
          addedAdminsReadable: payload.addedAdminsReadable,
          seedAdminCount: payload.seedAdminCount,
        })}
      </p>

      <ul className="admin-list">
        {payload.entries.map((entry) => (<li key={entry.email} className="admin-row">
            <div className="admin-row-head">
              <div className="admin-row-who">
                <p className="admin-row-email">
                  {entry.email}
                  {entry.isYou ? <span className="admin-row-you">You</span> : null}
                </p>
                <p className="admin-row-origin">
                  {originLabel(entry)}
                  {addedOn(entry) ? ` on ${addedOn(entry)}` : ''}
                </p>
              </div>
              {/* Absent rather than disabled for a row that cannot be removed. A
                  greyed button a reader can never enable is a permanent
                  invitation to ask why, and the line above the row already says
                  the row was set at deployment. */}
              {entry.removable ? (<Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => onRemove(entry)}
                  aria-label={`Remove ${entry.email}`}
                >
                  <Trash2 className="size-3.5" /> Remove
                </Button>
              ) : null}
            </div>
            <div className="admin-row-access">
              {accessFor(entry.email, payload.access).map((result) => (<AccessLine key={result.target} result={result} />
              ))}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

export function AdminListEditor() {
  const [payload, setPayload] = useState<AdminEditorPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState('');
  const [notice, setNotice] = useState('');
  const reconciled = useRef(false);

  /**
   * The list, then the access.
   *
   * Two calls in one effect, and the order is the point. The GET is a pure read
   * and answers while a warehouse is still waking up, so the names appear
   * immediately. The POST reconciles, which is what gives an administrator set at
   * deployment the grants their role needs even though they never passed through
   * the Add button below, and it may take a cold warehouse to answer. The rows say
   * "Not checked" in between rather than "no access".
   *
   * The ref stops the reconcile running twice under React's development double
   * mount. It is idempotent, so a second run would be harmless, but it writes an
   * audit row when it changes something and one action deserves one row.
   */
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/admins');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setPayload((await response.json()) as AdminEditorPayload);
    } catch (cause) {
      setError((cause as Error).message);
      setLoading(false);
      return;
    }
    setLoading(false);
    if (reconciled.current) return;
    reconciled.current = true;
    try {
      const response = await fetch('/api/admins/access', { method: 'POST' });
      if (!response.ok) return;
      setPayload((await response.json()) as AdminEditorPayload);
    } catch {
      // The names are on screen and their access is unchecked, which the rows
      // already say. Nothing was granted and nothing is wrong with the list, so
      // this is not the place for an error banner.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    const email = draft.trim();
    setBusy(true);
    setWriteError('');
    setNotice('');
    try {
      const response = await fetch('/api/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = (await response.json()) as AdminEditorPayload & { detail?: string };
      if (!response.ok) {
        setWriteError(body.detail ?? 'The administrator was not added.');
        return;
      }
      setPayload(body);
      setDraft('');
      // "Added" and not "added, with access". Whether the access landed is on the
      // row, per target, and a summary line here claiming more than the row says
      // is the exact dishonesty this screen is built to avoid.
      setNotice(`${email} is now an administrator. Their access is below.`);
    } catch (cause) {
      setWriteError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: AdminListEntry) {
    setBusy(true);
    setWriteError('');
    setNotice('');
    try {
      const response = await fetch(`/api/admins/${encodeURIComponent(entry.email)}`, { method: 'DELETE' });
      const body = (await response.json()) as AdminEditorPayload & { detail?: string };
      if (!response.ok) {
        setWriteError(body.detail ?? 'Nobody was removed.');
        return;
      }
      setPayload(body);
      // What went back with the role, in the server's own words. Only what this
      // app granted is ever revoked, so this line is where a reader learns that
      // access somebody held for another reason was left alone.
      const revoked = body.access.find((report) => report.email === entry.email);
      const lines = (revoked?.results ?? []).filter((result) => result.state !== 'not-configured');
      setNotice(
        lines.length > 0
          ? `${entry.email} is no longer an administrator. ${lines.map((result) => result.summary).join(' ')}`
          : `${entry.email} is no longer an administrator.`,
      );
    } catch (cause) {
      setWriteError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (<Card>
      <CardHeader>
        <CardTitle>Roles</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? <p className="admin-list-note">Reading the list.</p> : null}

        {error ? (<p className="admin-list-note admin-list-error">
            The administrator list could not be read. Nobody has lost the role. Reload the page.
          </p>
        ) : null}

        {payload ? <AdminRows payload={payload} busy={busy} onRemove={(entry) => void remove(entry)} /> : null}
        {payload ? (
          <p className="admin-grants-footer">
            Telemetry feeds the Ops health block; billing feeds the Ops cost block.
          </p>
        ) : null}

        <div className="admin-add">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="name@example.com"
            aria-label="Email address of the administrator to add"
          />
          <Button disabled={!canSubmit(draft, busy)} onClick={() => void add()}>
            <UserPlus className="size-3.5" /> Add
          </Button>
        </div>
        {/* The removal rule, stated once for the card rather than once per target
            per person. It used to be the second half of every already-held row,
            which is where the repetition came from: the same sentence under every
            object of every administrator, saying something true about this screen
            rather than anything about the row it sat under. */}
        <p className="admin-list-note">
          Adding grants the role and requests the Unity Catalog access the role needs, under your own permissions. A
          refused grant still grants the role; the row says what is missing. Removing takes back only the access this
          app granted. Access marked Already held is left alone.
        </p>

        {/* One live region for both, because they are the same slot on screen and
            two regions would be two announcements for one action. */}
        <p className="admin-list-note admin-list-outcome" role="status" aria-live="polite">
          {writeError || notice}
        </p>
      </CardContent>
    </Card>
  );
}
