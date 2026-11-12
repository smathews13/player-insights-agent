/**
 * The record a promotion is allowed to rely on, and the rules that decide
 * whether it says PASS.
 *
 * THREE OUTCOMES, NOT TWO. A certificate that could only say PASS or FAIL would
 * have to decide what to call a run where nothing went wrong and half the
 * catalogue could not be observed, and every such scheme eventually calls it
 * PASS. INCOMPLETE is that third answer, and it blocks a promotion exactly as
 * FAIL does. The difference is what a reader does next: FAIL names something to
 * fix, INCOMPLETE names something to find out.
 *
 * The digest is TAMPER-EVIDENT, NOT SIGNED. It catches a certificate edited by
 * hand or truncated in transit. It does not catch anyone who can also recompute
 * it, because there is no key here and inventing a key store for a file written
 * next to the tree it describes would buy nothing. Do not describe these as
 * signed anywhere.
 */
import { createHash } from 'node:crypto';
import { acceptsAttestation, checkDefinition, type CheckStatus, CHECKS } from './catalogue.ts';
import { tupleDigest, type ReleaseTuple } from './release-identity.ts';

export interface CheckResult {
  code: string;
  status: CheckStatus;
  /** One or two sentences a reader can act on. Never a result set. */
  detail: string;
  durationMs: number;
  /**
   * A genuine reference to something durable: a run id, a trace id, a
   * deployment id. Never a row, never a token, never a fragment of an answer.
   */
  evidenceRef?: string;
}

export interface Attestation {
  code: string;
  /** Who states it. A person, not a role, so it can be asked about later. */
  by: string;
  at: string;
  /** What they did and what they saw. An empty note is refused. */
  note: string;
  /**
   * The release this statement is about. An attestation does not survive a
   * rebuild: a person signed in against one scope set and one app build, and
   * carrying that forward to the next release is how the outage this check
   * exists for gets re-shipped with a green tick over it.
   */
  tupleDigest: string;
}

export type CertificateStatus = 'PASS' | 'FAIL' | 'INCOMPLETE';

export interface Certificate {
  /** Bumped when the shape changes, so an old file is rejected, not misread. */
  schema: 1;
  target: string;
  tuple: ReleaseTuple;
  tupleDigest: string;
  status: CertificateStatus;
  /** Whether this run was allowed to stop a release. */
  mode: 'shadow' | 'blocking';
  issuedAt: string;
  expiresAt: string;
  /** The identity the live checks ran as. Certification is not anonymous. */
  issuedBy: string;
  checks: CheckResult[];
  attestations: Attestation[];
  /** sha256 over everything above. See the note at the top of this file. */
  digest: string;
}

/**
 * How long a certificate speaks for.
 *
 * Twelve hours, because most of what this certifies is live state that nothing
 * stops changing: a scope stops being in effect when someone restarts the app,
 * a grant disappears when the postgres resource is detached, traffic moves when
 * another release lands. A certificate older than a working day is a statement
 * about a system that no longer exists.
 */
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

export interface Verdict {
  status: CertificateStatus;
  /** Required checks that failed. These block and name a repair. */
  failed: string[];
  /** Required checks nothing established. These block and name a question. */
  unresolved: string[];
  /** Attestations that were offered and not admitted, with the reason. */
  rejectedAttestations: Array<{ code: string; reason: string }>;
}

/**
 * Whether an attestation may stand in for an observation of this check.
 *
 * Every rejection here is a way the certificate could otherwise have been
 * talked into a PASS, so each returns the reason rather than a boolean: the
 * report prints them, and a rejected attestation is more interesting than an
 * accepted one.
 */
export function admitAttestation(
  attestation: Attestation,
  expectedTupleDigest: string
): { admitted: true } | { admitted: false; reason: string } {
  const definition = checkDefinition(attestation.code);
  if (!definition) {
    return { admitted: false, reason: `${attestation.code} is not a check in the catalogue.` };
  }
  if (!acceptsAttestation(attestation.code)) {
    return {
      admitted: false,
      reason:
        `${attestation.code} is observable through an API, so a statement about it is not ` +
        'evidence. Run the check.',
    };
  }
  if (attestation.tupleDigest !== expectedTupleDigest) {
    return {
      admitted: false,
      reason:
        'it was made against a different release. An attestation covers the exact app build, ' +
        'model version and scope set that was in front of the person making it.',
    };
  }
  if (!attestation.by.trim()) {
    return { admitted: false, reason: 'it names nobody, so there is no one to ask about it.' };
  }
  if (!attestation.note.trim()) {
    return {
      admitted: false,
      reason: 'it records no observation. What was done and what was seen is the whole evidence.',
    };
  }
  return { admitted: true };
}

/**
 * The verdict for a set of results.
 *
 * A check the runner did not emit at all counts as unresolved rather than being
 * skipped. Forgetting to run something and it being fine are the two states this
 * whole design exists to keep apart.
 */
export function verdict(input: { checks: CheckResult[]; attestations: Attestation[]; tupleDigest: string }): Verdict {
  const byCode = new Map(input.checks.map((result) => [result.code, result]));
  const rejectedAttestations: Array<{ code: string; reason: string }> = [];
  const attested = new Set<string>();
  for (const attestation of input.attestations) {
    const decision = admitAttestation(attestation, input.tupleDigest);
    if (decision.admitted) attested.add(attestation.code);
    else rejectedAttestations.push({ code: attestation.code, reason: decision.reason });
  }

  const failed: string[] = [];
  const unresolved: string[] = [];
  for (const definition of CHECKS) {
    if (definition.severity !== 'required') continue;
    const result = byCode.get(definition.code);
    if (!result) {
      unresolved.push(definition.code);
      continue;
    }
    if (result.status === 'fail') {
      // Deliberately checked before the attestation set. A failing check cannot
      // be attested past, whatever anybody signed.
      failed.push(definition.code);
      continue;
    }
    if (result.status === 'pass') continue;
    if (attested.has(definition.code)) continue;
    unresolved.push(definition.code);
  }

  const status: CertificateStatus = failed.length > 0 ? 'FAIL' : unresolved.length > 0 ? 'INCOMPLETE' : 'PASS';
  return { status, failed, unresolved, rejectedAttestations };
}

/** sha256 over the certificate with its own digest field removed. */
export function certificateDigest(certificate: Omit<Certificate, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify(certificate)).digest('hex');
}

export function issueCertificate(input: {
  tuple: ReleaseTuple;
  checks: CheckResult[];
  attestations: Attestation[];
  mode: 'shadow' | 'blocking';
  issuedBy: string;
  now?: Date;
  ttlMs?: number;
}): Certificate {
  const now = input.now ?? new Date();
  const digestOfTuple = tupleDigest(input.tuple);
  const body: Omit<Certificate, 'digest'> = {
    schema: 1,
    target: input.tuple.target,
    tuple: input.tuple,
    tupleDigest: digestOfTuple,
    status: verdict({
      checks: input.checks,
      attestations: input.attestations,
      tupleDigest: digestOfTuple,
    }).status,
    mode: input.mode,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    issuedBy: input.issuedBy,
    checks: input.checks,
    attestations: input.attestations,
  };
  return { ...body, digest: certificateDigest(body) };
}

export interface Acceptance {
  accepted: boolean;
  /** Every reason it is not acceptable, not just the first. */
  reasons: string[];
}

/**
 * Whether a stored certificate may be relied on to promote the release in front
 * of us.
 *
 * Everything is a separate reason, and all of them are collected, because the
 * operator reading this is about to decide whether to override it and needs the
 * whole picture rather than the first tripwire.
 */
export function acceptCertificate(input: { certificate: Certificate; tuple: ReleaseTuple; now?: Date }): Acceptance {
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  const { certificate } = input;

  if (certificate.schema !== 1) {
    reasons.push(`its schema is ${String(certificate.schema)}, which this tool cannot read.`);
    // Nothing below can be trusted to mean what it appears to, so stop here
    // rather than reporting derived findings from a shape we do not know.
    return { accepted: false, reasons };
  }

  const { digest, ...body } = certificate;
  if (certificateDigest(body) !== digest) {
    reasons.push('its digest does not match its contents, so it has been altered since it was issued.');
  }
  if (certificate.status !== 'PASS') {
    reasons.push(`its status is ${certificate.status}, not PASS.`);
  }
  const expected = tupleDigest(input.tuple);
  if (certificate.tupleDigest !== expected) {
    reasons.push(
      'it was issued for a different release. Something in the app build, model version, ' +
        'scope set or manifest has changed since.'
    );
  }
  if (Date.parse(certificate.expiresAt) <= now.getTime()) {
    reasons.push(`it expired at ${certificate.expiresAt}. Re-certify rather than extending it.`);
  }
  if (certificate.mode === 'shadow') {
    reasons.push(
      'it was issued in shadow mode, where checks report and never gate, so it was never a ' +
        'decision about whether to promote.'
    );
  }
  return { accepted: reasons.length === 0, reasons };
}
