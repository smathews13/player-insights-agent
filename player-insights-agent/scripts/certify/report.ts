/**
 * The certificate as something a person reads at the end of a release.
 *
 * Ordered by what a reader has to act on: the verdict, then the failures, then
 * the things nothing established, then what passed, and last the standing list
 * of conditions no API will ever answer.
 *
 * THE UNVERIFIABLE SECTION IS PRINTED ON EVERY RUN, INCLUDING A CLEAN ONE. It
 * is the part of the report with the shortest shelf life in a reader's memory
 * and the longest consequences: a certificate that says PASS while four
 * conditions were never observed is only honest if the reader is told so at the
 * moment they read PASS, not in a document they would have to go and find.
 */
import { checkDefinition, type CheckStatus } from './catalogue.ts';
import { verdict, type Certificate } from './certificate.ts';
import { describeTuple } from './release-identity.ts';

const MARK: Record<CheckStatus, string> = {
  pass: 'ok      ',
  fail: 'FAIL    ',
  unknown: 'unknown ',
  unverifiable: 'NOT SEEN',
};

function wrap(text: string, indent: string, width = 92): string[] {
  const lines: string[] = [];
  let current = indent;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current.length > indent.length && current.length + 1 + word.length > width) {
      lines.push(current);
      current = indent;
    }
    current += (current.length > indent.length ? ' ' : '') + word;
  }
  if (current.trim()) lines.push(current);
  return lines;
}

export function renderReport(certificate: Certificate): string {
  const decision = verdict({
    checks: certificate.checks,
    attestations: certificate.attestations,
    tupleDigest: certificate.tupleDigest,
  });
  const lines: string[] = [];
  const byStatus = (status: CheckStatus) => certificate.checks.filter((c) => c.status === status);

  lines.push('', `==> Release under certification`);
  for (const line of describeTuple(certificate.tuple)) lines.push(`  ${line}`);

  lines.push('', `==> ${certificate.status}  (${certificate.mode} mode)`);
  lines.push(`  issued by         ${certificate.issuedBy || '(unrecorded)'}`);
  lines.push(`  issued at         ${certificate.issuedAt}`);
  lines.push(`  expires at        ${certificate.expiresAt}`);

  // Required failures only. An advisory failure has its own section further
  // down, and printing it here as well put "FAIL APP_MODEL_BUILD_MATCH" at the
  // top of a report whose verdict was not FAIL, above a note two screens later
  // explaining that it never gates. The reader believes the first one.
  const failed = byStatus('fail').filter((outcome) => checkDefinition(outcome.code)?.severity !== 'advisory');
  if (failed.length > 0) {
    lines.push('', '==> Findings');
    for (const outcome of failed) {
      const definition = checkDefinition(outcome.code);
      lines.push(`  FAIL  ${outcome.code}  ${definition?.title ?? ''}`);
      lines.push(...wrap(outcome.detail, '        '));
      if (definition) lines.push(...wrap(`Remedy: ${definition.remedy}`, '        '));
    }
  }

  const unresolved = certificate.checks.filter((outcome) => decision.unresolved.includes(outcome.code));
  if (unresolved.length > 0) {
    lines.push('', '==> Not established');
    lines.push(
      ...wrap(
        'These are required and nothing answered them. They block a certificate exactly as a ' +
          'failure does. The difference is that each one names a question rather than a repair.',
        '  '
      )
    );
    for (const outcome of unresolved) {
      const definition = checkDefinition(outcome.code);
      lines.push(`  ${MARK[outcome.status]}  ${outcome.code}  ${definition?.title ?? ''}`);
      lines.push(...wrap(outcome.detail, '            '));
    }
  }

  const passed = byStatus('pass');
  if (passed.length > 0) {
    lines.push('', '==> Observed and correct');
    for (const outcome of passed) {
      lines.push(`  ok    ${outcome.code}  ${checkDefinition(outcome.code)?.title ?? ''}`);
    }
  }

  const advisory = certificate.checks.filter(
    (outcome) => outcome.status === 'fail' && checkDefinition(outcome.code)?.severity === 'advisory'
  );
  if (advisory.length > 0) {
    lines.push('', '==> Advisory, and never a gate');
    for (const outcome of advisory) {
      lines.push(`  note  ${outcome.code}`);
      lines.push(...wrap(outcome.detail, '        '));
    }
  }

  if (decision.rejectedAttestations.length > 0) {
    lines.push('', '==> Statements that were not admitted');
    for (const rejection of decision.rejectedAttestations) {
      lines.push(`  ${rejection.code}`);
      lines.push(...wrap(rejection.reason, '      '));
    }
  }

  lines.push('', '==> What this certificate does NOT cover');
  const unobservable = certificate.checks.filter((outcome) => checkDefinition(outcome.code)?.observability !== 'api');
  for (const outcome of unobservable) {
    const definition = checkDefinition(outcome.code);
    const attested = certificate.attestations.find(
      (statement) => statement.code === outcome.code && statement.tupleDigest === certificate.tupleDigest
    );
    lines.push(`  ${outcome.code}  ${attested ? `attested by ${attested.by} at ${attested.at}` : 'NOT ATTESTED'}`);
    if (definition?.notObservable) lines.push(...wrap(definition.notObservable, '      '));
    if (!attested && definition) lines.push(...wrap(`To resolve: ${definition.remedy}`, '      '));
  }

  lines.push('');
  return lines.join('\n');
}
