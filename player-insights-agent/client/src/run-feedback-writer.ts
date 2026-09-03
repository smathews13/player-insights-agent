import type { FeedbackDirection } from '../../shared/feedback-direction';
import { FeedbackWriteQueue } from './feedback-write-queue';

export interface RunFeedbackRequest {
  messageId: string;
  sentiment: FeedbackDirection;
  comment?: string;
}

interface RunFeedbackCallbacks {
  pending: () => void;
  /** Runs for every accepted write, even when a newer request owns the UI. */
  committed?: () => void;
  saved: () => void;
  failed: (error: Error) => void;
}

/** POST the same caller-scoped canonical feedback contract used by AnswerCard. */
export async function postRunFeedback(request: RunFeedbackRequest, send: typeof fetch = fetch): Promise<void> {
  const response = await send('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messageId: request.messageId,
      sentiment: request.sentiment,
      ...(request.sentiment === 'down' && request.comment?.trim() ? { comment: request.comment.trim() } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Feedback was not recorded (HTTP ${response.status}).`);
}

/**
 * Serialize writes per run and fence stale completions.
 *
 * The feedback table is append-only, so ordering is correctness rather than
 * polish: a rapid down-to-up change must be stored and displayed in that order.
 */
export class RunFeedbackWriter {
  private readonly queue = new FeedbackWriteQueue();
  private readonly versions = new Map<string, number>();

  async save(request: RunFeedbackRequest, callbacks: RunFeedbackCallbacks, send: typeof fetch = fetch): Promise<void> {
    const version = (this.versions.get(request.messageId) ?? 0) + 1;
    this.versions.set(request.messageId, version);
    callbacks.pending();
    try {
      await this.queue.enqueue(request.messageId, () => postRunFeedback(request, send));
      callbacks.committed?.();
      if (this.versions.get(request.messageId) === version) callbacks.saved();
    } catch (error) {
      if (this.versions.get(request.messageId) === version) {
        callbacks.failed(error instanceof Error ? error : new Error('Feedback was not recorded.'));
      }
    }
  }
}
