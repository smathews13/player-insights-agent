import type { ElementType } from 'react';
import { UserDrilldownLink } from './UserDrilldownLink';

export function QuestionAttributionBubble({
  question,
  asker,
  canOpenUser = false,
  questionAs: Question = 'div',
  questionId,
  className = '',
  questionClassName = '',
}: {
  question: string;
  asker: string | null | undefined;
  canOpenUser?: boolean;
  questionAs?: ElementType;
  questionId?: string;
  className?: string;
  questionClassName?: string;
}) {
  return (
    <div className={`question-attribution-bubble${className ? ` ${className}` : ''}`}>
      <div className="question-attribution-surface">
        <Question
          id={questionId}
          className={`question-attribution-message${questionClassName ? ` ${questionClassName}` : ''}`}
        >
          {question}
        </Question>
        <div className="question-attribution-meta">
          <UserDrilldownLink
            identity={asker}
            label="Asked by"
            compact
            className="question-attribution-user"
            canOpen={canOpenUser}
          />
        </div>
      </div>
    </div>
  );
}
