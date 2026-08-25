/**
 * The dropdowns an administrator gets after clicking the rail pencil.
 *
 * Outcome and rating persist. The run number jumps to another turn in this
 * conversation. Conversation, message, user and tool-count are listed so every
 * chip has a control, and disabled because none of those is a closed set this
 * screen can honestly offer.
 */
import { abbreviatedConversationId } from './display-id';
import { identityName } from './user-identity';
import { shortRunId } from './run-header';
import {
  RAIL_FIELD_REASONS,
  RAIL_OUTCOME_OPTIONS,
  RAIL_RATING_OPTIONS,
  type ConversationRunChoice,
  type RailOutcome,
  type RailRating,
} from './run-header-labels';
import type { Run } from './app-types';

export function RunHeaderLabelEditor({
  run,
  conversationId,
  conversationRuns,
  toolCalls,
  outcome,
  rating,
  onOutcome,
  onRating,
  onSelectRun,
}: {
  run: Run;
  conversationId?: string;
  conversationRuns: ConversationRunChoice[];
  toolCalls: number | null;
  outcome: RailOutcome;
  rating: RailRating;
  onOutcome: (value: RailOutcome) => void;
  onRating: (value: RailRating) => void;
  onSelectRun?: (runId: string) => void;
}) {
  const convLabel = conversationId ? abbreviatedConversationId(conversationId) : 'not set';
  const toolLabel =
    typeof toolCalls === 'number' && Number.isFinite(toolCalls) ? String(toolCalls) : 'not set';
  return (
    <div className="run-header-label-editor" data-testid="run-header-label-editor">
      <label className="run-header-label-field">
        <span>Conversation</span>
        <select className="run-header-label-select" disabled aria-label="Conversation" title={RAIL_FIELD_REASONS.conversation}>
          <option value={conversationId ?? ''}>{convLabel}</option>
        </select>
      </label>
      <label className="run-header-label-field">
        <span>Run</span>
        <select
          className="run-header-label-select"
          aria-label="Run"
          value={run.id}
          disabled={conversationRuns.length < 2 || !onSelectRun}
          onChange={(event) => onSelectRun?.(event.target.value)}
        >
          {(conversationRuns.length ? conversationRuns : [{ id: run.id, number: 1 }]).map((choice) => (
            <option key={choice.id} value={choice.id}>
              Run {choice.number}
            </option>
          ))}
        </select>
      </label>
      <label className="run-header-label-field">
        <span>Message</span>
        <select className="run-header-label-select" disabled aria-label="Message" title={RAIL_FIELD_REASONS.message}>
          <option value={run.id}>{shortRunId(run.id)}</option>
        </select>
      </label>
      <label className="run-header-label-field">
        <span>User</span>
        <select className="run-header-label-select" disabled aria-label="User" title={RAIL_FIELD_REASONS.user}>
          <option value={run.stakeholder ?? ''}>{identityName(run.stakeholder)}</option>
        </select>
      </label>
      <label className="run-header-label-field">
        <span>Outcome</span>
        <select
          className="run-header-label-select"
          aria-label="Outcome"
          value={outcome}
          onChange={(event) => onOutcome(event.target.value as RailOutcome)}
        >
          {RAIL_OUTCOME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="run-header-label-field">
        <span>Tools</span>
        <select className="run-header-label-select" disabled aria-label="Tools" title={RAIL_FIELD_REASONS.tools}>
          <option value={toolLabel}>{toolLabel}</option>
        </select>
      </label>
      <label className="run-header-label-field">
        <span>Rating</span>
        <select
          className="run-header-label-select"
          aria-label="Rating"
          value={rating}
          onChange={(event) => onRating(event.target.value as RailRating)}
        >
          {RAIL_RATING_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
