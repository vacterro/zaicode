#!/usr/bin/env bash
# saipen state exporter (macOS/Linux)
set -u

EXPLICIT_ROOT=""
EXPLICIT_ROOT_SET=0
case "$#" in
  0) ;;
  1)
    case "$1" in
      --project-root=*) EXPLICIT_ROOT=${1#--project-root=}; EXPLICIT_ROOT_SET=1 ;;
      *) echo "Use: $0 [--project-root PATH]"; exit 1 ;;
    esac
    ;;
  2)
    [ "$1" = "--project-root" ] \
      || { echo "Use: $0 [--project-root PATH]"; exit 1; }
    EXPLICIT_ROOT=$2
    EXPLICIT_ROOT_SET=1
    ;;
  *) echo "Use: $0 [--project-root PATH]"; exit 1 ;;
esac

resolve_project_root() {
  local start root top common common_leaf common_parent parent
  start=$(pwd -P) || return 1
  if [ "$EXPLICIT_ROOT_SET" -eq 1 ]; then
    [ -n "$EXPLICIT_ROOT" ] \
      || { echo "FAILED: explicit project root requires a non-empty path" >&2; return 1; }
    root=$(cd "$EXPLICIT_ROOT" 2>/dev/null && pwd -P) \
      || { echo "FAILED: explicit project root is not a directory: $EXPLICIT_ROOT" >&2; return 1; }
    [ -d "$root/.saipen" ] \
      || { echo "FAILED: explicit project root has no .saipen: $root" >&2; return 1; }
    printf '%s\n' "$root"
    return 0
  fi

  if top=$(git -C "$start" rev-parse --show-toplevel 2>/dev/null); then
    common=$(git -C "$start" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
      || { echo "FAILED: cannot resolve Git common directory from $start" >&2; return 1; }
    common=$(cd "$common" 2>/dev/null && pwd -P) \
      || { echo "FAILED: Git common directory is not accessible: $common" >&2; return 1; }
    common_leaf=${common##*/}
    common_parent=$(dirname "$common")
    case "$common_leaf" in
      .[Gg][Ii][Tt])
        if [ -d "$common_parent/.saipen" ]; then root=$common_parent; else root=$top; fi
        ;;
      *) root=$top ;;
    esac
    root=$(cd "$root" 2>/dev/null && pwd -P) \
      || { echo "FAILED: resolved Git project root is not accessible: $root" >&2; return 1; }
    [ -d "$root/.saipen" ] \
      || { echo "FAILED: Git project root owns no .saipen: $root; pass --project-root PATH to export another project" >&2; return 1; }
    printf '%s\n' "$root"
    return 0
  fi

  root=$start
  while :; do
    if [ -d "$root/.saipen" ]; then printf '%s\n' "$root"; return 0; fi
    parent=$(dirname "$root")
    [ "$parent" != "$root" ] || break
    root=$parent
  done
  echo "FAILED: no owning .saipen found from $start" >&2
  return 1
}

PROJECT_ROOT=$(resolve_project_root) || exit 1
SAIPEN_DIR="$PROJECT_ROOT/.saipen"

# T-1017: collision-safe export naming. Two exports within one second MUST
# both survive -- never silently overwrite a prior backup, so pick the next
# free name with a monotonic suffix instead of clobbering.
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BASE_NAME="saipen_export_${TIMESTAMP}"
TAR_PATH="$PROJECT_ROOT/${BASE_NAME}.tar.gz"
SUFFIX=1
while [ -e "$TAR_PATH" ]; do
    TAR_PATH="$PROJECT_ROOT/${BASE_NAME}_${SUFFIX}.tar.gz"
    SUFFIX=$((SUFFIX + 1))
done

# Build through a temporary artifact in the same directory, then atomically
# promote -- a failed export never leaves a partial-looking backup.
TMP_PATH="$PROJECT_ROOT/.${BASE_NAME}.tmp.$$.tar.gz"
rm -f "$TMP_PATH"

echo "saipen STATE-ONLY exporter (NO implementation files)"
echo "------------------------------------------------------------"
echo "Archiving: $SAIPEN_DIR"
if ! tar -czf "$TMP_PATH" --exclude='.saipen/quarantine' -C "$PROJECT_ROOT" .saipen; then
    echo "FAILED: tar exited non-zero"
    rm -f "$TMP_PATH"
    exit 1
fi
if [ ! -s "$TMP_PATH" ]; then
    echo "FAILED: archive missing or empty at $TMP_PATH after tar reported success"
    rm -f "$TMP_PATH"
    exit 1
fi
if ! mv "$TMP_PATH" "$TAR_PATH"; then
    echo "FAILED: could not promote temporary archive to $TAR_PATH"
    rm -f "$TMP_PATH"
    exit 1
fi
echo "Done. Export saved to: $TAR_PATH"
echo "------------------------------------------------------------"
