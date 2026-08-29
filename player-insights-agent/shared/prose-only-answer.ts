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
import { isMlflowTraceId } from './mlflow-trace-id';
import { takeawayWhenTablesLanded, UNANSWERED_LINE } from './run-verdict';
import { DEGRADED_ANSWER_MARKER } from './setup-remedies';
import { projectReaderStage } from './stage-lexicon';

/**
 * Said above the answer, in red, rather than fifth under "What to keep in mind".
 *
 * Carries `DEGRADED_ANSWER_MARKER` because the client lifts those out of the
 * caveat list, and the sentence has to do the work `provenance` cannot: a
 * reader looking at a narrative with no figures under it cannot tell "the agent
 * had nothing to show" from "this app dropped them".
 */
export const PROSE_ONLY_ANSWER_CAVEAT = `${DEGRADED_ANSWER_MARKER} no structured result arrived and no tool steps were recorded.`;

/**
 * The caveat when a run did take steps and still produced no result contract.
 *
 * Distinct from {@link PROSE_ONLY_ANSWER_CAVEAT}: that sentence is a lie once
 * the stream (or the ledger) recorded tool work. The count is the run's, so a
 * card can say where it stopped without inventing a finding.
 */
export function proseOnlyCaveat(stageCount: number): string {
  if (stageCount <= 0) return PROSE_ONLY_ANSWER_CAVEAT;
  const steps = stageCount === 1 ? '1 step' : `${stageCount} steps`;
  return `${DEGRADED_ANSWER_MARKER} the run stopped after ${steps} without a structured result.`;
}

/**
 * The steps a stream or ledger actually reported, merged by id and settled.
 *
 * A step arrives twice (announced, then reported). The second replaces the
 * first so the stored card has one row per id. A last row still marked
 * `running` is the step the run died inside, so it is marked failed rather
 * than left looking live on a finished card.
 */
export type RecordedStage = {
  [key: string]: unknown;
  id: string;
  name: string;
  kind: string;
  start: number;
  duration: number;
  status: 'complete' | 'running' | 'partial' | 'failed';
  calls: number;
  input: string;
  output: string;
  depth: number;
  parent_id: string;
};

function asRecordedStage(stage: Record<string, unknown>): RecordedStage {
  const status = stage.status;
  return projectReaderStage({
    ...stage,
    id: typeof stage.id === 'string' ? stage.id : '',
    name: typeof stage.name === 'string' ? stage.name : '',
    kind: typeof stage.kind === 'string' ? stage.kind : '',
    start: typeof stage.start === 'number' && Number.isFinite(stage.start) ? stage.start : 0,
    duration: typeof stage.duration === 'number' && Number.isFinite(stage.duration) ? stage.duration : 0,
    status:
      status === 'complete' || status === 'running' || status === 'partial' || status === 'failed'
        ? status
        : 'complete',
    calls: typeof stage.calls === 'number' && Number.isFinite(stage.calls) ? stage.calls : 0,
    input: typeof stage.input === 'string' ? stage.input : '',
    output: typeof stage.output === 'string' ? stage.output : '',
    depth: typeof stage.depth === 'number' && Number.isFinite(stage.depth) ? stage.depth : 0,
    parent_id: typeof stage.parent_id === 'string' ? stage.parent_id : '',
  });
}

export function foldRecordedStages(stages: readonly unknown[]): {
  stages: RecordedStage[];
  totalMs: number;
  toolCalls: number;
} {
  const folded: RecordedStage[] = [];
  for (const raw of stages) {
    if (!raw || typeof raw !== 'object') continue;
    const stage = asRecordedStage(raw as Record<string, unknown>);
    const id = stage.id;
    const at = id ? folded.findIndex((held) => held.id === id) : -1;
    if (at !== -1) folded[at] = stage;
    else folded.push(stage);
  }
  const settled = folded.map((stage, index, list) => {
    if (index === list.length - 1 && stage.status === 'running') {
      return { ...stage, status: 'failed' as const };
    }
    return stage;
  });
  return {
    stages: settled,
    totalMs: settled.reduce((sum, stage) => sum + stage.duration, 0),
    toolCalls: settled.filter((stage) => stage.kind === 'tool').length,
  };
}

/**
 * Put recorded steps onto an answer whose own trace is empty, if MLflow recorded it.
 *
 * The prose-only path used to store `stages: []` even when the stream had
 * already reported a dozen tool calls. A later reader then saw "no steps"
 * over a run they had watched fill in. Restoring those steps is still right
 * when the run has a real MLflow id. Without one, grafting them on is how a
 * live Ask drew a Gantt that could not be opened in MLflow.
 */
export function attachRecordedStages<
  T extends { trace: { id?: string; stages: unknown[]; totalMs?: number; toolCalls?: number } },
>(answer: T, recorded: readonly unknown[]): T {
  // Local stream stages without an MLflow id are exactly the split this helper
  // used to create: a Gantt that looks recorded and a Keep in mind line that
  // says it was not. The live rail can still narrate the run; the stored answer
  // may not.
  if (!isMlflowTraceId(answer.trace.id)) return answer;
  if ((answer.trace.stages?.length ?? 0) > 0 || recorded.length === 0) return answer;
  const folded = foldRecordedStages(recorded);
  return {
    ...answer,
    trace: {
      ...answer.trace,
      stages: folded.stages as T['trace']['stages'],
      totalMs: answer.trace.totalMs || folded.totalMs,
      toolCalls: answer.trace.toolCalls || folded.toolCalls,
    },
  };
}

/**
 * The takeaway when the prose opens with nothing usable as one.
 *
 * A statement about the shape of the reply, deliberately, and not a statement
 * about data. Anything with a subject from the question in it would be this
 * module writing a finding.
 */
export const PROSE_ONLY_FALLBACK_TAKEAWAY = 'The agent did not return a structured result.';

const CANNED_FIRST_LINE = [
  /^the analysis completed\b/i,
  /\bfrom assessed sources\b/i,
  /^the agent answered in prose\b/i,
];

function isCannedFirstLine(text: string): boolean {
  const value = text.trim();
  return !value || CANNED_FIRST_LINE.some((pattern) => pattern.test(value));
}

/** How much of the first line is used as the takeaway. */
const TAKEAWAY_LIMIT = 220;

/*
 * ---- The finder's package is apparatus, and it was reaching the card ----
 *
 * `agent.py` already knows this. `reader_facing_findings` splits the finder's
 * internal report into the two sections a reader is shown and the two that
 * become caveats, and drops everything else -- the `## DATA PACKAGE` heading,
 * the sources roll-call, the columns inventory, the handoff note, and the
 * scratchpad the model writes above the heading while it decides what to do.
 * Every path in the agent that hands a package to a card runs it through that.
 *
 * THIS PATH DID NOT, because it is not in the agent. When the endpoint streams
 * prose and no result contract ever arrives, the route wraps whatever text came
 * back and serves it as the answer. On a run that ended in the finder, "whatever
 * text came back" is the package, verbatim: a reader got "This question was not
 * answered." as the headline and then the model's own working notes underneath
 * it -- "Sources used", "Columns assessed", "Package note: Optional detail was
 * clipped at the DSF handoff bound" -- which reads as the answer, and reads as an
 * answer that contradicts its own headline.
 *
 * So the same split, in the same shape, on this side of the wire. The section
 * names are the agent's and are deliberately duplicated rather than imported:
 * this is a TypeScript server and that is a Python module, and the alternative
 * is a shared file neither language owns. `prose-only-answer.test.ts` asserts
 * the two lists against `agent.py`'s so a section renamed there fails here.
 */

/** The sections a reader is shown, in the order they are shown in. */
const PROSE_SECTIONS = ['Interpretation', 'Findings / data'];

/** The sections that become caveats under "What to keep in mind". */
const CAVEAT_SECTIONS = ['Caveats & rules applied', 'Gaps'];

/*
 * One `- **Name:**` lead-in. The finder is inconsistent about whether the colon
 * falls inside or outside the bold run, so both are accepted; a section's body
 * runs to the next lead-in, which is what carries a Markdown table through
 * under "Findings / data".
 */
const LEAD_IN = /^\s{0,3}[-*]\s+\*\*(?<name>[^*:]+?):?\*\*:?\s*(?<rest>.*)$/;

export interface ReaderFacingFindings {
  narrative: string;
  caveats: string[];
}

/**
 * Splits the finder's package into the prose a reader is shown and the caveats.
 *
 * Text with no recognisable lead-ins is returned as its own prose with heading
 * lines removed: that is the `## DATA OVERVIEW` and `## CLARIFICATION NEEDED`
 * shape, and an ordinary prose reply, both of which are already written for a
 * reader and have nothing in them to take out but an internal heading.
 */
export function readerFacingFindings(findings: string): ReaderFacingFindings {
  const sections: { name: string; lines: string[] }[] = [];
  const preamble: string[] = [];

  for (const line of findings.split('\n')) {
    const leadIn = LEAD_IN.exec(line);
    if (leadIn?.groups) {
      sections.push({ name: leadIn.groups.name.trim(), lines: [leadIn.groups.rest] });
    } else if (sections.length > 0) {
      sections[sections.length - 1].lines.push(line);
    } else {
      preamble.push(line);
    }
  }

  if (sections.length === 0) {
    return {
      narrative: preamble
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n')
        .trim(),
      caveats: [],
    };
  }

  const bodiesOf = (wanted: string[]): string[] => {
    const found: string[] = [];
    for (const name of wanted) {
      for (const section of sections) {
        if (section.name.toLowerCase() !== name.toLowerCase()) continue;
        const body = section.lines.join('\n').trim();
        // An empty lead-in is where the bulleted label with nothing after it
        // came from, so a section with no body is dropped rather than titled.
        if (body) found.push(body);
      }
    }
    return found;
  };

  const caveats: string[] = [];
  for (const body of bodiesOf(CAVEAT_SECTIONS)) {
    // One caveat per line: the finder writes these as its own nested bullets,
    // and the card is what makes them a list, so the markers come off.
    for (const entry of body.split('\n')) {
      const stripped = entry
        .trim()
        .replace(/^[-*]+/, '')
        .trim();
      if (stripped) caveats.push(stripped);
    }
  }

  return { narrative: bodiesOf(PROSE_SECTIONS).join('\n\n').trim(), caveats };
}

export interface ProseOnlyAnswer {
  id: string;
  takeaway: string;
  narrative: string;
  content: string;
  figures: never[];
  charts: never[];
  sources: never[];
  document_snippets: never[];
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
    stages: RecordedStage[];
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
 * MLflow. Token counts are left OUT rather than set to zero, because a reader
 * cannot tell a metered zero from an unmetered one.
 *
 * `recordedStages` is the path the stream already reported. Without it this
 * function stored an empty trace over a run that had taken many steps, and the
 * card then claimed nothing ran.
 */
export function proseOnlyAnswer(id: string, prose: string, recordedStages: readonly unknown[] = []): ProseOnlyAnswer {
  /*
   * THE TAKEAWAY IS READ OFF THE ORIGINAL AND THE NARRATIVE OFF THE SPLIT, which
   * is the one asymmetry here and it is deliberate. When a run ends in the finder
   * the first line is the agent's own verdict -- "This question was not answered."
   * -- and it sits in the preamble, which the split drops along with the rest of
   * the scratchpad. Reading the takeaway from the cleaned text would throw that
   * sentence away and leave the card headed by whatever the first surviving
   * section happened to be, which is the internal report being promoted rather
   * than removed.
   */
  const firstLine = prose
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const reader = readerFacingFindings(prose);
  const usableFirst = firstLine && !isCannedFirstLine(firstLine) ? firstLine : '';
  const usableNarrative = reader.narrative.trim();
  const rawTakeaway = usableFirst
    ? usableFirst.slice(0, TAKEAWAY_LIMIT)
    : usableNarrative && !isCannedFirstLine(usableNarrative.split('\n')[0] ?? '')
      ? usableNarrative.split('\n')[0].slice(0, TAKEAWAY_LIMIT)
      : PROSE_ONLY_FALLBACK_TAKEAWAY;
  const takeaway = UNANSWERED_LINE.test(rawTakeaway)
    ? takeawayWhenTablesLanded(rawTakeaway, usableNarrative)
    : rawTakeaway;
  let narrative = usableNarrative;
  if (isCannedFirstLine(narrative)) {
    narrative = '';
  } else if (isCannedFirstLine(narrative.split('\n')[0] ?? '')) {
    narrative = narrative.split('\n').slice(1).join('\n').trim();
  }
  const folded = foldRecordedStages(recordedStages);
  return {
    id,
    takeaway,
    narrative,
    content: '',
    figures: [],
    charts: [],
    sources: [],
    document_snippets: [],
    caveats: [proseOnlyCaveat(folded.stages.length), ...reader.caveats],
    derivation: [],
    sql: '',
    trace: {
      id: '',
      totalMs: folded.totalMs,
      toolCalls: folded.toolCalls,
      stages: folded.stages,
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
  narrative?: string;
  content?: string;
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
