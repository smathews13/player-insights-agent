import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { agentReadinessFrom, type AgentReadiness } from './agent-readiness';
import { RUN_TONE_FAMILY, runStatusFor, type RunStatus } from './run-status';
import { RunStatusPill } from './RunStatusPill';
import { partial } from './styles/stylesheet';

/**
 * The pill that reports the harness, rendered rather than read.
 *
 * The rest of this suite asserts against source and stylesheet, which is right
 * for a claim about a default or a rule that exists. It is not enough here. Every
 * claim below is about what a reader is looking at in a particular state -- that
 * an unreachable endpoint does not produce a green pill, that a finished run does
 * not go on breathing -- and each is one wrong ternary away from being false while
 * a source-level test of the same file passes. So the component is rendered to
 * markup, in the node environment the suite already runs in, with no DOM and no
 * new dependency: `react-dom/server` is what `react-dom` ships for this.
 *
 * What this cannot see is the paint: whether the animation actually runs, what
 * the cadence looks like, what a screen reader says. No browser was launched.
 */
const HOME = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
const RAIL_CSS = partial('rail.css').replace(/\/\*[\s\S]*?\*\//g, ' ');

/** The pill's markup for one state, as the page would draw it. */
function draw(status: RunStatus) {
  return renderToStaticMarkup(createElement(RunStatusPill, { status }));
}

/** The idle screen, for a given reading of the endpoint. */
function idle(readiness: AgentReadiness) {
  return runStatusFor({
    loading: false,
    liveSteps: 0,
    runStopped: false,
    awaitingApproval: false,
    asked: false,
    answered: false,
    readiness,
  });
}

/** A preflight payload of the shape the route really answers with. */
function report(agentCheck: { status: string } | null) {
  return {
    checked_at: '2026-08-15T20:00:00Z',
    status: agentCheck?.status === 'ok' ? 'ok' : 'failed',
    principal: 'app-sp',
    principal_resolved: true,
    table_source: 'model-version',
    checks: agentCheck
      ? [
          {
            id: 'agent-endpoint',
            kind: 'serving-endpoint',
            name: 'player-insights-agent',
            label: 'Agent endpoint · player-insights-agent',
            status: agentCheck.status,
            detail: 'The app invoked the agent endpoint and it answered.',
            checked_with: 'POST /serving-endpoints/:name/invocations',
            duration_ms: 0,
            error: '',
            remedy: null,
          },
        ]
      : [],
    assumptions: [],
    counts: { ok: 1, failed: 0, unverified: 0 },
    source: 'app',
  };
}

describe('the harness says it is ready before anybody has asked anything', () => {
  it('draws the pill on an idle screen rather than waiting for a run to report', () => {
    // Both seatings were gated, in different ways and to different effect. The
    // column is drawn unconditionally and always was, so a wide screen did show
    // the mark; the strip that stands in for it below 1180px was drawn only once
    // there was a run, so a narrow screen showed nothing at all until the first
    // question was already away -- which is the one moment the mark is no use.
    expect(HOME).not.toMatch(/\(loading \|\| runStopped \|\| answer\) && \(<div className="trace-summary"/);
    expect(HOME).toMatch(/\n {10}<div className="trace-summary">/);
    expect(HOME).toMatch(/<\/section>\n\n {6}<aside className="trace-inspector">/);
    // And it draws something in every state, including before the check lands.
    for (const readiness of ['checking', 'ready', 'unreachable', 'unchecked'] as const) {
      expect(draw(idle(readiness)), readiness).toContain('class="run-status');
    }
  });

  it('says Ready only when the endpoint itself answered', () => {
    // `ok` on this check is the app having POSTed to the endpoint's invocations
    // path and got a reply, under the credential the question will use. It is the
    // whole of what entitles this word to be on screen.
    expect(agentReadinessFrom(report({ status: 'ok' }))).toBe('ready');
    const pill = idle('ready');
    expect(pill.label).toBe('Ready');
    expect(pill.tone).toBe('is-ready');
    expect(draw(pill)).toContain('Ready');
  });

  it('does not call an endpoint that refused a green Ready', () => {
    expect(agentReadinessFrom(report({ status: 'failed' }))).toBe('unreachable');
    const pill = idle('unreachable');
    expect(pill.label).toBe('Agent unreachable');
    expect(pill.tone).toBe('is-failed');
    const markup = draw(pill);
    expect(markup).not.toContain('is-ready');
    expect(markup).not.toContain('Ready');
  });

  it('does not call an endpoint nobody could ask a green Ready either', () => {
    // Four ways to end up with no answer, and none of them is health: a check
    // that did not run is not a check that passed, which is the rule the server
    // already applies to its own overall verdict.
    expect(agentReadinessFrom(report({ status: 'unverified' }))).toBe('unchecked');
    expect(agentReadinessFrom(report(null))).toBe('unchecked');
    expect(agentReadinessFrom(null)).toBe('unchecked');
    expect(agentReadinessFrom({ error: 'preflight_unavailable' })).toBe('unchecked');
    const pill = idle('unchecked');
    expect(pill.label).toBe('Agent not checked');
    expect(draw(pill)).not.toContain('is-ready');
  });

  it('does not claim anything at all while the check is still in flight', () => {
    // The state the pill is in for the first second of every page load, and the
    // one it used to skip: it said "Ready" from mount, which was a statement
    // about the browser having parsed the bundle.
    const pill = idle('checking');
    expect(pill.label).toBe('Checking agent');
    expect(pill.alive).toBe(false);
    expect(draw(pill)).not.toContain('is-ready');
  });

  it('reads the endpoint rather than a literal, so the word cannot be right by luck', () => {
    // The failure this is against is a pill that says "Ready" because somebody
    // typed it in the branch. The label for the idle screen has to come from the
    // reading, and the four readings have to produce four different pills.
    const labels = (['checking', 'ready', 'unreachable', 'unchecked'] as const).map((state) => idle(state).label);
    expect(new Set(labels).size).toBe(4);
    expect(HOME).not.toMatch(/label: 'Ready'/);
    expect(HOME).toMatch(/readiness,/);
  });
});

describe('ready and live are not the same pill', () => {
  const live = runStatusFor({
    loading: true,
    liveSteps: 8,
    runStopped: false,
    awaitingApproval: false,
    asked: false,
    answered: false,
    readiness: 'ready',
  });

  it('says a different word in a different colour', () => {
    // Two digits, out of the same `stepNumber` the rail beneath it numbers its
    // cards with: the badge and the card it points at should read as the same
    // figure rather than as "8" above "08".
    expect(live.label).toBe('Live · step 08');
    expect(live.tone).toBe('is-live');
    expect(idle('ready').tone).toBe('is-ready');
    expect(draw(live)).not.toEqual(draw(idle('ready')));
  });

  it('breathes in each pill’s own colour, from one animation rather than two', () => {
    // The dot takes `currentcolor` from whichever family the pill is wearing --
    // white on the live solid, the positive family's own ink on the green -- and
    // the keyframes touch no colour at all, so extending the pulse to the second
    // pill added no second animation and needed no per-tone dot rule.
    expect([...RAIL_CSS.matchAll(/@keyframes run-status-breath/g)]).toHaveLength(1);
    expect([...RAIL_CSS.matchAll(/animation: run-status-breath/g)]).toHaveLength(1);
    expect(RAIL_CSS).toMatch(/\.run-status\.is-alive \.run-status-dot \{[^}]*animation: run-status-breath/);
    expect(RAIL_CSS).toMatch(/\.run-status-dot \{[^}]*background: currentcolor/);
    expect(draw(live)).toContain('is-live is-alive');
    expect(draw(idle('ready'))).toContain('ast-pill--pos is-ready is-alive');
  });

  it('moves nothing that would change what either label is measured against', () => {
    // The live pill's white word is 4.72:1 on #2272B4 and the green pill's is
    // 4.95:1. Breathing either fill would swing a number neither has much room
    // on, so only the dots move, and they move in opacity and transform --
    // neither of which is a colour.
    const frames = RAIL_CSS.match(/@keyframes run-status-breath \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(frames).not.toMatch(/background|color|border/);
    expect(frames).toMatch(/opacity|transform/);
    for (const rule of [
      RAIL_CSS.match(/\.run-status\.is-live \{([^}]*)\}/)?.[1] ?? '',
      partial('astrolabe-tokens.css').match(/\.ast-pill--pos \{([^}]*)\}/)?.[1] ?? '',
    ]) {
      expect(rule, 'a tone is a fill, not an animation').not.toMatch(/animation/);
      expect(rule, 'a tone is stated at all').not.toBe('');
    }
    // §4: "Ready (green) or Live (solid blue #2272B4) pill". The fill was orange
    // and the argument for it was that a mass meaning "working, right now" was
    // what the token was for; §2 removes orange from the palette, so there is no
    // token left to spend. `--ast-blue` rather than `--db-blue-600`: same value,
    // and the astrolabe spelling is the one this rebuild is checked against.
    expect(RAIL_CSS).toMatch(/\.run-status\.is-live \{[^}]*background: var\(--ast-blue\)/);
    expect(RAIL_CSS).not.toMatch(/\.run-status\.is-live \{[^}]*--db-orange/);
    // Green is the shared recipe's positive family rather than a wash this
    // stylesheet names for itself, which is the whole of the migration.
    expect(RUN_TONE_FAMILY['is-ready']).toBe('ast-pill--pos');
    expect(partial('astrolabe-tokens.css')).toMatch(/\.ast-pill--pos \{[^}]*background: var\(--ast-pos-fill\)/);
  });

  it('stops the moment the run does, and does not let a finished one keep pulsing', () => {
    // `is-alive` is not a restatement of a tone, and this is why it cannot be
    // one: "Complete" wears `is-ready` too, and a finished run whose dot went on
    // breathing would be claiming the harness was still doing something.
    const done = runStatusFor({
      loading: false,
      liveSteps: 21,
      runStopped: false,
      awaitingApproval: false,
      asked: false,
      answered: true,
      readiness: 'ready',
    });
    expect(done.label).toBe('Complete');
    expect(done.tone).toBe('is-ready');
    expect(done.alive).toBe(false);
    expect(draw(done)).not.toContain('is-alive');
    expect(draw(done)).not.toContain('Live');
  });

  it('leaves every state that is merely waiting perfectly still', () => {
    for (const still of [
      idle('checking'),
      idle('unreachable'),
      idle('unchecked'),
      runStatusFor({
        loading: false,
        liveSteps: 0,
        runStopped: true,
        awaitingApproval: false,
        asked: false,
        answered: false,
        readiness: 'ready',
      }),
      runStatusFor({
        loading: false,
        liveSteps: 0,
        runStopped: false,
        awaitingApproval: true,
        asked: true,
        answered: false,
        readiness: 'ready',
      }),
    ]) {
      expect(still.alive, still.label).toBe(false);
      expect(draw(still), still.label).not.toContain('is-alive');
    }
  });

  it('lets a run that has landed outrank a reading taken when the page opened', () => {
    // The readiness is a reading of one moment and is never refreshed. A run that
    // has since answered is later evidence about the same endpoint, so it must
    // not be possible for a stale `unreachable` to caption a finished answer.
    const after = runStatusFor({
      loading: false,
      liveSteps: 0,
      runStopped: false,
      awaitingApproval: false,
      asked: false,
      answered: true,
      readiness: 'unreachable',
    });
    expect(after.label).toBe('Complete');
    expect(after.tone).toBe('is-ready');
  });
});

describe('a run that stopped says where it stopped, and only what it knows', () => {
  const stopped = (steps: { liveSteps: number; runningStep?: number }) =>
    runStatusFor({
      loading: false,
      runStopped: true,
      awaitingApproval: false,
      asked: false,
      answered: false,
      readiness: 'ready',
      ...steps,
    });

  it('names the step it was inside when the endpoint said which', () => {
    // The design's own wording, and it is finally true: the endpoint announces a
    // step when it starts, so the step a failure interrupted is known by name and
    // number rather than being the one nobody heard about.
    expect(stopped({ liveSteps: 7, runningStep: 7 }).label).toBe('Failed at step 07');
    expect(stopped({ liveSteps: 7, runningStep: 7 }).tone).toBe('is-failed');
    expect(stopped({ liveSteps: 7, runningStep: 7 }).alive).toBe(false);
  });

  it('says how far it got when it does not', () => {
    // TWO WAYS TO GET HERE AND BOTH ARE REAL. A run can die in the gap between one
    // step finishing and the next being announced, and a model version that
    // reports only completions never announces at all -- which is every run
    // against the deployed endpoint until it is re-logged. In both, NN under
    // "Failed at" would name the last step that WORKED.
    expect(stopped({ liveSteps: 6 }).label).toBe('Stopped after step 06');
    expect(stopped({ liveSteps: 6, runningStep: 0 }).label).toBe('Stopped after step 06');
    // And a run that stopped before it reported anything names no step at all.
    expect(stopped({ liveSteps: 0 }).label).toBe('Stopped');
  });

  it('marks the step in progress in the live badge as well, and counts it', () => {
    // "Live · step 07" over a card numbered 07, where 07 is the step being worked
    // on rather than the last one finished. The fallback is the frontier, which is
    // the same number: the announced row is the last row in the list.
    const inside = runStatusFor({
      loading: true,
      liveSteps: 7,
      runningStep: 7,
      runStopped: false,
      awaitingApproval: false,
      asked: false,
      answered: false,
      readiness: 'ready',
    });
    expect(inside.label).toBe('Live · step 07');
    expect(inside.alive).toBe(true);
    // Between steps, and against a model that announces nothing, it counts the
    // steps that have been reported -- which is what this badge said before.
    const between = runStatusFor({
      loading: true,
      liveSteps: 6,
      runStopped: false,
      awaitingApproval: false,
      asked: false,
      answered: false,
      readiness: 'ready',
    });
    expect(between.label).toBe('Live · step 06');
  });

  it('counts the run’s newest step rather than an envelope that opened at step 01', () => {
    /*
     * THE REPORTED DEFECT, on this badge: "Live · step 01" for a whole run.
     *
     * A run announces `orchestrator` before it does anything and reports it only at
     * the end, so the step-in-progress reading can name step 01 while seven steps
     * are on screen. The later of the two readings is the newest step either way,
     * which is also what the band beside this pill marks -- the two cannot disagree
     * about which step the reader is waiting on.
     */
    const envelope = runStatusFor({
      loading: true,
      liveSteps: 7,
      runningStep: 1,
      runStopped: false,
      awaitingApproval: false,
      asked: false,
      answered: false,
      readiness: 'ready',
    });
    expect(envelope.label).toBe('Live · step 07');
  });
});

describe('the pill under a reduced-motion preference, and to a screen reader', () => {
  it('holds the dot still and resets it, for the green pill as well as the orange', () => {
    // One guard, because there is one animation. Reset as well as stopped: an
    // animation removed mid-cycle leaves the dot at whatever the last computed
    // frame was, which can be the 55% trough -- a dot that looks half switched
    // off for as long as the screen is open.
    const guard = RAIL_CSS.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(guard).toContain('.run-status.is-alive .run-status-dot');
    expect(guard).toMatch(/animation: none/);
    expect(guard).toMatch(/opacity: 1/);
    expect(guard).toMatch(/transform: none/);
  });

  it('leaves both pills readable without the motion', () => {
    // Nothing is lost by stopping it. The live pill counts its steps in words,
    // and the ready one is a word that only appears once an endpoint has
    // answered for it -- both are changes over time that need no motion.
    expect(idle('ready').label).toBe('Ready');
    expect(idle('checking').label).not.toBe(idle('ready').label);
  });

  it('announces each pill once, without a second region beside it', () => {
    const markup = draw(idle('ready'));
    expect([...markup.matchAll(/role="status"/g)]).toHaveLength(1);
    expect(markup).toContain('aria-atomic="true"');
    // The dot is decoration and is never spoken: the word carries the state.
    expect(markup).toMatch(/<span class="run-status-dot" aria-hidden="true">/);
  });

  it('does not re-announce a state that has not changed', () => {
    // A live region speaks when its text changes. The elapsed clock re-renders
    // this page several times a second, so the property that keeps a settled
    // "Ready" silent is that the same inputs produce the same string.
    expect(draw(idle('ready'))).toEqual(draw(idle('ready')));
  });
});
