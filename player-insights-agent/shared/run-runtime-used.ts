/**
 * What one Ask actually sent as runtime, for the run that used it.
 *
 * Settings is live: the next question reads today's row. A run from last week
 * has to show last week's bounds, or Monitoring and Run Explorer are describing
 * a different agent than the one that answered. Old rows stored no snapshot;
 * those read as "Not recorded" rather than as today's defaults or the bundle's.
 *
 * Extracted once. Monitoring, Run Explorer Overview, and Agent map all render
 * the chips this file names, so they cannot disagree about a budget. D13.
 */

export const RUN_RUNTIME_USED_HEADING = 'Settings applied in this run';
export const RUN_RUNTIME_USED_ABSENT = 'Not recorded';

/**
 * The Settings pane's own labels for the three loop bounds.
 *
 * Architecture's bound tiles quote the same strings (`CHAIN_BOUND_LABEL` is this
 * object). A second phrasing for Max DSF steps is a second thing to search for.
 */
export const RUN_RUNTIME_LOOP_LABEL = {
  maxSteps: 'Max DSF steps',
  maxToolCalls: 'Max tool calls',
  maxRunSeconds: 'Run budget (s)',
} as const;

/** Settings' answer-content labels, compact enough for a chip row. */
export const RUN_RUNTIME_ANSWER_LABEL = {
  takeaway: 'Takeaway',
  narrative: 'Narrative',
  figures: 'Figures',
  charts: 'Charts',
  characterCap: 'Character cap',
  figuresOrder: 'Order',
} as const;

/** Settings' figure-order option labels. */
export const RUN_RUNTIME_ORDER_LABEL = {
  'as-ranked': 'As the agent ranks them',
  'totals-first': 'Totals first',
  'averages-first': 'Averages first',
} as const;

export type RunRuntimeFiguresOrder = keyof typeof RUN_RUNTIME_ORDER_LABEL;

export interface RunRuntimeUsed {
  loop: {
    maxSteps: number | null;
    maxToolCalls: number | null;
    maxRunSeconds: number | null;
  };
  answer: {
    takeaway: boolean | null;
    narrative: boolean | null;
    figures: boolean | null;
    charts: boolean | null;
    narrativeMaxCharacters: number | null;
    figuresOrder: RunRuntimeFiguresOrder | null;
  };
}

export interface RunRuntimeUsedChip {
  key: string;
  label: string;
  value: string;
  /** False for an answer section that was switched off for this run. */
  on?: boolean;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function optionalOrder(value: unknown): RunRuntimeFiguresOrder | null {
  return value === 'as-ranked' || value === 'totals-first' || value === 'averages-first' ? value : null;
}

/**
 * The `runtime_settings` object stored on an Ask payload or a saved answer.
 *
 * Looks on the payload itself, then under `custom_inputs`, then under
 * `runtime_settings`. A stored answer writes the key at the top level; the
 * invoke body nested it. Both are the same fact.
 */
export function storedRuntimeSettings(payload: unknown): Record<string, unknown> | null {
  const record = asObject(payload);
  if (!record) return null;
  const direct = asObject(record.runtime_settings);
  if (direct) return direct;
  const inputs = asObject(record.custom_inputs);
  return inputs ? asObject(inputs.runtime_settings) : null;
}

function recorded(used: RunRuntimeUsed): boolean {
  const { loop, answer } = used;
  return [
    loop.maxSteps,
    loop.maxToolCalls,
    loop.maxRunSeconds,
    answer.takeaway,
    answer.narrative,
    answer.figures,
    answer.charts,
    answer.narrativeMaxCharacters,
    answer.figuresOrder,
  ].some((value) => value !== null);
}

/**
 * The snapshot a run stored, or null when it stored none.
 *
 * Null, not defaults. Filling in 12 / 12 / 150 (or any other current row) for a
 * run that predates this field would describe an agent that did not run.
 */
export function runRuntimeUsedFromStored(payload: unknown): RunRuntimeUsed | null {
  const raw = storedRuntimeSettings(payload);
  if (!raw) return null;
  const loop = asObject(raw.loop) ?? {};
  const answer = asObject(raw.answer) ?? {};
  const used: RunRuntimeUsed = {
    loop: {
      maxSteps: optionalInt(loop.maxSteps),
      maxToolCalls: optionalInt(loop.maxToolCalls),
      maxRunSeconds: optionalInt(loop.maxRunSeconds),
    },
    answer: {
      takeaway: optionalBool(answer.takeaway),
      narrative: optionalBool(answer.narrative),
      figures: optionalBool(answer.figures),
      charts: optionalBool(answer.charts),
      narrativeMaxCharacters: optionalInt(answer.narrativeMaxCharacters),
      figuresOrder: optionalOrder(answer.figuresOrder),
    },
  };
  return recorded(used) ? used : null;
}

function loopValue(value: number | null): string {
  return value === null ? RUN_RUNTIME_USED_ABSENT : String(value);
}

function flagValue(value: boolean): string {
  return value ? 'on' : 'off';
}

/**
 * The chips both surfaces draw, in Settings order.
 *
 * Loop bounds always, because those three are the ask. Answer flags only when
 * the snapshot actually carried them, so a loop-only row does not invent
 * Takeaway-on. Character cap 0 is Settings' "uncapped", not a missing value.
 */
export function runRuntimeUsedChips(used: RunRuntimeUsed): RunRuntimeUsedChip[] {
  const chips: RunRuntimeUsedChip[] = [
    { key: 'maxSteps', label: RUN_RUNTIME_LOOP_LABEL.maxSteps, value: loopValue(used.loop.maxSteps) },
    { key: 'maxToolCalls', label: RUN_RUNTIME_LOOP_LABEL.maxToolCalls, value: loopValue(used.loop.maxToolCalls) },
    { key: 'maxRunSeconds', label: RUN_RUNTIME_LOOP_LABEL.maxRunSeconds, value: loopValue(used.loop.maxRunSeconds) },
  ];
  const flags: { key: keyof RunRuntimeUsed['answer']; label: string }[] = [
    { key: 'takeaway', label: RUN_RUNTIME_ANSWER_LABEL.takeaway },
    { key: 'narrative', label: RUN_RUNTIME_ANSWER_LABEL.narrative },
    { key: 'figures', label: RUN_RUNTIME_ANSWER_LABEL.figures },
    { key: 'charts', label: RUN_RUNTIME_ANSWER_LABEL.charts },
  ];
  for (const flag of flags) {
    const value = used.answer[flag.key];
    if (typeof value !== 'boolean') continue;
    chips.push({ key: flag.key, label: flag.label, value: flagValue(value), on: value });
  }
  if (used.answer.narrativeMaxCharacters !== null) {
    chips.push({
      key: 'narrativeMaxCharacters',
      label: RUN_RUNTIME_ANSWER_LABEL.characterCap,
      value: used.answer.narrativeMaxCharacters === 0 ? 'uncapped' : String(used.answer.narrativeMaxCharacters),
    });
  }
  if (used.answer.figuresOrder) {
    chips.push({
      key: 'figuresOrder',
      label: RUN_RUNTIME_ANSWER_LABEL.figuresOrder,
      value: RUN_RUNTIME_ORDER_LABEL[used.answer.figuresOrder],
    });
  }
  return chips;
}
