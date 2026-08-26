/**
 * Align the guidelines judge to human thumbs / SQL-correct, the flywheel
 * 02_human_review way: pair verdicts, measure agreement, then *replace* the
 * rubric so the next run would have said what the humans said.
 *
 * Appending "Human labels:" sentences is not alignment.
 */

export interface AlignableRow {
  question: string;
  expectedAnswer: string;
  sqlCorrect: 'yes' | 'no' | '';
  thumbs: 'up' | 'down' | '';
}

export type YesNo = 'yes' | 'no';

export interface AlignmentPair {
  question: string;
  human: YesNo;
  judge: YesNo | null;
  agree: boolean | null;
}

export interface AlignmentAgreement {
  labeled: number;
  compared: number;
  agreed: number;
  rate: number | null;
  label: string;
}

export interface JudgeCaseForAlignment {
  question: string | null;
  judgements: readonly { name: string; state: string; value: string | null }[];
}

export function humanVerdictFromRow(row: Pick<AlignableRow, 'thumbs' | 'sqlCorrect'>): YesNo | null {
  if (row.thumbs === 'up') return 'yes';
  if (row.thumbs === 'down') return 'no';
  if (row.sqlCorrect === 'yes') return 'yes';
  if (row.sqlCorrect === 'no') return 'no';
  return null;
}

export function stripAppendedHumanLabels(text: string): string {
  const cut = text.search(/\nHuman labels:\s*\n/);
  return (cut >= 0 ? text.slice(0, cut) : text).trim();
}

export function firstGuidelineSentence(text: string): string {
  const stem = stripAppendedHumanLabels(text);
  const line = stem.split(/\n/).map((entry) => entry.trim()).find((entry) => entry.length > 0);
  return line || '';
}

export function pairLabelsWithCases(
  rows: readonly AlignableRow[],
  cases: readonly JudgeCaseForAlignment[]
): AlignmentPair[] {
  const byQuestion = new Map<string, JudgeCaseForAlignment>();
  for (const entry of cases) {
    const key = (entry.question ?? '').trim().toLowerCase();
    if (key && !byQuestion.has(key)) byQuestion.set(key, entry);
  }
  const pairs: AlignmentPair[] = [];
  for (const row of rows) {
    const human = humanVerdictFromRow(row);
    const question = row.question.trim();
    if (!human || !question) continue;
    const match = byQuestion.get(question.toLowerCase());
    const judgement = match?.judgements.find((entry) => entry.name === 'guidelines' && entry.state === 'scored');
    const judge = judgement?.value === 'yes' || judgement?.value === 'no' ? judgement.value : null;
    pairs.push({
      question,
      human,
      judge,
      agree: judge === null ? null : judge === human,
    });
  }
  return pairs;
}

export function agreementFromPairs(pairs: readonly AlignmentPair[]): AlignmentAgreement {
  const labeled = pairs.length;
  const compared = pairs.filter((pair) => pair.agree !== null);
  const agreed = compared.filter((pair) => pair.agree === true).length;
  const rate = compared.length > 0 ? agreed / compared.length : null;
  const percent = rate === null ? null : Math.round(rate * 100);
  return {
    labeled,
    compared: compared.length,
    agreed,
    rate,
    label:
      compared.length === 0
        ? `${labeled} labelled row(s). No Phase B guidelines verdict to compare yet.`
        : `${agreed}/${compared.length} = ${percent}% agreement with the last guidelines judge.`,
  };
}

/**
 * Replace the rubric. Distils rules from human verdicts; does not dump every
 * labelled question back onto the guidelines.
 */
export function distillGuidelinesFromLabels(base: string, rows: readonly AlignableRow[]): string {
  const pairs = pairLabelsWithCases(rows, []);
  return distillGuidelinesFromPairs(base, rows, pairs);
}

export function distillGuidelinesFromPairs(
  base: string,
  rows: readonly AlignableRow[],
  pairs: readonly AlignmentPair[]
): string {
  const stem = firstGuidelineSentence(base);
  const rules: string[] = [];
  if (rows.some((row) => row.sqlCorrect === 'yes' || row.sqlCorrect === 'no')) {
    rules.push('Published SQL must match the labelled ground-truth statement for that question.');
  }
  if (rows.some((row) => row.thumbs === 'down')) {
    rules.push('Do not repeat the style or claims reviewers rejected with a thumbs-down.');
    const expected = rows.find((row) => row.thumbs === 'down' && row.expectedAnswer.trim())?.expectedAnswer.trim();
    if (expected) {
      rules.push(`A rejected answer must be replaced by the labelled expected answer, such as: ${clip(expected, 240)}`);
    }
  }
  if (rows.some((row) => row.thumbs === 'up' && row.expectedAnswer.trim())) {
    rules.push('A good answer matches the labelled expected answer in facts and tone.');
  }
  const fewShot = pairs.filter((pair) => pair.human).slice(0, 3);
  if (fewShot.length > 0) {
    rules.push(
      `Few-shot human verdicts (yes = acceptable, no = not): ${fewShot
        .map((pair) => `"${clip(pair.question, 80)}" → ${pair.human}`)
        .join('; ')}.`
    );
  }
  const next = [stem, ...rules].filter(Boolean).join('\n');
  return next.slice(0, 4000);
}

export function alignmentRewritePrompt(base: string, pairs: readonly AlignmentPair[]): string {
  const examples = pairs
    .slice(0, 12)
    .map((pair) => {
      const judge = pair.judge ? ` Last guidelines judge said ${pair.judge}.` : '';
      return `- Question: ${pair.question}\n  Human verdict: ${pair.human}.${judge}`;
    })
    .join('\n');
  return `You align an LLM guidelines judge to human labels.

Current guidelines:
${stripAppendedHumanLabels(base) || '(empty)'}

Human verdicts (yes = acceptable, no = not acceptable):
${examples || '(none)'}

Rewrite the guidelines so a yes/no judge following them would have matched the human verdicts.
Replace the rubric. Do not append a "Human labels:" list. Write 3 to 8 short guideline sentences.
Return only this JSON:
{
  "rationale": "Let's think step by step. Why this rubric matches the humans.",
  "result": "yes",
  "guidelines": "the replacement guidelines text"
}`;
}

export function parseAlignedGuidelines(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = fence ? fence[1].trim() : trimmed;
  try {
    const parsed = JSON.parse(body) as { guidelines?: unknown };
    if (typeof parsed.guidelines === 'string' && parsed.guidelines.trim()) {
      return parsed.guidelines.trim().slice(0, 4000);
    }
  } catch {
    // Fall through: some models return the rubric as plain text.
  }
  if (/^\s*\{/.test(body)) return null;
  return body.slice(0, 4000);
}

export function agreementLine(agreement: AlignmentAgreement): string {
  return agreement.label;
}

function clip(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
