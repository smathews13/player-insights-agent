/**
 * The evidence half of an answer: the charts, or the rows behind them.
 *
 * Charts and tables are the same measurements drawn twice, so showing both at
 * once made every answer read as though it were saying something twice. The rule
 * is charts XOR tables -- but folded, not dropped, because a chart that fails to
 * paint would otherwise take the only copy of the numbers with it.
 *
 * This lives outside AnswerCard because the Run Explorer shows the same stored
 * answer and has to obey the same rule. It did not: the Overview tab printed the
 * narrative whole, tables and all, while the run's charts were handed to the
 * Agent map tab -- so the one answer was drawn as rows on one tab and as pictures
 * on another, and the reader had no way to tell they were the same figures.
 */
import { useState } from 'react';
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui';
import { ChevronDown } from 'lucide-react';
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
  /*
   * The rows start folded, and stay open once opened. A reader who asked to see
   * the numbers behind one chart is not asking to be shown a chart again, and a
   * chart that failed to paint opens this itself -- a picture that is not there
   * is a reason to show the numbers, not a reason to take the choice away.
   */
  const [showRows, setShowRows] = useState(false);
  const hasCharts = Array.isArray(charts) && charts.length > 0;
  const hasTables = carriesTable(narrative, content);
  if (!hasCharts && !hasTables) return null;
  const [narrativeOrigins, contentOrigins] = tableOriginMaps([narrative, content], sources);
  const tables = (
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
  );
  return (
    <section className="answer-evidence" aria-label={hasCharts ? 'Chart evidence' : 'Table evidence'}>
      {hasCharts ? <AnswerCharts charts={charts} sources={sources} onFailure={() => setShowRows(true)} /> : null}
      {hasCharts && hasTables ? (
        <Collapsible open={showRows} onOpenChange={setShowRows}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="answer-evidence-rows">
              {showRows ? 'Hide the rows' : 'Show the rows behind this'}
              <ChevronDown className={`transition-transform ${showRows ? 'rotate-180' : ''}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>{tables}</CollapsibleContent>
        </Collapsible>
      ) : null}
      {!hasCharts && hasTables ? tables : null}
    </section>
  );
}
