import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription } from './ui';
import { CircleAlert, ExternalLink } from 'lucide-react';
import { entityHref, entityRowId, trackedEntity, type ProseSegment } from './data-entities';
import {
  answerBlocks,
  answerInline,
  selectAnswerBlocks,
  tableStoryMetadata,
  type AnswerBlockSelection,
  type Block,
  type Inline,
} from './answer-markdown';
import { layoutFindingBlocks } from './answer-findings';
import { tableOriginSources } from './answer-table-origins';
import { dateBadgeRuns, isLabelLeadIn, labelBadgeRuns } from './answer-badges';
import { sourceRows, splitSourceName } from './source-rows';
import type { SourceRef } from './answer-shape';
import { databricksLink, type DatabricksObject } from '../../shared/databricks-links';
import { useRequestedEntity, useTrackedTables, useWorkspaceHost } from './data-entity-state';

/**
 * The rendering half of "an answer names a table, the reader can go and see it".
 *
 * Deliberately its own module rather than more of `App.tsx`: the answer card
 * and the page that documents an entry are no longer even in the same file, and
 * the one thing that must not drift between them is how an entry is named.
 */

/**
 * The tracked table list, read once per page load and shared by every answer.
 *
 * Through `readPreflightOnce` rather than its own `fetch`, because the Ask page's
 * status pill now reads the agent's own check out of the same payload. That route
 * invokes the serving endpoint, so two modules each memoising their own request
 * would be two cold starts on one page load rather than one.
 */
/**
 * The workspace this app runs in, read once per page load and shared.
 *
 * From `/api/architecture`, which is the route that already answers this and is
 * documented as probing nothing: it reports what the container was given. The
 * value is `DATABRICKS_HOST`, normalised on the server, and it is `''` in every
 * deployment that was not given one -- which is a supported state here and the
 * reason `databricksLink` returns null rather than guessing a host.
 */
/**
 * One identifier, linked to the entry that documents it.
 *
 * `text-primary underline underline-offset-2` is the app's existing link
 * treatment (the same one the MLflow trace link uses), so an entity reads as a
 * link without introducing a second vocabulary for one. The dotted underline is
 * the only addition, and it is what distinguishes an identifier the reader can
 * inspect from ordinary emphasis inside a sentence.
 *
 * The weight and the pinned 1px are the design's: a tracked table name sits
 * inside body prose at #3A3838, and at 400 in the action blue the link was doing
 * its work through hue alone. `decoration-1` states the thickness the browser
 * would otherwise scale with the font.
 */
export function EntityLink({ entity, children }: { entity: string; children: ReactNode }) {
  return (
    <Link
      to={entityHref(entity)}
      data-entity={entity}
      title={`${entity}, see it on Connections`}
      className="entity-table text-primary font-medium underline decoration-dotted decoration-1 underline-offset-2 hover:decoration-solid"
    >
      {children}
    </Link>
  );
}

/**
 * One identifier the reader cannot be sent anywhere for.
 *
 * A column, or a table with no entry on Connections. It is set in the same
 * weight family as a link and given none of the link's other signals, so a
 * sentence that names a column reads as naming a thing rather than using a
 * word, and nothing about it invites a click. 600 rather than the link's 500
 * because the link says what it is three ways -- weight, the action colour and
 * a rule under it -- and this has only the one.
 *
 * A `span` rather than `strong` or `b`. Tailwind's preflight sets those to
 * `font-weight: bolder`, which is relative: a column name inside a bolded
 * lead-in would come out at 900 while the same name in the sentence after it
 * came out at 700, and neither would be a decision anyone made.
 */
export function EntityMark({ children }: { children: ReactNode }) {
  return <span className="entity-mark entity-column font-semibold">{children}</span>;
}

export function EntityParts({
  text,
  entity,
  sourceName = false,
}: {
  text: string;
  entity: string;
  /**
   * Source rows keep the qualifier/short-name hooks they have always exposed,
   * while using the same entity tokens as names inside answer prose.
   */
  sourceName?: boolean;
}) {
  const full = entity.split('.');
  const shown = text.split('.');
  const offset = Math.max(0, full.length - shown.length);
  return (
    <>
      {shown.map((part, index) => {
        const fullIndex = offset + index;
        const kind =
          fullIndex === 0 && full.length >= 3
            ? 'catalog'
            : fullIndex === full.length - 2 && full.length >= 2
              ? 'schema'
              : 'table';
        return (
          <Fragment key={shown.slice(0, index + 1).join('.')}>
            {index > 0 ? '.' : null}
            <span
              className={[
                `entity-token entity-${kind}`,
                sourceName ? (index === shown.length - 1 ? 'source-name-short' : 'source-name-qualifier') : '',
              ]
                .filter(Boolean)
                .join(' ')}
              data-entity-part={kind}
            >
              {part}
            </span>
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * The workspace object behind a name, offered beside the name and not instead
 * of it.
 *
 * The pattern the Architecture page settled on, and it is settled for a reason
 * worth repeating: the in-app link is the one that always works, so it stays on
 * the identifier, and leaving the app is a control of its own so that one tab
 * stop does not sometimes end up in another origin. See ArchitecturePage.tsx.
 *
 * Renders NOTHING when no link can be built -- no host, or a name that is not a
 * three-level Unity Catalog object -- rather than a disabled-looking control.
 * The row still names its source; it just does not claim to be able to open it.
 */
export function OpenInDatabricks({ name, object }: { name: string; object?: DatabricksObject }) {
  const host = useWorkspaceHost();
  // A table unless the caller says otherwise, which is what every original caller
  // meant and still gets. `object` exists because a SCHEMA is browsed at a
  // two-level path: passing a schema name through the table branch asks
  // `unityCatalogPath` for three parts, gets null, and renders no link at all --
  // so the Settings row that names the telemetry destination would have quietly
  // had nothing to click.
  const href = databricksLink(host, object ?? { kind: 'table', table: name });
  if (!href) return null;
  return (
    <a
      className="text-primary inline-flex items-center gap-1 text-xs font-medium underline decoration-dotted decoration-1 underline-offset-2 hover:decoration-solid"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      <ExternalLink className="size-3" aria-hidden="true" /> Open in Databricks
      <span className="sr-only"> ({name})</span>
    </a>
  );
}

/**
 * The same link with the words taken off, for a list of names.
 *
 * WHY NOT JUST USE `OpenInDatabricks`. Twelve rows of declared tables would carry
 * twelve copies of the phrase "Open in Databricks", which is 19 characters of
 * repeated boilerplate against a 40-character table name in a column that has to
 * hold both. The phrase earns its width where there is one of them -- on a card, or
 * at the end of a sentence -- and loses it in a table.
 *
 * THE NAME IS STILL SPOKEN. The mark is `aria-hidden` and the accessible name is
 * the whole sentence including the table, so a screen reader gets "Open
 * a_catalog.a_schema.a_table in Databricks" rather than twelve links called
 * "Open". A row of identical link names is the standard way to make a table
 * unusable without a pointer.
 *
 * Renders nothing when no link can be built, for the reason above: no host, or a
 * name that is not a three-level Unity Catalog object.
 */
export function VisitInDatabricks({ name, object }: { name: string; object?: DatabricksObject }) {
  const host = useWorkspaceHost();
  const href = databricksLink(host, object ?? { kind: 'table', table: name });
  if (!href) return null;
  return <VisitLink href={href} name={name} />;
}

/**
 * The mark itself, handed a href.
 *
 * SEPARATE SO IT CAN BE RENDERED IN A TEST. `useWorkspaceHost` reads
 * `/api/architecture` in an effect, and `renderToStaticMarkup` runs no effects --
 * so a test that renders the wrapper gets `host: ''`, no href, and null. That is
 * the correct behaviour and it means the wrapper can never be used to check what
 * the link looks like or what it is called. Everything worth asserting is in here.
 */
export function VisitLink({ href, name }: { href: string; name: string }) {
  const label = `Open ${name} in Databricks`;
  return (
    <a className="visit-in-databricks" href={href} rel="noopener noreferrer" target="_blank" title={label}>
      <ExternalLink aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </a>
  );
}

/**
 * One text leaf, with its linked runs as links.
 *
 * Keyed by where the run starts in the answer rather than by array index. The
 * segmentation changes shape the moment the tracked list lands, and an index
 * key would make React reconcile run 3 of the plain version against run 3 of
 * the linked one.
 */
function ProseRuns({
  runs,
  badges = false,
  labelList = false,
}: {
  runs: readonly ProseSegment[];
  /** Whether this surface sets windows and labels as badges. See answer-badges.ts. */
  badges?: boolean;
  /** Whether the run this leaf opens with is the value of a `Labels:` lead-in. */
  labelList?: boolean;
}) {
  return (
    <>
      {runs.map((run, index) => {
        if (run.entity)
          return (
            <EntityLink entity={run.entity} key={run.start}>
              <EntityParts text={run.text} entity={run.entity} />
            </EntityLink>
          );
        if (run.emphasis && run.declaredTable) {
          return (
            <span className="entity-table-mark" key={run.start}>
              <EntityParts text={run.text} entity={run.declaredTable} />
            </span>
          );
        }
        if (run.emphasis) return <EntityMark key={run.start}>{run.text}</EntityMark>;
        if (!badges) return <PlainTextRun key={run.start} start={run.start} text={run.text} />;
        // The label list is the head of the leaf that follows the lead-in, so
        // only the first run can carry it; every other plain run is scanned for
        // a window instead.
        const cut = labelList && index === 0 ? labelBadgeRuns(run.text, run.start) : dateBadgeRuns(run.text, run.start);
        return (
          <Fragment key={run.start}>
            {cut.map((part) =>
              part.badge ? (
                <span className={`answer-badge answer-badge--${part.badge}`} key={part.start}>
                  {part.text}
                </span>
              ) : (
                <Fragment key={part.start}>{part.text}</Fragment>
              )
            )}
          </Fragment>
        );
      })}
    </>
  );
}

const INLINE_NUMBER = /\d{4}-\d{1,2}-\d{1,2}|[-+\u2212]?(?:[$€£]\s*)?\d[\d,]*(?:\.\d+)?%?/g;

/**
 * Numerals in ordinary prose take the mono face without changing the string.
 * The runs concatenate to the exact input, so selection and copy remain plain
 * text and no pseudo-element carries content.
 */
function PlainTextRun({ text, start }: { text: string; start: number }) {
  const parts: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(INLINE_NUMBER)) {
    const at = match.index ?? 0;
    if (at > from) parts.push(<Fragment key={start + from}>{text.slice(from, at)}</Fragment>);
    parts.push(
      <span className="answer-inline-number ast-num" key={`${start + at}-number`}>
        {match[0]}
      </span>
    );
    from = at + match[0].length;
  }
  if (from < text.length) parts.push(<Fragment key={start + from}>{text.slice(from)}</Fragment>);
  return <>{parts}</>;
}

/** The words in an inline subtree, for reading a lead-in back off it. */
function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
        case 'code':
          return node.runs.map((run) => run.text).join('');
        case 'strong':
        case 'link':
          return inlineText(node.children);
        case 'break':
          return '\n';
      }
    })
    .join('');
}

/**
 * The inline half of the agent's Markdown.
 *
 * Every branch renders an element and its children; none of them takes a string
 * of markup. There is no `dangerouslySetInnerHTML` in this file and no node
 * shape that could carry one, so a `<script>` the model wrote reaches the DOM
 * as the six characters it is. See answer-markdown.ts for why that is the
 * safety story rather than a sanitiser.
 */
function InlineNodes({ nodes, badges = false }: { nodes: readonly Inline[]; badges?: boolean }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.kind) {
          case 'text': {
            // `**Labels:** Northwind, Contoso` is a lead-in and its value, and the
            // parser puts them in two siblings: the list can only be recognised
            // from here, where both are in view.
            const previous = nodes[index - 1];
            const labelList =
              previous !== undefined && previous.kind === 'strong' && isLabelLeadIn(inlineText(previous.children));
            return <ProseRuns runs={node.runs} badges={badges} labelList={labelList} key={node.start} />;
          }
          case 'code':
            return (
              <code className="answer-code entity-quote" key={node.start}>
                <ProseRuns runs={node.runs} />
              </code>
            );
          case 'strong':
            return (
              <strong key={node.start}>
                <InlineNodes nodes={node.children} badges={badges} />
              </strong>
            );
          case 'link':
            // The href is scheme-checked in answer-markdown.ts; a link that got
            // this far is one we are willing to follow. `noreferrer` because
            // the answer may name a customer's own hostname and the referrer
            // would carry the conversation id with it.
            return (
              <a className="answer-link" href={node.href} key={node.start} rel="noopener noreferrer" target="_blank">
                <InlineNodes nodes={node.children} />
              </a>
            );
          case 'break':
            return <br key={node.start} />;
        }
      })}
    </>
  );
}

/**
 * One block.
 *
 * Headings are demoted a level on the way out: the agent's H2 becomes an `h3`
 * and its H3 an `h4`, because the card's own heading is the takeaway above this
 * prose and a section inside the card sits under it, not beside it. The sizes
 * in `.answer-heading` follow from the same thing -- these read as the label on
 * a paragraph, not as a title.
 *
 * `findingLabel` is the scannable exception: a `### Who` (or a bold lead-in
 * promoted to one) is an eyebrow on a handful of bullets, not a section title
 * competing with the takeaway. Catalog headings stay `.answer-heading`.
 */
function ProseBlock({
  block,
  badges = false,
  findingLabel = false,
  origins,
}: {
  block: Block;
  badges?: boolean;
  findingLabel?: boolean;
  origins?: ReadonlyMap<number, SourceRef[]>;
}) {
  switch (block.kind) {
    case 'heading': {
      if (findingLabel) {
        return (
          <h4 className="answer-finding-label">
            <InlineNodes nodes={block.children} />
          </h4>
        );
      }
      const Tag = block.level === 2 ? 'h3' : 'h4';
      return (
        <Tag className={block.level === 2 ? 'answer-heading' : 'answer-heading answer-subheading'}>
          <InlineNodes nodes={block.children} />
        </Tag>
      );
    }
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag className="answer-list">
          {block.items.map((item) => (
            <li key={item.start}>
              <InlineNodes nodes={item.children} badges={badges} />
            </li>
          ))}
        </Tag>
      );
    }
    case 'table' /**
     * The agent's Markdown table, as a table.
     *
     * A real `<table>` and not a grid of divs, which is the one decision in
     * here worth arguing. The block IS tabular data: it has a header row that
     * names its columns and rows whose cells belong to those columns, and a
     * screen reader given a grid of divs is handed a run of numbers with no
     * statement of which column each is in. `scope="col"` is what associates
     * them, and it costs one attribute.
     *
     * The alignment is on the cell rather than on a column class, because CSS
     * cannot select a column: a class per cell is the only way to right-align
     * the fourth column, and `data-align` is that class as an attribute so a
     * reviewer can see in the DOM which columns the parser read as figures.
     *
     * Scrolls in a wrapper rather than wrapping its cells. Six columns of
     * daily figures do not fit the transcript column at every width, and the
     * two ways out of that are a horizontal scrollbar or a table whose numbers
     * wrap mid-figure. A figure that wraps has to be re-read to be believed,
     * so this one scrolls.
     *
     * `data-wrap` is the same kind of statement as `data-align` and is here for
     * the same reason: CSS cannot select a column, and whether a column holds
     * dates or sentences decides whether its cells may break at all. Without
     * it a narrow panel gave every column its one-character minimum and set
     * `2026-07-14` on four lines.
     */: {
      const story = tableStoryMetadata(block);
      const origin = origins?.get(block.start) ?? [];
      return (
        <div className="answer-table-frame">
          {origin.length > 0 ? (
            <div className="answer-table-origin" aria-label="Source table">
              <AnswerOriginLinks sources={origin} />
            </div>
          ) : null}
          <div className="answer-table-wrap">
            <table className="answer-table">
              {block.header ? (
                <thead>
                  <tr>
                    {block.header.cells.map((cell, column) => (
                      <th key={cell.start} scope="col" data-align={block.align[column]} data-wrap={block.wrap[column]}>
                        <InlineNodes nodes={cell.children} />
                      </th>
                    ))}
                  </tr>
                </thead>
              ) : null}
              <tbody>
                {block.rows.map((row) => {
                  /*
                   * BOTH TAGS, NOT THE FIRST ONE THAT MATCHES.
                   *
                   * A series that only ever falls peaks on its opening row, so the
                   * baseline row and the peak row are the same row. Chained, the
                   * baseline branch won and the peak was never labelled at all -- on
                   * exactly the tables where "this was the high point" is the finding.
                   * `data-story` keeps the single role the row is tinted by; the tags
                   * beside the date are what the reader is told.
                   */
                  const tags = [
                    row.start === story.baselineRowStart ? 'baseline' : '',
                    row.start === story.peakRowStart ? 'peak' : '',
                  ].filter((tag) => tag);
                  return (
                    <tr data-story={tags[0]} key={row.start}>
                      {row.cells.map((cell, column) => (
                        <td key={cell.start} data-align={block.align[column]} data-wrap={block.wrap[column]}>
                          <InlineNodes nodes={cell.children} />
                          {column === 0
                            ? tags.map((tag) => (
                                <span className="answer-table-story-tag" key={tag}>
                                  {tag}
                                </span>
                              ))
                            : null}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    case 'rule':
      return <hr className="answer-rule" />;
    case 'code':
      return (
        <pre className="answer-code-block">
          <code data-language={block.language || undefined}>{block.text}</code>
        </pre>
      );
    case 'paragraph':
      return (
        <p>
          <InlineNodes nodes={block.children} badges={badges} />
        </p>
      );
  }
}

/**
 * Prose that is a sentence: the caveat list and the degraded-answer banner.
 *
 * Inline constructs only. Both callers render this after a bolded lead-in
 * inside an alert, where a heading or a list would break the line it is part
 * of. See `answerInline` in answer-markdown.ts.
 */
export function EntityText({
  text,
  sources,
  columns = [],
}: {
  text: string;
  sources: readonly { name: string }[];
  /** The columns this surface declared. Bolded, never linked. */
  columns?: readonly string[];
}) {
  const tracked = useTrackedTables();
  const nodes = answerInline(
    text,
    sources.map((source) => source.name),
    tracked,
    columns
  );
  return <InlineNodes nodes={nodes} />;
}

/**
 * A discovery result's table names, using the same entity tokens and links as
 * answer prose rather than a second chip recipe.
 */
export function TableEntityList({
  tables,
  empty = 'No tables were returned by this discovery step.',
}: {
  tables: readonly string[];
  empty?: string;
}) {
  const names = tables
    .map((name) => name.trim())
    .filter(
      (name, index, entries) =>
        name.length > 0 && entries.findIndex((candidate) => candidate.toLowerCase() === name.toLowerCase()) === index
    );
  if (names.length === 0) return <p className="entity-table-list-empty">{empty}</p>;
  return (
    <div className="entity-table-list">
      <p className="entity-table-list-count">
        <span className="ast-num">{names.length}</span> table{names.length === 1 ? '' : 's'} assessed
      </p>
      <ul>
        {names.map((name) => (
          <li key={name}>
            <EntityText text={name} sources={[{ name }]} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Prose that belongs to a plan rather than to an answer.
 *
 * The candidate set is everything the app tracks, which is the one place rule 1
 * is deliberately not applied. That rule exists because linking a table an
 * ANSWER did not cite would put provenance on screen the run never claimed, and
 * a plan has no provenance to overstate: it is a proposal, it has read nothing,
 * and the tables it names are the tables it is asking permission to read. The
 * set is still the preflight table list rather than a dictionary, and a bare
 * name still has to carry an underscore, so the false-positive rule that makes
 * every other link trustworthy is untouched.
 */
export function PlanText({ text, columns }: { text: string; columns: readonly string[] }) {
  const tracked = useTrackedTables();
  return <EntityText text={text} sources={tracked.map((name) => ({ name }))} columns={columns} />;
}

/**
 * Prose that is a document: the answer narrative.
 *
 * A wrapper rather than the single `<p>` this used to be, because the agent
 * writes headings and bullets and they are blocks. `className` moves to the
 * wrapper; the paragraphs inside it are still `.answer-card p`, so the
 * selection cursor and the wrapping rules that were written against that
 * selector still find them.
 */
export function AnswerProse({
  text,
  sources,
  className,
  columns = [],
  badges = false,
  blocks: selection = 'all',
  originMap,
}: {
  text: string;
  sources: readonly { name: string; freshness?: string; role?: SourceRef['role'] }[];
  className?: string;
  /** The columns this surface declared. Bolded, never linked. */
  columns?: readonly string[];
  /**
   * Whether date windows and label lists are set as badges.
   *
   * Off for the narrative, which is sentences: a paragraph that mentions three
   * dates would come out as three chips inside a sentence. On for the data
   * package, where the window and the labels are values in a list of facts and
   * the source table beside them is already a chip.
   */
  badges?: boolean;
  /** Which parsed blocks this seating owns; source text is never regex-edited. */
  blocks?: AnswerBlockSelection;
  /**
   * Source tables for this body's Markdown tables, already zipped across
   * narrative + content so a table in `content` can name a source the prose
   * mentioned above it. When omitted, origins are inferred from this body only.
   */
  originMap?: ReadonlyMap<number, SourceRef[]>;
}) {
  const tracked = useTrackedTables();
  const declared = sources.map((source) => source.name);
  const parsed = answerBlocks(text, declared, tracked, columns);
  const origins = originMap ?? tableOriginSources(parsed, sources as SourceRef[]);
  const selected = selectAnswerBlocks(parsed, selection);
  const blocks = selection === 'tables' ? selected : layoutFindingBlocks(selected);
  if (blocks.length === 0) return null;
  return (
    <div className={className ? `answer-prose ${className}` : 'answer-prose'}>
      <ProseBlocks blocks={blocks} badges={badges} origins={origins} />
    </div>
  );
}

function ProseBlocks({
  blocks,
  badges,
  origins,
}: {
  blocks: readonly Block[];
  badges: boolean;
  origins: ReadonlyMap<number, SourceRef[]>;
}) {
  const elements: ReactNode[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const next = blocks[index + 1];
    if (block.kind === 'heading' && block.level === 3 && next?.kind === 'list') {
      elements.push(
        <section className="answer-finding" key={block.start}>
          <div className="answer-finding-head">
            <ProseBlock block={block} findingLabel origins={origins} />
          </div>
          <ProseBlock block={next} badges={badges} origins={origins} />
        </section>
      );
      index += 1;
      continue;
    }
    elements.push(<ProseBlock block={block} badges={badges} origins={origins} key={block.start} />);
  }
  return <>{elements}</>;
}

/**
 * A source row's name, linked when the app tracks it.
 *
 * The row is already the answer's structural claim about where it read from, so
 * no prose matching is involved here: the whole string either is a tracked
 * entry or is not. A Genie space, which is what the second source usually is,
 * has no table row and stays plain.
 *
 * THE LAST SEGMENT IS MARKED OFF FROM THE QUALIFIER. The whole three-part name
 * is shown, because two tables in different schemas can share a short name and
 * the reader has to be able to tell them apart, but the segment they actually
 * recognise the table by is the last one, and set in one unbroken run of mono
 * at 12.5px it was the least findable part of the row. The split is spans and a
 * tint; no character is added, removed or reordered, so the name still copies
 * and reads back whole.
 *
 * No weight is set locally. The shared table-part metadata and entity-token
 * rule decide it for prose and source rows together; a `strong` nested inside
 * one would compound under Tailwind's relative `bolder`.
 */
export function SourceEntityName({ name }: { name: string }) {
  const tracked = useTrackedTables();
  const entry = trackedEntity(name, tracked);
  const { qualifier, short } = splitSourceName(name);
  // A one-part source can be a Genie space rather than a Unity Catalog table.
  // Keep its existing neutral source-name spelling instead of assigning table
  // semantics the source contract did not state.
  const spelled = name.includes('.') ? (
    <EntityParts text={name} entity={entry || name} sourceName />
  ) : (
    <>
      {qualifier && <span className="source-name-qualifier">{qualifier}</span>}
      <span className="source-name-short">{short}</span>
    </>
  );
  return entry ? <EntityLink entity={entry}>{spelled}</EntityLink> : spelled;
}

/**
 * The source table(s) an evidence block came from, as the same chip + Open
 * control the Sources stack used to carry under the block.
 *
 * Renders nothing when the run named no table for this block, so a table
 * without a recorded origin does not grow an empty header band.
 */
export function AnswerOriginLinks({ sources }: { sources: readonly SourceRef[] }) {
  const rows = sourceRows(sources);
  if (rows.length === 0) return null;
  return (
    <div className="answer-origin-links">
      {rows.map((row) => (
        <span className="answer-origin-link" key={row.name}>
          <span
            className="source-name-pill"
            data-tone={row.tone}
            title={row.freshness ? `${row.name} · ${row.freshness}` : row.name}
          >
            <SourceEntityName name={row.name} />
          </span>
          <OpenInDatabricks name={row.name} />
        </span>
      ))}
    </div>
  );
}

/**
 * Attributes that make one table row addressable and, when asked for, obvious.
 *
 * `bg-accent`/`text-accent-foreground` are whatever the palette already gives a
 * highlighted surface, so the landing row is unmistakable without a new colour
 * being invented for it. Under DuBois that pair is the neutral wash and ink; the
 * comment here used to describe them as a red wash and red type, which was true
 * of the palette this one replaced and is the sort of note that outlives the fact
 * it records.
 *
 * The row this paints belongs to the Connections page, so the design's selected-
 * row treatment for it — the blue tint and the reserved 3px inset edge — is that
 * page's to apply rather than this helper's.
 */
/**
 * Whether this entry is the one the URL asked for.
 *
 * Exported because the row's own CONTENT now has to know, not just its
 * attributes: the Connections table says "Linked from the answer you followed
 * here" in the Detail cell of the arrival row, and a page that decided that with
 * its own comparison would be a second rule for one fact -- one that could
 * disagree about case or whitespace and paint the wash on one row while
 * captioning another.
 */
/**
 * Scrolls the requested entry into view, and says so when there is not one.
 */
export function EntityHighlight({ tracked, ready }: { tracked: readonly string[]; ready: boolean }) {
  const requested = useRequestedEntity();
  const entry = trackedEntity(requested, tracked);
  const scrolledTo = useRef('');

  useEffect(() => {
    if (!entry || scrolledTo.current === entry) return;
    scrolledTo.current = entry;
    document.getElementById(entityRowId(entry))?.scrollIntoView({ block: 'center' });
  }, [entry]);

  if (!requested || !ready || entry) return null;
  return (
    <Alert>
      <CircleAlert />
      <AlertDescription>
        <strong>No entry here for {requested}.</strong> An answer linked to it, but this page has no entry for that
        table. The agent endpoint no longer reports which tables it depends on, so this list can lag what a release
        actually declares. Unity Catalog decides who can read that table.
      </AlertDescription>
    </Alert>
  );
}
