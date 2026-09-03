#!/usr/bin/env bash
# Safety boundary for the mutable Workspace directory used to stage App source.
# Sourced by app-release.sh and directly exercised by app-source-staging.test.sh.

app_staging_error() {
  printf 'unsafe app staging path: %s\n' "$*" >&2
  return 1
}

validate_app_staging_path() {
  local path="${1:-}" app_name="${2:-}" actor="${3:-}"
  local expected_parent basename

  if [[ -z "$path" ]]; then
    app_staging_error "path is empty"
    return
  fi
  if [[ -z "$app_name" || "$app_name" == */* || "$app_name" == "." || "$app_name" == ".." ]]; then
    app_staging_error "app name is empty or malformed"
    return
  fi
  if [[ -z "$actor" || "$actor" == */* || "$actor" == "." || "$actor" == ".." ]]; then
    app_staging_error "workspace actor is empty or malformed"
    return
  fi

  expected_parent="/Workspace/Users/$actor"
  if [[ "$path" != "$expected_parent/"* ]]; then
    app_staging_error "must be directly below $expected_parent"
    return
  fi
  if [[ "${path#"$expected_parent/"}" == */* ]]; then
    app_staging_error "must be one app-specific directory directly below $expected_parent"
    return
  fi
  if [[ "$path" == *"/../"* || "$path" == *"/./"* || "$path" == */.. || "$path" == */. ]]; then
    app_staging_error "relative traversal is forbidden"
    return
  fi

  basename="${path##*/}"
  case "$basename" in
    "$app_name-src"|"$app_name-real-src"|"$app_name-app-source") ;;
    *) app_staging_error "basename '$basename' does not identify app '$app_name' with an approved source suffix" ;;
  esac
}

assert_active_deployment_is_snapshotted() {
  local source_path="$1"
  python3 -c '
import json
import sys

source_path = sys.argv[1]
body = json.load(sys.stdin)
active = body.get("active_deployment")
if not active:
    print("greenfield")
    raise SystemExit(0)

mode = str(active.get("mode") or "")
artifact = str((active.get("deployment_artifacts") or {}).get("source_code_path") or "")
if mode != "SNAPSHOT":
    shown_mode = mode or "<empty>"
    raise SystemExit(f"active deployment mode is {shown_mode}, not SNAPSHOT")
if not artifact or artifact == source_path:
    raise SystemExit("active deployment has no separate stable snapshot source path")
if not artifact.startswith("/Workspace/Users/") or "/src/" not in artifact:
    raise SystemExit("active deployment artifact is not in the platform snapshot namespace")
print("snapshot")
' "$source_path"
}

app_source_manifest_summary() {
  local source_dir="$1"
  python3 - "$source_dir" <<'PY'
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
if not root.is_dir():
    raise SystemExit(f"deploy artifact directory is missing: {root}")

entries = []
for path in sorted(item for item in root.rglob("*") if item.is_file()):
    content = path.read_bytes()
    entries.append(
        {
            "path": path.relative_to(root).as_posix(),
            "size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
    )
manifest = json.dumps(entries, ensure_ascii=True, separators=(",", ":")).encode()
print(f"{len(entries)}\t{sum(entry['size'] for entry in entries)}\t{hashlib.sha256(manifest).hexdigest()}")
PY
}

clean_and_import_app_source() {
  local source_dir="$1" source_path="$2" app_name="$3" profile="$4"
  local actor app_json snapshot_state status_json status=0 object_type

  actor="$(
    databricks current-user me --profile "$profile" -o json \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("user_name") or d.get("userName") or "")'
  )" || return
  validate_app_staging_path "$source_path" "$app_name" "$actor" || return

  app_json="$(databricks apps get "$app_name" --profile "$profile" -o json)" || return
  snapshot_state="$(printf '%s' "$app_json" | assert_active_deployment_is_snapshotted "$source_path")" || return
  if [[ "$snapshot_state" == "greenfield" ]]; then
    printf '  no active deployment yet; there is no running source dependency to preserve\n'
  else
    printf '  active deployment uses a platform SNAPSHOT; mutable staging can be replaced safely\n'
  fi

  status_json="$(databricks workspace get-status "$source_path" --profile "$profile" -o json 2>&1)" || status=$?
  if [[ "$status" -eq 0 ]]; then
    object_type="$(
      printf '%s' "$status_json" \
        | python3 -c 'import json,sys; print((json.load(sys.stdin).get("object_type") or "").upper())'
    )" || return
    if [[ "$object_type" != "DIRECTORY" ]]; then
      app_staging_error "configured source exists but is not a directory"
      return
    fi
    printf '  deleting only the validated mutable staging directory: %s\n' "$source_path"
    databricks workspace delete "$source_path" --recursive --profile "$profile" || return
  elif [[ "$status_json" == *"RESOURCE_DOES_NOT_EXIST"* ]]; then
    printf '  staging directory does not exist yet; no cleanup needed\n'
  else
    printf '%s\n' "$status_json" >&2
    return "$status"
  fi

  databricks workspace import-dir "$source_dir" "$source_path" --overwrite --profile "$profile"
}
