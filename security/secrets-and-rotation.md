# Runbook: secrets and rotation

PIA holds two kinds of secret. Both live in Databricks secret scopes and reach
the app as declared resources. None is in the repository, the bundle, the model
artifact or a log.

| Secret | Scope (bundle variable) | Who reads it | Rotation |
|---|---|---|---|
| App-to-model signing key (Ed25519 private key) | `genie_mcp_signing_scope`, key `genie-mcp-ed25519-private-pem-<version>` | The app only, as a secret resource | Change `genie_mcp_signing_key_version`; see below |
| Persona OAuth client secrets | The scope and key named on each persona | The app service principal, to mint a short-lived token | Every 90 days, or at once if exposed |

The model artifact holds only public keys. The private signing key is created
inside the secret scope and its value is never exported.

## Signing key rotation

The app signs a short-lived capability (at most 60 seconds) for each question
that uses the managed Genie route. The model checks it against the public keys
baked in at release. It trusts at most two: the current key and the one before
it.

1. Set `genie_mcp_signing_key_version` to the next value (for example `v1` to
   `v2`) for the target.
2. Release the model first: `bash bundle/agent-release.sh --apply`. It creates
   the new key pair, keeps the old one, and bakes both public keys into the new
   model version. The release log says which previous key is still trusted.
3. Release the app: `bash bundle/app-release.sh --apply`. The app now signs with
   the new key. Questions signed with the old key a moment earlier still verify.
4. On the next rotation the oldest key drops out. A model that sees three keys
   refuses them all rather than trusting a retired one.

Do not roll the model back past step 2 while the app signs with the new key: the
older model trusts only the old key and would refuse the managed Genie route
until the app is rolled back too. The direct Genie route is unaffected.

**Drill.** On a non-production target, run steps 1 to 3 and ask one question
that uses the managed Genie route between steps 2 and 3 and one after step 3.
Both should answer. Record the date and versions in the deployment's change log.

## Persona client secrets

A persona is a service principal with an OAuth client secret. The persona row
names only the secret scope and key. The app reads the secret as its own
service principal, exchanges it for a token of at most one hour (cached until
the issuer's expiry), and never stores or returns the secret.

To rotate a persona secret:

1. In the Account Console, create a new OAuth secret for the persona's service
   principal.
2. Put the new value in the persona's scope and key:
   `databricks secrets put-secret <scope> <key>` (reads the value from stdin).
3. In PIA, Settings > Identity, run the persona's status check. The next token
   uses the new secret; cached tokens expire within the hour.
4. Delete the old secret in the Account Console.

Rotate every 90 days and record each rotation in the deployment's change log.

## Secret scan

`python3 bundle/secret_scan.py` checks every tracked file for credential formats
(Databricks tokens and OAuth secrets, private keys, cloud and SaaS tokens,
secret-looking assignments). `--history` checks every line any commit ever
added. A finding prints its location and a fingerprint, never the value.

A deliberate test value can be accepted by adding its fingerprint and a reason
to `bundle/secret-scan-allow.txt`. A live value is never accepted: rotate it,
then remove it.

The tree scan runs in `bash bundle/release-checks.sh fast`. Run the history scan
before publishing a repository for the first time and after any suspected leak.
