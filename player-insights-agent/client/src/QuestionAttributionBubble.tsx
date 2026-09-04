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
      <Question
        id={questionId}
        className={`question-attribution-message${questionClassName ? ` ${questionClassName}` : ''}`}
      >
        {question}
      </Question>
      <UserDrilldownLink
        identity={asker}
        label="Asked by"
        compact
        className="question-attribution-user"
        canOpen={canOpenUser}
      />
    </div>
  );
}
