import { describe, expect, it } from 'vitest';

import { DEFAULT_RUNTIME_SETTINGS } from './runtime-settings';
import {
  RUN_RUNTIME_LOOP_LABEL,
  RUN_RUNTIME_USED_ABSENT,
  runRuntimeUsedChips,
  runRuntimeUsedFromStored,
} from './run-runtime-used';

const SENT = {
  ...DEFAULT_RUNTIME_SETTINGS,
  loop: { maxSteps: 10, maxToolCalls: 15, maxRunSeconds: 200 },
  answer: {
    ...DEFAULT_RUNTIME_SETTINGS.answer,
    takeaway: true,
    narrative: true,
    figures: false,
    charts: false,
    narrativeMaxCharacters: 800,
    figuresOrder: 'totals-first' as const,
  },
};

describe('the runtime a stored run used', () => {
  it('reads the snapshot off a stored answer, which is what Ask sent', () => {
    const used = runRuntimeUsedFromStored({ type: 'answer', runtime_settings: SENT });
    expect(used?.loop).toEqual({ maxSteps: 10, maxToolCalls: 15, maxRunSeconds: 200 });
    expect(used?.answer.figures).toBe(false);
    expect(used?.answer.narrativeMaxCharacters).toBe(800);
    expect(used?.answer.figuresOrder).toBe('totals-first');
  });

  it('reads the same snapshot off the invoke body, nested under custom_inputs', () => {
    const used = runRuntimeUsedFromStored({
      input: [],
      custom_inputs: { conversation_id: 'c1', runtime_settings: SENT },
    });
    expect(used?.loop.maxRunSeconds).toBe(200);
  });

  it('does not invent today’s defaults when the run stored nothing', () => {
    expect(runRuntimeUsedFromStored({ type: 'answer', takeaway: 'Weekly actives fell.' })).toBeNull();
    expect(runRuntimeUsedFromStored(null)).toBeNull();
    expect(runRuntimeUsedFromStored({ runtime_settings: {} })).toBeNull();
    expect(runRuntimeUsedFromStored({ runtime_settings: { loop: { maxSteps: 12 } } })?.loop).toEqual({
      maxSteps: 12,
      maxToolCalls: null,
      maxRunSeconds: null,
    });
    expect(usedLoopDefaults()).toEqual({ maxSteps: 12, maxToolCalls: 12, maxRunSeconds: 150 });
  });

  it('names the three bounds the Settings pane names, and Not recorded for a missing number', () => {
    const chips = runRuntimeUsedChips({
      loop: { maxSteps: 10, maxToolCalls: 15, maxRunSeconds: null },
      answer: {
        takeaway: true,
        narrative: false,
        figures: null,
        charts: false,
        narrativeMaxCharacters: 0,
        figuresOrder: 'totals-first',
      },
    });
    expect(chips.map((chip) => `${chip.label} ${chip.value}`)).toEqual([
      `${RUN_RUNTIME_LOOP_LABEL.maxSteps} 10`,
      `${RUN_RUNTIME_LOOP_LABEL.maxToolCalls} 15`,
      `${RUN_RUNTIME_LOOP_LABEL.maxRunSeconds} ${RUN_RUNTIME_USED_ABSENT}`,
      'Takeaway on',
      'Narrative off',
      'Charts off',
      'Narrative cap uncapped',
      'Order Totals first',
    ]);
  });
});

function usedLoopDefaults() {
  return DEFAULT_RUNTIME_SETTINGS.loop;
}
