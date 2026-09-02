/**
 * Serialize writes per answer while allowing different answers to save in
 * parallel. This preserves click order in the append-only feedback table.
 */
export class FeedbackWriteQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue(messageId: string, write: () => Promise<void>): Promise<void> {
    const prior = this.tails.get(messageId) ?? Promise.resolve();
    const pending = prior.catch(() => undefined).then(write);
    this.tails.set(messageId, pending);
    const cleanup = () => {
      if (this.tails.get(messageId) === pending) this.tails.delete(messageId);
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }
}
