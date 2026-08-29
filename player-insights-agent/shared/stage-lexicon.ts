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

type ReaderStage = {
  id: string;
  name: string;
  kind: string;
  status: 'complete' | 'partial' | 'failed' | 'running';
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
  if (MODEL_STEP_ID.test(stage.id)) return READER_STAGE_TASKS.reasoning;
  return stage.input;
}

function projectOutput(stage: ReaderStage): string {
  if (typeof stage.output !== 'string' || !stage.output) return '';
  if (stage.id === 'data_source_finder') {
    if (stage.status === 'failed') return 'Governed data discovery could not complete.';
    if (stage.status === 'partial' || stage.status === 'running') {
      return 'Governed data discovery ended with unresolved gaps.';
    }
    if (stage.output.includes('## DATA OVERVIEW')) {
      return 'Identified the governed data available for this question.';
    }
    return 'Prepared an assessed data package from governed sources.';
  }
  if (stage.id === 'attachment') return 'Bounded attachment context was available to this run.';
  if (MODEL_STEP_ID.test(stage.id)) {
    const calls = stage.output
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (
      calls.length > 0 &&
      calls.length === stage.output.split(',').length &&
      calls.every((item) => /^[a-z_][a-z0-9_]*$/.test(item))
    ) {
      return calls.join(', ');
    }
    return stage.status === 'failed'
      ? 'The reasoning step did not complete.'
      : 'Prepared assessed findings from governed sources.';
  }
  const tool = toolNameFromStageId(stage.id);
  if (tool || stage.id === 'inventory') return projectToolOutput(stage.output, tool || 'list_data_assets');
  return stage.output;
}

/** Apply the allowlisted projection without changing unrelated stage fields. */
export function projectReaderStage<T extends ReaderStage>(stage: T): T {
  const input = projectInput(stage);
  const output = projectOutput(stage);
  return input === stage.input && output === stage.output ? stage : { ...stage, input, output };
}
