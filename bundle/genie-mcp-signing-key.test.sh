#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-genie-key-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

cat > "$WORK/bin/databricks" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
STATE="${GENIE_KEY_TEST_STATE:?}"
if [[ "$1 $2" == "secrets list-scopes" ]]; then
  [[ -f "$STATE/scope" ]] && printf '{"scopes":[{"name":"pia-test-signing"}]}\n' || printf '{"scopes":[]}\n'
elif [[ "$1 $2" == "secrets create-scope" ]]; then
  touch "$STATE/scope"
elif [[ "$1 $2" == "secrets list-secrets" ]]; then
  python3 - "$STATE" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
print(json.dumps({"secrets": [{"key": p.name} for p in root.glob("genie-mcp-ed25519-private-pem-*")]}))
PY
elif [[ "$1 $2" == "secrets put-secret" ]]; then
  cp /dev/stdin "$STATE/$4"
  count=0; [[ -f "$STATE/puts" ]] && count="$(<"$STATE/puts")"
  printf '%s' "$((count + 1))" > "$STATE/puts"
elif [[ "$1 $2" == "workspace get-status" ]]; then
  [[ -f "$STATE/$(basename "$3")" ]]
elif [[ "$1 $2" == "workspace mkdirs" ]]; then
  :
elif [[ "$1 $2" == "workspace import" ]]; then
  target="$(basename "$3")"
  while [[ $# -gt 0 ]]; do
    [[ "$1" == "--file" ]] && { cp "$2" "$STATE/$target"; exit 0; }
    shift
  done
  exit 2
elif [[ "$1 $2" == "workspace export" ]]; then
  source="$(basename "$3")"
  while [[ $# -gt 0 ]]; do
    [[ "$1" == "--file" ]] && { cp "$STATE/$source" "$2"; exit 0; }
    shift
  done
  exit 2
else
  printf 'unexpected databricks call: %s\n' "$*" >&2
  exit 2
fi
STUB
chmod +x "$WORK/bin/databricks"

cat > "$WORK/bundle.json" <<'JSON'
{"variables":{"app_name":{"default":"pia-test"},"bundle_root_path":{"default":"/Workspace/test"},"genie_mcp_signing_key_version":{"default":"v1"}}}
JSON
printf 'test\tprofile' > "$WORK/bundle.json.key"

export PATH="$WORK/bin:$PATH"
export TARGET=test PROFILE=profile
export GENIE_KEY_TEST_STATE="$WORK"
export PIA_BUNDLE_JSON_CACHE="$WORK/bundle.json"

bash "$ROOT/bundle/genie-mcp-signing-key.sh" > "$WORK/first.pem"
bash "$ROOT/bundle/genie-mcp-signing-key.sh" > "$WORK/second.pem"
cmp "$WORK/first.pem" "$WORK/second.pem"
[[ "$(<"$WORK/puts")" == 1 ]]
! rg -q 'PRIVATE KEY' "$WORK/first.pem"

python3 - "$WORK/bundle.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
body = json.loads(path.read_text())
body["variables"]["genie_mcp_signing_key_version"]["default"] = "v2"
path.write_text(json.dumps(body))
PY
bash "$ROOT/bundle/genie-mcp-signing-key.sh" > "$WORK/rotated.pem"
[[ "$(<"$WORK/puts")" == 2 ]]
! cmp -s "$WORK/first.pem" "$WORK/rotated.pem"

printf 'ok - Genie MCP signing key provisioning is idempotent and rotation is explicit\n'
