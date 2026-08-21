/**
 * The stages a question passes through, and the sections the answer comes back
 * in.
 *
 * WHY THIS FILE EXISTS. The Architecture page's "Answer path" rail was four
 * hand-written rows in the page component, and it described the run the agent
 * performed before the chain was reworked: browser, orchestrator, warehouse,
 * browser. It said nothing about the approval plan that now runs before anything
 * is read, nothing about the Data Source Finder's step loop or the three bounds
 * that stop it, and nothing about synthesis and charts being separate stages that
 * can be cut for budget. A reader comparing the rail against a run in the Run
 * Explorer saw different stage names in the two places.
 *
 * So the stages are data rather than markup, named as the agent's own spans name
 * them. `stage` on each row is the literal MLflow stage id the trace carries --
 * `data_source_finder`, `synthesis`, `plot` -- so a reader can hold this page and
 * a trace side by side and match them line for line. If a stage is renamed in
 * agent.py, the mismatch is visible here rather than being a caption that quietly
 * became wrong.
 *
 * THIS IS A DESCRIPTION AND NOT A CONTROL. Nothing here decides anything: the
 * loop is bounded by the runtime settings the agent reads per request, and the
 * answer's shape is `AnswerContract` in agent/contracts.py. What is written here
 * is what those two do, in the order they do it.
 */
import type { ArchitectureAccent } from './architecture-layout';

/** Which runtime setting bounds a stage, where one does. */
export type ChainBound = 'maxSteps' | 'maxToolCalls' | 'maxRunSeconds';

/**
 * One stage of a run.
 *
 * `optional` is the interesting field. Three of these do not run on every
 * question -- the plan only for a question worth approving, the attachment stage
 * only when a file was uploaded, the charts only when charts are on and there is
 * budget left -- and a rail that draws six rows for a run that had three is a
 * rail that will be read as a fault. It is stated per row rather than left to the
 * prose.
 */
export interface ChainStage {
  /** The MLflow stage id, as the trace carries it. */
  stage: string;
  title: string;
  body: string;
  accent: ArchitectureAccent;
  /** The word on the row's badge, where the row earns one. */
  badge?: string;
  /** What passes to the next stage, drawn on the arrow between the rows. */
  passes?: string;
  optional?: boolean;
  bound?: ChainBound;
}

/**
 * The chain, in order.
 *
 * Taken from `_turn` in agent/agent.py, which opens these spans in this sequence.
 * The plan gate is first because it can end the turn on its own: a question the
 * agent judges nontrivial comes back as a plan to approve and reads nothing at
 * all until somebody presses approve. That is the stage the old rail was most
 * wrong about -- it had the run going straight from the app to the orchestrator,
 * so the plan card a reader sees on their first real question appeared to come
 * from nowhere in the diagram.
 */
export const AGENT_CHAIN: readonly ChainStage[] = [
  {
    stage: 'plan',
    title: 'Plan, before anything is read',
    body:
      'A question worth approving comes back as a plan of what would be read, and the turn ends there. ' +
      'Nothing is queried until it is approved.',
    accent: 'question',
    badge: 'Approval',
    passes: 'approved plan',
    optional: true,
  },
  {
    stage: 'attachment',
    title: 'Attachment context',
    body: 'An uploaded file is summarised into a bounded block of context the rest of the run can cite.',
    accent: 'question',
    passes: 'question and context',
    optional: true,
  },
  {
    stage: 'orchestrator',
    title: 'Orchestrator owns the run',
    body:
      'One parent stage around everything below it. It holds the run budget, delegates discovery, and is the only ' +
      'thing that writes the final answer.',
    accent: 'agent',
    passes: 'one discovery request',
    bound: 'maxRunSeconds',
  },
  {
    stage: 'data_source_finder',
    title: 'Data Source Finder, one step at a time',
    body:
      'A bounded tool-calling loop. Each step asks the model which governed tools to call next, runs them, and ' +
      'either declares the findings prepared or takes another step. Dictionary terms are resolved before anything ' +
      'is measured.',
    accent: 'agent',
    badge: 'Bounded loop',
    passes: 'findings and evidence',
    bound: 'maxSteps',
  },
  {
    stage: 'step-N',
    title: 'Each step, and what stops it',
    body:
      'Steps run until the findings are ready or a bound is reached. On any cap the loop stops calling tools and ' +
      'answers from what it already has, rather than failing.',
    accent: 'agent',
    passes: 'gathered evidence',
    bound: 'maxToolCalls',
  },
  {
    stage: 'synthesis',
    title: 'Synthesis writes the answer',
    body:
      'The takeaway, the narrative, the figures and the caveats are written from the findings and nowhere else. ' +
      'Every figure carries the source, metric and window it came from.',
    accent: 'agent',
    passes: 'answer sections',
  },
  {
    stage: 'plot',
    title: 'Charts, if there is budget',
    body:
      'Charts are built last from evidence that can be plotted, so a run that is out of time returns the answer ' +
      'without them rather than returning nothing.',
    accent: 'genie',
    passes: 'answer contract',
    optional: true,
  },
];

/**
 * The three bounds, with the label the Settings pane puts on each.
 *
 * THE WORDING IS THE SETTINGS PANE'S, DELIBERATELY. A reader who sees "Max DSF
 * steps" here and wants to change it should find that exact string in the gear,
 * and a second phrasing for the same number is a second thing to search for. The
 * keys are `RuntimeSettings['loop']`'s own.
 */
export const CHAIN_BOUND_LABEL: Readonly<Record<ChainBound, string>> = {
  maxSteps: 'Max DSF steps',
  maxToolCalls: 'Max tool calls',
  maxRunSeconds: 'Run budget (s)',
};

/** The order the bounds are read across in the strip. */
export const CHAIN_BOUNDS: readonly ChainBound[] = ['maxSteps', 'maxToolCalls', 'maxRunSeconds'];

/**
 * What a bound does, for the tile's tooltip.
 *
 * One sentence each, and each one says what happens when the bound is REACHED
 * rather than restating the label as prose. "Caps the number of steps" tells a
 * reader nothing they did not get from "Max DSF steps"; what they cannot see is
 * that hitting it produces an answer rather than an error.
 */
export const CHAIN_BOUND_NOTE: Readonly<Record<ChainBound, string>> = {
  maxSteps: 'How many times the Data Source Finder may choose a next step. At the cap it answers from what it has.',
  maxToolCalls: 'How many governed tool calls one run may make in total, across every step.',
  maxRunSeconds: 'How long the orchestrator may spend before it stops gathering and writes the answer.',
};

/**
 * One section of the answer contract.
 *
 * `field` is the wire name from `AnswerContract` in agent/contracts.py, which is
 * the point of listing them: the app renders these, the agent fills them, and the
 * two have disagreed before. `derivation` is the one worth knowing about -- it is
 * called provenance everywhere a person discusses it and `derivation` on the
 * wire, and somebody reading a raw trace for the first time will look for the
 * wrong key.
 */
export interface AnswerSection {
  field: string;
  label: string;
  body: string;
  /** Whether the Settings pane can switch this section off. */
  optional?: boolean;
}

/**
 * The answer contract, in the order the card draws it.
 *
 * NOT EVERY FIELD. `id`, `trace` and `sql` are on the contract and are not in
 * this list, because they are not sections of an answer a reader reads -- they
 * are what the Run Explorer opens. This is the shape of the answer, which is what
 * the Architecture page is being asked to state.
 */
export const ANSWER_CONTRACT: readonly AnswerSection[] = [
  {
    field: 'takeaway',
    label: 'Takeaway',
    body: 'One finding, first, in a sentence.',
    optional: true,
  },
  {
    field: 'narrative',
    label: 'Narrative',
    body: 'The prose that explains the finding.',
    optional: true,
  },
  {
    field: 'figures',
    label: 'Figures',
    body: 'The numbers, each with the comparison it is against.',
    optional: true,
  },
  {
    field: 'charts',
    label: 'Charts',
    body: 'Plotly figures, built only from evidence already gathered.',
    optional: true,
  },
  {
    field: 'derivation',
    label: 'Derivation',
    body: 'Per-statement source, metric, window and filter. Never optional, and never invented.',
  },
  {
    field: 'sources',
    label: 'Sources',
    body: 'The tables read, under the reader\u2019s own Unity Catalog grants.',
  },
  {
    field: 'caveats',
    label: 'Caveats',
    body: 'What the answer does not cover.',
    optional: true,
  },
];
