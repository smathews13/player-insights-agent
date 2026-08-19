#!/usr/bin/env bash
# Prove that a direct-planner panic prints the selective state recovery.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pia-plan-gate-cli.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/databricks" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' \
  'panic: runtime error: invalid memory address or nil pointer dereference' \
  'databricks/cli/bundle/direct/dresources.(*ResourceApp).OverrideChangeDesc' >&2
exit 139
EOF
chmod +x "$TMP/databricks"

set +e
OUTPUT="$(
  PATH="$TMP:$PATH" TARGET=customer PROFILE=customer \
    "$HERE/plan-gate.sh" 2>&1
)"
STATUS=$?
set -e

[[ "$STATUS" -eq 2 ]] || {
  printf 'FAIL  expected exit 2, got %s\n%s\n' "$STATUS" "$OUTPUT"
  exit 1
}

for NEEDLE in \
  "deployment unbind player_insights_app" \
  "deployment unbind player_insights_schema" \
  "Run only the line for each resource you confirmed is already absent." \
  "Do NOT remove the whole state directory" \
  "deleted app also removes the stale endpoint binding"
do
  [[ "$OUTPUT" == *"$NEEDLE"* ]] || {
    printf 'FAIL  recovery output omitted: %s\n%s\n' "$NEEDLE" "$OUTPUT"
    exit 1
  }
done

printf 'PASS  direct-planner panic prints selective state recovery.\n'
