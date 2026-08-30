/**
 * Reader-facing trace copy.
 *
 * A model transcript may contain operating or safety instructions. A stage is a
 * separate allowlisted projection: compact task copy, concrete tool I/O, and a
 * result a reader can inspect. This adapter is also applied to legacy stored
 * traces, so old runs improve without a data migration.
 */

export const DATA_SOURCE_FINDER_TASK = 'Identify the governed data available for this question.';

export const READER_STAGE_TASKS = {
  attachment: 'Include the bounded attachment context supplied with this question.',
  data_source_finder: DATA_SOURCE_FINDER_TASK,
  reasoning: 'Choose the next governed data operation for this question.',
  synthesis: 'Prepare the final answer from assessed findings.',
} as const;

export type ReaderStageStatus = 'complete' | 'partial' | 'failed' | 'running' | 'cancelled' | 'awaiting_approval';

type ReaderStage = {
  id: string;
  name: string;
  kind: string;
  status: ReaderStageStatus;
  input: string;
  output: string;
};

const TOOL_STAGE_ID = /^step-\d+-\d+-(.+)$/;
const MODEL_STEP_ID = /^step-\d+$/;
const TOOL_OUTPUT_NOTES = [
  'Asked together with the other definition questions in this step,',
  'Already asked in this run.',
] as const;
const ERROR_INSTRUCTION_MARKERS = [
  '. Do not ',
  '. Do NOT ',
  '. Report this ',
  '. Call ',
  '. Ask ',
  '. Answer ',
  '. This is an outage',
] as const;

type FallbackFamily = 'data_source_finder' | 'attachment' | 'reasoning';

const IDENTIFIED_DATA_OUTPUT = 'Identified the governed data available for this question.';
const STAGE_FALLBACKS: Record<ReaderStageStatus, Record<FallbackFamily, string>> = {
  running: {
    data_source_finder: 'Governed data discovery is in progress.',
    attachment: 'Bounded attachment context is being reviewed.',
    reasoning: 'Reasoning is in progress.',
  },
  complete: {
    data_source_finder: 'Prepared an assessed data package from governed sources.',
    attachment: 'Bounded attachment context was available to this run.',
    reasoning: 'Prepared assessed findings from governed sources.',
  },
  failed: {
    data_source_finder: 'Governed data discovery could not complete.',
    attachment: 'Bounded attachment context could not be reviewed.',
    reasoning: 'The reasoning step did not complete.',
  },
  cancelled: {
    data_source_finder: 'Governed data discovery was cancelled before completion.',
    attachment: 'Bounded attachment review was cancelled before completion.',
    reasoning: 'The reasoning step was cancelled before completion.',
  },
  awaiting_approval: {
    data_source_finder: 'Governed data discovery is awaiting approval.',
    attachment: 'Bounded attachment context is awaiting approval.',
    reasoning: 'The reasoning step is awaiting approval.',
  },
  partial: {
    data_source_finder: 'Governed data discovery ended with unresolved gaps.',
    attachment: 'Bounded attachment context was only partially reviewed.',
    reasoning: 'The reasoning step ended with partial findings.',
  },
};

/** Canonicalize the statuses carried by live, replayed, and platform traces. */
export function normalizeReaderStageStatus(value: unknown): ReaderStageStatus {
  const status =
    typeof value === 'string'
      ? value
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, '_')
      : '';
  if (['complete', 'completed', 'succeeded', 'success', 'answered'].includes(status)) return 'complete';
  if (['partial', 'truncated', 'skipped'].includes(status)) return 'partial';
  if (['failed', 'error', 'refused', 'timed_out', 'timeout'].includes(status)) return 'failed';
  if (['running', 'in_progress', 'pending', 'queued'].includes(status)) return 'running';
  if (['cancelled', 'canceled', 'interrupted', 'aborted'].includes(status)) return 'cancelled';
  if (status === 'awaiting_approval') return 'awaiting_approval';
  return 'complete';
}

function stageFallback(stage: ReaderStage, output: string, family: FallbackFamily): string {
  const value = output.trim();
  const fallback = STAGE_FALLBACKS[stage.status][family];
  if (value === fallback) return value;
  if (family === 'data_source_finder' && stage.status === 'complete') {
    if (value === IDENTIFIED_DATA_OUTPUT || output.includes('## DATA OVERVIEW')) return IDENTIFIED_DATA_OUTPUT;
  }
  return fallback;
}

function toolNameFromStageId(id: string): string {
  return TOOL_STAGE_ID.exec(id)?.[1] ?? '';
}

/**
 * Remove only runtime-generated model guidance from a tool result.
 *
 * Successful output is returned byte-for-byte. This intentionally does not scan
 * arbitrary prose for words such as "must" or "never", so a user's question or
 * a governed value containing those words is not rewritten.
 */
function projectSemanticOutput(value: string): string {
  if (value.startsWith('SEMANTIC SEARCH UNAVAILABLE')) {
    return value.split(' This is discovery, not data', 1)[0]?.trim() ?? '';
  }
  return value
    .split('\n\n')
    .map((paragraph) => paragraph.trim())
    .filter(
      (paragraph) =>
        paragraph &&
        !paragraph.startsWith('SEMANTIC SEARCH RESULTS.') &&
        !paragraph.startsWith('What appears above was filtered by a cached snapshot')
    )
    .map((paragraph) => {
      if (paragraph.startsWith('No semantic entries matched.')) return 'No semantic entries matched.';
      return paragraph.split(' Search again with a narrower question', 1)[0]?.trim() ?? '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function projectNamedToolOutput(value: string, tool: string): string {
  if (tool === 'search_semantics') return projectSemanticOutput(value);
  if (tool === 'list_data_assets') {
    return value
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('Access note:'))
      .join('\n')
      .trim();
  }
  if (tool === 'search_tagged_assets') {
    if (value.startsWith('TAG SEARCH UNAVAILABLE')) {
      return value.split(' This is discovery, not data', 1)[0]?.trim() ?? '';
    }
    return value.split(' Use list_data_assets', 1)[0]?.trim() ?? '';
  }
  if (tool === 'resolve_table' && value.startsWith('AMBIGUOUS:')) {
    const [heading, remainder = ''] = value.split('. Do not ', 2);
    const listed = remainder.includes(':\n') ? remainder.split(':\n').slice(1).join(':\n') : '';
    return `${heading}.\n${listed}`.trim();
  }
  if (tool === 'describe_table') {
    for (const marker of ['. Call resolve_table', '. That is definitive:']) {
      if (value.includes(marker)) return `${value.split(marker, 1)[0]?.trim()}.`;
    }
  }
  if (tool === 'dictionary_genie' && value.includes('Definition note:')) {
    return value
      .split(/\r?\n/)
      .map((line) =>
        line.startsWith('Definition note:')
          ? "The dictionary space answered without reading the dictionary table; this is the space's account, not a governed entry."
          : line
      )
      .join('\n')
      .trim();
  }
  return value;
}

export function projectToolOutput(text: string, tool = ''): string {
  const value = text.trim();
  if (!value) return '';
  if (TOOL_OUTPUT_NOTES.some((lead) => value.startsWith(lead))) {
    return value.includes('\n\n') ? value.split('\n\n').slice(1).join('\n\n').trim() : '';
  }
  if (value.startsWith('REFUSED:')) return value.split('\n\n', 1)[0]?.trim() ?? '';
  if (!value.startsWith('ERROR:')) return projectNamedToolOutput(text, tool);

  const first = value.split('\n\n', 1)[0]?.trim() ?? '';
  let cut = first.length;
  for (const marker of ERROR_INSTRUCTION_MARKERS) {
    const at = first.indexOf(marker);
    if (at >= 0) cut = Math.min(cut, at + 1);
  }
  return first.slice(0, cut).trim();
}

function projectInput(stage: ReaderStage): string {
  if (typeof stage.input !== 'string' || !stage.input) return '';
  if (stage.id === 'data_source_finder') return READER_STAGE_TASKS.data_source_finder;
  if (stage.id === 'attachment') return READER_STAGE_TASKS.attachment;
  if (stage.id === 'synthesis') return READER_STAGE_TASKS.synthesis;
  if (MODEL_STEP_ID.test(stage.id) && stage.kind !== 'tool') return READER_STAGE_TASKS.reasoning;
  return stage.input;
}

function projectOutput(stage: ReaderStage): string {
  const output = typeof stage.output === 'string' ? stage.output : '';
  if (stage.id === 'data_source_finder') {
    return stageFallback(stage, output, 'data_source_finder');
  }
  if (stage.id === 'attachment') return stageFallback(stage, output, 'attachment');
  if (MODEL_STEP_ID.test(stage.id) && stage.kind !== 'tool') {
    const calls = output
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (
      calls.length > 0 &&
      calls.length === output.split(',').length &&
      calls.every((item) => /^[a-z_][a-z0-9_]*$/.test(item))
    ) {
      return calls.join(', ');
    }
    return stageFallback(stage, output, 'reasoning');
  }
  if (!output) return '';
  const tool = toolNameFromStageId(stage.id);
  if (tool || stage.id === 'inventory') return projectToolOutput(output, tool || 'list_data_assets');
  return output;
}

/** Apply the allowlisted projection without changing unrelated stage fields. */
export function projectReaderStage<T extends ReaderStage>(stage: T): T {
  const input = projectInput(stage);
  const output = projectOutput(stage);
  return input === stage.input && output === stage.output ? stage : { ...stage, input, output };
}
