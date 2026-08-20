export function identityName(identity: string | null | undefined): string {
  const value = identity?.trim() ?? '';
  if (!value) return 'Unknown';
  const at = value.indexOf('@');
  return at > 0 ? value.slice(0, at) : value;
}
