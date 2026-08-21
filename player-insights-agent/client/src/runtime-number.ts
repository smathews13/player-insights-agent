/**
 * Reading a whole number out of a text field, which is where the Runtime pane
 * went wrong.
 *
 * The old fields coerced the raw field text with `Number`, and `Number('')` is
 * 0. Clearing "Run budget (s)" to retype it therefore did not clear it -- it set
 * the value to zero, the zero was drawn back into the box, and the digits typed
 * next landed after it. That is the "I have to add a 0 to make it take" report.
 *
 * Here rather than beside the component so it can be asserted directly, and so
 * the component module exports only components.
 */

/**
 * The number a field's text means, held inside `min`/`max`.
 *
 * An empty or unreadable box returns `fallback` -- the value already in force --
 * rather than zero, because "nothing typed yet" is not a request for zero. The
 * clamp is here and not left to the server: the schema refuses a run budget
 * under 30 with a 400, and a refusal the reader cannot see is the same to them
 * as a button that did nothing.
 */
export function wholeNumberFrom(raw: string, min: number, max: number, fallback: number): number {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits === '') return fallback;
  const parsed = Number.parseInt(digits, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
