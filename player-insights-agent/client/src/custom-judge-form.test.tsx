import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BENCHMARK_SETTINGS } from '../../shared/benchmark-settings';
import { BenchmarkSettingsPanel } from './BenchmarkSettingsPanel';
import { changedSettingKeys } from './settings-save-state';
import { stageCustomJudge, validateCustomJudgeDraft } from './custom-judge-draft';

const englishDraft = {
  name: ' English ',
  guidelines: ' The response must be in English. ',
  prompt: '',
};

describe('Custom Judges Settings composer', () => {
  it('stages a valid name and guideline, with the prompt remaining optional', () => {
    const result = stageCustomJudge([], englishDraft);

    expect(result).toEqual({
      ok: true,
      judges: [{ name: 'English', guidelines: 'The response must be in English.', prompt: '' }],
      judge: { name: 'English', guidelines: 'The response must be in English.', prompt: '' },
    });
    if (result.ok === false) throw new Error(result.message);
    expect(
      changedSettingKeys(DEFAULT_BENCHMARK_SETTINGS, {
        ...DEFAULT_BENCHMARK_SETTINGS,
        customJudges: result.judges,
      })
    ).toEqual(['customJudges']);
  });

  it('explains incomplete forms instead of accepting an inert click', () => {
    expect(validateCustomJudgeDraft({ name: '', guidelines: '', prompt: '' }, [])).toMatchObject({
      ok: false,
      issue: 'name_required',
      message: 'Enter a name and yes/no guideline.',
    });
    expect(validateCustomJudgeDraft({ name: 'English', guidelines: '', prompt: 'Optional detail' }, [])).toMatchObject({
      ok: false,
      issue: 'guidelines_required',
      message: 'Enter the yes/no guideline this judge should score.',
    });
  });

  it('rejects duplicate assessment names and prevents a double submission', () => {
    const first = stageCustomJudge([], englishDraft);
    if (first.ok === false) throw new Error(first.message);

    const second = stageCustomJudge(first.judges, {
      name: 'english',
      guidelines: 'A second rule must not be staged.',
      prompt: '',
    });
    expect(second).toMatchObject({
      ok: false,
      issue: 'duplicate_name',
      judges: first.judges,
    });
    expect(second.judges).toHaveLength(1);
  });

  it('renders a disabled incomplete action with specific status and removes the redundant name helper', () => {
    const markup = renderToStaticMarkup(<BenchmarkSettingsPanel enabled={true} />);
    const addButton = markup.match(/<button[^>]*>Add this custom judge<\/button>/)?.[0] ?? '';

    expect(markup).not.toContain('Name shown in Lab.');
    expect(markup).toContain('Enter a name and yes/no guideline.');
    expect(addButton).toContain('disabled=""');
    expect(addButton).toContain('aria-describedby="bench-custom-add-status"');
    expect(markup).toContain('type="button"');
  });
});
