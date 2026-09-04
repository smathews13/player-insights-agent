import { PiaMark } from './PiaMark';

/** The one reader-facing caveat used wherever Player Insights Agent presents AI analysis. */
export const AI_ANALYSIS_CAVEAT = 'Player Insights Agent analysis. AI can make mistakes.';

/**
 * Quiet product mark and caveat, with no provenance or run-specific text mixed in.
 *
 * The mark is decorative because the adjacent sentence names Player Insights Agent. Keeping
 * the whole sentence in one text node makes its accessible text exactly the
 * shared copy, once.
 */
export function AIAnalysisCaveat({ className = '', showMark = true }: { className?: string; showMark?: boolean }) {
  return (
    <p className={className} data-ai-analysis-caveat="">
      {showMark ? <PiaMark size={14} /> : null}
      <span>{AI_ANALYSIS_CAVEAT}</span>
    </p>
  );
}
