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
 *  - The failure and refusal taxonomy, which is the server's.
 *
 * NO POLLING, for the reason Monitoring does not poll: the billing query scans
 * a workspace-wide table, and a page that re-ran it every thirty seconds would
 * cost money to look at. The same reason the four blocks are kept in
 * `ops-session.ts` rather than in this page's `useState`: leaving the tab and
 * coming back is not a reason to scan billing again. Refresh still is.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, ExternalLink, Search, Users, X } from 'lucide-react';
import { Button, Input, Skeleton } from './ui';
import { astPill } from './pia-pill';
import { BrandIcon } from './BrandIcon';
import { ExperimentalBadge } from './ExperimentalBadge';
import { PiaLoadingLabel } from './PiaLoadingLabel';
import { PiaBusyButtonContent } from './PiaLoader';
import { PiaEmptyStateMark } from './PiaMark';
import { Disclosure, PageHeading } from './page-chrome';
import { RefreshButton, RefreshControl } from './RefreshControl';
import { ageAgo, checkedAgoLine } from './refresh-state';
import { useWorkspaceHost } from './data-entity-state';
import { databricksLink } from '../../shared/databricks-links';
import { CostBudgetProvider, CostResourceBudgets, CostSpendSummary, CostTotalBudget } from './CostBudgets';
import {
  activeMinutesDisplay,
  bars,
  costAbsence,
  costAbsenceReplacesGrid,
  costTilesForDisplay,
  costTileWorkspaceObject,
  genieCostCardViews,
  tileAttribution,
  count,
  errorFraming,
  healthResourceObject,
  latencyAbsence,
  latencyFigure,
  latencyRouteMatchesTrend,
  latencyRouteView,
  latencySharedFacts,
  p50BarWidths,
  primaryCostCardViews,
  productForCostTile,
  productForProbe,
  splitMethod,
  telemetryNotice,
  WITHHELD,
  withheldReason,
  type Absence as AbsenceCopy,
  type HealthRow,
} from './ops-view';
import { healthConnectionsHref, healthRowsForDisplay } from './health-resource-view';
import { useOpsBlock } from './ops-session';
import { useOpsScopeCheck } from './OpsScopeModal';
import './styles/routes/ops.css';
import { NO_EXPERIMENTS, showsForecasting } from './experimental-features';
import { ForecastingBody } from './ForecastingPanel';
import { MethodologySections, type MethodologyGroup } from './MethodologySection';
import { dateOnlyBadgeValue, DateBadge } from './DateBadge';
import { showsAdminSurfaces, useRole, type AppOutletContext } from './role';
import { canCheckHealthResources } from '../../shared/user-roster-contract';
import { persistCostDisplayUnit, readCostDisplayUnit } from './cost-unit-preference';
import type { CostBudgetUnit } from '../../shared/cost-budgets';
import { perUserSpendHref } from './cost-user-monitoring-link';
import { UnitSegmentedControl } from './UnitSegmentedControl';
import type {
  DependencyResult,
  GrantRemedy,
  OpsCostPayload,
  OpsHealthPayload,
  OpsLatencyPayload,
  OpsTrafficPayload,
  RouteLatency,
} from '../../shared/ops-contract';
import { opsCurrentMonthKey } from '../../shared/ops-contract';

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
  titleBadge,
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
  titleBadge?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="ops-block-head">
      <div className="ops-block-head-text">
        {(badges ?? []).map((badge) => (
          <span key={badge.word} className={badge.tone}>
            {badge.word}
          </span>
        ))}
        <span className="ops-block-title-group">
          <h3 id={id}>{title}</h3>
          {titleBadge}
        </span>
        {meta ? <span className="ops-block-meta">{meta}</span> : null}
        {children}
      </div>
      {control ? <div className="ops-block-head-control">{control}</div> : null}
    </div>
  );
}

/** The body inside a block's border, held off the edges by one rule. */
function BlockBody({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`ops-block-body${className ? ` ${className}` : ''}`}>{children}</div>;
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
      {notice.body ? <p className="ops-absence-body">{notice.body}</p> : null}
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
function ResultPill({ row, busy }: { row: HealthRow; busy: boolean }) {
  if (busy) {
    return (
      <PiaLoadingLabel
        as="span"
        seat="status"
        tone="light"
        announce={false}
        className="ops-connection-status-loader"
        label={`Checking ${row.label}`}
      />
    );
  }
  return (
    <span
      className={`${row.pill.tone} ops-platform-pill`}
      aria-label={`${row.label} connection status: ${row.pill.value}`}
    >
      <span className="ops-platform-pill-state">{row.pill.value}</span>
    </span>
  );
}

export function HealthBody({ block }: { block: Block<OpsHealthPayload> }) {
  const host = useWorkspaceHost();
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
  const rows = healthRowsForDisplay(payload);

  return (
    <section className="ops-block" aria-labelledby="ops-health-heading">
      <BlockHead
        id="ops-health-heading"
        title="Health"
        // The probe's own word. These rows are a check rather than a read, and
        // the cost and traffic bands say "Read" for the same reason: they are.
        // Both wordings and the one rounding are the Refresh control's.
        meta={checkedAgoLine(payload?.checkedAt ?? '')}
        control={
          <div className="ops-health-head-controls">
            <RefreshButton busy={block.busy} onRefresh={block.refresh} />
          </div>
        }
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
              <div className="ops-table-scroll">
                <table className="ops-table ops-health-table">
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
                    {rows.map((row) => {
                      const object = healthResourceObject(row);
                      const resourceHref = object ? databricksLink(host, object) : null;
                      const connectionsHref = healthConnectionsHref(row);
                      return (
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
                              {connectionsHref ? (
                                <Link className="ops-dependency-label" to={connectionsHref}>
                                  {row.label}
                                </Link>
                              ) : (
                                <span className="ops-dependency-label">{row.label}</span>
                              )}
                              {/* Databricks, beside Connections, and only where a
                              verified path exists. Architecture does the same
                              split: the in-app row always works, leaving the
                              workspace is a second control. */}
                              {resourceHref && row.name && row.label.includes(row.name) ? (
                                <a
                                  className="ops-resource-open"
                                  href={resourceHref}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={`Open ${row.label} in Databricks`}
                                >
                                  <ExternalLink className="size-3.5" aria-hidden="true" />
                                  <span className="sr-only">Open in Databricks</span>
                                </a>
                              ) : null}
                            </span>
                            {/* The configured identifier, and only where the label is
                            not already carrying it. Most probe labels are
                            "SQL warehouse · <id>" and the second line was the
                            same string again under the first. When a Databricks
                            URL can be built, this identifier is that link. */}
                            {row.name && !row.label.includes(row.name) ? (
                              resourceHref ? (
                                <a
                                  className="ops-dependency-name"
                                  href={resourceHref}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={`Open ${row.name} in Databricks`}
                                >
                                  {row.name}
                                </a>
                              ) : (
                                <span className="ops-dependency-name">{row.name}</span>
                              )
                            ) : null}
                          </th>
                          <td className="ops-col-result">
                            {/* The badge that used to sit in the band above, in the
                            row it is about. The words are the state; the class
                            only paints what they already said, so this reads the
                            same in monochrome and to a screen reader. */}
                            <ResultPill row={row} busy={block.busy} />
                          </td>
                          <td className="ops-col-when">
                            {row.lastCheckedAt ? (
                              <time dateTime={row.lastCheckedAt}>{ageAgo(row.lastCheckedAt)}</time>
                            ) : null}
                          </td>
                          <td className="ops-reason">{row.notes}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
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

export function CostUnitControl({
  unit,
  onChange,
}: {
  unit: CostBudgetUnit;
  onChange: (unit: CostBudgetUnit) => void;
}) {
  return <UnitSegmentedControl unit={unit} onChange={onChange} label="Budget unit" ariaLabel="Budget unit filter" />;
}

export function CostBody({
  block,
  unit = 'USD',
  onUnitChange = () => {},
  userMonitoringHref,
}: {
  block: Block<OpsCostPayload>;
  unit?: CostBudgetUnit;
  onUnitChange?: (unit: CostBudgetUnit) => void;
  userMonitoringHref?: string;
}) {
  const payload = block.data;
  const host = useWorkspaceHost();

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
  const replaceGrid = payload ? costAbsenceReplacesGrid(payload) : false;
  const displayed = payload ? costTilesForDisplay(payload.tiles) : [];
  const budgetTiles = displayed.filter(
    (tile) => tile.id !== 'foundation-model' || tileAttribution(tile) === 'deployment'
  );

  return (
    <section className="ops-block" aria-labelledby="ops-cost-heading">
      <BlockHead
        id="ops-cost-heading"
        title="Cost Tracking"
        control={
          <div className="ops-cost-head-controls">
            {userMonitoringHref ? (
              <Button variant="default" size="sm" className="ops-user-spend-link" asChild>
                <Link to={userMonitoringHref}>
                  <Users aria-hidden="true" />
                  See per-user spend
                </Link>
              </Button>
            ) : null}
            <CostUnitControl unit={unit} onChange={onUnitChange} />
            <RefreshControl busy={block.busy} checkedAt={payload?.readAt ?? ''} onRefresh={block.refresh} />
          </div>
        }
        titleBadge={<ExperimentalBadge />}
      />

      <BlockBody>
        {block.busy && !payload ? (
          <Skeleton className="ops-skeleton" />
        ) : payload ? (
          <CostBudgetProvider payload={payload} tileIds={budgetTiles.map((tile) => tile.id)} unit={unit}>
            {replaceGrid && absent ? (
              <Absence notice={absent}>{payload.grant ? <Grant grant={payload.grant} /> : null}</Absence>
            ) : null}
            <div className="ops-cost-summary-grid">
              <CostSpendSummary payload={payload} unit={unit} />
              <div className="ops-cost-summary-box">
                <CostTotalBudget />
              </div>
              <CostResourceBudgets tiles={budgetTiles} />
            </div>
            <div className="ops-cost-resources">
              <CostCardGrid payload={payload} displayed={displayed} host={host} unit={unit} />
            </div>
            {!replaceGrid && absent ? <p className="ops-cost-empty-note">{absent.body}</p> : null}
            <CostMethodology />
          </CostBudgetProvider>
        ) : null}
      </BlockBody>
    </section>
  );
}

function CostCardGrid({
  payload,
  displayed,
  host,
  unit,
}: {
  payload: OpsCostPayload;
  displayed: OpsCostPayload['tiles'];
  host: string;
  unit: CostBudgetUnit;
}) {
  const primary = primaryCostCardViews(payload, unit);
  const average = primary.at(-1);
  const componentCards = primary.slice(0, -1);
  const genie = genieCostCardViews(payload, unit);
  return (
    <div className="ops-tiles" data-testid="cost-primary-grid">
      {componentCards.map((card) => (
        <PrimaryCostCard key={card.id} card={card} tile={displayed.find((item) => item.id === card.id)} host={host} />
      ))}
      {genie.map((card) => {
        const tile = displayed.find((item) => item.id === card.id);
        const href =
          tile?.resourceId && tile.resourceKind === 'genie-space'
            ? databricksLink(host, { kind: 'genie-space', spaceId: tile.resourceId })
            : null;
        return (
          <article key={card.id} className="ops-tile ops-primary-cost-card ops-genie-card">
            <div className="ops-tile-head">
              <h4 className="ops-tile-label">
                <BrandIcon product="genie" size={14} className="ops-tile-mark" />
                <span className="ops-tile-label-text">{card.title}</span>
              </h4>
              <span className={astPill('neutral-outline', 'ops-pill ops-cost-status')}>Estimated</span>
            </div>
            <dl className="ops-genie-values">
              <div>
                <dt title="Estimated value if this free usage had been charged at the applicable list price.">Free</dt>
                <dd className="ast-num">{card.free}</dd>
              </div>
              <div>
                <dt>Charged</dt>
                <dd className="ast-num">{card.charged}</dd>
              </div>
            </dl>
            <GenieDatabricksLink href={href} title={card.title} />
          </article>
        );
      })}
      {average ? <PrimaryCostCard card={average} host={host} /> : null}
    </div>
  );
}

function PrimaryCostCard({
  card,
  tile,
  host,
}: {
  card: ReturnType<typeof primaryCostCardViews>[number];
  tile?: OpsCostPayload['tiles'][number];
  host: string;
}) {
  const product = productForCostTile(card.id);
  const object = tile ? costTileWorkspaceObject(tile) : null;
  const href = object ? databricksLink(host, object) : null;
  const concise = card.id === 'foundation-model';
  return (
    <article className={`ops-tile ops-primary-cost-card${concise ? ' ops-primary-cost-card--concise' : ''}`}>
      <div className="ops-tile-head">
        <h4 className="ops-tile-label">
          {product ? <BrandIcon product={product} size={14} className="ops-tile-mark" /> : null}
          <span className="ops-tile-label-text">{card.title}</span>
        </h4>
        {card.status ? (
          <span className={astPill('neutral-outline', 'ops-pill ops-cost-status')}>{card.status}</span>
        ) : null}
      </div>
      <p className="ops-tile-figure" title={!concise && card.detail ? card.detail : undefined}>
        <span className="ast-num">{card.amount}</span>
      </p>
      {card.secondaryMetric ? <p className="ops-tile-secondary">{card.secondaryMetric}</p> : null}
      {!concise ? <p className="ops-tile-basis">{card.basis}</p> : null}
      {!concise && /^Billing through \d{4}-\d{2}-\d{2}$/.test(card.evidence) ? (
        <div className="ops-tile-evidence">
          <DateBadge
            value={dateOnlyBadgeValue(card.evidence.slice('Billing through '.length))}
            accessiblePrefix="Billing through"
          />
        </div>
      ) : !concise ? (
        <p className="ops-tile-evidence">{card.evidence || '\u00a0'}</p>
      ) : null}
      {card.resource ? <CostResourceLine label={card.resource} href={href} /> : null}
    </article>
  );
}

/**
 * A configured resource is separate from the concise card heading.
 *
 * Split so a test can render a real href. CostBody itself cannot: the workspace
 * host is read in an effect, and static markup never runs one.
 */
export function CostResourceLine({ label, href }: { label: string; href: string | null }) {
  if (!href) {
    return (
      <span className="ops-cost-resource" title={label}>
        {label}
      </span>
    );
  }
  return <GenieDatabricksLink href={href} title={label} />;
}

/** Compatibility export for focused render tests; resource links no longer serve as card titles. */
export const CostTileTitle = CostResourceLine;

export function GenieDatabricksLink({ href, title }: { href: string | null; title: string }) {
  if (!href) return null;
  return (
    <a
      className="ops-genie-open"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${title} in Databricks (opens in a new tab)`}
    >
      Open in Databricks
      <ExternalLink aria-hidden="true" />
    </a>
  );
}

function CostMethodology() {
  const groups: MethodologyGroup[] = [
    {
      title: 'Genie usage',
      rows: [
        {
          label: 'Allowance',
          detail: '150 DBU per identified human user each calendar month; resets on the first day of the month.',
        },
        {
          label: 'Current promotion',
          detail:
            'Through Jan 31, 2027, Genie One and Genie Agents usage is promotional free and does not consume allowance.',
        },
        {
          label: 'Genie Code',
          detail: 'Free usage consumes the user’s monthly allowance.',
        },
        {
          label: 'Free and charged',
          detail:
            'Free is waived list-price value. Charged is usage actually billed after allowance and promotion rules. Either can be larger.',
        },
        {
          label: 'Service principals',
          detail: 'No free allowance.',
        },
        {
          label: 'Configured spaces',
          detail:
            'Data Genie and Dictionary Genie cards include only attributable configured-space usage; unrelated or unmatched workspace usage is excluded.',
        },
        {
          label: 'Foundation tokens',
          detail: 'Total tokens are provider-reported input plus output; cache-specific counts are not added again.',
        },
        {
          label: 'Billing freshness',
          detail: (
            <>
              <code>system.billing.usage</code> is authoritative and can arrive hours after usage occurs.
            </>
          ),
        },
      ],
    },
  ];
  return (
    <Disclosure summary="Cost methodology" className="ops-cost-method">
      <MethodologySections groups={groups} />
    </Disclosure>
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
  qualification = '',
  series,
  tone,
  href,
}: {
  title: string;
  /** Shown INSTEAD of the bars when there are none, never under them. */
  caption: string;
  /** Coverage qualification shown with returned bars or an incomplete empty state. */
  qualification?: string;
  series: ReturnType<typeof bars>;
  /** Which ink the bars take: the failure red, the refusal slate, or the blue. */
  tone: 'failure' | 'refusal' | 'tool';
  /** Where a count links, if a count links anywhere. */
  href?: (bar: { key: string }) => string;
}) {
  return (
    <div className={`ops-chart ops-chart-${tone}`}>
      <h4>{title}</h4>
      {qualification ? <p className="ops-chart-freshness">{qualification}</p> : null}
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
                {tone === 'tool' ? <code title={bar.label}>{bar.label}</code> : bar.label}
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
    </div>
  );
}

type StatisticTone = 'neutral' | 'positive' | 'warning' | 'refusal' | 'negative';

function StatisticsChart({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; count: number | null; tone: StatisticTone }>;
}) {
  const maximum = Math.max(0, ...rows.map((row) => row.count ?? 0));
  return (
    <div className="ops-chart ops-statistics-chart">
      <h4>{title}</h4>
      <ul className="ops-bars">
        {rows.map((row) => {
          const percent = row.count === null || maximum === 0 ? 0 : Math.min(100, (row.count / maximum) * 100);
          const value = row.count === null ? 'Unavailable' : count(row.count);
          return (
            <li
              key={row.label}
              className={`ops-bar-row ops-statistic-${row.tone}`}
              aria-label={`${row.label}: ${value}`}
            >
              <span className="ops-bar-label">{row.label}</span>
              <span className="ops-bar-track">
                <span className="ops-bar-fill" style={{ width: `${percent}%` }} aria-hidden="true" />
              </span>
              <span className="ops-bar-count">{value}</span>
            </li>
          );
        })}
      </ul>
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
function DailyBars({
  title,
  days,
  empty,
}: {
  title: string;
  days: Array<{ day: string; count: number }>;
  empty: string;
}) {
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
      <h4>{title}</h4>
      {days.length === 0 ? (
        <p className="ops-chart-empty">{empty}</p>
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

/**
 * How many routes one page of the latency table holds.
 *
 * Ten, which is about what a reader scans without losing the head of the table,
 * and short enough that this block stays the same height as the three above it on
 * a deployment serving fifty routes.
 */
const LATENCY_PAGE_SIZE = 10;

/** The already-read routes matching one route-or-method query and the TREND pills. */
function filterLatencyRoutes(
  routes: readonly RouteLatency[],
  search: string,
  trend: { within: boolean; outside: boolean }
): RouteLatency[] {
  const query = search.trim().toLocaleLowerCase();
  return routes.filter((route) => {
    if (query && !route.route.toLocaleLowerCase().includes(query)) return false;
    return latencyRouteMatchesTrend(latencyRouteView(route).verdict, trend);
  });
}

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
export function LatencyBody({
  block,
  initialSearch = '',
  initialWithin = false,
  initialOutside = false,
}: {
  block: Block<OpsLatencyPayload>;
  /** A deterministic starting query for restored views and render-level tests. */
  initialSearch?: string;
  /** Starting TREND pills, for the same reason `initialSearch` exists. */
  initialWithin?: boolean;
  initialOutside?: boolean;
}) {
  const payload = block.data;
  /*
   * Which page of routes is on screen.
   *
   * Above the block's own early returns, because a hook cannot be called
   * conditionally. It is never reset: the clamp below does that job without an
   * effect, so nothing here can draw a stale page before correcting it.
   */
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState(initialSearch);
  const [showWithin, setShowWithin] = useState(initialWithin);
  const [showOutside, setShowOutside] = useState(initialOutside);

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
  const allRoutes = absence ? [] : (payload?.routes ?? []);
  const trend = { within: showWithin, outside: showOutside };
  /*
   * The server has already paid to read every route, so narrowing this list is a
   * browser operation just like Monitoring's filters. Searching the combined
   * recorded value deliberately covers both halves: "POST" and "ask" must lead
   * to the same row without a second request or a second field. The TREND pills
   * sit beside that search and narrow the same already-fetched list.
   */
  const routes = filterLatencyRoutes(allRoutes, search, trend);
  const pages = Math.max(1, Math.ceil(routes.length / LATENCY_PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const from = current * LATENCY_PAGE_SIZE;
  const shown = routes.slice(from, from + LATENCY_PAGE_SIZE);

  const facts = payload ? latencySharedFacts(routes) : { line: '', showPercentiles: false };
  const canFilterTrend = latencySharedFacts(allRoutes).showPercentiles;
  // Log-scaled across the rows ON SCREEN, so the scale answers to the page a
  // reader is looking at rather than to routes on another page of the table.
  const barWidths = p50BarWidths(shown.map((route) => route.p50Ms));

  return (
    <section className="ops-block ops-latency-block" aria-labelledby="ops-latency-heading">
      <BlockHead
        id="ops-latency-heading"
        title="Latency"
        control={
          <div className="ops-latency-head-controls">
            <div className="run-search monitoring-search ops-latency-search">
              <Search aria-hidden="true" />
              <Input
                type="search"
                placeholder="Search routes or methods…"
                aria-label="Search latency routes by route or method"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search !== '' ? (
                <button
                  type="button"
                  className="monitoring-search-clear"
                  onClick={() => setSearch('')}
                  aria-label="Clear the route search"
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <RefreshButton busy={block.busy} onRefresh={block.refresh} />
          </div>
        }
      >
        {canFilterTrend ? (
          <div className="ops-latency-trend-filters" role="group" aria-label="Filter by trend">
            <button
              type="button"
              className={astPill('pos', 'ops-pill ops-latency-trend-filter')}
              aria-pressed={showWithin}
              aria-label="Show routes within baseline"
              disabled={block.busy}
              onClick={() => setShowWithin((on) => !on)}
            >
              Within baseline
            </button>
            <button
              type="button"
              className={astPill('neg', 'ops-pill ops-latency-trend-filter')}
              aria-pressed={showOutside}
              aria-label="Show routes outside baseline"
              disabled={block.busy}
              onClick={() => setShowOutside((on) => !on)}
            >
              Outside baseline
            </button>
          </div>
        ) : null}
      </BlockHead>

      {block.busy && !payload ? null : (
        <BlockBody className={!absence && payload && routes.length > 0 ? 'ops-block-body-flush' : ''}>
          {absence ? (
            <Absence notice={absence}>{payload?.grant ? <Grant grant={payload.grant} /> : null}</Absence>
          ) : payload ? (
            <>
              {routes.length === 0 && (search.trim() || showWithin || showOutside) ? (
                /* The same one-line list absence and named escape Monitoring uses.
                 A search or TREND pill has hidden rows; it has not made the
                 telemetry empty. */
                <div className="monitoring-empty">
                  <PiaEmptyStateMark size={32} className="monitoring-empty-mark" />
                  <p className="monitoring-empty-line">
                    {search.trim() ? `Nothing matches "${search.trim()}".` : 'Nothing matches the selected trend.'}
                  </p>
                  <div className="monitoring-empty-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSearch('');
                        setShowWithin(false);
                        setShowOutside(false);
                      }}
                    >
                      {search.trim() && !showWithin && !showOutside ? 'Clear search' : 'Clear filters'}
                    </Button>
                  </div>
                </div>
              ) : (
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
                            <th scope="col" className="ops-lat-trend">
                              Trend
                            </th>
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
              )}
            </>
          ) : null}
        </BlockBody>
      )}

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
          <td className="ops-lat-trend">
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

export function TrafficBody({ block }: { block: Block<OpsTrafficPayload> }) {
  const payload = block.data;
  const activity = payload ? activeMinutesDisplay(payload) : 'Active app minutes';
  const coverageCaption = (state: 'complete' | 'partial' | 'unavailable', complete: string): string =>
    state === 'complete' ? complete : state === 'partial' ? 'Estimated' : 'Unavailable';

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
              <div className="ops-chart-stack">
                <DailyBars
                  title="Questions per day"
                  days={payload.questionsPerDay}
                  empty="No questions have been recorded."
                />
                <DailyBars
                  title="Distinct askers per day"
                  days={payload.distinctAskersPerDay ?? []}
                  empty="No distinct askers have been recorded."
                />
                <DailyBars
                  title={activity}
                  days={payload.activeMinutesPerDay ?? []}
                  empty="No recorded active app minutes yet. Recording starts with this release and does not backfill."
                />
              </div>

              <div className="ops-statistics-pair" data-testid="ops-traffic-statistics">
                <StatisticsChart
                  title="Question statistics"
                  rows={[
                    {
                      label: 'Questions asked',
                      count:
                        payload.questionStatistics?.asked ??
                        payload.questionsPerDay.reduce((total, day) => total + day.count, 0),
                      tone: 'neutral',
                    },
                    {
                      label: 'Questions answered',
                      count: payload.questionStatistics?.answered ?? null,
                      tone: 'positive',
                    },
                    {
                      label: 'Helpful feedback',
                      count: payload.questionStatistics?.helpful ?? null,
                      tone: 'positive',
                    },
                    {
                      label: 'Not helpful feedback',
                      count: payload.questionStatistics?.notHelpful ?? null,
                      tone: 'negative',
                    },
                  ]}
                />
                <StatisticsChart
                  title="Run statistics"
                  rows={[
                    {
                      label: 'Total runs',
                      count: payload.runStatistics?.total ?? payload.runsInRange,
                      tone: 'neutral',
                    },
                    {
                      label: 'Completed',
                      count: payload.runStatistics?.completed ?? null,
                      tone: 'positive',
                    },
                    {
                      label: 'Partial',
                      count: payload.runStatistics?.partial ?? null,
                      tone: 'warning',
                    },
                    {
                      label: 'Refused',
                      count: payload.runStatistics?.refused ?? null,
                      tone: 'refusal',
                    },
                    {
                      label: 'Failed',
                      count: payload.runStatistics?.failed ?? null,
                      tone: 'negative',
                    },
                  ]}
                />
              </div>

              <BarChart
                title="Tool calls by tool"
                // Three words where there was a sentence, and no denominator: the
                // run count is in the band above, once, and the three charts under
                // it were each repeating it back in a full sentence about nothing
                // having happened.
                caption={coverageCaption(payload.breakdownCoverage.toolCalls.state, 'No tool calls')}
                qualification={
                  payload.breakdownCoverage.toolCalls.state === 'complete'
                    ? ''
                    : payload.breakdownCoverage.toolCalls.reason ||
                      `${payload.breakdownCoverage.toolCalls.state} tool-call coverage`
                }
                series={bars(payload.toolCalls)}
                tone="tool"
              />
            </div>
          </>
        ) : null}
      </BlockBody>
    </section>
  );
}

/* ── The page ────────────────────────────────────────────────────────────── */

interface StopAllResult {
  targeted: number;
  cancelled: number;
  failures: unknown[];
}

/** Admin emergency control; the server remains the permission boundary. */
export function StopAllActiveRuns() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<StopAllResult | null>(null);
  const [error, setError] = useState('');

  const stop = async () => {
    const confirmed = window.confirm('Stop all active Player Insights Agent runs? No data or history is deleted.');
    if (!confirmed) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch('/api/admin/runs/cancel-all', { method: 'POST' });
      const body = (await response.json()) as Partial<StopAllResult> & { message?: unknown };
      if (!response.ok) {
        throw new Error(
          typeof body.message === 'string' ? body.message : `The cancellation endpoint answered ${response.status}.`
        );
      }
      setResult({
        targeted: body.targeted ?? 0,
        cancelled: body.cancelled ?? 0,
        failures: Array.isArray(body.failures) ? body.failures : [],
      });
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : 'Active runs could not be stopped.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ops-stop-all" aria-labelledby="ops-stop-all-heading">
      <strong id="ops-stop-all-heading">ADMIN</strong>
      <span>No data or history is deleted.</span>
      <Button
        className="ops-stop-all-button"
        variant="destructive"
        data-variant="destructive"
        type="button"
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => void stop()}
      >
        <PiaBusyButtonContent busy={busy} label="Stop all active runs" busyLabel="Stopping" />
      </Button>
      {result ? (
        <p role="status">
          Targeted {result.targeted}; cancelled {result.cancelled}; failures {result.failures.length}.
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

export function ScopeAdminControl({ action }: { action: ReactNode }) {
  return (
    <section className="ops-admin-action ops-admin-action-scope" aria-labelledby="ops-scope-admin-heading">
      <strong id="ops-scope-admin-heading">ADMIN</strong>
      <span>Compare user and app catalog access.</span>
      {action}
    </section>
  );
}

export function OpsPage() {
  const role = useRole();
  const features = useOutletContext<AppOutletContext | null>()?.features ?? NO_EXPERIMENTS;
  const forecastingShown = showsForecasting(features);
  const [params, setParams] = useSearchParams();
  const [openedAt] = useState(() => Date.now());
  const [costUnit, setCostUnit] = useState<CostBudgetUnit>(readCostDisplayUnit);
  const monthKey = opsCurrentMonthKey(openedAt);
  useEffect(() => {
    if (!params.has('range') && !params.has('from') && !params.has('to')) return;
    const canonical = new URLSearchParams(params);
    canonical.delete('range');
    canonical.delete('from');
    canonical.delete('to');
    setParams(canonical, { replace: true });
  }, [params, setParams]);

  // Four reads, started together on the first visit and finishing whenever
  // each finishes. Nothing below waits on anything else, which is the whole
  // point of the arrangement. Retrospective blocks share one server-authoritative
  // calendar-month key; live Health remains independent.
  const health = useOpsBlock<OpsHealthPayload>('/api/ops/health', '');
  const cost = useOpsBlock<OpsCostPayload>('/api/ops/cost', '', monthKey);
  const traffic = useOpsBlock<OpsTrafficPayload>('/api/ops/traffic', '', monthKey);
  const latency = useOpsBlock<OpsLatencyPayload>('/api/ops/latency', '', monthKey);
  const scopes = useOpsScopeCheck();

  const chooseCostUnit = (unit: CostBudgetUnit) => {
    setCostUnit(unit);
    persistCostDisplayUnit(unit);
  };
  const userMonitoringHref = perUserSpendHref('', costUnit);

  return (
    <div className="page-shell ops-page">
      <PageHeading title="Ops" />
      <div className="ops-page-controls">
        {canCheckHealthResources(role.state) ? <ScopeAdminControl action={scopes.button} /> : null}
        {showsAdminSurfaces(role.state) ? <StopAllActiveRuns /> : null}
      </div>
      {canCheckHealthResources(role.state) ? scopes.modal : null}

      {/* Each measured block reads itself. Four read times on one page rather
          than one, because they were read at four different moments. */}
      <HealthBody block={health} />
      <CostBody
        block={cost}
        unit={costUnit}
        onUnitChange={chooseCostUnit}
        userMonitoringHref={showsAdminSurfaces(role.state) ? userMonitoringHref : undefined}
      />
      {forecastingShown ? <ForecastingBody cost={cost} traffic={traffic} unit={costUnit} /> : null}
      <TrafficBody block={traffic} />
      <LatencyBody block={latency} />
    </div>
  );
}
