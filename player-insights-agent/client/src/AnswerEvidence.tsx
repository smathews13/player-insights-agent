/**
 * The evidence half of an answer: the charts, then every table the answer wrote.
 *
 * The backend decides what an answer shows. It caps tables and says so in a
 * caveat; this component draws what arrives, in the order it was written, each
 * table under its own heading. Nothing here hides, folds, merges or reorders a
 * chart or a table. A fold behind a chart is how an answer that sent twelve
 * tables came to show one.
 *
 * This lives outside AnswerCard because the Run Explorer shows the same stored
 * answer and has to draw it the same way.
 */
import { AnswerCharts } from './AnswerCharts';
import { AnswerProse } from './DataEntityLinks';
import { carriesTable } from './answer-markdown';
import { tableOriginMaps } from './answer-table-origins';
import { mentionedIdentifiers } from './data-entities';
import type { Answer } from './app-types';
import type { SourceRef } from './answer-shape';

export function AnswerEvidence({
  narrative,
  content,
  charts,
  sources,
}: {
  narrative: string;
  content?: string | null;
  charts?: Answer['charts'];
  sources: readonly SourceRef[];
}) {
  const hasCharts = Array.isArray(charts) && charts.length > 0;
  const hasTables = carriesTable(narrative, content);
  if (!hasCharts && !hasTables) return null;
  const [narrativeOrigins, contentOrigins] = tableOriginMaps([narrative, content], sources);
  return (
    <section className="answer-evidence" aria-label={hasCharts ? 'Chart evidence' : 'Table evidence'}>
      {hasCharts ? <AnswerCharts charts={charts} sources={sources} /> : null}
      {hasTables ? (
        <>
          <AnswerProse
            text={narrative}
            sources={sources}
            columns={mentionedIdentifiers([narrative])}
            blocks="tables"
            originMap={narrativeOrigins}
          />
          {content ? (
            <AnswerProse
              text={content}
              sources={sources}
              columns={mentionedIdentifiers([content])}
              blocks="tables"
              originMap={contentOrigins}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
