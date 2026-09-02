/**
 * The Overview tab's stored answer: takeaway, narrative, tables, sources, caveats.
 *
 * Its own module so the Run Explorer page can keep owning the KPI tiles and the
 * tabs without also owning how a past answer is read. Ask PIA still uses
 * AnswerCard; this is the same evidence helpers with a header that is allowed
 * to say the run did not finish.
 *
 * THE BADGE IS THE FIRST THING IN THE CARD. "Live agent response" sits at the
 * true top-left. A mark beside or above it pushed the chip onto the next row
 * and made the card open with a star instead of with what the answer is.
 */
import { Link } from 'react-router';
import { Badge, Card, CardContent } from './ui';
import { conversationHref } from './conversation-links';
import { AnswerProse, EntityText } from './DataEntityLinks';
import { AnswerEvidence } from './AnswerEvidence';
import { SourcesModule } from './SourcesModule';
import { mentionedIdentifiers } from './data-entities';
import { answerHonesty, readerFacingNarrative, readerFacingTakeaway } from './reader-facing-answer';
import { evidenceLinkedSourceNames } from './answer-table-origins';
import type { Derivation } from './answer-shape';
import type { Chart } from './AnswerCharts';
import { AIAnalysisCaveat } from './AIAnalysisCaveat';
import { normalizeReaderAnswer } from '../../shared/answer-content-policy';

export function FinalAnswer({
  takeaway,
  narrative,
  charts,
  sources,
  caveats,
  derivation,
  sql = '',
  truncated,
  conversationId,
  runId,
}: {
  takeaway: string;
  narrative: string;
  charts?: Chart[];
  sources: { name: string; freshness: string }[];
  caveats: readonly string[];
  derivation?: readonly Derivation[];
  sql?: string;
  truncated?: boolean | null;
  conversationId?: string | null;
  runId?: string | null;
}) {
  const displayed = normalizeReaderAnswer({ takeaway, narrative, sources, caveats, sql });
  const honesty = answerHonesty({ truncated, caveats: displayed.caveats ?? [], narrative: displayed.narrative });
  const headline = readerFacingTakeaway(displayed.takeaway ?? '', displayed.narrative ?? '');
  const story = readerFacingNarrative(displayed.takeaway ?? '', displayed.narrative ?? '');
  const restCaveats = displayed.caveats ?? [];
  const columns = mentionedIdentifiers([story]);
  return (
    <Card className="final-answer" data-tone={honesty.tone}>
      <CardContent>
        <div className="final-answer-head">
          <Badge variant="outline" className="provenance-chip" data-tone="live">
            Live agent response
          </Badge>
          {honesty.tone === 'partial' ? (
            <Badge variant="outline" className="provenance-chip ast-pill ast-pill--neg">
              {honesty.eyebrow}
            </Badge>
          ) : (
            <p className="final-answer-eyebrow">{honesty.eyebrow}</p>
          )}
        </div>
        {headline ? (
          <h4 className="final-answer-takeaway">
            <EntityText text={headline} sources={sources} />
          </h4>
        ) : null}
        {/* Prose only: the tables that came with it are evidence and are drawn
            below under the same charts-or-rows rule the live card uses. */}
        <AnswerProse text={story} sources={sources} columns={columns} blocks="prose" />
        <AnswerEvidence narrative={story} charts={charts} sources={sources} />
        <SourcesModule
          sources={sources}
          caveats={restCaveats}
          derivation={derivation}
          sql={sql}
          hideWorkspaceLinks={evidenceLinkedSourceNames(story, null, charts, sources)}
        />
        {conversationId ? (
          <Link className="final-answer-open" to={conversationHref(conversationId, runId)}>
            Open full response →
          </Link>
        ) : null}
        <AIAnalysisCaveat className="ai-note" />
      </CardContent>
    </Card>
  );
}
