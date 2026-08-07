import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Alert, AlertDescription } from './ui';
import { CircleAlert } from 'lucide-react';
import {
  ENTITY_PARAM,
  entityHref,
  entityRowId,
  trackedEntity,
  trackedTables,
  type ProseSegment,
} from './data-entities';
import { answerBlocks, answerInline, type Block, type Inline } from './answer-markdown';

/**
 * The rendering half of "an answer names a table, the reader can go and see it".
 *
 * Deliberately its own module rather than more of `App.tsx`: the answer card
 * and the page that documents an entry are no longer even in the same file, and
 * the one thing that must not drift between them is how an entry is named.
 */

/**
 * The tracked table list, read once per page load and shared by every answer.
 */
let trackedRequest: Promise<string[]> | null = null;

async function readTrackedTables(): Promise<string[]> {
  const response = await fetch('/api/preflight');
  return trackedTables((await response.json()) as unknown);
}

export function useTrackedTables(): string[] {
  const [tables, setTables] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    trackedRequest ??= readTrackedTables().catch(() => []);
    void trackedRequest.then((names) => {
      if (live) setTables(names);
    });
    return () => {
      live = false;
    };
  }, []);
  return tables;
}

/**
 * One identifier, linked to the entry that documents it.
 *
 * `text-primary underline underline-offset-2` is the app's existing link
 * treatment (the same one the MLflow trace link uses), so an entity reads as a
 * link without introducing a second vocabulary for one. The dotted underline is
 * the only addition, and it is what distinguishes an identifier the reader can
 * inspect from ordinary emphasis inside a sentence.
 */
export function EntityLink({ entity, children }: { entity: string; children: ReactNode }) {
  return (<Link
      to={entityHref(entity)}
      data-entity={entity}
      title={`${entity}, see it on Connections`}
      className="text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid"
    >
      {children}
    </Link>
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
      {runs.map((run) =>
        run.entity ? (<EntityLink entity={run.entity} key={run.start}>
            {run.text}
          </EntityLink>
        ) : (<Fragment key={run.start}>{run.text}</Fragment>
        )
      )}
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
            return (<code className="answer-code" key={node.start}>
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
export function EntityText({ text, sources }: { text: string; sources: readonly { name: string }[] }) {
  const tracked = useTrackedTables();
  const nodes = answerInline(text,
    sources.map((source) => source.name),
    tracked
  );
  return <InlineNodes nodes={nodes} />;
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
}: {
  text: string;
  sources: readonly { name: string }[];
  className?: string;
}) {
  const tracked = useTrackedTables();
  const blocks = answerBlocks(text,
    sources.map((source) => source.name),
    tracked
  );
  return (<div className={className ? `answer-prose ${className}` : 'answer-prose'}>
      {blocks.map((block) => (<ProseBlock block={block} key={block.start} />
      ))}
    </div>
  );
}

/**
 * The source chip's name, linked when the app tracks it.
 *
 * The chip is already the answer's structural claim about where it read from,
 * so no prose matching is involved here: the whole string either is a tracked
 * entry or is not. A Genie space, which is what the second source usually is,
 * has no table row and stays plain.
 */
export function SourceEntityName({ name }: { name: string }) {
  const tracked = useTrackedTables();
  const entry = trackedEntity(name, tracked);
  return entry ? <EntityLink entity={entry}>{name}</EntityLink> : <>{name}</>;
}

/** The entry the Connections page has been asked to highlight, as the URL asked for it. */
export function useRequestedEntity(): string {
  const [params] = useSearchParams();
  return (params.get(ENTITY_PARAM) ?? '').trim();
}

/**
 * Attributes that make one table row addressable and, when asked for, obvious.
 *
 * `bg-accent`/`text-accent-foreground` are the red wash and red type the
 * palette already uses for a highlighted surface, so the landing row is
 * unmistakable without a new colour being invented for it.
 */
export function entityRowProps(name: string, requested: string) {
  const highlighted = !!requested && requested.toLowerCase() === name.trim().toLowerCase();
  return {
    id: entityRowId(name),
    'data-entity': name,
    'data-highlighted': highlighted ? 'true' : undefined,
    // Announced as well as tinted: a reader who cannot see the wash still needs
    // to be told which of six rows the link they followed was about.
    'aria-current': highlighted ? ('location' as const) : undefined,
    className: highlighted ? 'bg-accent text-accent-foreground font-medium' : undefined,
  };
}

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
        actually declares. The declared set is generated at log time and baked into the model artifact; Unity Catalog
        is what says who can read it.
      </AlertDescription>
    </Alert>
  );
}
