import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { unavailableNotice, unavailableNoticeFor } from './unavailable-copy';
import { partial } from './styles/stylesheet';
import { unavailableResult } from '../../shared/terminal-response';
import { PROVIDER_MESSAGE_LIMIT } from '../../shared/failure-evidence';

/** The panel that draws these sentences, and the rules it is drawn by. */
const PANEL = readFileSync(new URL('./UnavailablePanel.tsx', import.meta.url), 'utf8');
const ALERTS = partial('alerts.css');

/**
 * The sentences a reader gets instead of invented rows.
 *
 * These are pinned rather than left to the components because the failure mode
 * is a wording one and wording drifts silently. The specific regressions worth
 * catching: a heading that names nothing anybody can go and look at, a failure
 * panel that withholds the error it was handed, and a retry button over a
 * permission denial.
 */

/** A denial as the serving path actually assembles one. */
const DENIAL = unavailableResult({
  code: 'USER_NOT_AUTHORIZED',
  requestId: 'req-77',
  executionIdentity: { mode: 'signed_in_user', verified: true },
  evidence: {
    dependency: { kind: 'agent-endpoint', name: 'player-insights-agent' },
    status: 403,
    providerCode: 'PERMISSION_DENIED',
    providerMessage: 'The endpoint refused this request under the signed-in user\u2019s own credential.',
    principal: 'reader@example.com',
    stage: { title: 'Query gold_title_daily_summary', completed: 4 },
  },
});

describe('what the heading says first', () => {
  it('names the dependency and what it did, not just that something is missing', () => {
    // The heading is as far as most people read, and "This question was not
    // answered" tells a reader watching a spinner nothing they did not just see.
    // A named endpoint and a verb is something they can act on.
    expect(unavailableNoticeFor('ask', DENIAL).heading).toBe(
      'Agent serving endpoint player-insights-agent refused this request'
    );
  });

  it('distinguishes a refusal from a silence, because they are different people to go and see', () => {
    // The one distinction in this file worth a switch statement: refused sends a
    // reader to whoever owns their grants, did-not-respond to whoever owns the
    // endpoint. A heading saying "failed" for both sends them to neither.
    const silent = unavailableResult({
      code: 'DEPENDENCY_UNAVAILABLE',
      requestId: 'req-1',
      evidence: { dependency: { kind: 'agent-endpoint', name: 'player-insights-agent' } },
    });
    expect(unavailableNoticeFor('ask', silent).heading).toContain('did not respond');
    expect(unavailableNoticeFor('ask', DENIAL).heading).toContain('refused this request');
  });

  it('falls back to what is missing when the payload named no dependency', () => {
    // Not every failure has a downstream provider to name: a malformed
    // idempotency key never reached one. The per-surface heading is still the
    // most specific thing available, so nothing regresses for those.
    expect(unavailableNotice({ surface: 'runs', code: 'DEPENDENCY_UNAVAILABLE' }).heading).toBe(
      'Runs could not be read'
    );
    expect(unavailableNotice({ surface: 'ask', code: 'DEPENDENCY_UNAVAILABLE' }).heading).toBe(
      'This question was not answered'
    );
  });

  it('names the label a reader can search for, not the identifier the code uses', () => {
    const notice = unavailableNoticeFor(
      'ask',
      unavailableResult({
        code: 'DEPENDENCY_UNAVAILABLE',
        requestId: 'req-2',
        evidence: { dependency: { kind: 'sql-warehouse', name: 'pia-serverless' } },
      })
    );
    expect(notice.heading).toContain('SQL warehouse pia-serverless');
    expect(notice.heading).not.toContain('sql-warehouse');
  });

  it('omits a name it does not have rather than inventing one', () => {
    // An endpoint whose name is unset is a misconfigured deployment. Printing
    // "unknown" beside the label reads as a component called unknown and sends
    // somebody looking for it.
    const notice = unavailableNoticeFor(
      'ask',
      unavailableResult({
        code: 'DEPENDENCY_UNAVAILABLE',
        requestId: 'req-3',
        evidence: { dependency: { kind: 'agent-endpoint', name: '' } },
      })
    );
    expect(notice.heading).toBe('Agent serving endpoint did not respond');
  });
});

/**
 * THE REGRESSION THIS FILE EXISTS FOR.
 *
 * The server has always sent the provider's status and sentence. The browser
 * dropped them, because `unavailableNoticeFor` read five fields and there was no
 * sixth for the error to land in, and no test noticed because the assertions
 * were all about the app's own sentences. So each field is asserted here
 * individually: a renderer that stops forwarding one of them fails on that one
 * rather than on a paragraph match that some other wording change can satisfy.
 */
describe('the error the provider actually returned', () => {
  it('carries the status, the provider code and the provider sentence verbatim', () => {
    const notice = unavailableNoticeFor('ask', DENIAL);
    expect(notice.error).toContain('HTTP 403');
    expect(notice.error).toContain('PERMISSION_DENIED');
    expect(notice.error).toContain('refused this request under the signed-in user');
  });

  it('does not paraphrase, because a paraphrased error is a second error to debug', () => {
    const raw = 'RESOURCE_DOES_NOT_EXIST: Endpoint player-insights-agent does not exist.';
    const notice = unavailableNoticeFor(
      'ask',
      unavailableResult({
        code: 'DEPENDENCY_UNAVAILABLE',
        requestId: 'req-4',
        evidence: {
          dependency: { kind: 'agent-endpoint', name: 'player-insights-agent' },
          status: 404,
          providerMessage: raw,
        },
      })
    );
    expect(notice.error).toContain(raw);
  });

  it('reads a free-form detail as the error when a call site had no structure to give', () => {
    // Several sites still hold a sentence and nothing else. Showing it is
    // strictly better than the alternative this replaces, which was showing
    // nothing while the sentence sat in the response body.
    const notice = unavailableNoticeFor(
      'ask',
      unavailableResult({
        code: 'OUTPUT_SCHEMA_VIOLATION',
        requestId: 'req-5',
        detail: 'object with keys: id, messages, custom_outputs',
      })
    );
    expect(notice.error).toBe('object with keys: id, messages, custom_outputs');
  });

  it('is null only when there was genuinely nothing to quote', () => {
    expect(unavailableNotice({ surface: 'ask', code: 'IDEMPOTENCY_KEY_MALFORMED' }).error).toBeNull();
  });

  it('truncates a provider that returns a stack trace rather than losing the retry button', () => {
    const long = 'x'.repeat(PROVIDER_MESSAGE_LIMIT + 200);
    const notice = unavailableNotice({
      surface: 'ask',
      code: 'DEPENDENCY_UNAVAILABLE',
      evidence: { providerMessage: long },
    });
    expect(notice.error?.length).toBeLessThan(PROVIDER_MESSAGE_LIMIT + 10);
    expect(notice.error).toContain('\u2026');
  });

  /**
   * The disclosure boundary, asserted so a future widening of the error line is
   * a deliberate decision rather than a side effect.
   *
   * Unity Catalog names the table, the privilege and its owner in a denial. That
   * body reaches the reader who has just been told they may not read that table,
   * and another label's restricted product is that label's business. The route
   * substitutes the refusal's own sentence and keeps the status, which is the
   * part that resolves what a reader is actually stuck on.
   */
  it('keeps the status on a denial without forwarding what Unity Catalog named', () => {
    const notice = unavailableNoticeFor('ask', DENIAL);
    expect(notice.error).toContain('HTTP 403');
    expect(notice.error).not.toMatch(/gold_title_daily_summary.*SELECT|GRANT|owner/i);
  });
});

describe('how far the run got', () => {
  it('says how many steps finished, which separates a stall from a cold start', () => {
    expect(unavailableNoticeFor('ask', DENIAL).stage).toContain('4 completed steps');
  });

  it('names the last step to finish rather than claiming to know which one failed', () => {
    // The app hears about a stage when the agent reports it COMPLETE, so the
    // stage that failed is by definition one nobody heard about. Naming the last
    // success as the failure would send a reader to read a query that ran.
    const stage = unavailableNoticeFor('ask', DENIAL).stage;
    expect(stage).toContain('Query gold_title_daily_summary');
    expect(stage).toMatch(/after/i);
    expect(stage).not.toMatch(/failed in|died in/i);
  });

  it('says nothing when nothing was narrated', () => {
    // A turn that answers with a plan emits no stages at all, and "stopped in
    // step 0" would name a step that does not exist.
    expect(unavailableNotice({ surface: 'ask', code: 'DEPENDENCY_UNAVAILABLE' }).stage).toBeNull();
  });
});

describe('the identity, on the failures where it is the answer', () => {
  it('names the principal and whether the identity was verified', () => {
    const identity = unavailableNoticeFor('ask', DENIAL).identity;
    expect(identity).toContain('reader@example.com');
    expect(identity).toContain('signed in user');
    expect(identity).toContain('identity verified');
  });

  it('says so when it was not verified, rather than leaving the word out', () => {
    // An absent word reads as an unimportant one, and this is the claim a reader
    // relies on to conclude a denial is really about their own grants.
    const notice = unavailableNoticeFor(
      'ask',
      unavailableResult({
        code: 'USER_AUTH_REJECTED',
        requestId: 'req-6',
        executionIdentity: { mode: 'signed_in_user', verified: false },
      })
    );
    expect(notice.identity).toContain('identity not verified');
  });

  it('is withheld where identity did not decide the outcome', () => {
    // A reader debugging an endpoint that did not answer does not need to be
    // told which of their identities was used, and a line per fact regardless of
    // relevance is how a panel becomes something people skim past.
    const notice = unavailableNoticeFor(
      'ask',
      unavailableResult({
        code: 'DEPENDENCY_UNAVAILABLE',
        requestId: 'req-8',
        executionIdentity: { mode: 'signed_in_user', verified: true },
      })
    );
    expect(notice.identity).toBeNull();
  });
});

describe('the one sentence of consequence', () => {
  it('names the wrong reading that surface invites, not a generic one', () => {
    // The wrong reading differs per surface: on Run Explorer it is "my history
    // was deleted", on the Benchmark Lab it is "we scored zero".
    expect(unavailableNotice({ surface: 'runs', code: 'DEPENDENCY_UNAVAILABLE' }).consequence).toContain(
      'not because there are no runs'
    );
    expect(unavailableNotice({ surface: 'conversations', code: 'DEPENDENCY_UNAVAILABLE' }).consequence).toContain(
      'not because you have no history'
    );
    expect(unavailableNotice({ surface: 'benchmarks', code: 'DEPENDENCY_UNAVAILABLE' }).consequence).toContain(
      'not a score of zero'
    );
    expect(unavailableNotice({ surface: 'run-trace', code: 'DEPENDENCY_UNAVAILABLE' }).consequence).toContain(
      'not because the run did nothing'
    );
  });

  /**
   * The Ask surface's consequence is now one sentence, and this test is the
   * reason it will stay one.
   *
   * It used to be three: the taxonomy's generic message, a sentence about the
   * app leaving questions unanswered rather than completing them with figures
   * nobody queried, and advice on whether to wait. All three were true. None of
   * them was the error, and the error was in the payload the whole time.
   */
  it('is one sentence, and not an essay on the app\u2019s posture', () => {
    const consequence = unavailableNotice({ surface: 'ask', code: 'DEPENDENCY_UNAVAILABLE' }).consequence;
    expect(consequence).toBe('Nothing was answered and the conversation is unchanged.');
    expect(consequence).not.toMatch(/figures nobody queried|rather than completing/i);
    // One terminal full stop, so a third clause cannot be appended quietly.
    expect(consequence.match(/\./g)).toHaveLength(1);
  });

  it('never offers the missing data as something already on screen', () => {
    // A failure sentence saying "showing recent results below" is the
    // fabrication with an apology attached.
    for (const surface of ['runs', 'ask', 'benchmarks'] as const) {
      const notice = unavailableNotice({ surface, code: 'DEPENDENCY_UNAVAILABLE' });
      expect(notice.consequence).not.toMatch(/representative|sample|cached|approximate|instead we/i);
      // And nothing pointing at screen furniture. The Ask panel sits at the end
      // of the transcript with nothing beneath it.
      expect(notice.consequence).not.toMatch(/below/i);
    }
  });
});

describe('whether it is worth waiting', () => {
  it('says so for a dependency that may come back', () => {
    const notice = unavailableNotice({ surface: 'runs', code: 'DEPENDENCY_UNAVAILABLE' });
    expect(notice.retryable).toBe(true);
    expect(notice.retryAdvice).toContain('worth trying again shortly');
  });

  it('says nothing at all for a denial, rather than advising on a retry that cannot work', () => {
    // The behavioural failure, not a wording preference. The previous version
    // said "waiting will not clear this, so try again only after the cause has
    // been addressed", which is still a sentence about retrying attached to a
    // failure that cannot be retried. No sentence and no button is unambiguous.
    const notice = unavailableNotice({ surface: 'runs', code: 'USER_NOT_AUTHORIZED' });
    expect(notice.retryable).toBe(false);
    expect(notice.retryAdvice).toBeNull();
  });
});

describe('the facts a panel must not guess', () => {
  it('renders never-verified as its own sentence, not as a missing date', () => {
    const notice = unavailableNotice({ surface: 'runs', code: 'DEPENDENCY_UNAVAILABLE', lastVerifiedAt: null });
    expect(notice.lastVerified).toContain('has not been read successfully');
  });

  it('says nothing at all when the caller did not know', () => {
    // Absent is not the same as never, and inventing either would be the same
    // class of claim this file exists to remove.
    expect(unavailableNotice({ surface: 'runs', code: 'DEPENDENCY_UNAVAILABLE' }).lastVerified).toBeNull();
  });

  it('shows a correlation id when there is one and omits the label when there is not', () => {
    expect(
      unavailableNotice({ surface: 'runs', code: 'DEPENDENCY_UNAVAILABLE', correlationId: 'req-9' }).correlation
    ).toBe('Correlation ID: req-9');
    expect(unavailableNotice({ surface: 'runs', code: 'DEPENDENCY_UNAVAILABLE' }).correlation).toBeNull();
  });
});

describe('what a screen reader is told', () => {
  it('interrupts only when somebody is waiting on the request', () => {
    // A failed submission interrupts. A pane that was already unreadable when
    // the page loaded does not, or a page with three of them announces three
    // interruptions before the reader hears the first heading, and the setting
    // gets turned off.
    expect(unavailableNotice({ surface: 'ask', code: 'DEPENDENCY_UNAVAILABLE', interactive: true }).liveRegion).toBe(
      'alert'
    );
    expect(unavailableNotice({ surface: 'runs', code: 'DEPENDENCY_UNAVAILABLE' }).liveRegion).toBe('status');
  });
});

/**
 * How the panel draws them.
 *
 * The decisions are in the copy module and are tested above; these are the ones the
 * component still owns, and each of them has been wrong at least once. Read from the
 * source rather than rendered, because the suite runs on `node` and the alternative
 * is a browser this work is not allowed to open.
 */
describe('the panel that draws the notice', () => {
  it('offers a retry only when the code is retryable, whatever the caller passed', () => {
    // Both halves. A caller that hands a retry handler to a permission denial does
    // not get a button: the copy module has already decided, and letting the call
    // site overrule it here is how the sentence and the button come to disagree.
    expect(PANEL).toMatch(/notice\.retryable && onRetry \?/);
  });

  it('draws the error, and draws it before anything of ours', () => {
    // The ordering IS the fix. A panel that renders the error under two
    // sentences of consequence has technically forwarded it and has still lost
    // the reader, who stopped at the second sentence.
    expect(PANEL).toContain('unavailable-error');
    expect(PANEL.indexOf('unavailable-error')).toBeLessThan(PANEL.indexOf('unavailable-detail'));
  });

  it('says the things it says in the order the reader needs them', () => {
    const order = [
      'unavailable-heading',
      'unavailable-error',
      'unavailable-context',
      'unavailable-detail',
      'unavailable-meta',
      'unavailable-retry',
    ].map((part) => PANEL.indexOf(part));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('leaves the error transcribable, for the same reason the correlation id is', () => {
    // It is not prose. It is a string somebody pastes into a ticket or a search
    // box, and a wrapped serif paragraph has to be reassembled by hand first.
    const rule = ALERTS.match(/\.unavailable-error \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/font-family: var\(--font-mono\)/);
    expect(rule).toMatch(/user-select: all/);
    // A three-part table identifier has no spaces in it, and a horizontal
    // scrollbar inside an alert hides the half of the message that names the
    // privilege.
    expect(rule).toMatch(/overflow-wrap: anywhere/);
    // The app declares two radii and this is a code panel, which is the small one.
    expect(rule).toMatch(/border-radius: var\(--radius-sm\)/);
  });

  it('leaves the correlation id transcribable', () => {
    // Its whole job is to be read down a phone or pasted into a ticket, so it is
    // mono, full ink, and selectable in one click without the sentence around it.
    const rule = ALERTS.match(/\.unavailable-correlation \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/font-family: var\(--font-mono\)/);
    expect(rule).toMatch(/user-select: all/);
    expect(rule).toMatch(/color: var\(--db-ink\)/);
  });

  it('is drawn as the card it replaces rather than as a strip across the page', () => {
    // The storage banner is a strip on the red wash, because it interrupts a page
    // that works. This panel stands where the runs list should be, and a whole empty
    // region on the wash reads as a stain rather than as a notice.
    const rule = ALERTS.match(/\[data-slot='alert']\.text-destructive\.unavailable-panel \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/border-radius: var\(--radius-md\)/);
    expect(rule).toMatch(/background: var\(--card\)/);
    // And the edge is still the red one, from the rule this one narrows.
    expect(ALERTS).toMatch(/border-color: color-mix\(in oklab, var\(--db-red-600\) 40%/);
  });

  it('takes the live region from the notice rather than choosing one for itself', () => {
    // Whether somebody is waiting on this is something the caller knows and the
    // component does not, and getting it backwards means either shouting on every
    // navigation or staying silent on the one event that mattered.
    expect(PANEL).toMatch(/role=\{notice\.liveRegion}/);
    expect(PANEL).toMatch(/aria-live=\{notice\.liveRegion === 'alert' \? 'assertive' : 'polite'}/);
  });
});

describe('a notice built from a server payload', () => {
  const payload = unavailableResult({
    code: 'DEPENDENCY_UNAVAILABLE',
    requestId: 'req-42',
    lastVerifiedAt: '2026-08-10 09:15',
    message: 'Run storage could not be read just now.',
  });

  it('uses the server sentence rather than re-deriving one', () => {
    // Re-deriving is how the settings page came to contradict its own API. The
    // server chose the code, the id and the time; the browser repeats them.
    const notice = unavailableNoticeFor('runs', payload);
    expect(notice.heading).toBe('Run storage could not be read just now.');
    expect(notice.correlation).toBe('Correlation ID: req-42');
    expect(notice.lastVerified).toBe('Last verified 2026-08-10 09:15.');
  });

  it('still carries the sentence about the blank space', () => {
    expect(unavailableNoticeFor('runs', payload).consequence).toContain('not because there are no runs');
  });

  it('believes the payload when it downgrades retryability, advice included', () => {
    // Not just the flag. A payload that says a normally-retryable failure will
    // not clear, over a sentence telling the reader to try again shortly, is the
    // same contradiction one field further along.
    const denied = unavailableResult({ code: 'USER_NOT_AUTHORIZED', requestId: 'req-43' });
    expect(unavailableNoticeFor('runs', denied).retryable).toBe(false);
    expect(unavailableNoticeFor('runs', denied).retryAdvice).toBeNull();
  });
});
