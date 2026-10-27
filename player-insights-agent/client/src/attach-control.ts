/**
 * What the composer's paperclip is doing, as one decision rather than three
 * conditions written at the call site.
 *
 * The control had no state of its own at all. It was `disabled={loading ||
 * conversationLoading}` and a fixed label, which leaves out the one moment it
 * most needs to say something: while a file it just accepted is being read,
 * uploaded and parsed. That is seconds of work for a PDF, and for the whole of
 * it the button looked exactly as it does at rest -- so the only reasonable
 * reading was that nothing had happened, and the reasonable response was to
 * press it again. Doing so starts a second `uploadAttachments` over the same
 * `<input>`, whose `value` the first one clears on its way out.
 *
 * Split out here rather than inlined because the app's tests run without a DOM:
 * a decision in JSX cannot be asserted, and this one has four states and a
 * precedence between them.
 */

/** The three facts the control's state is derived from. */
export interface AttachControlInput {
  /** A file this control accepted is being uploaded and parsed right now. */
  attaching: boolean;
  /** A question is in flight, so the conversation is not accepting documents. */
  asking: boolean;
  /** The conversation has not loaded, so there is nothing to attach to yet. */
  conversationLoading: boolean;
  /** The thread is a colleague's, opened to read; the server refuses an upload to it. */
  readOnly?: boolean;
}

export interface AttachControlState {
  /** Whether the control refuses input. */
  disabled: boolean;
  /**
   * Whether it refuses input BECAUSE it is working, which is the one reason a
   * reader is owed a visible answer for. Kept separate from `disabled` so the
   * busy treatment cannot be painted onto a control that is merely waiting for
   * a conversation to load.
   */
  pending: boolean;
  label: string;
}

export const ATTACH_LABEL = 'Attach context';

/**
 * The working label. Present tense and not "Attached": the upload has been
 * accepted and has not finished, and the chip row below the composer is what
 * reports the outcome of each file.
 */
export const ATTACHING_LABEL = 'Attaching…';

export function attachControlState({
  attaching,
  asking,
  conversationLoading,
  readOnly = false,
}: AttachControlInput): AttachControlState {
  return {
    disabled: attaching || asking || conversationLoading || readOnly,
    pending: attaching,
    label: attaching ? ATTACHING_LABEL : ATTACH_LABEL,
  };
}
