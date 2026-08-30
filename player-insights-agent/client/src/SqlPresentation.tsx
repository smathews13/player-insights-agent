import { type ReactNode } from 'react';

import { EntityText } from './DataEntityLinks';
import { sqlClauseLines, sqlHighlightRuns, sqlStatements } from './step-results';
import { compactSql, sanitizeSqlForDisplay, SQL_SUMMARY_LIMIT, truncateSql } from './sql-presentation';

function HighlightedSql({ text, tables = [] }: { text: string; tables?: readonly string[] }) {
  const sources = tables.map((name) => ({ name }));
  return (
    <>
      {sqlHighlightRuns(text).map((run) =>
        run.keyword ? (
          <span className="semantic-code-token semantic-code-keyword" key={run.start}>
            {run.text}
          </span>
        ) : (
          <EntityText key={run.start} text={run.text} sources={sources} />
        )
      )}
    </>
  );
}

/**
 * Compact SQL beside prose/tool identity. The prose remains outside this code
 * element; only a structurally identified SQL field reaches it.
 */
export function InlineSqlCode({
  sql,
  limit = SQL_SUMMARY_LIMIT,
  className = '',
}: {
  sql: string;
  limit?: number;
  className?: string;
}) {
  const full = compactSql(sql);
  const shown = truncateSql(full, limit);
  if (!full) return null;
  const fullLabel = shown.truncated ? `Full sanitized SQL: ${full}` : undefined;
  return (
    <code
      className={['semantic-sql-code', 'semantic-sql-code--inline', className].filter(Boolean).join(' ')}
      title={fullLabel}
      aria-label={fullLabel}
      data-sql-truncated={shown.truncated ? 'true' : undefined}
    >
      <HighlightedSql text={shown.text} />
    </code>
  );
}

function SqlLines({
  statement,
  formatClauses,
  tables,
}: {
  statement: string;
  formatClauses: boolean;
  tables: readonly string[];
}) {
  const lines = formatClauses
    ? sqlClauseLines(statement)
    : statement.replace(/^\n+/, '').replace(/\s+$/, '').split(/\r?\n/);
  const keyedLines = lines.map((line, at) => ({ line, key: lines.slice(0, at + 1).join('\n') }));
  return (
    <>
      {keyedLines.map(
        (entry): ReactNode => (
          <span className="sql-line" key={entry.key}>
            <HighlightedSql text={entry.line} tables={tables} />
            {'\n'}
          </span>
        )
      )}
    </>
  );
}

/** Full sanitized SQL, one statement per code block and one clause per line. */
export function SqlCodeBlocks({
  sql,
  className = '',
  formatClauses = true,
  tables = [],
}: {
  sql: string;
  className?: string;
  formatClauses?: boolean;
  tables?: readonly string[];
}) {
  const safe = sanitizeSqlForDisplay(sql);
  const statements = sqlStatements(safe);
  if (statements.length === 0) return null;
  const keyedStatements = statements.map((statement, at) => ({
    statement,
    key: statements.slice(0, at + 1).join('\u0000'),
  }));
  return (
    <div className={['semantic-sql-blocks', className].filter(Boolean).join(' ')}>
      {keyedStatements.map(({ statement, key }) => (
        <pre className="semantic-sql-code semantic-sql-code--block" key={key}>
          <code>
            <SqlLines statement={statement} formatClauses={formatClauses} tables={tables} />
          </code>
        </pre>
      ))}
    </div>
  );
}
