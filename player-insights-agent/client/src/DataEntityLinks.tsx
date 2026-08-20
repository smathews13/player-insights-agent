import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription } from './ui';
import { CircleAlert, ExternalLink } from 'lucide-react';
import {
  entityHref,
  entityRowId,
  trackedEntity,
  type ProseSegment,
} from './data-entities';
import { answerBlocks, answerInline, type Block, type Inline } from './answer-markdown';
import { splitSourceName } from './source-rows';
import { databricksLink, type DatabricksObject } from '../../shared/databricks-links';
import {
  useRequestedEntity,
  useTrackedTables,
  useWorkspaceHost,
} from './data-entity-state';

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
  return (<Link
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

function EntityParts({ text, entity }: { text: string; entity: string }) {
  const full = entity.split('.');
  const shown = text.split('.');
  const offset = Math.max(0, full.length - shown.length);
  return (<>
      {shown.map((part, index) => {
        const fullIndex = offset + index;
        const kind = fullIndex === 0 && full.length >= 3
          ? 'catalog'
          : fullIndex === full.length - 2 && full.length >= 2
            ? 'schema'
            : 'table';
        return (<Fragment key={shown.slice(0, index + 1).join('.')}>
            {index > 0 ? '.' : null}
            <span className={`entity-token entity-${kind}`}>{part}</span>
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
  return (<a
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
 * One text leaf, with its linked runs as links.
 *
 * Keyed by where the run starts in the answer rather than by array index. The
 * segmentation changes shape the moment the tracked list lands, and an index
 * key would make React reconcile run 3 of the plain version against run 3 of
 * the linked one.
 */
function ProseRuns({ runs }: { runs: readonly ProseSegment[] }) {
  return (<>
      {runs.map((run) => {
        if (run.entity)
          return (<EntityLink entity={run.entity} key={run.start}>
              <EntityParts text={run.text} entity={run.entity} />
            </EntityLink>
          );
        if (run.emphasis) return <EntityMark key={run.start}>{run.text}</EntityMark>;
        return <Fragment key={run.start}>{run.text}</Fragment>;
      })}
    </>
  );
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
function InlineNodes({ nodes }: { nodes: readonly Inline[] }) {
  return (<>
      {nodes.map((node) => {
        switch (node.kind) {
          case 'text':
            return <ProseRuns runs={node.runs} key={node.start} />;
          case 'code':
            return (<code className="answer-code entity-quote" key={node.start}>
                <ProseRuns runs={node.runs} />
              </code>
            );
          case 'strong':
            return (<strong key={node.start}>
                <InlineNodes nodes={node.children} />
              </strong>
            );
          case 'link':
            // The href is scheme-checked in answer-markdown.ts; a link that got
            // this far is one we are willing to follow. `noreferrer` because
            // the answer may name a customer's own hostname and the referrer
            // would carry the conversation id with it.
            return (<a
                className="answer-link"
                href={node.href}
                key={node.start}
                rel="noopener noreferrer"
                target="_blank"
              >
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
 */
function ProseBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading': {
      const Tag = block.level === 2 ? 'h3' : 'h4';
      return (<Tag className={block.level === 2 ? 'answer-heading' : 'answer-heading answer-subheading'}>
          <InlineNodes nodes={block.children} />
        </Tag>
      );
    }
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (<Tag className="answer-list">
          {block.items.map((item) => (<li key={item.start}>
              <InlineNodes nodes={item.children} />
            </li>
          ))}
        </Tag>
      );
    }
    case 'table':
      /**
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
       * wrap mid-figure. A figure that wraps has to be re-read to be believed
       * (the argument `.bar-row b` makes in answer-body.css), so this one
       * scrolls.
       */
      return (<div className="answer-table-wrap">
          <table className="answer-table">
            {block.header ? (<thead>
                <tr>
                  {block.header.cells.map((cell, column) => (<th key={cell.start} scope="col" data-align={block.align[column]}>
                      <InlineNodes nodes={cell.children} />
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {block.rows.map((row) => (<tr key={row.start}>
                  {row.cells.map((cell, column) => (<td key={cell.start} data-align={block.align[column]}>
                      <InlineNodes nodes={cell.children} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'rule':
      return <hr className="answer-rule" />;
    case 'code':
      return (<pre className="answer-code-block">
          <code data-language={block.language || undefined}>{block.text}</code>
        </pre>
      );
    case 'paragraph':
      return (<p>
          <InlineNodes nodes={block.children} />
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
  const nodes = answerInline(text,
    sources.map((source) => source.name),
    tracked,
    columns
  );
  return <InlineNodes nodes={nodes} />;
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
}: {
  text: string;
  sources: readonly { name: string }[];
  className?: string;
  /** The columns this surface declared. Bolded, never linked. */
  columns?: readonly string[];
}) {
  const tracked = useTrackedTables();
  const blocks = answerBlocks(text,
    sources.map((source) => source.name),
    tracked,
    columns
  );
  return (<div className={className ? `answer-prose ${className}` : 'answer-prose'}>
      {blocks.map((block) => (<ProseBlock block={block} key={block.start} />
      ))}
    </div>
  );
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
 * No weight is set here. Every surface that renders a source name decides its
 * own, and a `strong` nested inside one would compound to 900 under Tailwind's
 * relative `bolder`.
 */
export function SourceEntityName({ name }: { name: string }) {
  const tracked = useTrackedTables();
  const entry = trackedEntity(name, tracked);
  const { qualifier, short } = splitSourceName(name);
  const spelled = (<>
      {qualifier && <span className="source-name-qualifier">{qualifier}</span>}
      <span className="source-name-short">{short}</span>
    </>
  );
  return entry ? <EntityLink entity={entry}>{spelled}</EntityLink> : spelled;
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
  return (<Alert>
      <CircleAlert />
      <AlertDescription>
        <strong>No entry here for {requested}.</strong> An answer linked to it, but this page has no entry for that
        table. The agent endpoint no longer reports which tables it depends on, so this list can lag what a release
        actually declares. Unity Catalog decides who can read that table.
      </AlertDescription>
    </Alert>
  );
}
