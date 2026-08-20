import { commitOf, SHORT_SHA_LENGTH } from '../../shared/build-stamps';

export function deploymentTimeLabel(deployedAt: string): string {
  const at = new Date(deployedAt);
  if (!deployedAt || Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric' });
}

export function deploymentLocalTime(deployedAt: string): string {
  const at = new Date(deployedAt);
  if (!deployedAt || Number.isNaN(at.getTime())) return '';
  const clock = { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' } as const;
  const local = at.toLocaleString('en-US', clock);
  return local === at.toLocaleString('en-US', { ...clock, timeZone: 'UTC' }) ? '' : local;
}

export function deploymentTimeTitle(deployedAt: string, buildSha = '', deployedBy = ''): string {
  const at = new Date(deployedAt);
  if (!deployedAt || Number.isNaN(at.getTime())) return '';
  const when = `Deployed ${at.toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  })}`;
  const commit = commitOf(buildSha).slice(0, SHORT_SHA_LENGTH);
  const local = deploymentLocalTime(deployedAt);
  const facts = [when, local, deployedBy.trim() ? `by ${deployedBy.trim()}` : '', commit ? `commit ${commit}` : ''];
  return facts.filter(Boolean).join(' \u00b7 ');
}
