import type { ElementType } from 'react';
import { OrganizationUserBadge } from './OrganizationUserBadge';

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
          <OrganizationUserBadge
            identity={asker}
            className="question-attribution-user"
            canOpen={canOpenUser}
            showArrow={canOpenUser}
          />
        </div>
      </div>
    </div>
  );
}
