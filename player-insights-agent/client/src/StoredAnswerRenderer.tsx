import { AIAnalysisCaveat } from './AIAnalysisCaveat';
import { AnswerCard } from './AnswerCard';
import { AnswerProse } from './DataEntityLinks';
import { Card, CardContent } from './ui';
import type { Answer, FeedbackEntry } from './app-types';
import type { TraceStage } from './answer-shape';
import { normalizeReaderText } from '../../shared/answer-content-policy';
import type { FeedbackDirection } from '../../shared/feedback-direction';

export interface StoredAnswerRendererProps {
  answer?: Answer;
  rawContent: string;
  id?: string;
  preferenceKey?: string;
  question?: string;
  feedback: FeedbackEntry;
  onFeedbackChange: (changes: Partial<FeedbackEntry>) => void;
  saveFeedback: (sentiment: FeedbackDirection, options?: { keepCommentOpen?: boolean }) => Promise<void>;
  showFeedback: boolean;
  processStages?: TraceStage[];
}

export default function StoredAnswerRenderer({
  answer,
  rawContent,
  id,
  preferenceKey,
  question,
  feedback,
  onFeedbackChange,
  saveFeedback,
  showFeedback,
  processStages,
}: StoredAnswerRendererProps) {
  if (!answer) {
    const displayedContent = normalizeReaderText(rawContent, {}, 'raw');
    return (
      <Card className="answer-card">
        <CardContent className="pt-6 space-y-4">
          <AnswerProse text={displayedContent} sources={[]} preserveProse />
          <AIAnalysisCaveat className="ai-note" />
        </CardContent>
      </Card>
    );
  }
  return (
    <AnswerCard
      id={id}
      answer={answer}
      question={question}
      feedback={feedback}
      onFeedbackChange={onFeedbackChange}
      saveFeedback={saveFeedback}
      showFeedback={showFeedback}
      defaultRunProcessOpen={false}
      runProcessPreferenceKey={preferenceKey}
      processStages={processStages}
    />
  );
}
