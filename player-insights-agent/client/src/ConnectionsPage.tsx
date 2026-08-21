/**
 * What this deployment is connected to, whether it can reach any of it, and
 * what it would take to change each one.
 *
 * This page used to be two. `/sources` reported live dependency checks as seven
 * capability cards, a table matrix and a health card; `/connections` reported
 * the same checks again as resource cards, because the settings route runs the
 * same orchestrator preflight server-side. Identity was on both. Remediation was
 * on both. The two were indistinguishable to the person they were for, who
 * described the settings gear as "just linking to the sources tab", and both
 * were built out of cards carrying roughly one status line each.
 *
 * The spine is now ONE ROW PER CONNECTION. Collapsed, a row is a line: what it
 * is, whether anything reached it, and what it is demonstrably using. Opened, it
 * becomes what used to be a whole card, and only then does it offer a control.
 *
 * The page keeps one rule from before the merge: never show an edit box for a
 * value this app cannot change. Most of what a deployer wants to point at their
 * own workspace, the Genie spaces, the catalog, the warehouse, is baked into the
 * MLflow model artifact at log time, and a form that accepted a new Genie space
 * id and saved it would report success while the orchestrator carried on using
 * the old one. Which affordance a row gets is decided in
 * `shared/deployment-config.ts` rather than here.
 */
import { useCallback, useMemo, useState } from 'react';
import { showsAdminSurfaces, useRole } from './role';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui';
import {
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Clock,
  Copy,
  ExternalLink,
  GitCommitHorizontal,
  Lock,
  Pencil,
  Save,
  Undo2,
  Wrench,
} from 'lucide-react';
// The official product marks, from the one module that pairs a product with its
// artwork. The Lucide glyphs above keep the actions and the generic concepts --
// the carets, pencils, padlocks and copies -- and never stand in for a product.
import { BrandIcon } from './BrandIcon';
// GitHub's own mark is not Databricks artwork and does not live in the brand
// directory. One copy, shared with the login gate. See GithubMark.tsx.
import { GithubMark } from './GithubMark';
// The word, the icon and the pending state, decided once for the whole app.
import { RefreshButton, RefreshControl } from './RefreshControl';
import { CONNECTED_RESOURCES, type ChangedBy } from '../../shared/deployment-config';
import { IdentityCard } from './IdentityPanel';
import { useDeploymentIdentity } from './identity-panel-state';
// The value that is its own verdict, and the affordance that carries the whole
// of it. Both are the design's, and both are shared with the identity card.
import { CopyButton, NOT_SET, StatusBadge, type StatusTone } from './StatusBadge';
// The egress record. This page keeps its own copy of the grant-statement panel,
// so the call has to be made here too or the channel reports from one site and
// not the other.
import { reportEgress } from './egress-policy';
// Build stamps are shortened consistently away from the markup, and so is the
// reading that decides whether each half of the deployment is working.
import { buildFacts, HEALTH_FAMILY, type BuildArtifact } from './connection-build';
// The one status recipe. Named as a meaning here, painted in astrolabe-tokens.css.
import { astPill } from './astrolabe-pill';
// What this deployment is, as against what it was built from. The two grids the
// Build card draws are decided there, so a row with nothing to say is dropped
// before the markup sees it.
import { deploymentRows, telemetryRows, type BuildRow } from './build-card';
import { UserIdentityChip } from './UserIdentityChip';
import { NO_APP_FACTS } from '../../shared/app-facts';
import { EntityHighlight } from './DataEntityLinks';
import { entityRowProps, isRequestedEntity, useRequestedEntity } from './data-entity-state';
import { entityRowId } from './data-entities';
import {
  checkBadgeVariant,
  checkVerdictLabel,
  formatCheckedAt,
  verdictBadgeVariant,
  type PreflightCheck,
} from './preflight';
// Refused, unreachable and not-checked-yet are three different next moves, and
// the words for them are decided in one place so a row and the strip counting
// the rows cannot disagree. See shared/check-verdict.ts.
import { CHECK_VERDICT_LABEL } from '../../shared/check-verdict';
// One mechanism runs the checks for the whole session, and both tabs read it.
import { NotebookCard } from './NotebookCard';
import { DeclaredConnectionsCard } from './DeclaredConnectionsCard';
import { ApplyDeclarationCard } from './ApplyDeclarationCard';
import { configurationValue, RESOURCE_PRODUCT, tableReachabilityCopy } from './connections-view';
import { useSessionChecks } from './session-checks';
import {
  DRIFT_MARKER_LABEL,
  truncateHead,
  visibleCounts,
  type ConnectionCounts,
} from './connection-status';
// One cause said once over every check that shares it, and one remedy said once
// over every cause it clears. See connection-causes.ts for why the cause key is
// a verdict, a sentence and a whole remedy rather than something looser.
import {
  affectedLabel,
  causeGroupHeadline,
  declaredTablesAside,
  groupByCause,
  groupByRemedy,
  sharedLabelPrefix,
  type BlockCause,
  type RemedyBlock,
} from './connection-causes';
// Which of the blocked checks a reader is actually being asked to do something
// about. A refusal over one of the three optional catalog reads is not one, and
// this panel is the last surface that was still presenting it as one. See
// optional-scope-findings.ts.
import {
  OPTIONAL_SCOPES_CHIP,
  OPTIONAL_SCOPES_LABEL,
  isOptionalScopeShortfall,
  optionalScopeNote,
  splitOptionalScopeFindings,
  type OptionalScopeShortfall,
} from './optional-scope-findings';
import {
  EMPTY_CATALOG_DENYLIST,
  EMPTY_DATA_CATALOGS,
  dataCatalogFormLabel,
  parseCatalogDenylist,
  parseDataCatalogEntries,
} from '../../shared/data-catalog-scope';
// Point and click instead of remembering an identifier. Which list a field
// browses, and what a chosen row actually stores, are decided in
// `asset-picker.ts` rather than in either editor below: the same two editors draw
// ten fields between them, and a mapping written at the call site would be
// written twice. The picker itself keeps the text input beside it, because
// catalog browse rides an optional scope and a sign-in without it must still be
// able to edit the row.
import { AssetPickerField } from './AssetPicker';
// The derivation itself -- which check belongs to which resource, which
// findings are about it, and what that makes its badge -- is shared with the
// Architecture page, which draws these same connections as a graph. See
// connection-model.ts for why that is one module rather than two readings.
import {
  allChecks,
  deploymentWideFindings,
  groupConnections,
  readConnections,
  readingsById,
  type ConnectionGroup,
  type ConnectionGroupKey,
  type ConnectionEntry,
  type ConnectionReading,
  type DriftSeverity,
  type ResourceRow,
} from './connection-model';

/**
 * The tone a section's rows carry, decided by the section they are in.
 *
 * `not-checked` and `configuration` are deliberately `plain`. Nobody looked, or
 * there was nothing to look at, so there is no verdict for a colour to be a
 * second reading of, and a third tint would make the two that mean something
 * harder to tell apart.
 */
const GROUP_TONE: Record<ConnectionGroupKey, StatusTone> = {
  blocked: 'blocked',
  drifted: 'drifted',
  // Amber, the same rung as drift and the same rung the count line gives it. A
  // refusal is the one unsettled state where something happened, and it must not
  // take red: nothing was established about these objects, so a reader must not
  // read them as dependencies that are down.
  refused: 'drifted',
  // Amber as well, on the same rung: nothing was established, so it must not take
  // red, and it is not a state to leave untinted either -- the headline drops its
  // tick while a dependency is unreachable.
  unreachable: 'drifted',
  reachable: 'reachable',
  'not-checked': 'plain',
  configuration: 'plain',
};

/**
 * Which Databricks product each kind of connection belongs to.
 *
 * The MARK for a product is `brand-icons.ts`'s business and only its business;
 * this is the other half of the join, which is a question only this page can
 * answer -- what kind of thing a row points at. Eighteen rows previously drew
 * the nearest Lucide shape to each product, a bot for the agent and a warehouse
 * for the warehouse, because the official artwork was not in the repository. It
 * is now, so they are the real marks.
 *
 * Keyed on `ResourceKind` and exhaustive by type, which is what makes a new kind
 * a compile error here rather than a row that silently draws nothing. Every kind
 * has a mark; the handoff's mapping covers all ten, so no row falls back.
 */
const SEVERITY_ICON: Record<DriftSeverity, typeof CircleAlert> = {
  blocking: CircleAlert,
  warning: CircleAlert,
  pending: Clock,
  unknown: CircleHelp,
  note: CircleHelp,
};

/**
 * What the retired capability cards knew that the resource registry does not.
 *
 * Six of the seven cards named a dependency that is already a row here, joined
 * through `actualFromCheck`, and five of their descriptions were the resource's
 * own `purpose` in slightly different words. Only the example question was
 * genuinely theirs: it is the one line on either page that says what a
 * dependency is FOR in the reader's own terms, so it survives inside the row
 * rather than being lost with the card around it.
 */
const CAPABILITY_EXAMPLES: Record<string, string[]> = {
  'genie-data': ['How many active players did we have last week?'],
  'genie-dictionary': ['What does \u201chighly engaged\u201d mean?'],
  'sql-warehouse': ['Check null ratios in the latest partition.'],
  'llm-endpoint': ['Why did retention move last month?'],
  'agent-endpoint': ['Compare engagement by title.'],
  // Both of Lakebase's, because the seventh card, "Knowledge files", had no
  // check behind it and a permanent "Not checked" badge. It was not a seventh
  // dependency: the uploads it described are stored in Lakebase, which is a row
  // here with a live check, and the volume that once held published knowledge
  // documents has read nothing at runtime since those were removed. So it folds
  // in here, where its badge becomes a measured one instead of a grey word that
  // could never change.
  lakebase: ['Reopen a conversation from last week.', 'Explain the cross-brand identity rules.'],
};

/**
 * Where a resolved value came from, said plainly.
 *
 * `artifact` is the only answer that means the model version vouches for the
 * value. Everything else is reported as what it is rather than smoothed over,
 * because "the orchestrator read this from a shell" is the defect the whole
 * provenance chain was added to expose.
 */
const SOURCE_WORDS: Record<string, string> = {
  artifact: 'from the model artifact',
  environment: 'from the process environment',
  profile: 'from a named profile',
  default: 'a compiled default',
  'app-environment': 'from the app container',
  'app-default': 'the app default, because no value was set',
  'app-saved': 'saved here, and in force ahead of the deployed value',
};

function tierBadgeVariant(tier: ChangedBy) {
  return tier === 'app-runtime' ? ('default' as const) : ('outline' as const);
}

/**
 * A statement in the shape the handoff's code panel asks for: mono, on the code
 * wash, selectable whole, with the copy affordance beside it rather than over it.
 */
function CopyableCommand({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="connections-command">
      <pre className="connections-code" aria-label={label}>
        {command}
      </pre>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(command);
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
 * One row of the Build and telemetry card, in whichever of the three shapes it is.
 *
 * The shape is decided in `build-card.ts` and not here: a table name, a sentence
 * and a list of tags are three different kinds of thing, and letting the markup
 * choose between them is how a description ended up in the monospace face.
 *
 * Exported for rendering rather than for reuse, for the same reason the rows
 * below it are: a static render of the page runs no effects, so the card is only
 * ever composed with facts in a test.
 */
export function BuildFactRow({ row }: { row: BuildRow }) {
  return (
    <div className="identity-fact" data-wrap={row.kind === 'chips' ? 'true' : undefined}>
      <p className="identity-fact-label">{row.label}</p>
      <div className="identity-fact-value">
        {row.kind === 'badge' ? (
          <>
            <StatusBadge value={row.value} tone={row.tone} title={row.full} testId={`build-${row.key}`} />
            {row.copyable ? <CopyButton value={row.full} label={`Copy the ${row.label.toLowerCase()}`} /> : null}
            {/* Opens the thing the row names, which is only ever offered for the
                app's own URL: it is the one value on this card that is a place a
                reader can go. */}
            {row.openable ? (
              <a
                className="deployment-open"
                href={row.full}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${row.full}`}
              >
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            ) : null}
          </>
        ) : null}
        {row.kind === 'text' ? ( // The exact figures where the row shows a shortened one, which today is
          // the telemetry span: two Delta stamps to the millisecond, printed
          // whole, wrapped this row over three lines.
          <p className="deployment-fact-text" title={row.title}>
            <span className="deployment-fact-lead">{row.value}</span>
            {row.aside ? <span className="deployment-fact-aside">{row.aside}</span> : null}
            {row.identity ? <UserIdentityChip identity={row.identity} label="by" compact /> : null}
          </p>
        ) : null}
        {/* A PLACE, NOT A VALUE. These two rows are the only ones on the card
            whose point is to be followed, so they are anchors and they carry
            the mark of whoever owns the destination: the official Databricks
            Apps mark for the workspace the app is running its source from, and
            GitHub's own octocat -- the login gate's, from one module -- for the
            published repository. A reader picks between them by the logo before
            they read the label. */}
        {row.kind === 'link' ? (
          <a
            className="deployment-fact-link"
            href={row.href}
            target="_blank"
            rel="noreferrer noopener"
            title={row.title}
            data-testid={`build-${row.key}`}
          >
            {row.mark === 'apps' ? (
              <BrandIcon product="apps" size={14} className="deployment-fact-mark" />
            ) : (
              <GithubMark className="deployment-fact-mark" />
            )}
            <span className="deployment-fact-link-text">{row.value}</span>
            {/* The same affordance the app endpoint row uses for the one other
                thing on this card a reader can open, so "this leaves the app"
                is said the same way twice rather than two ways. */}
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        ) : null}
        {row.kind === 'chips' ? (
          <span className="deployment-tags">
            {row.values.map((value) => (
              <span key={value} className="deployment-tag">
                {value}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One build stamp, and whether the half of the deployment it names is working.
 *
 * THE ROW WAS A VERSION STAMP AND WAS READ AS A STATUS. `App 5b0e675b` and
 * `Orchestrator 05d742b2`, two grey hashes, on the tab a reader opens to find out
 * what this deployment can reach: the commit answers which build is running and
 * says nothing about whether it is up, so a crashed app and a healthy one drew
 * the same row. The reading is decided in `connection-build.ts` -- what green and
 * red MEAN for each half is the part that has to be assertable without composing
 * a screen.
 *
 * THE IDENTIFIER IS STILL THE IDENTIFIER. It keeps the eight characters a commit
 * is recognised by, the whole hash in `title` and on the clipboard, and its copy
 * button: the health is added beside it and takes nothing away, because the
 * reason somebody comes to this row is often to paste the stamp into a ticket.
 *
 * AND THE WORD IS NOT DECORATION. The tint is the answer at a glance and the word
 * is the same answer for anybody who cannot see the tint, which is this app's
 * rule for every pill it draws.
 */
export function BuildStampRow({ artifact }: { artifact: BuildArtifact }) {
  return (
    <div className="identity-fact">
      <p className="identity-fact-label">{artifact.label}</p>
      <div className="identity-fact-value">
        {/* Eight characters, which is what a reader recognises a commit by, and
            the whole hash on the clipboard: `git show` takes the short one, but a
            paste into a message or a ticket wants the full string. */}
        <StatusBadge
          value={artifact.short || NOT_SET}
          tone={artifact.tone}
          title={artifact.full || NOT_SET}
          testId={`build-${artifact.key}`}
        />
        {artifact.full ? (
          <CopyButton value={artifact.full} label={`Copy the ${artifact.label} commit`} />
        ) : null}
        {/* Nothing at all where nothing was measured. A neutral pill there would
            put a verdict-shaped element on a row that has no verdict, which is
            how a page teaches a reader that its badges mean nothing. */}
        {artifact.health.state === 'unknown' ? null : (
          <span
            className={astPill(HEALTH_FAMILY[artifact.health.state], 'deployment-health')}
            data-health={artifact.health.state}
            data-testid={`build-${artifact.key}-health`}
            title={artifact.health.note}
          >
            {artifact.health.label}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A block that is a heading until somebody wants it.
 *
 * A plain button and a conditional child rather than an animated primitive: the
 * table matrix below is the landing target for `?entity=` deep links, and the
 * highlighted row has to be in the document and scrollable on the first commit
 * after that URL is opened.
 */
function Disclosure({
  open,
  onToggle,
  summary,
  aside,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  summary: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="connection-block">
      <button type="button" className="connection-block-summary" aria-expanded={open} onClick={onToggle}>
        <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="connection-block-label">{summary}</span>
        {aside ? <span className="connection-block-aside">{aside}</span> : null}
      </button>
      {open ? <div className="connection-block-body">{children}</div> : null}
    </section>
  );
}

/**
 * One blocked dependency and the literal statement that unblocks it.
 *
 * The remedy is rendered as selectable text rather than prose about it, because
 * the whole value of this page for a new workspace is that an admin can copy the
 * line out of it.
 */
/**
 * The design's counts line, over ONE population: the rows drawn below it.
 *
 * These five counts used to be taken from two. Reachable, blocked and not-checked
 * came off the CHECK list -- twenty-four of them against this deployment, twelve
 * being individual tables that the list draws as a single "Declared tables" row --
 * while drifted and pending came off the nineteen resource rows. So the line read
 * "24 reachable · 0 blocked · 0 not checked" directly above four rows badged "Not
 * checked" and four badged "Nothing to reach". A summary a reader can disprove by
 * counting the screen is worse than no summary, and this one invited the count by
 * printing the total.
 *
 * "Nothing to reach" is shown only when there is some, and it is shown rather than
 * folded into "not checked" for two reasons: without it the parts do not sum to
 * the number of rows on screen, and "nobody looked" is a different claim from
 * "there is nothing to look at". The row badges keep those apart, so this does.
 *
 * A count of nothing is not RENDERED, which is the stronger form of the rule
 * this line used to keep. It was already true that a zero was not tinted, and
 * that was not enough: the line printed "0 blocked · 0 not checked · 0 drifted ·
 * 0 pending" on a healthy deployment, so four of its six phrases named states
 * the deployment was not in and a reader had to read all four to learn that.
 * Which counts survive is decided in `visibleCounts`, beside the counting, so
 * this component cannot acquire an opinion of its own about it.
 *
 * Each count carries its own word, so the colour is a second reading of
 * something already stated in text rather than the only carrier of it.
 */
export function ConnectionsCounts({ counts }: { counts: ConnectionCounts }) {
  const shown = visibleCounts(counts);
  return (
    <>
      {shown.map((entry, index) => (
        <span key={entry.key}>
          {index > 0 ? ' · ' : ''}
          {/* The figure in mono and the word beside it in DM Sans. The tone is on
              the pair, so a tinted count colours its number and its word
              together and the colour stays a second reading of the word rather
              than of the digits alone. */}
          <span className="connections-count" data-tone={entry.tone}>
            <span className="ast-num">{entry.count}</span> {entry.word}
          </span>
        </span>
      ))}
    </>
  );
}

/**
 * The declared tables, three columns, as the design has them: Table, Status, Detail.
 *
 * The arrival row is SAID as well as tinted. A reader who followed a table name out
 * of an answer lands on twelve near-identical monospace rows with one of them washed
 * blue, and a wash is a decoration until something names it -- the tint and
 * `aria-current` left that fact carried entirely by colour and by a screen reader,
 * so a sighted reader arriving here had to infer why one row looked different. The
 * sentence is PREFIXED to the workspace's own detail rather than replacing it,
 * because what the workspace said about the table is the reason the reader came.
 *
 * Whether a row is the arrival is asked of `isRequestedEntity`, the same predicate
 * `entityRowProps` uses for the tint. Two comparisons would be two chances to
 * disagree about case or trailing space, and disagreeing here means washing one row
 * and captioning another.
 */
export function DeclaredTablesTable({
  tableChecks,
  requestedEntity,
  checkedAt = '',
}: {
  tableChecks: readonly PreflightCheck[];
  requestedEntity: string;
  checkedAt?: string;
}) {
  return (
    <Table className="connections-table">
      <TableHeader>
        <TableRow>
          <TableHead>Table</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Detail</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tableChecks.map(
          (
            check // Addressable and, when an answer linked here, highlighted. The row is
          ) => (
            // the entry an entity link lands on, so it carries the id rather than
            // the block around it.
            <TableRow key={check.id} {...entityRowProps(check.name, requestedEntity)}>
              <TableCell className="connections-table-name">{check.name}</TableCell>
              {/* THE WORD, NOT THE STATUS. Every row here read `Not checked`
                beside a Detail of `HTTP 403`, which contradicts itself on one
                line: a call the workspace refused was made. `checkVerdict`
                separates a refusal from a broken call and from a probe nobody
                ran, and the strip above this table counts through the same
                function so the two cannot disagree. */}
              <TableCell>
                <Badge variant={checkBadgeVariant(check)}>{checkVerdictLabel(check)}</Badge>
              </TableCell>
              {/* A STATUS, NOT AN ESSAY. This cell used to print the check's whole
                detail, and on this deployment one missing OAuth scope gives all
                twelve of these rows the same three-sentence diagnosis: opening
                the section meant reading it twelve more times. The first
                sentence is the part that is about THIS table, which is what the
                workspace said about it or the code it answered with. The
                reasoning is stated once, on the group in What to fix, and the
                whole sentence is still here in a title. */}
              <TableCell title={tableReachabilityCopy(check, checkedAt).title}>
                {isRequestedEntity(check.name, requestedEntity) ? (
                  <span className="connections-table-arrival">Linked from the answer you followed here. </span>
                ) : null}
                {tableReachabilityCopy(check, checkedAt).row}
              </TableCell>
            </TableRow>
          )
        )}
      </TableBody>
    </Table>
  );
}

/**
 * The declared Unity Catalog matrix and its asset controls are one list.
 *
 * It starts open because the rows are the reason this section exists. The
 * disclosure remains available for readers who have already checked them.
 */
export function DeclaredTablesSection({
  tableChecks,
  requestedEntity,
  checkedAt = '',
  entries,
  storeAvailable = true,
  allowMutations = false,
  onChanged,
}: {
  tableChecks: readonly PreflightCheck[];
  requestedEntity: string;
  checkedAt?: string;
  entries?: ConnectionEntry[];
  storeAvailable?: boolean;
  allowMutations?: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen((was) => !was)}
      summary="Unity Catalog tables"
      aside={declaredTablesAside(tableChecks)}
    >
      <DeclaredTablesTable tableChecks={tableChecks} requestedEntity={requestedEntity} checkedAt={checkedAt} />
      <DeclaredConnectionsCard
        entries={entries}
        storeAvailable={storeAvailable}
        allowMutations={allowMutations}
        onChanged={onChanged}
      />
    </Disclosure>
  );
}

/** Concise table-specific reachability, without repeating the probing identity. */
/**
 * ONE CAUSE inside a block: what it is, and what it alone says.
 *
 * The chip and the sentence are the cause's own, because two causes in one block
 * fail for genuinely different reasons -- four API families, four permissions --
 * and printing one sentence over all of them would assert a permission over
 * objects that were refused over another. What they agree on is not here; it is
 * said once by the block (DECISIONS.md D10).
 */
function FixCause({ cause }: { cause: BlockCause }) {
  const many = cause.checks.length > 1;
  // The catalog and schema every member shares, lifted out of the list so the
  // twelve entries carry the part that differs. Empty for a group of one, and
  // for a group whose labels share nothing.
  const prefix = sharedLabelPrefix(cause.checks.map((affected) => affected.label));
  return (
    <div className="connections-fix-cause" data-affected={cause.checks.length}>
      <div className="connections-fix-problem-head">
        <span className="connections-fix-problem-label">{causeGroupHeadline(cause)}</span>
        {/* ONE CHIP FOR THE CAUSE, which is the design's rule and is also the
            honest reading: every check in a cause shares its verdict, because
            the verdict is part of what collects them. A chip repeated down
            twelve rows was twelve statements of one fact.

            The word is the verdict rather than the status, so a refusal does not
            read "Not checked" over a call the workspace answered. */}
        <Badge variant={verdictBadgeVariant(cause.verdict)}>{CHECK_VERDICT_LABEL[cause.verdict]}</Badge>
        {/* ON THE SAME LINE AS THE OBJECT IT IS ABOUT, which is the whole of
            what a reader wants from a finding: what, and why. It was a
            paragraph of its own under the head, so every cause took two lines
            and a panel of four took eight before it said anything a reader
            could act on. Sam's word for the result was "clunky".

            Only what the block does not already say. Usually one sentence,
            naming the permission this cause turns on; empty when the block
            holds a single cause, because then everything it says is shared and
            is stated once below. */}
        {cause.own ? <span className="connections-fix-problem-cause">{cause.own}</span> : null}
      </div>
      {/* The objects this cause is holding up, compactly, so a reader can see
          "one permission, twelve tables" without scrolling through twelve copies
          of the explanation to count them. */}
      {many ? (
        <div className="connections-fix-affected">
          <p className="connections-fix-affected-label">
            {prefix ? (
              <>
                Affected, in <code>{prefix}</code>
              </>
            ) : (
              <>Affected</>
            )}
          </p>
          <ul>
            {cause.checks.map((affected) => (
              <li key={affected.id} title={affected.label}>
                {affectedLabel(affected.label, prefix)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * ONE REMEDY, STATED ONCE, over every cause it clears.
 *
 * WHAT THIS BLOCK USED TO BE. It was one block per failing item, and on this
 * deployment a single stale sign-in refuses four API families at once. So the
 * panel printed the same three-line instruction about private browsing windows
 * four times over, plus the same sentence about signing out of Databricks, and a
 * reader crossed roughly twenty lines of identical advice to learn one thing:
 * that there is one move, and it clears all of it. Which the page never actually
 * said. Before that it was worse -- one block per CHECK, so twelve tables meant
 * twelve copies.
 *
 * Now the remedy is the block and the causes are rows in it. The sentences every
 * cause shares are lifted above them and said once; each cause keeps the one
 * sentence that is about it.
 *
 * The grouping itself is in `connection-causes.ts`, deliberately away from the
 * markup, so which checks belong together is assertable without composing a
 * screen and the page cannot grow a second reading of it. A block of one cause
 * renders what a single check rendered before: the label, the chip, the sentence
 * and the remedy.
 *
 * Exported for rendering, not for reuse: nothing else on the app composes one.
 * A page render under `renderToStaticMarkup` runs no effects, so
 * `ConnectionsPage` itself only ever composes its empty state in a test and this
 * panel is unreachable from there. The alternative was asserting the panel's
 * source text, and this repository has twice shipped a wrong screen past exactly
 * that kind of assertion -- including a source row whose separator was missing
 * while every claim about the file was true.
 */
export function PreflightRemedyBlock({ block }: { block: RemedyBlock }) {
  const headline = causeGroupHeadline(block.causes[0]);
  return (
    <div className="connections-fix-problem" data-causes={block.causes.length}>
      <div className="connections-fix-causes">
        {block.causes.map((cause) => (
          <FixCause key={cause.key} cause={cause} />
        ))}
      </div>
      {/* WHAT THEY ALL SAY, ONCE, under the list of what they are. Below the
          causes rather than above them because a reader arriving at this panel
          wants to know which objects are affected before they read why; four
          shared sentences at the top pushed the object names off the first
          screen. */}
      {/* Small and grey, which is a change of rank rather than of content. What
          these sentences carry is the caveat, not the finding: that a refusal
          stopped before the object, so nothing was established about whether
          the reader can reach it, and that it is therefore not a grant they are
          missing. That has to stay on the page, and it must not outweigh the
          line naming the object or the line saying what to do. */}
      {block.shared ? (
        <p className="connections-fix-problem-detail connections-fix-problem-shared">{block.shared}</p>
      ) : null}
      {block.remedy ? (
        <>
          {/* A `ui` remedy is the reader's own move in their own browser, and
              setting it as code is what made forty lines of shell the answer to
              a stale sign-in. A private window is not something anyone pastes
              into a terminal, and a `<pre>` around it sends somebody looking
              for one. Everything a workspace runs still gets the code block:
              a statement set as prose is a statement somebody retypes, and
              retyping a backtick-quoted principal is where that goes wrong. */}
          {block.remedy.kind === 'ui' ? (
            <p className="connections-fix-problem-do">{block.remedy.statement}</p>
          ) : (
            <pre className="connections-code" aria-label={`Fix for ${headline}`}>
              {block.remedy.statement}
            </pre>
          )}
          {/* THE ONE LINE THE STATEMENT CANNOT CARRY, and only where there is
              one. This is what is left of the "Why this is the fix" fold: the
              fold came off for reading as narrative, the server went on
              generating the paragraph, and it reached no screen, so a blocked row
              carried an instruction and no reasoning at all. Almost every remedy
              now says nothing here, because almost every statement is complete on
              its own.

              Inline and unwrapped on purpose. Not a disclosure, because a reader
              who has to open something to find out the grant they just ran was
              not sufficient will not open it. Not a heading, because one sentence
              under a heading is two lines to carry one. */}
          {block.remedy.guidance ? <p className="connections-fix-problem-guidance">{block.remedy.guidance}</p> : null}
          {/* Where to run it and WHO can, kept whole. A statement somebody
              cannot place is a statement they cannot run, and this line is the
              only thing on the page that says which surface it belongs to.

              Who could run it was the missing half, and it was missing from the
              page entirely once the panel's lead paragraph turned out to be
              wrong about it. A reader holding a GRANT they lack the authority to
              execute has been given a task rather than a fix, and the two
              authorities differ: a Unity Catalog grant needs the metastore admin
              or the object's owner, and a workspace object's permissions need
              somebody who can manage that object. */}
          {/* `run_by` overrides both defaults, and the case it exists for is
              the one where both are wrong: a scope the app never declared is
              fixed in this repository and by a restart, so sending the reader
              to a metastore admin or an object owner is sending them to
              somebody with nothing to do. */}
          {block.remedy.kind === 'ui' ? null : (
            <p className="connections-fix-problem-who">
              {block.remedy.run_by ||
                (block.remedy.kind === 'sql'
                  ? 'Run in a SQL editor as a metastore admin or the object\u2019s owner'
                  : 'Run with the Databricks CLI as a workspace admin, or as someone who can manage this object')}
            </p>
          )}
        </>
      ) : (
        // KEPT, AND SAID ONCE. This is a real remedy -- it names the two things
        // that would clear the fault -- and it used to be repeated under every
        // cause that had no statement. One block collects all of them, so it is
        // stated here and phrased short.
        <p className="connections-fix-problem-note">
          {block.causes.length > 1
            ? 'No statement can fix these. They need the dependency to exist, or the agent redeployed with it declared.'
            : 'No statement can fix this one. It needs the dependency to exist, or the agent redeployed with it declared.'}
        </p>
      )}
    </div>
  );
}

/**
 * One check's block, which is a block of one cause of one check.
 *
 * Kept as the way a single blocked check is drawn, so the case a reader meets on
 * a deployment with one fault is composed by the same code as the case with
 * twelve. A separate single-check renderer is how the two came apart the last
 * time this panel was rebuilt.
 */
export function PreflightRemedyRow({ check }: { check: PreflightCheck }) {
  return <PreflightRemedyBlock block={groupByRemedy(groupByCause([check]))[0]} />;
}

/**
 * The optional catalog permissions, once, neutrally, and OUTSIDE "What to fix".
 *
 * WHAT IT REPLACES. Three of the four blocks in that panel were these: a block
 * for the catalog, one for the schema, and one collecting twelve tables with
 * their twelve names listed under it. Each carried a full diagnosis and each was
 * headed by a chip, inside a red-edged section titled "What to fix", for three
 * permissions this app records as optional and no ask needs. A reader was being
 * asked to go and repair something the app had already decided it can do without.
 *
 * ONE LINE, and the shape of it follows the login gate and the Identity card
 * rather than inventing a fourth: the same label those two use for these same
 * names, the names themselves as values, and the NEUTRAL pill rather than the
 * red one. What is deliberately not borrowed is the gate's word "Not granted",
 * which those surfaces earn by reading the token's own scope list and this one
 * does not; see {@link OPTIONAL_SCOPES_CHIP}.
 *
 * The affected objects are not listed. They are the declared tables, and every
 * one of them has a row of its own in the Unity Catalog tables section below
 * with the workspace's own words on it. Listing twelve names here as well is
 * what the panel was doing, and it is what a reader called clunky.
 */
export function OptionalScopeLine({ shortfall }: { shortfall: OptionalScopeShortfall }) {
  if (shortfall.checks.length === 0) return null;
  return (
    <div className="connections-optional-scopes" data-testid="connections-optional-scopes">
      <p className="connections-optional-scopes-head">
        <span className="connections-optional-scopes-label">{OPTIONAL_SCOPES_LABEL}</span>
        {shortfall.scopes.map((scope) => (
          <code key={scope}>{scope}</code>
        ))}
        <span className="ast-pill ast-pill--neutral">{OPTIONAL_SCOPES_CHIP}</span>
      </p>
      <p className="connections-optional-scopes-note">{optionalScopeNote(shortfall.checks.length)}</p>
    </div>
  );
}

/**
 * One connection: a line until it is opened, a case file after.
 *
 * The collapsed line carries the two facts a reader scans eighteen rows for:
 * whether anything reached this dependency, and what it is demonstrably using.
 * Everything else, the configured value beside the used one, the drift, the
 * remedy, the tier, and the control, waits inside, because a row that offered
 * all of that at rest is the card this replaces.
 *
 * Exported for the same reason as `PreflightRemedyRow`: the padlock-versus-pencil
 * affordance and the configured/in-use pair are only decidable from composed
 * markup, and the page cannot compose either without effects having run.
 */
export function ConnectionRow({
  reading,
  tone,
  onSave,
  onClear,
  saving,
  requested,
  refreshing,
  catalogInUse = '',
  allowMutations = false,
}: {
  /**
   * The whole reading, derived once by `readConnections` and handed down.
   *
   * The row used to take a payload row, a check and a list of findings and
   * derive the reading itself, which meant the page derived every reading twice
   * -- once for the counts, once per row -- from two different call sites that
   * were one edit away from disagreeing about a row's verdict.
   */
  reading: ConnectionReading;
  /**
   * The colour its section carries.
   *
   * Passed in rather than decided here, because the STATUS IS SAID ONCE, in the
   * section header above, and the tint on this row is a second reading of that
   * header rather than a claim of its own.
   */
  tone: StatusTone;
  /** Resolves true when the server took the value, false when it refused it. */
  onSave: (value: string) => Promise<boolean>;
  onClear: () => Promise<void>;
  saving: boolean;
  /**
   * The entry a link asked this page to show, when it named this one.
   *
   * The Architecture page's nodes link here, and a node that opened the page at
   * a row the reader then has to find themselves has not taken them anywhere.
   */
  requested: boolean;
  /** Whether a refresh is in flight, so this row's badge is being re-decided. */
  refreshing: boolean;
  /**
   * The catalog this deployment is configured with, for the schema picker.
   *
   * The App schema row stores a bare schema name, so nothing in the row itself
   * says which catalog to list. The page holds every row and passes it down;
   * empty means the picker opens on the catalog list instead, which is the
   * correct behaviour rather than a degraded one.
   */
  catalogInUse?: string;
  /** Administrators only may stage or save. Consumers still see the row. */
  allowMutations?: boolean;
}) {
  // `problems` is every finding but the pending one, which says what the
  // Intended banner directly above it already says, and two statements of one
  // fact read as two problems. `remote` is whether anything out there could be
  // asked about this value; where nothing could, the row says there is nothing
  // to measure against rather than "not measured", which would invite a search
  // for a discrepancy that cannot exist.
  const { row, check, problems, disagrees, remote, status, marker, summary, driftCount } = reading;
  const { resource } = row;
  const displayValue = check?.display_name?.trim() || summary.value;
  const rawValue = displayValue && displayValue !== summary.value ? summary.value : '';
  const canWrite = Boolean(allowMutations);
  // Open on arrival when a link named this row. The collapsed line carries the
  // value and its verdict; the reason for either is inside, and somebody who
  // followed a link from a diagram came for the reason.
  const [open, setOpen] = useState(requested);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.intended ?? row.configured);

  const examples = CAPABILITY_EXAMPLES[resource.id] ?? [];

  /**
   * Whether THIS row is one a refresh will re-decide.
   *
   * A row the app both resolves and applies has no remote end, so a refresh
   * cannot change its badge and saying "Refreshing" over it would promise an
   * answer that is never coming. Every other row's badge is about to be
   * restated, and until it is, the one on screen is a reading of a moment that
   * has passed: showing it unchanged during the wait is how a button that
   * appears to do nothing came to look broken.
   */
  const restating = refreshing && status !== 'nothing-to-reach';

  /**
   * Closed only when the server took it.
   *
   * Closing either way discarded the typed value on a refusal and left a row
   * that looked exactly like one that had saved, with the old value in it, and
   * the banner explaining why potentially a screen further up.
   */
  const commit = async () => {
    if (await onSave(draft.trim())) setEditing(false);
  };

  return (
    <div
      className="connection-row"
      id={entityRowId(resource.id)}
      data-testid={`connection-${resource.id}`}
      data-status={status}
      data-refreshing={restating ? 'true' : undefined}
      data-open={open ? 'true' : undefined}
      data-highlighted={requested ? 'true' : undefined}
      // Announced as well as tinted, the same pairing the table matrix uses: a
      // reader who cannot see the wash still has to be told which of eighteen
      // rows the link they followed was about.
      aria-current={requested ? 'location' : undefined}
    >
      <button
        type="button"
        className="connection-row-summary"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        {/* Which product this connection is to, as its own mark rather than a
            word or an approximation of one. Decorative: the product's name is
            in the label immediately beside it, so a mark that announced itself
            would have a screen reader read the product twice. */}
        <BrandIcon product={RESOURCE_PRODUCT[resource.kind]} className="connection-row-product" />
        <span className="connection-row-label">{resource.label}</span>
        {/* THE VALUE IS THE VERDICT. This line used to carry a status chip and,
            beside it, the value in plain text: two columns to read per row, and
            the same word repeated down a page of eighteen. The status is said
            once, in the section header above, and the tint on the value here is
            a second reading of it.

            `aria-live` on the value rather than on the page: a screen reader
            hears this row's verdict change, which is the fact that changed,
            instead of nineteen of them being read out at once. */}
        <span className="connection-row-value" aria-live="polite" aria-busy={restating || undefined}>
          <StatusBadge
            value={restating ? 'Refreshing\u2026' : truncateHead(displayValue || NOT_SET)}
            tone={restating ? 'plain' : summary.value ? tone : 'plain'}
            title={summary.value || NOT_SET}
          />
          {!restating && rawValue ? (
            <code className="connection-row-raw-id" title={rawValue}>
              {rawValue}
            </code>
          ) : null}
        </span>
        {/* Announced, not drawn. A row in the Drifted section is under a header
            that says so, and repeating it per row is what the chip did; the
            count is the one thing the header cannot carry, and a reader who
            cannot see which section they are in still needs the verdict. */}
        {marker !== 'none' ? (
          <span className="sr-only">
            {DRIFT_MARKER_LABEL[marker]}
            {marker === 'drift' && driftCount > 1 ? ` ×${driftCount}` : ''}
          </span>
        ) : null}
        {/* The mutability tier, reduced to the one bit of it that is worth a
            glance: whether opening this row will offer anything to do. The
            label and the paragraph behind it are inside, next to the control
            they describe, which is where the question "why can I not change
            this?" is actually asked. */}
        {/* Both carry the attribute, not just the pencil. The two icons are the
            design's promise about what opening the row will offer, and with only
            one of them labelled there was no way to assert that the OTHER case
            draws a padlock rather than nothing at all -- which is how an icon
            silently disappears and the row reads as offering an edit it does
            not. */}
        {canWrite ? (
          <Pencil className="size-3.5 shrink-0 connection-row-affordance" data-affordance="write" />
        ) : (
          <Lock className="size-3.5 shrink-0 connection-row-affordance" data-affordance="locked" />
        )}
        <span className="sr-only">{canWrite ? row.changedByLabel : `${row.changedByLabel}, not changeable here`}</span>
      </button>

      {open ? (
        <div className="connection-row-detail">
          <div className="connection-pair">
            <div className="connection-tile">
              <p className="connection-tile-label">Configured</p>
              <p className="connection-tile-value">{row.configured || 'not set'}</p>
              {row.configuredFrom ? (
                <p className="connection-tile-note">{SOURCE_WORDS[row.configuredFrom] ?? row.configuredFrom}</p>
              ) : null}
            </div>
            {/* Red only when the two readings disagree, which is the one case on
                this page where a value is evidence of a fault rather than a
                report of a state. */}
            <div className="connection-tile" data-disagrees={disagrees ? 'true' : undefined}>
              <p className="connection-tile-label">In use</p>
              {row.actualObserved ? (
                <>
                  <p className="connection-tile-value">{row.actual}</p>
                  <p className="connection-tile-note">
                    {disagrees ? 'differs from what is configured' : 'reached from inside the endpoint'}
                  </p>
                </>
              ) : (
                <>
                  <p className="connection-tile-value connection-tile-unmeasured">
                    {remote ? 'Not measured' : 'Nothing to measure it against'}
                  </p>
                  {/* Only the pending state. The check's own sentence used to be
                      printed here, and its tail is the clause naming what a
                      metadata read does not prove -- which the failure alert
                      below already carries in full where it is a failure, and
                      which is narration where it is a pass. */}
                  {restating ? <p className="connection-tile-note">{'Refreshing this one now\u2026'}</p> : null}
                </>
              )}
            </div>
          </div>

          {/* The failure in the dependency's own words. The statement that fixes
              it is not repeated here: it is in What to fix at the top of the
              page, once, alongside every other blocked check including the
              table ones that have no row to live in.

              AND ONLY WHERE IT REALLY IS. The catalog and the schema have rows of
              their own, and a refusal over one of the optional catalog reads is
              no longer drawn in that section, so pointing a reader up the page at
              a statement that is not there would send them looking for something
              this app deliberately stopped saying. The row still reports what the
              workspace said, which is the row's job. */}
          {check && check.status !== 'ok' ? (
            <Alert>
              <CircleAlert />
              <AlertDescription>
                {check.error || check.detail}{' '}
                {check.remedy && !isOptionalScopeShortfall(check)
                  ? 'The statement that fixes this is under \u201cWhat to fix\u201d above.'
                  : ''}
              </AlertDescription>
            </Alert>
          ) : null}

          {row.intended ? (
            <Alert>
              <Clock />
              <AlertDescription>
                {/* One span, because the description slot is a grid and every
                    direct child of it takes a row of its own. Unwrapped, the
                    <strong> was one row and the clause after it was another
                    that began with a comma. The sentence is one child now, so
                    it is one row and wraps as prose. */}
                <span>
                  <strong>Intended: {row.intended}</strong>, recorded
                  {row.intendedBy ? ` by ${row.intendedBy}` : ''}
                  {row.intendedAt ? ` on ${formatCheckedAt(row.intendedAt)}` : ''}. Not applied.
                </span>
              </AlertDescription>
            </Alert>
          ) : null}

          {problems.map((finding) => {
            const Icon = SEVERITY_ICON[finding.severity];
            return (
              <Alert key={finding.id}>
                <Icon />
                <AlertDescription>
                  <strong>{finding.headline}.</strong> {finding.detail}
                </AlertDescription>
              </Alert>
            );
          })}

          {examples.length > 0 ? (
            <div className="connection-row-examples">
              <span>Try asking</span>
              <ul>
                {examples.map((example) => (
                  <li key={example}>{example}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* The badge says what pressing the button below will do, because that
              is the question asked here; the tier that decides it keeps its own
              name at the head of the sentence beside it. A row the app cannot
              apply says so before it offers anything, and it never offers a
              control that claims otherwise. */}
          {/* Chip, sentence and control on ONE line, with the control pushed to
              the far end, which is the design's arrangement and reads as one
              statement-and-its-consequence instead of three stacked blocks. The
              button group is inside this row rather than under it precisely
              because the badge is what says what pressing it will do: separated,
              a reader had to hold "Recorded, not applied" in their head across a
              paragraph to understand why the button did not say Save. The editor
              is still its own block below, because it is a form and not an
              affordance. */}
          <div className="connection-row-tier">
            <Badge variant={tierBadgeVariant(resource.changedBy)}>
              {row.editable ? <Pencil className="size-3" /> : <Lock className="size-3" />}
              {!row.editable && canWrite ? 'Recorded, not applied' : row.changedByLabel}
            </Badge>
            {!row.editable && canWrite ? (
              <p className="connection-row-tier-note">
                <strong>{row.changedByLabel}.</strong>
              </p>
            ) : null}
            {!editing && allowMutations && (canWrite || row.intended) ? (
              <div className="connection-row-tier-actions">
                {canWrite ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDraft(row.intended ?? row.configured);
                      setEditing(true);
                    }}
                  >
                    <Pencil className="size-3.5" /> {row.editable ? 'Change' : 'Record intended value'}
                  </Button>
                ) : null}
                {row.intended ? (
                  <Button variant="ghost" size="sm" disabled={saving} onClick={() => void onClear()}>
                    <Undo2 className="size-3.5" /> Discard intention
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          {resource.id === 'shared-conversation-rail' && canWrite ? (
            <p className="connection-row-tier-note connection-row-warning" role="alert">
              <strong>Widens tenancy.</strong> Setting this to true lets every signed-in user see everyone else&apos;s
              conversations on the rail. Writes (ask, delete, upload) stay owner-only, but conversation titles and
              history become shared. Confirm before recording; an app release is still required for it to take effect.
            </p>
          ) : null}

          {editing ? (
            <div className="connection-row-editor">
              {/* THE BROWSER FIRST, because it is the answer to the question the
                  pencil raises. A blank box asking for a Genie space id sends
                  somebody to another tab; the list of spaces their own sign-in
                  can see does not. The box stays underneath: browsing these
                  lists rides optional permissions, and a reader whose sign-in
                  does not carry them still has to be able to change the row. */}
              <AssetPickerField field={resource.id} current={draft} catalog={catalogInUse} onPick={setDraft} />
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={resource.label}
                aria-label={`New value for ${resource.label}`}
              />
              {/* The consequence of the button below, in the fewest words that
                  still state it. Two values are about to look identical on
                  screen and only one of them will be in force. */}
              <p className="connection-row-tier-note">
                {row.editable
                  ? 'Applied immediately.'
                  : resource.changedBy === 'app-redeploy'
                    ? 'Recorded only. Applied by the next app release.'
                    : resource.changedBy === 'model-version'
                      ? 'Recorded only. Applied by the next model version.'
                      : 'Recorded only. Not applied until the change path below runs.'}
              </p>
              <div className="flex gap-2">
                <Button size="sm" disabled={saving || !draft.trim()} onClick={() => void commit()}>
                  <Save className="size-3.5" /> {row.editable ? 'Save and apply' : 'Record intention'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {!row.editable ? (
            <CopyableCommand command={resource.applyWith} label={`How to change ${resource.label}`} />
          ) : null}

          <p className="connection-row-arrival">
            {resource.arrivesBy}{' '}
            {resource.bundleVariable
              ? `Bundle variable: ${resource.bundleVariable}.`
              : 'No bundle variable configures this.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A configured value, as a boolean where it is one.
 *
 * `true` and `false` are how these arrive from the environment and are not how
 * anybody reads a switch. Everything else is passed through untouched, including
 * the empty string, which the caller renders as `not set`.
 */
/**
 * The agent's Unity Catalog read boundary: each entry labelled by blast radius.
 *
 * A bare catalog name includes every non-system schema; a `catalog.schema` name
 * limits access to that one schema. Printing the raw strings without that
 * distinction is how the page showed the list and still left a customer unsure
 * what they had opened up. Empty is a real state (no declared read scope), not
 * "not set".
 *
 * Structure only: a later picker can attach beside these rows without rewriting
 * how the forms are named. No editing here.
 */
export function DataCatalogsValue({ configured }: { configured: string }) {
  const entries = parseDataCatalogEntries(configured);
  if (entries.length === 0) {
    return (
      <p
        className="configuration-row-value configuration-row-value--empty"
        data-testid="configuration-catalog-allowlist-value"
      >
        {EMPTY_DATA_CATALOGS}
      </p>
    );
  }
  return (
    <ul
      className="configuration-row-value configuration-scope-list"
      data-testid="configuration-catalog-allowlist-value"
    >
      {entries.map((entry) => (
        <li key={entry.name} data-scope-form={entry.form}>
          <code>{entry.name}</code>
          <span className="configuration-scope-form">{dataCatalogFormLabel(entry.form)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Tables the agent must not declare: patterns, or the default of none.
 *
 * An empty denylist is the normal case. It must not read as a warning, a
 * missing grant, or "not set".
 */
export function CatalogDenylistValue({ configured }: { configured: string }) {
  const patterns = parseCatalogDenylist(configured);
  if (patterns.length === 0) {
    return (
      <p
        className="configuration-row-value configuration-row-value--empty"
        data-testid="configuration-catalog-denylist-value"
      >
        {EMPTY_CATALOG_DENYLIST}
      </p>
    );
  }
  return (
    <ul className="configuration-row-value configuration-scope-list" data-testid="configuration-catalog-denylist-value">
      {patterns.map((pattern) => (
        <li key={pattern}>
          <code>{pattern}</code>
        </li>
      ))}
    </ul>
  );
}

/**
 * The deployment's own settings: one card, one grid, no verdicts.
 *
 * These are the values with no remote end -- a token cap, two lists of catalog
 * patterns, a Postgres schema name, a switch -- and they were drawn as
 * dependencies: a caret to expand, a chip reading "Nothing to reach", and a
 * status column that could never say anything else. Five rows of a page's most
 * emphatic furniture spent asserting that there was nothing to assert.
 *
 * So they are a list. No caret, no chip, and the only interactive thing on a row
 * is the pencil, on the rows that have one.
 */
export function ConfigurationList({
  group,
  saving,
  requestedResource,
  onSave,
  onClear,
  catalogInUse = '',
  allowMutations = false,
}: {
  group: ConnectionGroup;
  /** The resource id currently being written, if any. */
  saving: string;
  requestedResource: string;
  onSave: (row: ResourceRow, value: string) => Promise<boolean>;
  onClear: (row: ResourceRow) => Promise<void>;
  /** The configured catalog, for the pickers that browse inside one. */
  catalogInUse?: string;
  /** Administrators only may stage or save. */
  allowMutations?: boolean;
}) {
  // One row open at a time, by id. A list this short with every editor expanded
  // is a form, and these are values a release owns.
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState('');

  return (
    <section className="connection-group">
      <h3 className="connection-group-title">{group.title}</h3>
      <Card className="deployment-card">
        <div className="configuration-rows">
          {group.readings.map(({ row, resource }) => {
            const canWrite = Boolean(allowMutations);
            const raw = row.intended ?? row.configured;
            const shown = configurationValue(raw);
            const open = editing === resource.id;
            return (
              <div
                key={resource.id}
                className="configuration-row"
                id={entityRowId(resource.id)}
                data-testid={`configuration-${resource.id}`}
                data-highlighted={requestedResource === resource.id ? 'true' : undefined}
                aria-current={requestedResource === resource.id ? 'location' : undefined}
              >
                {/* The same mark the dependency rows carry, for the same
                    reason: these rows name products too -- a Lakebase schema, a
                    Unity Catalog volume, an MLflow experiment -- and a reader
                    scanning the page should not have the column stop halfway
                    down it. */}
                <BrandIcon product={RESOURCE_PRODUCT[resource.kind]} className="configuration-row-product" />
                <p className="configuration-row-label">{resource.label}</p>
                {/* NO TINT IN THIS LIST, INCLUDING ON THE EXPERIMENT.
                
                    The design asks for one green value here -- the MLflow
                    experiment traces land in -- and the grouping has already
                    granted it, somewhere else. A row is in this section only
                    when NOTHING checked it; the moment the experiment probe
                    answers, the row has a remote end and appears under "Checked
                    and reachable" with the green badge every reachable row
                    carries. Tinting it here as well would mean a value that was
                    never reached rendering in the same green as one that was,
                    which is the distinction this page's whole colour scheme
                    rests on.

                    data_catalogs and catalog_denylist get their own reading:
                    each entry labelled by form, and empty states that say what
                    empty means rather than "not set". */}
                {resource.id === 'catalog-allowlist' ? (
                  <DataCatalogsValue configured={raw} />
                ) : resource.id === 'catalog-denylist' ? (
                  <CatalogDenylistValue configured={raw} />
                ) : (
                  <p className="configuration-row-value" title={shown || NOT_SET}>
                    {truncateHead(shown || NOT_SET, 44)}
                  </p>
                )}
                {canWrite ? (
                  <button
                    type="button"
                    className="configuration-row-affordance"
                    data-affordance="write"
                    aria-label={`Change ${resource.label}`}
                    aria-expanded={open}
                    onClick={() => {
                      setDraft(row.intended ?? row.configured);
                      setEditing(open ? '' : resource.id);
                    }}
                  >
                    <Pencil className="size-3.5" aria-hidden="true" />
                  </button>
                ) : (
                  <span className="configuration-row-affordance" data-affordance="locked">
                    <Lock className="size-3.5" aria-hidden="true" />
                    {/* The tier, for a reader who cannot see the padlock. The
                        command that WOULD change it is not here: it is one line
                        of shell per row, and five of them under a list of five
                        values is the card this replaced. */}
                    <span className="sr-only">{`${row.changedByLabel}, not changeable here`}</span>
                  </span>
                )}
                {open ? (
                  <div className="configuration-row-editor">
                    {/* The two list fields on this card are the ones a picker
                        helps most: a `data_catalogs` entry decides whether the
                        agent may read one schema or every non-system schema in a
                        catalog, and a reader typing that by hand cannot see the
                        difference until somebody asks what was opened up. Picking
                        adds an entry rather than replacing the list, which is
                        decided in `applyPick` and not here. */}
                    <AssetPickerField field={resource.id} current={draft} catalog={catalogInUse} onPick={setDraft} />
                    <Input
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      aria-label={`New value for ${resource.label}`}
                    />
                    <Button
                      size="sm"
                      disabled={saving === resource.id || !draft.trim()}
                      onClick={() => {
                        void onSave(row, draft.trim()).then((took) => {
                          if (took) setEditing('');
                        });
                      }}
                    >
                      <Save className="size-3.5" /> {row.editable ? 'Save and apply' : 'Record intention'}
                    </Button>
                    {row.intended ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={saving === resource.id}
                        onClick={() => void onClear(row)}
                      >
                        <Undo2 className="size-3.5" /> Discard
                      </Button>
                    ) : null}
                    <Button variant="outline" size="sm" onClick={() => setEditing('')}>
                      Cancel
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>
    </section>
  );
}

export function ConnectionsPage() {
  const role = useRole();
  const allowMutations = showsAdminSurfaces(role.state);
  const [saving, setSaving] = useState('');
  const [writeError, setWriteError] = useState('');

  /**
   * The checks, from the one mechanism that runs them for the whole session.
   *
   * THIS PAGE USED TO FETCH BOTH ROUTES ON EVERY MOUNT. That looked like the
   * opposite of the Architecture page's defect and was a defect of its own: every
   * navigation back to this tab re-invoked the serving endpoint and re-probed the
   * workspace, with nobody having asked. Both tabs now read one run, started once
   * per session, with Refresh as the only thing that re-runs it. See
   * session-checks.ts.
   */
  const { session, running: refreshing, refresh, reloadSettings } = useSessionChecks();
  const payload = session?.settings ?? null;
  const report = session?.report ?? null;
  const checkError = session?.error ?? '';
  /**
   * Whether the first run is still in flight.
   *
   * Distinct from `refreshing`, which is true for a re-run as well. Only the
   * first run has nothing to draw underneath it, so only the first run gets the
   * skeleton; a re-run leaves the previous answers on screen and marks the rows
   * as being restated, which is what the row badges already do.
   */
  const firstRun = refreshing && !session;

  const requestedEntity = useRequestedEntity();
  // A resource id rather than a table name means the link came from a
  // connection, so the table matrix is not where it is going.
  const requestedResource = CONNECTED_RESOURCES.some((resource) => resource.id === requestedEntity.toLowerCase())
    ? requestedEntity.toLowerCase()
    : '';
  /**
   * Re-read the configuration after a write, and report a refusal.
   *
   * NOT a re-run of the checks. A save changes what the deployment is configured
   * with, so the rows are redrawn; it changes nothing about whether the workspace
   * answers, so re-probing every dependency would be an expensive way of learning
   * nothing. Returns the sentence to show, or '' when it worked.
   */
  const rereadSettings = useCallback(async () => {
    const failure = await reloadSettings();
    if (failure) setWriteError(failure);
    return failure;
  }, [reloadSettings]);

  /** Saves one value, and says whether the server took it. */
  const write = useCallback(
    async (row: ResourceRow, value: string): Promise<boolean> => {
      setSaving(row.resource.id);
      setWriteError('');
      try {
        const response = await fetch(`/api/settings/values/${encodeURIComponent(row.resource.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value, intent: row.editable ? 'active' : 'intended', note: '' }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { detail?: string };
          // Surfaced verbatim. The server's refusal carries the command that
          // would work, and rewording it here would be a second copy of the
          // rules about what is changeable.
          throw new Error(body.detail ?? `the settings endpoint answered ${response.status}`);
        }
        await rereadSettings();
        return true;
      } catch (caught) {
        setWriteError((caught as Error).message);
        return false;
      } finally {
        setSaving('');
      }
    },
    [rereadSettings]
  );

  const clear = useCallback(
    async (row: ResourceRow) => {
      setSaving(row.resource.id);
      setWriteError('');
      try {
        const response = await fetch(`/api/settings/values/${encodeURIComponent(row.resource.id)}`, {
          method: 'DELETE',
        });
        if (!response.ok) throw new Error(`the settings endpoint answered ${response.status}`);
        await rereadSettings();
      } catch (caught) {
        setWriteError((caught as Error).message);
      } finally {
        setSaving('');
      }
    },
    [rereadSettings]
  );

  // Memoized rather than defaulted inline: a fresh `[]` on every render makes
  // the map below a new object every render, and the row counts that depend on
  // it recompute for eighteen resources each time the page redraws.
  const reported = useMemo(() => report?.checks ?? [], [report]);
  // Both halves, in the order `allChecks` fixes: what the app asked the
  // workspace under the reader's own token, and then anything the orchestrator
  // reported, which outranks it where they answer about the same resource.
  const checks = useMemo(() => allChecks(payload, reported), [payload, reported]);
  const blocked = checks.filter((check) => check.status !== 'ok');
  /**
   * The blocked checks, split by whether anybody is being asked to act.
   *
   * A refusal over one of the three optional catalog reads is not a fix, and
   * this panel was the last surface still drawing one as one. `required` is what
   * "What to fix" is allowed to hold; the rest is stated once, neutrally, in a
   * line of its own. The rule is in `optional-scope-findings.ts`, where it is
   * asserted without composing a screen.
   */
  const findings = splitOptionalScopeFindings(blocked);
  const tableChecks = checks.filter((check) => check.kind === 'table');
  /**
   * The blocked checks, collected into one panel block per remedy.
   *
   * Two passes: by cause, so twelve tables refused for one permission are one
   * row, and then by remedy, so four permissions cleared by one restart are one
   * block rather than four repetitions of the same instruction.
   *
   * Not memoized, because `blocked` is a fresh array on every render and a
   * dependency that never compares equal makes a `useMemo` a slower way of doing
   * the same work. The grouping is a single pass over a few dozen checks.
   */
  const remedyBlocks = groupByRemedy(groupByCause(findings.required));

  /**
   * Every connection, read once.
   *
   * The sections and the rows are off this one derivation. They used to be off
   * three: a count strip walked the readings, the sections were a fixed list of
   * resource KINDS, and each row re-derived its own verdict from a check it
   * looked up itself. The strip is gone; the rows still speak for themselves.
   */
  const readings = useMemo(() => readConnections(payload, reported), [payload, reported]);
  /**
   * The sections, in the order a reader needs them: what is broken, what moved,
   * what answered, what nobody asked, and then the configuration.
   *
   * The status is the SECTION, which is what lets each row drop its own status
   * chip. Grouping by kind put a blocked warehouse under "Data and compute"
   * three screens down, with its verdict as a chip a reader had to find.
   */
  const groups = useMemo(() => groupConnections(readings), [readings]);
  /**
   * The catalog the schema picker lists inside.
   *
   * Read off the App catalog row, and off its INTENDED value first, because a
   * reader who has just recorded a new catalog is about to pick a schema in that
   * one rather than in the one the current model version was logged with. Empty
   * on a deployment whose catalog was never configured, where the picker opens on
   * the catalog list instead.
   */
  const catalogInUse = useMemo(() => {
    const catalogRow = readingsById(readings).get('catalog')?.row;
    return (catalogRow?.intended ?? catalogRow?.configured ?? '').trim();
  }, [readings]);
  /**
   * The serving endpoint's own reading, for the Orchestrator stamp's badge.
   *
   * The SAME reading the connection row is drawn from, taken by id off the same
   * derivation, rather than a verdict computed here: the endpoint appears twice on
   * this page and two readings of it are two chances to badge one endpoint green
   * in the Build card and red in the list.
   */
  const orchestratorReading = useMemo(() => readingsById(readings).get('agent-endpoint'), [readings]);

  /**
   * When these answers were taken.
   *
   * The settings payload's stamp first, because that is the response the
   * workspace probes are computed in and so is the one that moves on every
   * successful refresh. The orchestrator's own `checked_at` is the fallback and
   * is routinely EMPTY: a version that answers with its configuration and runs
   * no checks has no check time to report, which is why the header's old
   * "Checked …" line rendered a blank on a perfectly healthy deployment. The
   * control now says "Not read yet" for that, which is the truth.
   */
  const lastCheckedAt = payload?.checkedAt || report?.checked_at || '';

  const now = Date.now();

  /**
   * The independent app and orchestrator build stamps, and whether each half is
   * working.
   *
   * THE HEALTH IS READ OFF WHAT THIS PAGE ALREADY HOLDS, which is the only way
   * these two rows can be trusted to agree with the rest of the tab. The app's
   * comes from the workspace's own report of the app and its compute -- the same
   * field the App endpoint row is tinted from -- with the fact that this page's
   * read was answered as the fallback. The orchestrator's comes from the check on
   * the serving endpoint row, which is the endpoint a question is actually run
   * against, and falls back to whether the served model version reported its own
   * configuration on this pass.
   *
   * Neither is a second probe. A row that measured its own health would eventually
   * disagree with the row above it about one app.
   */
  const build = buildFacts({
    appBuildSha: payload?.appBuildSha ?? '',
    modelBuildSha: payload?.modelBuildSha ?? '',
    appBuildAncestors: payload?.appBuildAncestors ?? [],
    appServing: payload?.app?.serving,
    appAnswered: Boolean(payload),
    orchestratorStatus: orchestratorReading?.status,
    orchestratorReported: payload?.orchestratorReported,
  });

  /**
   * The app's own record, and the rows it earns.
   *
   * `NO_APP_FACTS` rather than a nullable, so the two derivations below take one
   * shape and the "nothing was reported" case is an empty row list rather than a
   * branch in the markup. A server built before this field existed lands here
   * too, and correctly draws nothing.
   *
   * Both read the same clock, taken once per render, so an uptime and a
   * freshness line cannot round two different instants.
   */
  const appFacts = payload?.app ?? NO_APP_FACTS;
  const deploymentFacts = useMemo(() => deploymentRows(appFacts), [appFacts]);
  const telemetryFacts = useMemo(() => telemetryRows(appFacts, now), [appFacts, now]);

  const wide = deploymentWideFindings(payload?.drift ?? []);
  const identityRead = useDeploymentIdentity();
  // One list, one control. Two error alerts each offering their own would be two
  // controls for one intention, and one run produces one account of what failed.
  const problems = [checkError].filter(Boolean);
  const principal = report?.principal_resolved ? report.principal : '';

  return (
    <div className="page-shell connections-page">
      <div className="page-heading">
        <div>
          <p className="section-label">Deployment</p>
          <h2>Connections</h2>
        </div>
        {/* The one control on the page, and it is the shared one: the word, the
            icon, the pending state and the freshness line are decided in
            RefreshControl.tsx, so this header and the Architecture header cannot
            come apart again.
            
            The timestamp is beside the button and appears nowhere else on the
            page. It used to sit in the status block's meta line instead, which
            was the right call while the button had no line of its own; printing
            it in both places would be the thing this page's whole rebuild was
            against, which was saying everything more than once. */}
        <RefreshControl busy={refreshing} checkedAt={lastCheckedAt} onRefresh={() => void refresh()} />
      </div>

      {firstRun ? (
        <Card>
          <CardHeader>
            <CardTitle>Checking dependencies…</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </CardContent>
        </Card>
      ) : null}

      {problems.length > 0 ? (
        <Alert>
          <CircleAlert />
          <AlertDescription>
            {problems.map((problem) => (
              <span key={problem} className="block">
                {problem}
              </span>
            ))}
            {/* The same action as the header's, so the same button. It said "Try
                again" for as long as it was its own markup. */}
            <RefreshButton busy={refreshing} onRefresh={() => void refresh()} />
          </AlertDescription>
        </Alert>
      ) : null}

      {writeError ? (
        <Alert data-testid="settings-write-error">
          <CircleAlert />
          <AlertDescription>{writeError}</AlertDescription>
        </Alert>
      ) : null}

      {/* Only ever visible to someone who followed an entity link here and whose
          entry has since stopped being tracked. Silence in that case would be
          the page answering a question it had not been asked. */}
      {/* The connection rows are entries too, since the Architecture page's
          nodes link to them, so a link naming one is not a link to nothing. */}
      <EntityHighlight
        tracked={[...tableChecks.map((check) => check.name), ...CONNECTED_RESOURCES.map((resource) => resource.id)]}
        ready={!!report || !!payload}
      />

      {wide.length > 0 ? (
        <div className="connections-status" data-testid="drift-summary">
          {wide.map((finding) => {
            const Icon = SEVERITY_ICON[finding.severity];
            return (
              <Alert key={finding.id}>
                <Icon />
                <AlertDescription>
                  <strong>{finding.headline}.</strong> {finding.detail}
                  {finding.remedy ? <> {finding.remedy}</> : null}
                </AlertDescription>
              </Alert>
            );
          })}
        </div>
      ) : null}

      {/* Kept whole, against the general rule
          that everything collapses. Every other block on this page describes
          state; this one is the only thing on it a reader can act on, and most of
          what it carries belongs to the table checks, which have no resource row
          to hold them. It renders only when something is blocked, so a healthy
          deployment never sees it -- which is also why it can sit above the two
          cards without pushing them down on the deployments that are fine. */}
      {/* The REQUIRED findings, and only those. It used to render on every
          blocked check, which on this deployment meant a red section headed
          "What to fix" whose first three entries were optional catalog reads
          nothing needs. A section that names things that are not the reader's to
          fix is a section people stop reading. */}
      {findings.required.length > 0 ? (
        <section className="connections-fix" aria-labelledby="connections-fix-title">
          <div className="connections-fix-head">
            <Wrench className="size-3.5" aria-hidden="true" />
            <h3 id="connections-fix-title">What to fix</h3>
          </div>
          {/* No lead paragraph, and its removal is a correction rather than a
              trim. It said each statement was "already filled in with the serving
              principal", which stopped being true when the app took over the
              probing: the grants are filled in with the SIGNED-IN USER, whose
              refusal is what was measured, and telling an admin the line names
              the service principal would have them grant the wrong identity. It
              also said "Run it as a workspace admin", which every block below
              already says more precisely for its own statement. */}
          {/* ONE BLOCK PER REMEDY, not one per failure. Twelve table checks
              stopped by one missing OAuth scope were twelve identical blocks;
              collecting them by cause fixed that and left four -- one per API
              family -- each repeating the same three-line instruction about
              private browsing windows for the one restart that clears all four.
              What shares a cause and what shares a remedy is decided in
              connection-causes.ts, where it can be asserted without composing a
              screen. */}
          <div className="connections-fix-body">
            {remedyBlocks.map((block) => (
              <PreflightRemedyBlock key={block.key} block={block} />
            ))}
          </div>
        </section>
      ) : null}

      {/* Under the panel rather than in it, and drawn whether or not the panel
          is there: the commonest deployment has these three short and nothing
          else wrong at all, and on that one this line is the only thing said
          about them. */}
      <OptionalScopeLine shortfall={findings.optional} />

      {/* The two cards the design puts under the summary: what is running, and
          who it runs as. Both were prose before -- the hashes were a clause in
          the grey meta line above, and the identity was a disclosure called
          "Connected as" whose closed line read `not reported · questions run as
          the signed-in user`, which named nobody. */}
      <div className="deployment-cards">
        <Card className="deployment-card deployment-card-build" data-testid="build-card">
          <div className="deployment-card-head">
            <p className="deployment-card-title">
              <GitCommitHorizontal className="size-3.5" aria-hidden="true" />
              Build and telemetry
            </p>
          </div>
          {/* TWO GRIDS, which is the design's arrangement and is also a
              division of subject: what this deployment IS on the left, what it
              was BUILT FROM on the right. One column of ten label/value pairs
              reads as a list of unrelated facts.

              The left column is dropped entirely, rather than left empty, on a
              deployment whose workspace reported nothing about the app: an empty
              half beside a full one draws the eye to the emptiness. */}
          <div className="deployment-card-body" data-columns={deploymentFacts.length > 0 ? 'two' : 'one'}>
            {deploymentFacts.length > 0 ? (
              <div className="deployment-grid">
                {deploymentFacts.map((row) => (
                  <BuildFactRow key={row.key} row={row} />
                ))}
              </div>
            ) : null}
            <div className="deployment-grid">
              {/* The stamp AND whether that half is working. The row used to be
                  the hash alone, on the tab a reader opens to find out what this
                  deployment can reach. */}
              {build.artifacts.map((artifact) => (
                <BuildStampRow key={artifact.key} artifact={artifact} />
              ))}
              {telemetryFacts.map((row) => (
                <BuildFactRow key={row.key} row={row} />
              ))}
            </div>
          </div>
        </Card>

        {/* `remedyStatedElsewhere` is the same condition the What to fix section
            renders on, read from the same array, so the two cannot disagree about
            whether the sign-in remedy is already on this screen. The card carries
            it only on the deployment where the panel is absent: a permission can
            be missing while nothing is blocked, and there the action would
            otherwise be on no surface. */}
        {/* The REQUIRED findings, which is what the panel now renders on. Read
            off the same split for the same reason the old condition read off the
            same array: a deployment whose only shortfall is the three optional
            catalog reads has no panel, so the card must not think the sign-in
            remedy is already on the screen. */}
        <IdentityCard checkedAs={principal} read={identityRead} remedyStatedElsewhere={findings.required.length > 0} />
      </div>

      {/* The notebook, and where what it published differs from what the model is
          running. Drawn from the payload rather than fetched here, so this page
          keeps its one read per session. */}
      <div className="configuration-plane-row">
        <NotebookCard panel={payload?.notebook} allowMutations={allowMutations} onSaved={rereadSettings} />

        {/* The same panel the Notebook card reads, so the two cannot disagree
            about whether a notebook is connected. */}
        <ApplyDeclarationCard notebook={payload?.notebook} onRefresh={() => void refresh()} />
      </div>

      {/* ONE SECTION PER VERDICT, and the verdict said once in its header. The
          list was grouped by what a dependency IS -- "Agents and models", "Genie
          spaces", "Data and compute", "App storage and behaviour", each under a
          sentence explaining the category -- with every row carrying its own
          status chip. A blocked warehouse was the eleventh row of the third
          group, and its verdict was a chip a reader had to find. */}
      {groups.map((group) =>
        group.key === 'configuration' ? (
          <ConfigurationList
            key={group.key}
            group={group}
            saving={saving}
            requestedResource={requestedResource}
            onSave={write}
            onClear={clear}
            catalogInUse={catalogInUse}
            allowMutations={allowMutations}
          />
        ) : (
          <section key={group.key} className="connection-group">
            {/* No blurb. Each of the four the categories carried was a sentence
                explaining what the category meant, which a header naming a
                verdict does not need. */}
            <h3 className="connection-group-title" data-tone={GROUP_TONE[group.key]}>
              {group.title}
              {group.aside ? <span className="connection-group-aside">{group.aside}</span> : null}
            </h3>
            <div className="connection-rows">
              {group.readings.map((reading) => (
                <ConnectionRow
                  key={reading.resource.id}
                  reading={reading}
                  tone={GROUP_TONE[group.key]}
                  saving={saving === reading.resource.id}
                  refreshing={refreshing}
                  requested={requestedResource === reading.resource.id}
                  catalogInUse={catalogInUse}
                  allowMutations={allowMutations}
                  onSave={(value) => write(reading.row, value)}
                  onClear={() => clear(reading.row)}
                />
              ))}
            </div>
          </section>
        )
      )}

      {tableChecks.length > 0 ? (
        <DeclaredTablesSection
          tableChecks={tableChecks}
          requestedEntity={requestedEntity}
          checkedAt={lastCheckedAt}
          entries={payload?.connections}
          storeAvailable={payload?.storeAvailable ?? true}
          allowMutations={allowMutations}
          onChanged={() => {
            void rereadSettings();
          }}
        />
      ) : (
        <DeclaredConnectionsCard
          entries={payload?.connections}
          storeAvailable={payload?.storeAvailable ?? true}
          allowMutations={allowMutations}
          onChanged={() => {
            void rereadSettings();
          }}
        />
      )}
    </div>
  );
}
