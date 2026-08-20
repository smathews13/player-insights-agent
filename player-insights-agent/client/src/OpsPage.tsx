/**
 * Ops: whether this deployment is working, what it costs, and how much of it
 * people use.
 *
 * THREE BLOCKS THAT DO NOT DEPEND ON EACH OTHER, and that is the design rather
 * than an implementation detail. Health is a probe of live dependencies, cost is
 * a query against workspace billing tables, traffic is a query against the app's
 * own store. They are three different systems with three different failure
 * modes and three very different latencies, and the billing query is the slow
 * one. Behind a single route, a billing table an admin has no grant on would
 * hold up the block that says whether the warehouse is answering, at exactly the
 * moment somebody is trying to find out why nothing works.
 *
 * So each block fetches itself, fails by itself, and carries its own read time.
 * Three timestamps on one page look untidy and are honest: they were read at
 * three different moments and one of them can be twenty minutes older than the
 * others.
 *
 * THE SHAPE IS THE HANDOFF'S. Each block is a bordered card with a #F7F7F7
 * header band carrying its title, the one line that qualifies everything under
 * it, and its own read control; the body sits inside the border and a hairline
 * footer holds whatever the body cannot say about itself. Health is a table,
 * cost is a grid of tiles, traffic is three charts in three columns. See
 * `docs/design-handoff-pia-dubois-revamp/ops-tab.md`.
 *
 * WHAT THIS FILE DOES NOT DECIDE. Every claim about a number is in
 * `ops-view.ts`, so it can be asserted without rendering anything. This file is
 * layout and ARIA. It also does not own:
 *
 *  - The Refresh control and its freshness line, which are `RefreshControl`.
 *  - The time-range control, which is `TimeRangeControl`, and the window it
 *    means, which is `rangeWindow` in `time-range.ts`. Both are shared with
 *    Monitoring. Sharing them is what MAKES it possible for the two tabs to be
 *    over one window; it does not by itself achieve it, and this comment used to
 *    claim it did. It was wrong in the direction that costs the most: this page
 *    sent the control's word to a server that reads timestamps, so 24h and 30
 *    days both returned the last 7 days for as long as that went unnoticed. What
 *    keeps the two tabs together is that both resolve the control to a window
 *    with `rangeWindow` and send THAT. See the note in `OpsPage` itself.
 *  - The failure and refusal taxonomy, which is the server's.
 *
 * NO POLLING, for the reason Monitoring does not poll: the billing query scans
 * a workspace-wide table, and a page that re-ran it every thirty seconds would
 * cost money to look at.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, ExternalLink, Info } from 'lucide-react';
import { Button, Skeleton } from './ui';
import { astPill } from './astrolabe-pill';
import { BrandIcon } from './BrandIcon';
import { PageHeading } from './page-chrome';
import { RefreshButton, RefreshControl } from './RefreshControl';
import { ageAgo, checkedAgoLine } from './refresh-state';
import { TimeRangeControl } from './TimeRangeControl';
// Shared with Monitoring, so the two tabs cannot be over different windows.
import { rangeWindow } from './time-range';
import { OUTCOME_PARAM } from './monitoring-filters';
import { useWorkspaceHost } from './data-entity-state';
import { databricksLink } from '../../shared/databricks-links';
import {
  bars,
  costAbsence,
  count,
  errorFraming,
  healthRows,
  latencyAbsence,
  latencyFigure,
  latencyRouteView,
  latencySharedFacts,
  p50BarWidths,
  productForCostTile,
  productForProbe,
  splitMethod,
  telemetryNotice,
  WITHHELD,
  withheldReason,
  tileView,
  trafficCaption,
  type Absence as AbsenceCopy,
  type HealthRow,
} from './ops-view';
import { opsDayRange, opsRangeDates } from '../../shared/ops-contract';
import type {
  DependencyResult,
  GrantRemedy,
  OpsCostPayload,
  OpsHealthPayload,
  OpsLatencyPayload,
  OpsTrafficPayload,
  RouteLatency,
} from '../../shared/ops-contract';

/* ── Loading one block ───────────────────────────────────────────────────── */

/**
 * One block's state, as its body receives it.
 *
 * The bodies below take this rather than fetching into it, which is what lets
 * every state be rendered and read in a test without a browser. This repository
 * has shipped screens that were wrong while every assertion about their source
 * was true, so the states that matter here are asserted against markup.
 */
export interface Block<T> {
  data: T | null;
  busy: boolean;
  /** The sentence for a read that did not come back at all. */
  failed: string;
  refresh: () => void;
}

/**
 * One block's own read.
 *
 * A hook per block rather than one fetch for the page, which is the independence
 * the file header describes made mechanical: three calls to this cannot
 * accidentally become one.
 *
 * A route that answers 200 with a `reason` inside the payload is NOT a failure
 * here. That is the server saying it looked and could not find out, which is a
 * fact the block renders; `failed` is for the narrower case of the request
 * itself not completing, where there is nothing to render at all.
 */
function useBlock<T>(path: string, search: string): Block<T> {
  const [attempt, setAttempt] = useState(0);
  /**
   * The last answer, and which request it answered.
   *
   * One piece of state carrying its own request key rather than three pieces
   * kept in step by hand, and `busy` is DERIVED from comparing that key to the
   * request this render wants. That is what lets the effect below set state only
   * from its own callbacks: an effect that opens by setting a `busy` flag is a
   * cascading render, and the flag it sets is information the component already
   * had.
   */
  const [answer, setAnswer] = useState<{ key: string; data: T | null; failed: string } | null>(null);

  const key = `${path}${search}#${attempt}`;
  useEffect(() => {
    // Abandoned rather than cancelled: a range change while a read is in flight
    // must not let the older answer land on top of the newer one. This app has
    // shipped that race before, on Connections.
    let current = true;
    fetch(`${path}${search}`, { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`The server answered ${response.status}.`);
        return (await response.json()) as T;
      })
      .then((payload) => {
        if (current) setAnswer({ key, data: payload, failed: '' });
      })
      .catch((error: Error) => {
        // The previous payload is deliberately kept. A block that empties itself
        // on a failed re-read has thrown away the last thing it knew, at the
        // moment somebody is trying to work out what changed.
        if (current) setAnswer((last) => ({ key, data: last?.data ?? null, failed: error.message }));
      });
    return () => {
      current = false;
    };
  }, [path, search, key]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  return {
    data: answer?.data ?? null,
    busy: answer?.key !== key,
    // Only this request's failure. A stale one from the previous range would
    // report the new read as broken before it has come back.
    failed: answer?.key === key ? answer.failed : '',
    refresh,
  };
}

/* ── Pieces shared by the three blocks ───────────────────────────────────── */

/**
 * The head of a block: what it is, the one line qualifying everything beneath
 * it, and the control to read it again.
 *
 * A FILLED BAND RATHER THAN A HEADING IN THE BODY. Three cards of white on white
 * read as one page with rules across it, which is exactly the reading the
 * independence of these blocks has to survive: a failed middle third has to look
 * like one block that could not be read.
 *
 * Per block rather than one for the page, because the three read times are
 * genuinely different and a single one would be a claim about all three that is
 * true of at most one.
 */
function BlockHead({
  id,
  title,
  badges,
  meta,
  control,
  children,
}: {
  /** The heading's own id, so the section's `aria-labelledby` reaches it. */
  id: string;
  title: string;
  /**
   * The qualifiers that govern the WHOLE block, beside its heading.
   *
   * Badges rather than sentences, and the same badge the dependency results use,
   * because these hold at section level: "Experimental" is true of every figure
   * in the cost block and of the cards that have no figure. Said as a sentence
   * under the heading it was three lines of caveat that a reader skipped on the
   * way to the numbers.
   *
   * A LIST, because Cost carries two: what its figures are worth, and that the
   * block itself is not finished. The tone travels with each word — a warning
   * about how much weight a figure bears is amber, a statement of the block's
   * stage is not — so the caller says which, rather than the head deciding by
   * position.
   */
  badges?: readonly { word: string; tone: string }[];
  /**
   * The block's own one line: what these figures are, and when they were read.
   *
   * A node rather than a string, so a caption can carry a `title` — Latency
   * shows human-readable window times on the page and keeps the exact
   * timestamps on hover, per the handoff — without every other block having to.
   * A plain string is still a valid node, so the other callers are unchanged.
   */
  meta?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="ops-block-head">
      <div className="ops-block-head-text">
        <h3 id={id}>{title}</h3>
        {(badges ?? []).map((badge) => (
          <span key={badge.word} className={badge.tone}>
            {badge.word}
          </span>
        ))}
        {meta ? <span className="ops-block-meta">{meta}</span> : null}
        {children}
      </div>
      {control ? <div className="ops-block-head-control">{control}</div> : null}
    </div>
  );
}

/** The body inside a block's border, held off the edges by one rule. */
function BlockBody({ children }: { children: React.ReactNode }) {
  return <div className="ops-block-body">{children}</div>;
}

/**
 * A block that could not be read at all, as opposed to one that read something
 * disappointing.
 *
 * Says which block, so a page with one broken third does not read as a broken
 * page. `status` rather than `alert`: three of these announcing assertively
 * would interrupt a screen reader three times before the first heading.
 */
function BlockFailed({ title, reason, onRetry }: { title: string; reason: string; onRetry: () => void }) {
  return (
    <div className="ops-block-failed" role="status" aria-live="polite">
      <p className="ops-block-failed-title">{title} could not be read</p>
      <p>{reason}</p>
      {/*
        The shared control rather than this block's own button, which said "Try
        this block again". Which block is already the first line above, so the
        word is not carrying that; what it was carrying was a fifth spelling of
        Refresh, in the one file whose header says the control is not its to own.
      */}
      <RefreshButton className="ops-block-failed-retry" onRefresh={onRetry} />
    </div>
  );
}

/**
 * A missing privilege, with the statement that fixes it.
 *
 * The statement is selectable text in a `<pre>` rather than prose, because the
 * next thing that happens to it is that somebody pastes it into a SQL editor,
 * and prose that has been wrapped and smart-quoted does not run.
 */
function Grant({ grant }: { grant: GrantRemedy }) {
  return (
    <div className="ops-grant">
      <p className="ops-grant-label">
        Grant {grant.privilege} on {grant.object}
      </p>
      <pre className="ops-grant-statement">{grant.statement}</pre>
    </div>
  );
}

/**
 * A stated absence, at body size so it never reads as a measurement.
 *
 * TITLE, ONE LINE, REMEDY, AND NOTHING ELSE. Each of these used to carry a
 * "Why" disclosure holding a paragraph on how the reading works. A collapsed
 * paragraph is still a paragraph, and it sat between a reader and the statement
 * they came here to copy. What a person acts on is the state and the remedy;
 * `ops-view.ts` no longer produces anything else for this to draw.
 */
function Absence({ notice, children }: { notice: AbsenceCopy; children?: React.ReactNode }) {
  return (
    <div className="ops-absence">
      <p className="ops-absence-title">{notice.title}</p>
      <p className="ops-absence-body">{notice.body}</p>
      {children}
    </div>
  );
}

/** When something happened, as the reader's own local time, or nothing at all. */
function When({ at }: { at: string }) {
  if (!at) return <span className="ops-when-absent">Not checked</span>;
  const parsed = new Date(at);
  if (!Number.isFinite(parsed.getTime())) return <span className="ops-when-absent">Not checked</span>;
  return <time dateTime={at}>{parsed.toLocaleString()}</time>;
}

/* ── Health ──────────────────────────────────────────────────────────────── */

/** A dependency's product mark at table-row size, or nothing at all. */
function probeMark(kind: string) {
  const product = productForProbe(kind);
  return product ? <BrandIcon product={product} size={16} className="ops-dependency-mark" /> : null;
}

/**
 * Recorded error lines under the health table, only while a current dependency
 * is not answering. Historical lines add no action to an all-green health view.
 *
 * The framing sentence and the count are `errorFraming`'s, so the one line a
 * reader acts on can be asserted without a browser. This component is the list
 * itself and the absolute timestamp on each line. Nothing renders at zero.
 */
function RecordedErrors({
  errors,
  dependencies,
}: {
  errors: { count: number; recent: Array<{ at: string; body: string }> };
  dependencies: DependencyResult[];
}) {
  const framing = errorFraming({ errorCount: errors.count, dependencies });
  if (!framing) return null;
  return (
    <div className="ops-errors">
      <p className="ops-errors-headline">{framing.headline}</p>
      <p className="ops-errors-note">{framing.note}</p>
      {errors.recent.length > 0 ? (
        <ul className="ops-error-list">
          {errors.recent.map((line) => (
            <li key={`${line.at}-${line.body}`}>
              <When at={line.at} /> <span className="ops-error-body">{line.body}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * One resource's result: what the resource is, and the word for its state.
 *
 * THE PILL NAMES ITS OWN SUBJECT, which is what lets the platform's readings and
 * this app's probes share a column. "Serving endpoint · Ready" is the endpoint's
 * own state and "SQL warehouse · Reachable" is what a metadata GET established,
 * and a reader can tell which is which from the pill rather than from where on
 * the page it was drawn. The separator is drawn in CSS, so the text is the two
 * phrases and nothing a substring match has to step over.
 */
function ResultPill({ pill }: { pill: HealthRow['pill'] }) {
  return (
    <span className={`${pill.tone} ops-platform-pill`}>
      <span className="ops-platform-pill-label">{pill.label}</span>
      <span className="ops-platform-pill-state">{pill.value}</span>
    </span>
  );
}

export function HealthBody({ block }: { block: Block<OpsHealthPayload> }) {
  const payload = block.data;

  if (block.failed) {
    return (
      <section className="ops-block" aria-labelledby="ops-health-heading">
        <h3 id="ops-health-heading" className="sr-only">
          Health
        </h3>
        <BlockBody>
          <BlockFailed title="Health" reason={block.failed} onRetry={block.refresh} />
        </BlockBody>
      </section>
    );
  }

  const telemetry = payload
    ? telemetryNotice(payload.app.telemetry, {
        variable: payload.app.variable,
        table: payload.app.table,
        reason: payload.app.reason,
      })
    : null;
  const rows = healthRows(payload);

  return (
    <section className="ops-block" aria-labelledby="ops-health-heading">
      <BlockHead
        id="ops-health-heading"
        title="Health"
        // The probe's own word. These rows are a check rather than a read, and
        // the cost and traffic bands say "Read" for the same reason: they are.
        // Both wordings and the one rounding are the Refresh control's.
        meta={checkedAgoLine(payload?.checkedAt ?? '')}
        control={<RefreshButton busy={block.busy} onRefresh={block.refresh} />}
      />
      {/* NO PILLS IN THIS BAND. The platform's readings used to sit here as a
          cluster of their own, above a table that reported the same serving
          endpoint in its own Result column and in different words. One badge per
          resource, in the row for that resource: see `healthRows`. */}

      <BlockBody>
        {block.busy && !payload ? (
          <Skeleton className="ops-skeleton" />
        ) : (
          <>
            {payload?.reason ? (
              <Absence notice={{ title: 'The dependency checks did not run', body: payload.reason }} />
            ) : null}

            {/* BESIDE THAT SENTENCE RATHER THAN INSTEAD OF THE TABLE. The probes
                failing says nothing about the readings that are not probes: the
                app answered this request and the store was read on the same pass.
                Replacing the whole table with the sentence threw away the two
                rows that were established. */}
            {rows.length > 0 ? (
              <table className="ops-table">
                <caption className="sr-only">
                  Every resource this deployment runs on, and the state each was in when it was last checked.
                </caption>
                <thead>
                  <tr>
                    {/* Resource rather than Dependency. The app itself and the
                        store it writes to are on this list now, and neither is
                        something the deployment depends ON from outside. */}
                    <th scope="col">Resource</th>
                    <th scope="col" className="ops-col-result">
                      Result
                    </th>
                    <th scope="col" className="ops-col-when">
                      Last check
                    </th>
                    <th scope="col">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">
                        <span className="ops-dependency">
                          {/* The product's own mark, 16px, from the module that
                              owns the artwork. Decorative: the name is right
                              beside it, and a mark that announced itself would
                              make a screen reader say the product twice. Drawn
                              only where the probe's KIND is one we can name;
                              null draws nothing rather than a stand-in, because
                              the wrong mark on a failing row sends a reader to
                              the wrong service's console. */}
                          {probeMark(row.kind)}
                          {/* The row this dependency is documented on. Drawn only
                              where the server said there is one: some probes have
                              no Connections row, and a link to nothing looks like
                              the page failing to find it. */}
                          {row.connectionsId ? (
                            <Link
                              className="ops-dependency-label"
                              to={`/connections?entity=${encodeURIComponent(row.connectionsId)}`}
                            >
                              {row.label}
                            </Link>
                          ) : (
                            <span className="ops-dependency-label">{row.label}</span>
                          )}
                        </span>
                        {/* The configured identifier, and only where the label is
                            not already carrying it. Most probe labels are
                            "SQL warehouse · <id>" and the second line was the
                            same string again under the first. */}
                        {row.name && !row.label.includes(row.name) ? (
                          <span className="ops-dependency-name">{row.name}</span>
                        ) : null}
                      </th>
                      <td className="ops-col-result">
                        {/* The badge that used to sit in the band above, in the
                            row it is about. The words are the state; the class
                            only paints what they already said, so this reads the
                            same in monochrome and to a screen reader. */}
                        <ResultPill pill={row.pill} />
                      </td>
                      <td className="ops-col-when">
                        {row.lastCheckedAt ? (
                          <time dateTime={row.lastCheckedAt}>{ageAgo(row.lastCheckedAt)}</time>
                        ) : null}
                      </td>
                      <td className="ops-reason">{row.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}

            {/* NO HEADING OVER THIS, and no section naming itself. The handoff's
                Health block is a band, a table and a footer; "Platform record and
                telemetry" was a subsection this tab invented to introduce a link
                and two figures that introduce themselves. What is left is what a
                person acts on: the way out to the platform record, when the app
                last served anything, and the error lines themselves. */}
            <div className="ops-subsection">
              {payload?.app.insightsHref ? (
                <a className="ops-external" href={payload.app.insightsHref} target="_blank" rel="noreferrer">
                  App availability in Databricks
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              ) : null}

              {telemetry ? (
                <Absence notice={telemetry}>{payload?.app.grant ? <Grant grant={payload.app.grant} /> : null}</Absence>
              ) : payload ? (
                <div className="ops-telemetry-figures">
                  <p>
                    Most recent request: <When at={payload.app.lastServedAt} />
                  </p>
                  {/* ZERO IS NOT A COUNT, per the tab's own rule. "0 error lines
                      in this range" is a line of text saying nothing happened,
                      which is what the absence of the line already says, and it
                      draws the eye to a number a reader then has to read to
                      discover is nothing.

                      When there IS a count, it appears only beside a current
                      failed dependency. Old lines disappear when the live checks
                      are healthy, because they are history rather than an active
                      health result. */}
                  <RecordedErrors
                    errors={payload.app.errors}
                    dependencies={(payload.dependencies ?? []).map((row) => row.result)}
                  />
                </div>
              ) : null}
            </div>
          </>
        )}
      </BlockBody>
    </section>
  );
}

/* ── Cost ────────────────────────────────────────────────────────────────── */

/*
 * THERE IS NO PER-QUESTION AVERAGE AT THE FOOT OF THIS BLOCK, and it is not
 * coming back in this shape.
 *
 * It read "57.41 USD · Average per question · 918.51 USD across 16 questions",
 * and every word of it was true and the number was still wrong. Most of what it
 * divided is billed by TIME: a warehouse and an endpoint charge for the hours
 * they exist, whether anybody asks anything or not. Dividing a whole range's
 * idle hours by sixteen questions does not produce the cost of a question — it
 * produces a figure that falls as the deployment is used more, which is the
 * opposite of how a reader will use a number labelled "per question". Sixteen
 * questions made it look like a question costs fifty-seven dollars.
 *
 * The label said "Average" and the breakdown showed the division, which is what
 * the block's honesty rule asks of a rate, and neither was enough: the rule can
 * make an average honest about its arithmetic but not about its meaning. So the
 * row is gone, with the view function that composed it. `headline` still arrives
 * on the payload from the server, and nothing on this client reads it.
 */

/**
 * The qualifiers that govern every figure in the block, said once.
 *
 * "AT LIST PRICE" LEADS, which is the handoff's line and is not the same claim
 * as the badge beside it. The badge says these figures are not a production
 * account's. This says the rate they were computed at is the published one,
 * before any discount the account actually holds, which is the difference
 * between a figure that is approximately the bill and one that is reliably
 * above it. It was dropped when the badge arrived, on the reading that the two
 * were one caveat wearing two hats. They are two facts and the handoff asks for
 * both.
 */
function costQualifiers(payload: OpsCostPayload): string {
  const parts = ['At list price', payload.currency, spokenDay(payload.throughDay), 'read under your own grants'];
  return parts.filter(Boolean).join(' \u00b7 ');
}

/** A day as the handoff writes one: "through Aug 14, the last complete day". */
function spokenDay(day: string): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(at)) return '';
  const spoken = new Date(at).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  return `through ${spoken}, the last complete day`;
}

export function CostBody({ block }: { block: Block<OpsCostPayload> }) {
  const payload = block.data;
  const billingHref = databricksLink(useWorkspaceHost(), { kind: 'table', table: 'system.billing.usage' });

  if (block.failed) {
    return (
      <section className="ops-block" aria-labelledby="ops-cost-heading">
        <h3 id="ops-cost-heading" className="sr-only">
          Cost
        </h3>
        <BlockBody>
          <BlockFailed title="Cost" reason={block.failed} onRetry={block.refresh} />
        </BlockBody>
      </section>
    );
  }

  const absent = payload ? costAbsence(payload) : null;

  return (
    /*
     * THE ONE BLOCK ON THIS TAB THAT IS NOT FINISHED, and it says so in its own
     * surface rather than only in a word. The cards, the figures and the outline
     * all stay: what this block will look like is the useful thing about it
     * today. What goes is the finish — the wash behind it and the marks in grey,
     * so nobody reads a number off it and acts.
     *
     * The class is on THIS SECTION and the rules under it are descendants of it,
     * which is what keeps the treatment off Health, Traffic and Latency. Those
     * three are separate sections showing measured data and a de-emphasis
     * reaching them would be a lie about all three.
     */
    <section className="ops-block ops-block-unfinished" aria-labelledby="ops-cost-heading">
      <BlockHead
        id="ops-cost-heading"
        title="Cost"
        /* TWO BADGES OVER THE BLOCK, INSTEAD OF THREE QUALIFIERS UNDER IT. There
           were a sentence, a date line and a disclosure: list prices rather than
           the bill, complete days only, and read under this reader's own grants.
           Every one of them says the same thing about how much weight the figures
           will bear, and stacked they were a paragraph above a grid of numbers
           that nobody finished. The badge says it once, at section level, where it
           governs the whole block including the cards that have no figure. The
           window the figures cover is the range chip at the top of the page.

           "Experimental" is that qualifier, and it replaces "Not production",
           which was a claim about the account the figures came from rather than
           about the figures. "Under development" is the block's stage and not a
           property of any number in it, so it takes the neutral pill: amber twice
           over would be one warning wearing two hats, and it is the greyed
           surface below that says the same thing at full volume. */
        badges={[
          { word: 'Experimental', tone: astPill('warn', 'ops-pill') },
          { word: 'Under development', tone: astPill('neutral-outline', 'ops-pill') },
        ]}
        meta={payload ? costQualifiers(payload) : ''}
        control={<RefreshControl busy={block.busy} checkedAt={payload?.readAt ?? ''} onRefresh={block.refresh} />}
      />

      <BlockBody>
        {block.busy && !payload ? (
          <Skeleton className="ops-skeleton" />
        ) : absent ? (
          <Absence notice={absent}>{payload?.grant ? <Grant grant={payload.grant} /> : null}</Absence>
        ) : payload ? (
          <>
            <div className="ops-tiles">
              {payload.tiles.map((tile) => {
                const view = tileView(tile, payload.currency);
                const product = productForCostTile(tile.id);
                return (
                  <div key={tile.id} className="ops-tile">
                    {/* 14px beside the label, and absent on the two tiles whose
                      spend is not any one product's: a Lakeflow job and the
                      platform's charge for writing telemetry tables. */}
                    <p className="ops-tile-label">
                      {product ? <BrandIcon product={product} size={14} className="ops-tile-mark" /> : null}
                      {/* Truncated with an ellipsis rather than wrapped, and
                        carrying its own full text on hover. An uppercase
                        letter-spaced eyebrow is the one line on this card that
                        cannot wrap without pushing the figure down a row and
                        taking the card out of step with its neighbours. */}
                      <span className="ops-tile-label-text" title={view.label}>
                        {view.label}
                      </span>
                    </p>
                    {/* `.ast-num` on the figure and not on the basis beside it.
                      Six of these sit in a three-column grid, so a reader compares
                      them down a column, and DM Sans cannot line them up: the
                      basis is a phrase and belongs in DM Sans. */}
                    {view.figure ? (
                      <p className="ops-tile-figure">
                        <span className="ast-num">{view.figure}</span>{' '}
                        <span className="ops-tile-basis">{view.basisLabel}</span>
                      </p>
                    ) : (
                      /* Not a dash and not a zero. A component nobody could
                       attribute and one that cost nothing are different facts. */
                      <p className="ops-tile-absent">{view.absence}</p>
                    )}
                    {/*
                    THE FOOT OF THE CARD, and it holds a badge or a remedy and
                    never a sentence. Six cards of prose under six numbers was a
                    grid nobody read to the end of, and the captions wrapped into
                    the card's own border on the way.

                    The badge is the block's own pill, so "Estimate" on a card
                    reads as the same kind of statement as "Experimental" over all
                    of them. It is drawn only on the apportionments: a badge
                    on a measurement would say the wrong thing about it, and a
                    card with no figure has nothing for it to qualify.

                    Beside it, on the two cards whose meter is the whole
                    warehouse or the whole workspace, the scope. In the neutral
                    pill and not the amber one: it states what the figure covers,
                    and there is nothing about it for anybody to fix.
                  */}
                    {view.estimate || view.sharedScope || view.remedy ? (
                      <p className="ops-tile-foot">
                        {view.estimate ? (
                          <span className={astPill('warn', 'ops-pill')}>{view.qualityLabel}</span>
                        ) : null}
                        {view.sharedScope ? (
                          <span className={astPill('neutral-outline', 'ops-pill')}>{view.population}</span>
                        ) : null}
                        {/* The one thing that would make this figure attributable,
                          and only where there is one. It is not description: it
                          is the single action that fills the card in. */}
                        {view.remedy ? <span className="ops-tile-remedy">{view.remedy}</span> : null}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {billingHref ? (
              <a className="ops-external" href={billingHref} target="_blank" rel="noreferrer">
                Open system.billing.usage
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            ) : null}
            <p className="ops-source-filter">
              Filtered to <code>{"custom_tags['astrolabe']"}</code>.
            </p>
          </>
        ) : null}
      </BlockBody>
    </section>
  );
}

/* ── Traffic ─────────────────────────────────────────────────────────────── */

/**
 * One chart. A list of labelled rows rather than a plotted figure, because every
 * value here is a count against a name and that is a table with bars on it.
 *
 * The count is text on every row. The bar is the thing that can be misread and
 * the number is the thing that cannot, so the number is never only a length.
 */
function BarChart({
  title,
  caption,
  series,
  tone,
  href,
  note,
}: {
  title: string;
  /** Shown INSTEAD of the bars when there are none, never under them. */
  caption: string;
  series: ReturnType<typeof bars>;
  /** Which ink the bars take: the failure red, the refusal slate, or the blue. */
  tone: 'failure' | 'refusal' | 'tool';
  /** Where a count links, if a count links anywhere. */
  href?: (bar: { key: string }) => string;
  /**
   * A standing fact about what this chart is FOR, under it whether or not it has
   * bars. The tool-call chart carries the one that pays for the chart: a shift in
   * its shape is usually the first sign a release moved the agent. It is body
   * text, not a caption on the empty state, because it is true of the populated
   * chart too.
   */
  note?: string;
}) {
  return (
    <div className={`ops-chart ops-chart-${tone}`}>
      <h4>{title}</h4>
      {series.length === 0 ? (
        <p className="ops-chart-empty">{caption}</p>
      ) : (
        <ul className="ops-bars">
          {series.map((bar) => (
            <li key={bar.key} className="ops-bar-row">
              {/* The name in full, wrapping rather than broken through the middle
                  of a word. Cause and tool labels alike are prose the store
                  recorded, so a label clipped to one line loses the phrase that
                  carries its meaning; the full text stays on `title` as well for
                  a pointer. */}
              <span className="ops-bar-label" title={bar.label}>
                {bar.label}
              </span>
              <span className="ops-bar-track">
                <span className="ops-bar-fill" style={{ width: `${bar.percent}%` }} aria-hidden="true" />
              </span>
              {href ? (
                <Link className="ops-bar-count" to={href(bar)}>
                  {count(bar.count)}
                </Link>
              ) : (
                <span className="ops-bar-count">{count(bar.count)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {note ? <p className="ops-chart-note">{note}</p> : null}
    </div>
  );
}

/** A day on the questions axis, short enough to sit under a 64px column. */
function axisDay(day: string): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(at)) return day;
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * How many columns can carry their own figure before the figures collide.
 *
 * A week fits comfortably, a month does not. Above this the scale is the peak on
 * the gridline instead, which is one label rather than thirty and is the fact a
 * reader was missing either way.
 */
const DAY_VALUE_LIMIT = 10;

/**
 * Questions per day, as columns rather than as rows.
 *
 * The one chart on this page whose x axis is time, so it is the one drawn as a
 * time series. Only the first and last dates are labelled: the handoff's shape,
 * and the honest one, because a column per day in a 30 day range cannot carry
 * thirty legible labels and the ones it would drop are not the ones a reader
 * picks.
 *
 * IT NOW CARRIES A SCALE, WHICH IS WHAT IT WAS MISSING. Drawn with the counts
 * off screen it was four unlabelled bars between two dates: a reader could see
 * which day was busiest and had no way at all to tell whether the tallest was
 * three questions or three hundred. Over a short range every column shows its
 * own figure; over a long one the peak is marked on the line the tallest column
 * reaches, which is a scale a reader can read the rest of the chart against.
 *
 * EVERY COLUMN STILL CARRIES ITS NUMBER IN TEXT whatever the density, on the
 * column's own `title` and to a screen reader. A chart whose counts exist only
 * as heights is a chart a screen reader reports as nothing at all.
 */
function QuestionsPerDay({ days }: { days: Array<{ day: string; count: number }> }) {
  const busiest = days.reduce((high, day) => Math.max(high, day.count), 0);
  const valued = days.length <= DAY_VALUE_LIMIT;
  /*
   * The tallest column's share of the plot.
   *
   * Short of the full height where the columns carry their figures, because the
   * figure sits above the column inside the same 64px and a bar drawn to 100%
   * would push it out through the top of the chart.
   */
  const ceiling = valued ? 78 : 100;
  return (
    <div className="ops-chart">
      <h4>Questions per day</h4>
      {days.length === 0 ? (
        <p className="ops-chart-empty">No questions were asked in this range.</p>
      ) : (
        <>
          {/* The scale, where the columns are too many to each carry one. On the
              line the tallest column reaches, so it reads as the top of the axis
              rather than as a figure belonging to the first day. */}
          {!valued && busiest > 0 ? <p className="ops-daybars-peak">{count(busiest)}</p> : null}
          <ul className="ops-daybars">
            {days.map((day) => (
              <li key={day.day} className="ops-daybar" title={`${axisDay(day.day)}: ${count(day.count)}`}>
                {valued && day.count > 0 ? <span className="ops-daybar-value">{count(day.count)}</span> : null}
                {/* No column at all for a day nothing was asked on. A drawn bar
                    is a claim that there is something to draw. */}
                {day.count > 0 && busiest > 0 ? (
                  <span
                    className="ops-daybar-fill"
                    style={{ height: `${Math.max(4, Math.round((day.count / busiest) * ceiling))}%` }}
                    aria-hidden="true"
                  />
                ) : null}
                <span className="sr-only">
                  {axisDay(day.day)}: {count(day.count)}
                </span>
              </li>
            ))}
          </ul>
          <p className="ops-daybars-axis">
            <span>{axisDay(days[0].day)}</span>
            <span>{axisDay(days[days.length - 1].day)}</span>
          </p>
        </>
      )}
    </div>
  );
}

/** Where a cause count lands on Monitoring, with that outcome already chosen. */
export type MonitoringHref = (outcome: 'failed' | 'refused') => string;

/**
 * How many routes one page of the latency table holds.
 *
 * Ten, which is about what a reader scans without losing the head of the table,
 * and short enough that this block stays the same height as the three above it on
 * a deployment serving fifty routes.
 */
const LATENCY_PAGE_SIZE = 10;

/**
 * Per-route latency, from the server spans.
 *
 * A BLOCK OF ITS OWN, reading a route of its own, so a warehouse that will not
 * answer this leaves health, cost and traffic standing.
 *
 * FIGURES PLUS A VERDICT AGAINST EACH ROUTE'S OWN PRIOR HALF. No fixed budgets:
 * a route is concerning when its current-half median is at least 1.5× its
 * prior-half median, and only when both halves clear the baseline floor. Thin
 * samples say so in words and never draw a fault colour.
 */
export function LatencyBody({ block }: { block: Block<OpsLatencyPayload> }) {
  const payload = block.data;
  /*
   * Which page of routes is on screen.
   *
   * Above the block's own early returns, because a hook cannot be called
   * conditionally. It is never reset: the clamp below does that job without an
   * effect, so nothing here can draw a stale page before correcting it.
   */
  const [page, setPage] = useState(0);

  if (block.failed) {
    return (
      <section className="ops-block" aria-labelledby="ops-latency-heading">
        <h3 id="ops-latency-heading" className="sr-only">
          Latency
        </h3>
        <BlockBody>
          <BlockFailed title="Latency" reason={block.failed} onRetry={block.refresh} />
        </BlockBody>
      </section>
    );
  }

  const absence = payload ? latencyAbsence(payload) : null;

  /*
   * The routes this page of the table holds.
   *
   * CLAMPED IN THE RENDER RATHER THAN RESET IN AN EFFECT. A re-read can come back
   * with fewer routes than the page a reader is sitting on -- a quiet hour drops
   * routes out of the span table entirely -- and a page index left pointing past
   * the end would draw an empty table under a populated head. An effect correcting
   * it would draw that empty table first and then replace it.
   */
  const routes = absence ? [] : (payload?.routes ?? []);
  const pages = Math.max(1, Math.ceil(routes.length / LATENCY_PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const from = current * LATENCY_PAGE_SIZE;
  const shown = routes.slice(from, from + LATENCY_PAGE_SIZE);

  const facts = payload ? latencySharedFacts(routes) : { line: '', showPercentiles: false };
  // Log-scaled across the rows ON SCREEN, so the scale answers to the page a
  // reader is looking at rather than to routes on another page of the table.
  const barWidths = p50BarWidths(shown.map((route) => route.p50Ms));

  return (
    <section className="ops-block" aria-labelledby="ops-latency-heading">
      <BlockHead
        id="ops-latency-heading"
        title="Latency"
        meta={<LatencyCaption from={payload?.coveredFrom ?? ''} to={payload?.coveredTo ?? ''} />}
        control={<RefreshControl busy={block.busy} checkedAt={payload?.readAt ?? ''} onRefresh={block.refresh} />}
      />

      <BlockBody>
        {block.busy && !payload ? (
          <Skeleton className="ops-skeleton" />
        ) : absence ? (
          <Absence notice={absence}>{payload?.grant ? <Grant grant={payload.grant} /> : null}</Absence>
        ) : payload ? (
          <>
            {/* THE FACT TRUE OF EVERY ROW, SAID ONCE. Replaces the columns of
                repeated dashes p95/p99/errors/refusals/trend became on a quiet
                window. When a route crosses the span floor the columns come
                back and this line stops claiming there are none. */}
            {facts.line ? (
              <p className="ops-latency-facts">
                <Info className="size-3.5" aria-hidden="true" />
                <span>{facts.line}</span>
              </p>
            ) : null}
            <div className="ops-latency-scroll">
              <table
                className={`ops-table ops-latency-table${facts.showPercentiles ? ' ops-latency-table-expanded' : ''}`}
                data-testid="ops-latency"
              >
                <colgroup>
                  <col className="ops-lat-col-method" />
                  <col className="ops-lat-col-route" />
                  <col className="ops-lat-col-hit" />
                  <col className="ops-lat-col-spans" />
                  <col className="ops-lat-col-p50" />
                  <col className="ops-lat-col-bar" />
                  <col className="ops-lat-col-slowest" />
                  {facts.showPercentiles ? (
                    <>
                      <col className="ops-lat-col-percentile" />
                      <col className="ops-lat-col-percentile" />
                      <col className="ops-lat-col-trend" />
                    </>
                  ) : null}
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col" className="ops-lat-method">
                      Method
                    </th>
                    <th scope="col" className="ops-lat-route">
                      Route
                    </th>
                    <th scope="col" className="ops-lat-hit">
                      Last hit
                    </th>
                    <th scope="col" className="ops-lat-spans">
                      Spans
                    </th>
                    <th scope="col" className="ops-lat-p50">
                      p50
                    </th>
                    <th scope="col" className="ops-lat-bar-head">
                      P50 · log scale
                    </th>
                    <th scope="col" className="ops-lat-slowest">
                      Slowest
                    </th>
                    {facts.showPercentiles ? (
                      <>
                        <th scope="col">p95</th>
                        <th scope="col">p99</th>
                        <th scope="col">Trend</th>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((route, index) => (
                    <LatencyRow
                      key={route.route}
                      route={route}
                      barWidth={barWidths[index]}
                      showPercentiles={facts.showPercentiles}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </BlockBody>

      {/*
        A PAGE AT A TIME, AND ONLY WHERE THERE IS MORE THAN ONE. A deployment
        serves dozens of routes and every one of them lands in this table, so the
        block grew until it was longer than the three above it put together and
        the slow route somebody came here for was thirty rows down.

        Drawn as the block's foot, which is where Cost puts its average and
        Traffic its link out, so this is the same hairline strip rather than a
        fourth kind of thing. Nothing renders at ten routes or fewer: controls
        over a single page are chrome for a decision nobody has to make.
      */}
      {pages > 1 ? (
        <div className="ops-block-foot ops-pager">
          <span className="ops-pager-range">
            {from + 1}&ndash;{from + shown.length} of {count(routes.length)}
          </span>
          <span className="ops-pager-steps">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(current - 1)}
              disabled={current === 0}
              aria-label="Previous routes"
            >
              <ChevronLeft className="size-3.5" aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(current + 1)}
              disabled={current === pages - 1}
              aria-label="Next routes"
            >
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </Button>
          </span>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The window the baseline is taken from, in the reader's words, with the exact
 * span timestamps kept on hover.
 *
 * "vs each route's prior half" is the constant; the dates are what the table is
 * actually over, which is NOT the range chip at the top of the page — telemetry
 * does not backfill, so the spans reach back only as far as they were recorded.
 * Human-readable on the page, full timestamps in `title`, per the handoff.
 */
function LatencyCaption({ from, to }: { from: string; to: string }) {
  if (!from || !to) {
    return <span className="ops-block-meta">By route, vs each route’s prior half</span>;
  }
  return (
    <span className="ops-block-meta" title={`${from} to ${to}`}>
      By route, vs each route’s prior half · {spokenSpanTime(from)} to {spokenSpanTime(to)}
    </span>
  );
}

/** A span time as a reader reads one: "Aug 16, 7:30 PM". Empty stays empty. */
function spokenSpanTime(raw: string): string {
  if (!raw) return '';
  const at = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  if (!Number.isFinite(at)) return raw;
  return new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'UTC',
  });
}

/** One high percentile, or the withheld mark with the reason on the cell. */
function PercentileCell({ ms, spans }: { ms: number | null; spans: number }) {
  if (ms === null) {
    return (
      <td title={withheldReason(spans)}>
        <abbr title={withheldReason(spans)}>{WITHHELD}</abbr>
      </td>
    );
  }
  return <td>{latencyFigure(ms)}</td>;
}

/**
 * One route in the compact grid: method chip · route · last hit · spans · p50 ·
 * log-scaled p50 bar · slowest, with p95/p99/trend appended only where the block
 * has crossed the span floor for at least one route.
 */
function LatencyRow({
  route,
  barWidth,
  showPercentiles,
}: {
  route: RouteLatency;
  barWidth: number;
  showPercentiles: boolean;
}) {
  const view = latencyRouteView(route);
  const { method, path } = splitMethod(route.route);
  const p50 = latencyFigure(route.p50Ms);
  const verdictTone =
    view.verdict === 'slower'
      ? astPill('neg', 'ops-pill')
      : view.verdict === 'within'
        ? astPill('pos', 'ops-pill')
        : astPill('neutral-outline', 'ops-pill');

  return (
    <tr className={view.verdict === 'slower' ? 'ops-latency-row-slower' : undefined}>
      <td className="ops-lat-method">
        {method ? <span className={`ops-lat-chip ops-lat-chip-${method.toLowerCase()}`}>{method}</span> : null}
      </td>
      <th scope="row" className="ops-lat-route">
        <span className="ops-lat-path" title={route.route}>
          {path}
        </span>
      </th>
      <td className="ops-lat-hit">{view.freshLabel}</td>
      <td className="ops-lat-spans">{count(route.spans)}</td>
      {/* Empty is not zero: an unmeasurable p50 says "not set" in mono rather
          than a bare 0 or a blank cell, per the tab's own rule. */}
      <td className="ops-lat-p50">{p50 || <span className="ops-when-absent">not set</span>}</td>
      <td className="ops-lat-bar">
        {/* The bar is a length that can be misread; the p50 beside it is the
            number that cannot, so the bar is decorative and aria-hidden. No
            track at all where there is no duration to draw. */}
        {barWidth > 0 ? (
          <span className="ops-lat-bar-track" aria-hidden="true">
            <span className="ops-lat-bar-fill" style={{ width: `${barWidth}%` }} />
          </span>
        ) : null}
      </td>
      <td className="ops-lat-slowest">
        {latencyFigure(route.slowestMs) || <span className="ops-when-absent">not set</span>}
      </td>
      {showPercentiles ? (
        <>
          <PercentileCell ms={route.p95Ms} spans={route.spans} />
          <PercentileCell ms={route.p99Ms} spans={route.spans} />
          <td>
            {view.verdict === 'slower' || view.verdict === 'within' ? (
              <span className={verdictTone} title={view.verdictDetail || undefined}>
                {view.verdictLabel}
              </span>
            ) : (
              <abbr className="ops-when-absent" title={view.verdictDetail || withheldReason(route.spans)}>
                {WITHHELD}
              </abbr>
            )}
          </td>
        </>
      ) : null}
    </tr>
  );
}

export function TrafficBody({
  block,
  monitoringHref = (outcome) => `/monitoring?${OUTCOME_PARAM}=${outcome}`,
  runsHref = () => '/runs',
}: {
  block: Block<OpsTrafficPayload>;
  monitoringHref?: MonitoringHref;
  /** Where the footer's answer-times link lands, carrying this page's range. */
  runsHref?: () => string;
}) {
  const payload = block.data;

  if (block.failed) {
    return (
      <section className="ops-block" aria-labelledby="ops-traffic-heading">
        <h3 id="ops-traffic-heading" className="sr-only">
          Traffic
        </h3>
        <BlockBody>
          <BlockFailed title="Traffic" reason={block.failed} onRetry={block.refresh} />
        </BlockBody>
      </section>
    );
  }

  return (
    <section className="ops-block" aria-labelledby="ops-traffic-heading">
      <BlockHead
        id="ops-traffic-heading"
        title="Traffic"
        // The denominator every chart under this band is counted against, said
        // once here rather than repeated as a caption under each of them. Absent
        // rather than zero when nothing ran: "From 0 recorded runs" is a count
        // the tab's rules forbid, and it reads as a population that was measured
        // rather than as one that does not exist.
        meta={payload && payload.runsInRange > 0 ? `From ${count(payload.runsInRange)} recorded runs` : ''}
        control={<RefreshControl busy={block.busy} checkedAt={payload?.readAt ?? ''} onRefresh={block.refresh} />}
      />

      <BlockBody>
        {block.busy && !payload ? (
          <Skeleton className="ops-skeleton" />
        ) : payload?.reason ? (
          <Absence notice={{ title: 'Traffic could not be read', body: payload.reason }} />
        ) : payload ? (
          <>
            {/* A read that was cut off, standing BESIDE the charts that
                answered rather than replacing them. An empty chart is a
                population of nobody, and a read that never came back did not
                measure a population at all. `reason` above substitutes the
                whole block; this one does not, because two charts out of three
                are still worth looking at. */}
            {payload.unread ? (
              <Absence notice={{ title: 'Part of this could not be read', body: payload.unread }} />
            ) : null}
            <div className="ops-charts">
              <QuestionsPerDay days={payload.questionsPerDay} />

              {/* TWO CHARTS, NEVER ONE SERIES AND NEVER A TOTAL. A refusal is the
                app working correctly and telling somebody they may not read
                something; a failure is the app not working. Drawn together they
                make a "problems" figure an operator will chase, and most of it
                would be the access controls doing their job.

                The failures title used to carry that as a clause: "refusals are
                the next chart, never this one". It was the design narrating its
                own layout to a reader who can see two headings, and it is the
                comment above rather than words on the page. */}
              <div className="ops-chart-pair" data-testid="ops-traffic-causes">
                <BarChart
                  title="Failures by cause"
                  caption={trafficCaption(payload.failuresByCause, 'failure', 'failures', payload.runsInRange)}
                  series={bars(payload.failuresByCause)}
                  tone="failure"
                  href={() => monitoringHref('failed')}
                />
                <BarChart
                  title="Refusals by cause"
                  caption={trafficCaption(payload.refusalsByCause, 'refusal', 'refusals', payload.runsInRange)}
                  series={bars(payload.refusalsByCause)}
                  tone="refusal"
                  href={() => monitoringHref('refused')}
                />
              </div>

              <BarChart
                title="Tool calls by tool"
                // Three words where there was a sentence, and no denominator: the
                // run count is in the band above, once, and the three charts under
                // it were each repeating it back in a full sentence about nothing
                // having happened.
                caption="No tool calls"
                series={bars(payload.toolCalls)}
                tone="tool"
                // The reason this chart earns its column, said on the chart. It is
                // the one whose shape an operator reads for release drift, so the
                // sentence that tells them that stands under it rather than in a
                // doc they will not have open.
                note="A change in this shape is usually the first sign a release changed the agent's behaviour."
              />
            </div>
          </>
        ) : null}
      </BlockBody>

      {/*
        THE WAY THROUGH TO THE RUNS THEMSELVES. The two cause charts already
        land on Monitoring filtered to the outcome that was clicked; the thing
        this block could not reach was the runs as runs, which is where an
        answer time is a fact about one question rather than a shape on a
        chart. The range travels, for the reason it travels to Monitoring: the
        charts above were drawn over THIS window, and landing a reader on Run
        Explorer's default would show them a different population than the one
        they clicked out of.
      */}
      {payload && !payload.reason ? (
        <p className="ops-block-foot">
          <Link className="ops-foot-link" to={runsHref()}>
            Answer times in Run Explorer
          </Link>
        </p>
      ) : null}
    </section>
  );
}

/* ── The page ────────────────────────────────────────────────────────────── */

export function OpsPage() {
  const [searchParams] = useSearchParams();

  /**
   * One instant for the whole page, taken once when it mounts.
   *
   * Not `Date.now()` in the render: the window below is part of the string the
   * three blocks fetch, so a clock read here would produce a new string on every
   * render and three reads that never stopped. It is also the right answer on its
   * own terms -- the three blocks refresh independently, and a `now` that moved
   * between them would let health be over a different window from cost, which is
   * the one thing this page's range is shared to prevent.
   */
  const [now] = useState(() => Date.now());

  /**
   * THE RANGE, RESOLVED TO TIMESTAMPS BEFORE IT IS SENT. This is the fix for a
   * bug worth naming here, because the shape of the code invited it: this page
   * used to hand the browser's own search string to the three routes, and the
   * server reads `from` and `to`. The control writes `range=24h` or `range=30d`
   * and deliberately writes no timestamps for those -- so the server saw no
   * bounds, fell back to its default, and returned the last seven days for three
   * of the four options while the chosen button stayed highlighted.
   *
   * Monitoring never had the bug because it has always resolved the control to a
   * window with `rangeWindow` and sent that. This now does the same thing the
   * same way. Nothing on either page should send the control's WORD to a server.
   */
  const window_ = rangeWindow(searchParams, now);
  const search = `?from=${encodeURIComponent(window_.from)}&to=${encodeURIComponent(window_.to)}`;

  /**
   * The days the figures are actually over, derived with the server's own
   * function so the printed window cannot drift from the queried one.
   */
  const days = opsDayRange(window_.from, window_.to, now);

  // Three reads, started together and finishing whenever each finishes. Nothing
  // below waits on anything else, which is the whole point of the arrangement.
  // All three take the same `search`, so a range change re-reads all three
  // rather than only whichever one is on screen.
  const health = useBlock<OpsHealthPayload>('/api/ops/health', search);
  const cost = useBlock<OpsCostPayload>('/api/ops/cost', search);
  const traffic = useBlock<OpsTrafficPayload>('/api/ops/traffic', search);
  /*
    The fourth read, and the one that does not take the range: it is passed the
    same `search` so a range change still re-reads it, but the server ignores the
    bounds and reports the window the spans actually cover. See
    `buildLatencyStatement`.
  */
  const latency = useBlock<OpsLatencyPayload>('/api/ops/latency', search);

  /**
   * Monitoring, over the window this page is showing, narrowed to one outcome.
   *
   * The range parameters travel rather than being dropped, because the count the
   * reader clicked was counted over THIS window: landing them on Monitoring's
   * default week would show a different number for the same question and the
   * page they came from would look wrong.
   */
  const monitoringHref: MonitoringHref = (outcome) => {
    const params = new URLSearchParams(searchParams);
    params.set(OUTCOME_PARAM, outcome);
    return `/monitoring?${params.toString()}`;
  };

  /**
   * Run Explorer, over the window this page is showing.
   *
   * The range travels for the same reason it travels to Monitoring: a reader
   * following an answer time out of a chart drawn over 30 days must not land on
   * Run Explorer's default week and see a shorter list than the one they clicked
   * out of.
   */
  const runsHref = () => {
    const params = new URLSearchParams(searchParams);
    const query = params.toString();
    return query ? `/runs?${query}` : '/runs';
  };

  return (
    <div className="page-shell ops-page">
      <PageHeading title="Ops" actions={<TimeRangeControl page="Ops" />} />

      {/*
        THE DATES, SPELLED OUT. A highlighted button is a claim about a window and
        this is the evidence for it. Without it a total for the wrong week is
        indistinguishable from one for the right week, which is exactly how the
        range bug above survived: every caption said "in this range" and nothing
        on the page said which range.

        `data-testid` because the string is a date and a test asserting it by
        prose would be asserting the locale.
      */}
      {/* The dates alone, in the chip idiom the filters use. "Showing" was a word
          spent introducing a fact that reads as a fact without it. */}
      <p className="ops-range-dates" data-testid="ops-range-dates">
        <span className="ops-range-dates-value">{opsRangeDates(days)}</span>
        {/*
          A custom range that could not be read is not the window that was asked
          for, and a page showing figures over a substituted window has to say so.
          Silently falling back is how somebody reads last week's spend as the
          answer to a question about March.
        */}
        {window_.customIncomplete ? (
          <span className="ops-range-dates-note">
            The custom range was incomplete, so this is the default window rather than the one asked for.
          </span>
        ) : null}
      </p>

      {/* Each block reads itself. Three read times on one page rather than one,
          because they were read at three different moments. */}
      <HealthBody block={health} />
      <CostBody block={cost} />
      <TrafficBody block={traffic} monitoringHref={monitoringHref} runsHref={runsHref} />
      <LatencyBody block={latency} />
    </div>
  );
}
