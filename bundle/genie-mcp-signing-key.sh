#!/usr/bin/env bash
# Ensure the app-only Ed25519 private key and export its public counterpart.
#
# Operation is idempotent and never overwrites an existing private key. Rotation
# means incrementing the bundle's version variable, preserving the old pair for
# rollback.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

[[ $# -eq 0 ]] || die "usage: TARGET=<target> PROFILE=<profile> $(basename "$0")"

require_cmd databricks
require_cmd node
require_target
resolve_profile
seed_bundle_cache

APP_NAME="$(bundle_var app_name)"
ROOT_PATH="$(bundle_var bundle_root_path)"
KEY_VERSION="$(bundle_var genie_mcp_signing_key_version)"
[[ "$KEY_VERSION" =~ ^v[1-9][0-9]*$ ]] ||
  die "genie_mcp_signing_key_version must look like v1, v2, ..."
SCOPE="${APP_NAME}-signing"
PRIVATE_KEY="genie-mcp-ed25519-private-pem-${KEY_VERSION}"
PUBLIC_PATH="${ROOT_PATH}/security/genie-mcp-ed25519-public-${KEY_VERSION}.pem"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-genie-signing.XXXXXX")"
on_exit 'rm -rf "$WORK"'
PRIVATE_FILE="$WORK/private.pem"
PUBLIC_FILE="$WORK/public.pem"
PROFILE_ARGS=()
[[ -n "$PROFILE" ]] && PROFILE_ARGS=(--profile "$PROFILE")

scope_exists() {
  local metadata
  if ! metadata="$(databricks secrets list-scopes "${PROFILE_ARGS[@]}" -o json)"; then
    die "Could not list secret scopes; refusing to infer that $SCOPE is absent."
  fi
  printf '%s' "$metadata" |
    python3 -c 'import json,sys; wanted=sys.argv[1]; body=json.load(sys.stdin); rows=body.get("scopes",[]) if isinstance(body,dict) else body; raise SystemExit(0 if any(x.get("name")==wanted for x in rows) else 1)' "$SCOPE"
}

private_exists() {
  local metadata
  if ! metadata="$(databricks secrets list-secrets "$SCOPE" "${PROFILE_ARGS[@]}" -o json)"; then
    die "Could not list keys in $SCOPE; refusing to infer that $PRIVATE_KEY is absent."
  fi
  printf '%s' "$metadata" |
    python3 -c 'import json,sys; wanted=sys.argv[1]; body=json.load(sys.stdin); rows=body.get("secrets",[]) if isinstance(body,dict) else body; raise SystemExit(0 if any(x.get("key")==wanted for x in rows) else 1)' "$PRIVATE_KEY"
}

public_exists() {
  databricks workspace get-status "$PUBLIC_PATH" "${PROFILE_ARGS[@]}" -o json >/dev/null 2>&1
}

write_pair() {
  node - "$PRIVATE_FILE" "$PUBLIC_FILE" <<'NODE'
const { generateKeyPairSync } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const [privatePath, publicPath] = process.argv.slice(2);
const pair = generateKeyPairSync('ed25519');
writeFileSync(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(publicPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
NODE
  databricks workspace mkdirs "$(dirname "$PUBLIC_PATH")" "${PROFILE_ARGS[@]}"
  databricks workspace import "$PUBLIC_PATH" \
    --file "$PUBLIC_FILE" --format RAW --overwrite "${PROFILE_ARGS[@]}"
  # stdin keeps the private PEM out of argv, process listings and shell traces.
  databricks secrets put-secret "$SCOPE" "$PRIVATE_KEY" "${PROFILE_ARGS[@]}" < "$PRIVATE_FILE"
}

scope_exists || databricks secrets create-scope "$SCOPE" "${PROFILE_ARGS[@]}"

if private_exists; then
  public_exists || die "The Genie MCP private key exists but $PUBLIC_PATH is missing.
The private value cannot be exported by the workspace Secrets API. Refusing to
replace it. Advance genie_mcp_signing_key_version during a coordinated release."
else
  # A public-only remainder is safe to replace: no app can sign with it.
  write_pair
  printf 'Created Genie MCP signing key %s/%s without exposing its private value.\n' \
    "$SCOPE" "$PRIVATE_KEY" >&2
fi

rm -f "$PUBLIC_FILE"
databricks workspace export "$PUBLIC_PATH" \
  --file "$PUBLIC_FILE" --format RAW --direct-download "${PROFILE_ARGS[@]}"
cat "$PUBLIC_FILE"
