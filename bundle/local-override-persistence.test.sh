#!/usr/bin/env bash
# Prove the public Git workflow preserves ignored per-target bundle variables.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-local-overrides.XXXXXX")"
SERVER_PID=""
cleanup() {
  [[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

command -v databricks >/dev/null 2>&1 || {
  printf 'FAIL  databricks CLI is required to prove bundle override precedence.\n' >&2
  exit 1
}

AUTHOR="$WORK/author"
REMOTE="$WORK/public.git"
CLONE="$WORK/operator"
PORT_FILE="$WORK/mock-workspace.port"
python3 - "$PORT_FILE" <<'PY' &
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pathlib
import sys

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/2.0/preview/scim/v2/Me"):
            body = json.dumps({"userName": "operator@example.invalid"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/api/2.0/workspace/get-status"):
            body = json.dumps({"object_type": "DIRECTORY"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        body = b"{}"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
pathlib.Path(sys.argv[1]).write_text(str(server.server_address[1]), encoding="utf-8")
server.serve_forever()
PY
SERVER_PID=$!
for _ in {1..100}; do
  [[ -s "$PORT_FILE" ]] && break
  sleep 0.01
done
[[ -s "$PORT_FILE" ]]
TEST_HOST="http://127.0.0.1:$(cat "$PORT_FILE")"

mkdir -p "$AUTHOR"
git -C "$AUTHOR" init --quiet --template= --initial-branch=main
git -C "$AUTHOR" config user.name "Public Mirror Test"
git -C "$AUTHOR" config user.email "public-mirror@test.invalid"

cp "$ROOT/.gitignore" "$AUTHOR/.gitignore"
cat >"$AUTHOR/databricks.yml" <<'YAML'
bundle:
  name: local-override-contract

variables:
  persistence_marker:
    description: Synthetic test value.
    default: tracked-default-v1
  opaque_local_value:
    description: Second synthetic value checked for byte persistence.
    default: tracked-opaque-default

targets:
  dev:
    mode: development
    workspace:
      host: TEST_HOST_PLACEHOLDER
      root_path: /Workspace/Users/operator@example.invalid/.bundle/local-override-contract/dev
  prod:
    mode: production
    workspace:
      host: TEST_HOST_PLACEHOLDER
      root_path: /Workspace/Users/operator@example.invalid/.bundle/local-override-contract/prod
YAML
python3 - "$AUTHOR/databricks.yml" "$TEST_HOST" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
path.write_text(path.read_text(encoding="utf-8").replace("TEST_HOST_PLACEHOLDER", sys.argv[2]), encoding="utf-8")
PY
printf 'public revision one\n' >"$AUTHOR/README.md"
git -C "$AUTHOR" add .gitignore databricks.yml README.md
git -C "$AUTHOR" commit --quiet -m "public revision one"
git -C "$WORK" clone --quiet --bare "$AUTHOR" "$REMOTE"
git clone --quiet "$REMOTE" "$CLONE"

DEV_OVERRIDE="$CLONE/.databricks/bundle/dev/variable-overrides.json"
PROD_OVERRIDE="$CLONE/.databricks/bundle/prod/variable-overrides.json"
mkdir -p "$(dirname "$DEV_OVERRIDE")" "$(dirname "$PROD_OVERRIDE")"
cat >"$DEV_OVERRIDE" <<'JSON'
{
  "persistence_marker": "DEV_SENTINEL_7f75c1",
  "opaque_local_value": "DEV_BYTES_46d8a0"
}
JSON
cat >"$PROD_OVERRIDE" <<'JSON'
{
  "persistence_marker": "PROD_SENTINEL_7f75c1",
  "opaque_local_value": "PROD_BYTES_46d8a0"
}
JSON
cp "$DEV_OVERRIDE" "$WORK/expected-dev-overrides.json"
cp "$PROD_OVERRIDE" "$WORK/expected-prod-overrides.json"

git -C "$CLONE" check-ignore -q .databricks/bundle/dev/variable-overrides.json
git -C "$CLONE" check-ignore -q .databricks/bundle/prod/variable-overrides.json
[[ -z "$(git -C "$CLONE" status --porcelain)" ]]
[[ -z "$(git -C "$REMOTE" ls-tree -r --name-only HEAD -- .databricks)" ]]

validate_marker() {
  local target="$1" expected="$2" output="$WORK/validate-$1.json"
  (
    cd "$CLONE"
    DATABRICKS_TOKEN=fake-offline-token \
      databricks bundle validate -t "$target" -o json >"$output"
  )
  python3 - "$output" "$expected" <<'PY'
import json
import sys

document = json.load(open(sys.argv[1], encoding="utf-8"))
entry = document["variables"]["persistence_marker"]
value = entry.get("value")
if value is None:
    value = entry.get("default")
if value != sys.argv[2]:
    raise SystemExit(f"local override lost precedence: {value!r}")
PY
}

# `bundle validate` is the read-only preparation path used by every release
# script through bundle/_lib.sh. It must consume, not mutate, the local file.
validate_marker dev DEV_SENTINEL_7f75c1
validate_marker prod PROD_SENTINEL_7f75c1
cmp -s "$WORK/expected-dev-overrides.json" "$DEV_OVERRIDE"
cmp -s "$WORK/expected-prod-overrides.json" "$PROD_OVERRIDE"

python3 - "$AUTHOR/databricks.yml" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
path.write_text(text.replace("tracked-default-v1", "tracked-default-v2"), encoding="utf-8")
PY
printf 'public revision two\n' >"$AUTHOR/README.md"
git -C "$AUTHOR" add databricks.yml README.md
git -C "$AUTHOR" commit --quiet -m "public revision two"
git -C "$AUTHOR" push --quiet "$REMOTE" HEAD:main

git -C "$CLONE" pull --ff-only --quiet
cmp -s "$WORK/expected-dev-overrides.json" "$DEV_OVERRIDE"
cmp -s "$WORK/expected-prod-overrides.json" "$PROD_OVERRIDE"
[[ -z "$(git -C "$CLONE" status --porcelain)" ]]
validate_marker dev DEV_SENTINEL_7f75c1
validate_marker prod PROD_SENTINEL_7f75c1
cmp -s "$WORK/expected-dev-overrides.json" "$DEV_OVERRIDE"
cmp -s "$WORK/expected-prod-overrides.json" "$PROD_OVERRIDE"

printf 'PASS  public clone, pull, and bundle validation preserved local overrides byte-for-byte.\n'
