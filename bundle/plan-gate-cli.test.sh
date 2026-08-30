#!/usr/bin/env bash
# Prove that a direct-planner panic fails closed without prescribing state edits.

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
  "COULD NOT RUN. 'databricks bundle plan' produced no output" \
  "OverrideChangeDesc" \
  "This is NOT a clean plan" \
  "databricks bundle plan -t customer --profile \"customer\"" \
  ".databricks/bundle/customer/variable-overrides.json"
do
  [[ "$OUTPUT" == *"$NEEDLE"* ]] || {
    printf 'FAIL  recovery output omitted: %s\n%s\n' "$NEEDLE" "$OUTPUT"
    exit 1
  }
done

[[ "$OUTPUT" != *"deployment unbind"* ]] || {
  printf 'FAIL  planner failure must not prescribe state mutation\n%s\n' "$OUTPUT"
  exit 1
}

printf 'PASS  direct-planner panic fails closed without state mutation guidance.\n'
