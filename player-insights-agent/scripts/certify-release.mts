/**
 * Certify one release, or record a statement about one.
 *
 * Called by `bundle/certify-release.sh`, which is where the bundle is read and
 * the target resolved. Everything environment-specific arrives as an argument,
 * for the reason `bundle/_lib.sh` states at the top: one place a value is
 * written down, and no value that lives only in somebody's shell.
 *
 * SHADOW IS THE DEFAULT AND EXITS 0 WHATEVER IT FINDS. A gate that blocks a
 * demo because a warehouse was cold is worse than no gate, because the first
 * thing anybody does with it is learn the flag that skips it. `--blocking` is
 * the opt-in, and it is not to be turned on by default until the checks have
 * run over several releases without a false finding.
 *
 * Usage, both forms already wrapped by bundle/certify-release.sh:
 *   node scripts/certify-release.mts --target t --profile p --app a \
 *     --endpoint e --model cat.sch.m --catalog c --schema s --scopes a,b
 *   node scripts/certify-release.mts ... --attest CODE --by you --note "..."
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitAttestation, type Attestation } from './certify/certificate.ts';
import { observe, type ObserveOptions } from './certify/observe.ts';
import { renderReport } from './certify/report.ts';
import { tupleDigest } from './certify/release-identity.ts';
import { certify, observedTuple } from './certify/runner.ts';
import { addAttestation, DEFAULT_STORE, readAttestations, writeCertificate } from './certify/store.ts';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(APP_DIR, '..');

function arg(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? '' : (process.argv[at + 1] ?? '');
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const target = arg('target');
const profile = arg('profile');
if (!target || !profile) {
  console.error(
    'usage: node scripts/certify-release.mts --target <target> --profile <profile> ' +
      '--app <app> --endpoint <endpoint> --model <catalog.schema.model> ' +
      '--catalog <catalog> --schema <schema> --scopes <a,b,c> ' +
      '--declared-identity <system-passthrough|user-authorization> [--blocking] [--store <dir>]\n' +
      '       ... --attest <CHECK_CODE> --by <person> --note "<what you did and saw>"\n\n' +
      'Prefer bundle/certify-release.sh, which resolves all of these out of the bundle.'
  );
  process.exit(2);
}

const store = arg('store') || path.join(REPO_ROOT, DEFAULT_STORE);
const options: ObserveOptions = {
  target,
  profile,
  appName: arg('app'),
  modelName: arg('model'),
  servingEndpoint: arg('endpoint'),
  catalog: arg('catalog'),
  schema: arg('schema'),
  authoredScopes: arg('scopes')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean),
  declaredIdentity: arg('declared-identity'),
  repoRoot: REPO_ROOT,
  appDir: APP_DIR,
  log: (message) => console.log(message),
};

const observations = await observe(options);
const tuple = observedTuple(observations);

// --- Recording a statement ----------------------------------------------------
//
// Against the release observed just now, never against one named on the command
// line. A digest a person can type is a digest a person can mistype, and the
// failure mode of getting it wrong is a statement that appears to cover a
// release nobody looked at.
const attesting = arg('attest');
if (attesting) {
  const statement: Attestation = {
    code: attesting,
    by: arg('by'),
    at: new Date().toISOString(),
    note: arg('note'),
    tupleDigest: tupleDigest(tuple),
  };
  const decision = admitAttestation(statement, statement.tupleDigest);
  if (!decision.admitted) {
    console.error(`\nNot recorded: ${decision.reason}`);
    process.exit(2);
  }
  const file = addAttestation(store, target, statement);
  console.log(`\nRecorded ${statement.code} for release ${statement.tupleDigest.slice(0, 12)}`);
  console.log(`  ${file}`);
  console.log('\nIt covers this release only. Anything that moves the app build, the model');
  console.log('version, the scope set or the manifest voids it, which is the point.');
  process.exit(0);
}

// --- Certifying ---------------------------------------------------------------

const mode = flag('blocking') ? 'blocking' : 'shadow';
const certificate = certify({
  observations,
  attestations: readAttestations(store, target),
  mode,
});

console.log(renderReport(certificate));
const file = writeCertificate(store, certificate);
console.log(`Certificate written to ${file}\n`);

if (mode === 'shadow') {
  console.log('Shadow mode: this reports and does not gate. Exiting 0 whatever it found.');
  process.exit(0);
}
process.exit(certificate.status === 'PASS' ? 0 : 1);
