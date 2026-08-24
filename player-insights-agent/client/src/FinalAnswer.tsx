/**
 * The Overview tab's stored answer: takeaway, narrative, tables, sources, caveats.
 *
 * Its own module so the Run Explorer page can keep owning the KPI tiles and the
 * tabs without also owning how a past answer is read. Ask PIA still uses
 * AnswerCard; this is the same evidence helpers with a header that is allowed
 * to say the run did not finish.
 */
import { Link } from 'react-router';
import { Card, CardContent } from './ui';
import { CircleAlert } from 'lucide-react';
import { conversationHref } from './conversation-links';
import { AnswerProse, EntityText } from './DataEntityLinks';
import { AnswerEvidence } from './AnswerEvidence';
import { AstrolabeMark } from './AstrolabeMark';
import { SourcesModule } from './SourcesModule';
import { mentionedIdentifiers } from './data-entities';
import {
  answerHonesty,
  readerFacingTakeaway,
} from './reader-facing-answer';
import type { Derivation } from './answer-shape';
import type { Chart } from './AnswerCharts';

export function FinalAnswer({
  takeaway,
  narrative,
  charts,
  sources,
  caveats,
  derivation,
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
  truncated?: boolean | null;
  conversationId?: string | null;
  runId?: string | null;
}) {
  const honesty = answerHonesty({ truncated, caveats });
  const headline = readerFacingTakeaway(takeaway, narrative);
  const warningTexts = new Set(honesty.warnings.map((warning) => warning.text));
  const restCaveats = caveats.filter((caveat) => !warningTexts.has(caveat.trim()));
  const columns = mentionedIdentifiers([narrative]);
  return (
    <Card className="final-answer" data-tone={honesty.tone}>
      <CardContent>
        <div className="final-answer-head">
          {/* 18 because `.final-answer-mark svg` paints 18. The size picks the
              drawing as well as the box -- the graduation ring is dropped below
              GRADUATION_FLOOR -- so a seat that asks for one number and is painted
              another gets the wrong cut stretched to the right size. */}
          <span className="final-answer-mark">
            {honesty.tone === 'partial' ? (
              <CircleAlert size={18} aria-hidden="true" />
            ) : (
              <AstrolabeMark size={18} />
            )}
          </span>
          <p className="final-answer-eyebrow">{honesty.eyebrow}</p>
        </div>
        {honesty.warnings.length > 0 ? (
          <ul className="final-answer-warnings">
            {honesty.warnings.map((warning) => (
              <li className="final-answer-warning" key={warning.label + warning.text}>
                <strong>{warning.label}</strong>
                <span>
                  <EntityText text={warning.text} sources={sources} columns={mentionedIdentifiers([warning.text])} />
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {headline ? <h4 className="final-answer-takeaway">{headline}</h4> : null}
        {/* Prose only: the tables that came with it are evidence and are drawn
            below under the same charts-or-rows rule the live card uses. */}
        <AnswerProse text={narrative} sources={sources} columns={columns} blocks="prose" />
        <AnswerEvidence narrative={narrative} charts={charts} sources={sources} />
        <SourcesModule
          layout="list"
          sources={sources}
          caveats={restCaveats}
          derivation={derivation}
        />
        {conversationId ? (
          <Link className="final-answer-open" to={conversationHref(conversationId, runId)}>
            Open full response →
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
