/**
 * What the ask route serves when the agent replied in prose and nothing else.
 *
 * THIS USED TO BE THE DEMO ANSWER WITH NEW WORDS ON TOP. The endpoint returns a
 * text output item and no result contract, the route kept the agent's sentences
 * and filled the figures, charts, sources, SQL and stage timings from the app's
 * own stored demo answer, then labelled the whole thing `provenance: 'mixed'`
 * with a caveat saying which half was borrowed. Both labels were accurate and
 * neither was a control: the numbers were still on the screen, underneath a
 * narrative about the reader's own business, and a reader who has been told the
 * figures are illustrative still reads the figure. It is the same finding
 * `agent/tools.py` records about Genie prose, and the same one that made an
 * identity refusal readable as an answer with the demo dataset attached.
 *
 * So there is no scaffold now. The prose is kept, because it is the agent's own
 * work and the reader asked for it, and everything that would have been
 * invented around it is empty.
 *
 * WHY THIS IS NOT `NO_VALID_EVIDENCE`. That code means a run read nothing it
 * was allowed to use, and the agent is the only thing that can observe it:
 * `agent.py` replaces the body with its own unanswered text when
 * `no_evidence_survived` and returns a normal result contract, which reaches the
 * route as a structured answer and never comes near here. A prose reply tells
 * this app one thing only, which is that no result contract arrived. Reporting
 * that as an evidence failure would be a surface asserting a finding it did not
 * make, which is the class of bug this workstream is removing rather than a new
 * instance of it.
 */
import { DEGRADED_ANSWER_MARKER } from './setup-remedies';

/**
 * Said above the answer, in red, rather than fifth under "What to keep in mind".
 *
 * Carries `DEGRADED_ANSWER_MARKER` because the client lifts those out of the
 * caveat list, and the sentence has to do the work `provenance` cannot: a
 * reader looking at a narrative with no figures under it cannot tell "the agent
 * had nothing to show" from "this app dropped them".
 */
export const PROSE_ONLY_ANSWER_CAVEAT =
  `${DEGRADED_ANSWER_MARKER} the agent replied in prose rather than with a result, so the words above ` +
  'are its own and there are no figures, sources, SQL or stage timings under them. Nothing has been ' +
  'put in their place: this app shows what came back and does not complete an answer from anything ' +
  'stored.';

/**
 * The takeaway when the prose opens with nothing usable as one.
 *
 * A statement about the shape of the reply, deliberately, and not a statement
 * about data. Anything with a subject from the question in it would be this
 * module writing a finding.
 */
export const PROSE_ONLY_FALLBACK_TAKEAWAY = 'The agent answered in prose, without a structured result.';

/** How much of the first line is used as the takeaway. */
const TAKEAWAY_LIMIT = 220;

export interface ProseOnlyAnswer {
  id: string;
  takeaway: string;
  narrative: string;
  content: string;
  figures: never[];
  charts: never[];
  sources: never[];
  caveats: string[];
  /**
   * Empty for the same reason `sql` is empty: no statement ran on this path, so
   * there is no source, metric, window or filter to name. Typed `never[]` so it
   * cannot later be filled from anywhere but a statement.
   */
  derivation: never[];
  sql: string;
  trace: {
    id: string;
    totalMs: number;
    toolCalls: number;
    stages: never[];
    // OMITTED RATHER THAN ZEROED. They were zero here, under a comment conceding
    // that zero meant "not measured on this path", which is a distinction the
    // renderers could not see: they read a number and printed it, so this path
    // reported a model that read nothing and wrote nothing. The schema no longer
    // defaults them, so leaving them out is now sayable and is what is true.
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * The agent's prose, with empty evidence, and no id it did not earn.
 *
 * `trace.id` is empty rather than minted. `mlflowReference` and
 * `discloseAnswerProvenance` both read that field to decide whether a run is
 * addressable, and a synthesised `trace-<timestamp>` (which is what the demo
 * scaffold supplied here) hands a reader a correlation id that finds nothing in
 * MLflow. `totalMs` and `toolCalls` are zero for the same reason: this path
 * measures nothing it can attribute to the run, and the streamed stages went to
 * the browser rather than into a list this route holds. The token counts are left
 * OUT rather than set to zero, because a reader cannot tell a metered zero from an
 * unmetered one and the renderers printed the zero as a measurement.
 */
export function proseOnlyAnswer(id: string, prose: string): ProseOnlyAnswer {
  const firstLine = prose.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  return {
    id,
    takeaway: firstLine ? firstLine.slice(0, TAKEAWAY_LIMIT) : PROSE_ONLY_FALLBACK_TAKEAWAY,
    narrative: prose,
    content: '',
    figures: [],
    charts: [],
    sources: [],
    caveats: [PROSE_ONLY_ANSWER_CAVEAT],
    derivation: [],
    sql: '',
    trace: {
      id: '',
      totalMs: 0,
      toolCalls: 0,
      stages: [],
    },
  };
}

/**
 * The four sections of an answer a reader would read as evidence.
 *
 * Every field optional and everything else on the object ignored, so this can
 * be asked of a full answer, a stored row missing keys that postdate it, or a
 * partial parse, without any of the three needing to be widened to fit.
 */
export interface AnswerEvidenceSections {
  figures?: unknown[];
  sources?: unknown[];
  sql?: string;
  /**
   * Widened deliberately. Callers pass the whole answer, and every one of them
   * declares a slightly different trace type; naming a structural one here just
   * moves the friction to a cast at each call site, which is where a widening
   * stops being reviewed.
   */
  trace?: unknown;
}

/**
 * Whether an answer carries anything a reader would read as evidence.
 *
 * Used by the disclosure that marks answers whose figures did not come from a
 * traced run: an answer with no figures, no sources, no SQL and no stages has
 * nothing for that caveat to be about, and adding it would tell a reader the
 * numbers came from a stored demo response when there are no numbers.
 */
export function carriesEvidence(answer: AnswerEvidenceSections): boolean {
  return (
    (answer.figures?.length ?? 0) > 0 ||
    (answer.sources?.length ?? 0) > 0 ||
    Boolean(answer.sql?.trim()) ||
    stageCount(answer.trace) > 0
  );
}

function stageCount(trace: unknown): number {
  if (!trace || typeof trace !== 'object') return 0;
  const stages = (trace as { stages?: unknown }).stages;
  return Array.isArray(stages) ? stages.length : 0;
}
