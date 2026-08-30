/**
 * Validate a timezone with the same Intl implementation used by Ops bucketing.
 *
 * Returning the trimmed input (rather than Intl's canonical spelling) preserves
 * valid aliases and custom IANA values exactly as an administrator chose them.
 */
export function validIanaTimeZone(value: string): string {
  const candidate = value.trim();
  if (!candidate) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return '';
  }
}
