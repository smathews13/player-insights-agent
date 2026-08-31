import { AstrolabeMark } from './AstrolabeMark';

/** The one reader-facing caveat used wherever Astrolabe presents AI analysis. */
export const AI_ANALYSIS_CAVEAT = 'Astrolabe analysis. AI can make mistakes.';

/**
 * Quiet product mark and caveat, with no provenance or run-specific text mixed in.
 *
 * The mark is decorative because the adjacent sentence names Astrolabe. Keeping
 * the whole sentence in one text node makes its accessible text exactly the
 * shared copy, once.
 */
export function AIAnalysisCaveat({ className = '' }: { className?: string }) {
  return (
    <p className={className} data-ai-analysis-caveat="">
      <AstrolabeMark size={14} />
      <span>{AI_ANALYSIS_CAVEAT}</span>
    </p>
  );
}
