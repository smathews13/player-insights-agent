#!/usr/bin/env bash
# Install the repository's Genie Code skills as workspace skills.
#
#   TARGET=<target> PROFILE=<profile> bash bundle/genie-skills.sh [--apply]
#
# Copies each folder under genie/skills/ to /Workspace/.assistant/skills/<name>/,
# where Genie Code loads skills for everyone in the workspace. Without --apply it
# lists what would be installed. Creating the workspace skills folder needs a
# workspace admin; after that, write access to the folder is enough. A skill that
# already exists is overwritten, and skills this repository does not ship are
# left alone.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

APPLY=0
case "${1:-}" in
  "") ;;
  --apply) APPLY=1 ;;
  *) die "Unknown option '${1}'. Use --apply, or nothing to list the skills." ;;
esac

require_cmd databricks
resolve_profile

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/genie/skills"
DEST="/Workspace/.assistant/skills"

skills=()
for dir in "$SOURCE"/*/; do
  [[ -f "$dir/SKILL.md" ]] && skills+=("$(basename "$dir")")
done
[[ ${#skills[@]} -gt 0 ]] || die "No skills under $SOURCE."

step "Genie Code workspace skills"
for skill in "${skills[@]}"; do note "$skill -> $DEST/$skill"; done
if [[ $APPLY -eq 0 ]]; then
  note "Nothing changed. Re-run with --apply to install."
  exit 0
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/pia-genie-skills.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT INT TERM

databricks workspace mkdirs "$DEST" --profile "$PROFILE" \
  || die "Could not create $DEST. Creating the workspace skills folder needs a workspace admin."
for skill in "${skills[@]}"; do
  mkdir -p "$STAGE/$skill"
  (cd "$SOURCE/$skill" && find . -type f ! -path '*/__pycache__/*' ! -name '*.pyc' -print0 \
    | while IFS= read -r -d '' file; do
        mkdir -p "$STAGE/$skill/$(dirname "$file")"
        cp "$file" "$STAGE/$skill/$file"
      done)
  databricks workspace import-dir "$STAGE/$skill" "$DEST/$skill" --overwrite --profile "$PROFILE" >/dev/null \
    || die "Could not install $skill."
  note "installed $skill"
done
note "Start a new Genie Code chat to pick up changes."
