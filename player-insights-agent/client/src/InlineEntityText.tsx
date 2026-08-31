import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';

import { entityHref, linkifyEntities } from './data-entities';
import { useTrackedTables } from './data-entity-state';

const INLINE_NUMBER = /\d{4}-\d{1,2}-\d{1,2}|[-+\u2212]?(?:[$€£]\s*)?\d[\d,]*(?:\.\d+)?%?/g;
const KNOWN_TOOLS = [
  'data_genie',
  'dictionary_genie',
  'list_data_assets',
  'search_tagged_assets',
  'search_semantics',
  'search_sources',
  'resolve_table',
  'describe_table',
  'query_named_table',
  'run_sql',
  'request_clarification',
  'new_plot',
];

function EntityParts({ text, entity }: { text: string; entity: string }) {
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
            <span className={`entity-token entity-${kind}`} data-entity-part={kind}>
              {part}
            </span>
          </Fragment>
        );
      })}
    </>
  );
}

function plainRuns(text: string, start: number, tools: readonly string[], numbers: boolean): ReactNode[] {
  const candidates = [...new Set([...KNOWN_TOOLS, ...tools])]
    .filter((name) => /^[a-z_][a-z0-9_]*$/.test(name))
    .sort((left, right) => right.length - left.length);
  const toolPattern =
    candidates.length > 0
      ? new RegExp(`\\b(${candidates.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi')
      : null;
  const pieces = toolPattern ? text.split(toolPattern) : [text];
  let offset = 0;
  const nodes: ReactNode[] = [];
  for (const piece of pieces) {
    const at = start + offset;
    offset += piece.length;
    if (candidates.some((tool) => tool.toLowerCase() === piece.toLowerCase())) {
      nodes.push(
        <code className="answer-code semantic-inline-code" data-technical-entity="tool" key={`${at}-tool`}>
          {piece}
        </code>
      );
      continue;
    }
    if (!numbers) {
      nodes.push(<Fragment key={at}>{piece}</Fragment>);
      continue;
    }
    let from = 0;
    for (const match of piece.matchAll(INLINE_NUMBER)) {
      const numberAt = match.index ?? 0;
      if (numberAt > from) nodes.push(<Fragment key={at + from}>{piece.slice(from, numberAt)}</Fragment>);
      nodes.push(
        <span className="answer-inline-number ast-num" key={`${at + numberAt}-number`}>
          {match[0]}
        </span>
      );
      from = numberAt + match[0].length;
    }
    if (from < piece.length) nodes.push(<Fragment key={at + from}>{piece.slice(from)}</Fragment>);
  }
  return nodes;
}

function EntityRuns({
  text,
  sources,
  tracked,
  columns,
  tools,
  numbers,
}: {
  text: string;
  sources: readonly string[];
  tracked: readonly string[];
  columns: readonly string[];
  tools: readonly string[];
  numbers: boolean;
}) {
  return (
    <>
      {linkifyEntities(text, sources, tracked, columns).map((run) =>
        run.entity ? (
          <Link
            to={entityHref(run.entity)}
            data-entity={run.entity}
            title={`${run.entity}, see it on Connections`}
            className="entity-table text-primary font-medium underline decoration-dotted decoration-1 underline-offset-2 hover:decoration-solid"
            key={run.start}
          >
            <EntityParts text={run.text} entity={run.entity} />
          </Link>
        ) : run.emphasis && run.declaredTable ? (
          <span className="entity-table-mark" key={run.start}>
            <EntityParts text={run.text} entity={run.declaredTable} />
          </span>
        ) : run.emphasis ? (
          <span className="entity-mark entity-column font-semibold" key={run.start}>
            {run.text}
          </span>
        ) : (
          <Fragment key={run.start}>{plainRuns(run.text, run.start, tools, numbers)}</Fragment>
        )
      )}
    </>
  );
}

/** Lightweight entity prose for the eager plan and live-progress surfaces. */
export function EntityText({
  text,
  sources,
  columns = [],
  tools = [],
  numbers = true,
}: {
  text: string;
  sources: readonly { name: string }[];
  columns?: readonly string[];
  tools?: readonly string[];
  toolClassName?: string;
  numbers?: boolean;
}) {
  const tracked = useTrackedTables();
  return (
    <EntityRuns
      text={text}
      sources={sources.map((source) => source.name)}
      tracked={tracked}
      columns={columns}
      tools={tools}
      numbers={numbers}
    />
  );
}

export function PlanText({ text, columns }: { text: string; columns: readonly string[] }) {
  const tracked = useTrackedTables();
  return <EntityText text={text} sources={tracked.map((name) => ({ name }))} columns={columns} />;
}

export function TableEntityList({
  tables,
  empty = 'No tables were returned by this discovery step.',
  countVerb = 'assessed',
}: {
  tables: readonly (string | { name: string; metadata?: readonly string[] })[];
  empty?: string;
  countVerb?: string;
}) {
  const items = tables
    .map((table) =>
      typeof table === 'string'
        ? { name: table.trim(), metadata: [] as readonly string[] }
        : { ...table, name: table.name.trim() }
    )
    .filter(
      (table, index, entries) =>
        table.name.length > 0 &&
        entries.findIndex((candidate) => candidate.name.toLowerCase() === table.name.toLowerCase()) === index
    );
  if (items.length === 0) return <p className="entity-table-list-empty">{empty}</p>;
  return (
    <div className="entity-table-list">
      <p className="entity-table-list-count">
        <span className="ast-num">{items.length}</span> table{items.length === 1 ? '' : 's'} {countVerb}
      </p>
      <ul>
        {items.map((table) => (
          <li key={table.name}>
            <span className="entity-table-list-name" title={table.name} aria-label={`Table ${table.name}`} tabIndex={0}>
              <EntityText text={table.name} sources={[{ name: table.name }]} />
            </span>
            {table.metadata && table.metadata.length > 0 ? (
              <span className="entity-table-list-metadata" aria-label={`Metadata for ${table.name}`}>
                {table.metadata.map((metadata) => (
                  <span
                    className="ast-pill ast-pill--neutral-outline entity-table-list-meta"
                    key={`${table.name}-${metadata}`}
                  >
                    {metadata}
                  </span>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
