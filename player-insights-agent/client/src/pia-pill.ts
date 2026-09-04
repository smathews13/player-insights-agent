/**
 * The one semantic status recipe for every surface that carries a state word.
 *
 * The CSS class names remain stable layout contracts; call sites name only the
 * state's meaning and never select a color directly.
 */
export type PiaPillFamily = 'pos' | 'neg' | 'warn' | 'neutral' | 'neutral-outline' | 'info';

export function piaPill(family: PiaPillFamily, extra?: string): string {
  return ['ast-pill', `ast-pill--${family}`, extra].filter(Boolean).join(' ');
}

/** A mono value whose family is also its verdict. */
export function piaValueBadge(family: PiaPillFamily | 'plain', extra?: string): string {
  if (family === 'plain') return ['ast-num', extra].filter(Boolean).join(' ');
  return ['ast-pill', `ast-pill--${family}`, 'ast-num', extra].filter(Boolean).join(' ');
}

// Source-compatible aliases keep the broad status call-site migration
// mechanical while the brand-only module path itself is retired.
export { piaPill as astPill, piaValueBadge as astValueBadge };
export type AstPillFamily = PiaPillFamily;
