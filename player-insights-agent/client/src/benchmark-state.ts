import type { ScorerDefinition } from '../../shared/scorer-catalog';
import type { Scorecard, ScorecardValue } from '../../shared/scorecard-contract';
import { formatDuration } from './benchmark-summary';

export function formatScore(definition: ScorerDefinition, value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (definition.unit === 'rate') return `${Math.round(value * 100)}%`;
  if (definition.unit === 'milliseconds') return formatDuration(value);
  return value % 1 === 0 ? String(value) : value.toFixed(1);
}

export function scoreCoverage(definition: ScorerDefinition, score: ScorecardValue | null): string {
  if (definition.availability === 'unimplementable') return definition.blockedReason;
  if (!score) return 'Not measured by the published evaluation.';
  if (score.state !== 'scored') return score.reason || 'No case produced a verdict for this scorer.';
  const applied = `${score.scored} of ${score.scored + score.notApplicable} case${score.scored + score.notApplicable === 1 ? '' : 's'}`;
  return definition.unit === 'rate'
    ? `Over the ${applied} this scorer applied to.`
    : `Median across the ${applied} this scorer applied to.`;
}

export function labelSourceSummary(scorecard: Scorecard): string {
  const counts = scorecard.provenance.labelSourceCounts ?? {};
  const byQuery = counts['data-query'] ?? 0;
  const byPolicy = counts['policy-document'] ?? 0;
  const total = scorecard.provenance.caseCount;
  return (
    `Of ${total} labelled cases, ${byQuery} are settled by a query anyone can re-run against the data, and ` +
    `${byPolicy} rest on a reading of policy alone -- those are the ones no query can check and the first ` +
    'worth an expert\'s time. The rest mix the two: which table an answer had to reach is checkable, what it ' +
    'had to say about it is not.'
  );
}
