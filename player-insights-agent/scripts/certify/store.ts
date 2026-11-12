/**
 * Where certificates and attestations are kept.
 *
 * NOT LAKEBASE, DELIBERATELY, and this is the reason rather than an omission.
 * The plan proposes Lakebase tables. The app OWNS the `player_insights` schema
 * and its boot DDL is refused on any object it does not own, which is the
 * failure `scripts/check-db-ownership.mjs` exists to catch and which
 * `bundle/app-release.sh` now halts a release over. A release script that
 * created certificate tables would create them as the DEPLOYER's Postgres role
 * and would be manufacturing that exact failure on every release. A separate
 * schema owned by the release role is the way to do it later; it is a schema,
 * a grant and a migration, and it is not free.
 *
 * So: files. Flat JSON under a directory, one file per issued certificate,
 * named so the newest for a release is findable without an index.
 *
 * The directory is NOT committed. A certificate names the workspace, the app,
 * the endpoint, the Lakebase branch and every table in the manifest, and the
 * publication rewrite is a line-wise pass that cannot remove a document. The
 * cost is that the store is per-machine, so `--store` takes a path: point it at
 * shared storage and the records are shared.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Attestation, Certificate } from './certificate.ts';
import { tupleDigest, type ReleaseTuple } from './release-identity.ts';

export const DEFAULT_STORE = '.certificates';

/** A filename that sorts by time and carries the release it is about. */
export function certificateFilename(certificate: Certificate): string {
  const stamp = certificate.issuedAt.replace(/[:.]/g, '-');
  return `${stamp}--${certificate.tupleDigest.slice(0, 12)}--${certificate.status}.json`;
}

function targetDir(store: string, target: string): string {
  // A target name reaches this from the shell, so it is not allowed to choose a
  // directory. `..` in a TARGET would otherwise write outside the store.
  return path.join(store, target.replace(/[^A-Za-z0-9_.-]/g, '_'));
}

export function writeCertificate(store: string, certificate: Certificate): string {
  const directory = targetDir(store, certificate.target);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, certificateFilename(certificate));
  writeFileSync(file, `${JSON.stringify(certificate, null, 2)}\n`);
  return file;
}

/** Every stored certificate for a target, newest first. */
export function readCertificates(store: string, target: string): Certificate[] {
  const directory = targetDir(store, target);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const found: Certificate[] = [];
  for (const name of names.sort().reverse()) {
    try {
      found.push(JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as Certificate);
    } catch {
      // A file that will not parse is skipped rather than fatal. It cannot be
      // relied on, and `acceptCertificate` is what decides that; refusing to
      // read the directory at all would let one corrupt file hide a good
      // certificate beside it.
    }
  }
  return found;
}

/** The newest stored certificate issued for exactly this release. */
export function latestFor(store: string, tuple: ReleaseTuple): Certificate | null {
  const wanted = tupleDigest(tuple);
  return readCertificates(store, tuple.target).find((certificate) => certificate.tupleDigest === wanted) ?? null;
}

// --- Attestations -------------------------------------------------------------
//
// Kept in one file per target rather than inside a certificate, because they
// outlive the run that recorded them: a person signs in once and the next
// certification for the SAME release digest should find their statement. They
// stop applying the moment the digest changes, which `admitAttestation`
// enforces rather than this file.

function attestationsFile(store: string, target: string): string {
  return path.join(targetDir(store, target), 'attestations.json');
}

export function readAttestations(store: string, target: string): Attestation[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(attestationsFile(store, target), 'utf8'));
    return Array.isArray(parsed) ? (parsed as Attestation[]) : [];
  } catch {
    return [];
  }
}

/**
 * Record one statement, replacing an earlier one for the same check and release.
 *
 * Replaced rather than appended: two people attesting the same thing about the
 * same release is not more evidence, and a growing list makes the most recent
 * statement harder to find. The earlier one is not history worth keeping,
 * because the certificate that relied on it recorded it in full.
 */
export function addAttestation(store: string, target: string, attestation: Attestation): string {
  const directory = targetDir(store, target);
  mkdirSync(directory, { recursive: true });
  const kept = readAttestations(store, target).filter(
    (existing) => !(existing.code === attestation.code && existing.tupleDigest === attestation.tupleDigest)
  );
  const file = attestationsFile(store, target);
  writeFileSync(file, `${JSON.stringify([...kept, attestation], null, 2)}\n`);
  return file;
}
