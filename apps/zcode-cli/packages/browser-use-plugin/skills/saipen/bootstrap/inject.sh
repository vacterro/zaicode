#!/usr/bin/env bash
# saipen injector (macOS/Linux) -- installs saipen as default on every agentic system found.
# Run from clone dir:  bash inject.sh
# Idempotent: re-run safe.
#
# Host inventory law (SRC-028:R008 / SRC-030 Part 7): every installed host,
# its surfaces and its blocking hook come from extensions/adapters/registry.json.
# This script contains NO handwritten host list; the per-adapter loop is
# data-driven, and only the three registry-declared bespoke installers
# (freebuff-backstop, aider-conf, antigravity-plugins) keep hand-written bodies.

set -u
FAILURES=0
# Optional host filter (T-1319 TARGET 1): --adapter NAME updates ONLY that
# registered adapter. Default empty = all-host behavior. The host inventory
# stays extensions/adapters/registry.json; this is a filter, never a list.
ADAPTER_FILTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --adapter) ADAPTER_FILTER="${2:-}"; shift 2 ;;
    --adapter=*) ADAPTER_FILTER="${1#*=}"; shift ;;
    *) shift ;;
  esac
done
SKILL_HOME="$(cd "$(dirname "$0")/../saipen" 2>/dev/null && pwd)"
# BOOT.md, not RFC.md: the sanity check must name the file the injected block
# actually sends agents to. RFC.md has been a redirect stub since the v7.190.0
# split, so a clone missing BOOT.md but carrying the stub would pass this guard
# and install an entry point with no rules behind it.
[ -f "$SKILL_HOME/BOOT.md" ] || { echo "FATAL: saipen/BOOT.md not found"; exit 1; }

# Under git bash / MSYS / Cygwin on Windows, `pwd` yields an MSYS path such as
# /v/proj/saipen. The agents that later READ these instructions are Windows
# programs, and they cannot open that form -- only the shell that produced it
# can. Writing it into CLAUDE.md hands every Windows user who ran the .sh
# injector a config pointing at files their agent will never find, and nothing
# reports an error: the block is present, the paths are simply dead.
# cygpath ships with git bash, so the conversion is free where it is needed
# and skipped entirely everywhere else.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    if command -v cygpath >/dev/null 2>&1; then
      SKILL_HOME="$(cygpath -w "$SKILL_HOME")"
    fi
    ;;
esac

ROOT="$(dirname "$SKILL_HOME")"
MANIFEST="$SKILL_HOME/MANIFEST.json"
[ -f "$MANIFEST" ] || { echo "FATAL: saipen/MANIFEST.json not found"; exit 1; }
REGISTRY="$ROOT/extensions/adapters/registry.json"
[ -f "$REGISTRY" ] || { echo "FATAL: extensions/adapters/registry.json not found"; exit 1; }
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN=python
else
  echo "FATAL: Python is required to parse saipen/MANIFEST.json safely"
  exit 1
fi
# The activation template path comes FROM the registry (one authority); this
# script never hardcodes it.
TEMPLATE_REL="$("$PYTHON_BIN" - "$REGISTRY" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    registry = json.load(handle)
template = registry.get("activation_template")
if not isinstance(template, str) or not template:
    sys.exit("registry names no activation_template")
print(template)
PY
)" || { echo "FATAL: adapter registry unreadable"; exit 1; }
TEMPLATE="$ROOT/$TEMPLATE_REL"
[ -f "$TEMPLATE" ] || { echo "FATAL: activation template missing: $TEMPLATE"; exit 1; }

manifest_query() {
  "$PYTHON_BIN" - "$MANIFEST" "$1" <<'PY'
import json
import sys
from pathlib import PurePosixPath

manifest_path, query = sys.argv[1:]
sys.stdout.reconfigure(newline="\n")
with open(manifest_path, encoding="utf-8") as handle:
    manifest = json.load(handle)

def safe(value):
    if not isinstance(value, str) or not value or "\\" in value or "|" in value:
        raise ValueError(f"unsafe runtime manifest path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"unsafe runtime manifest path: {value!r}")
    return value

managed = manifest.get("managed_dirs")
trees = manifest.get("copy_trees")
files = manifest.get("files")
phases = manifest.get("phase_docs", {}).get("files")
if not all(isinstance(group, list) and group for group in (managed, trees, files, phases)):
    raise ValueError("runtime manifest lacks nonempty managed_dirs/copy_trees/files/phase_docs.files")
managed = [safe(item) for item in managed]
trees = [(safe(item["src"]), safe(item["dst"])) for item in trees]
files = [safe(item["src"]) for item in files if item.get("required") is True]
phases = [safe(f"phases/{item}")[len("phases/"):] for item in phases]
if not files:
    raise ValueError("runtime manifest has no required files")
if query == "all":
    for item in managed:
        print(f"M|{item}|")
    for src, dst in trees:
        print(f"T|{src}|{dst}")
    for item in files:
        print(f"F|{item}|")
    for item in phases:
        print(f"P|{item}|")
else:
    raise ValueError(f"unknown manifest query: {query}")
PY
}

registry_query() {
  "$PYTHON_BIN" - "$REGISTRY" <<'PY'
import json
import sys

registry_path = sys.argv[1]
sys.stdout.reconfigure(newline="\n")
with open(registry_path, encoding="utf-8") as handle:
    registry = json.load(handle)
adapters = registry.get("adapters")
if not isinstance(adapters, list) or not adapters:
    sys.exit("adapter registry has no adapters")
for adapter in adapters:
    install = adapter.get("install") or {}
    def column(key):
        value = install.get(key)
        return value if isinstance(value, str) else ""
    artifact = adapter.get("hook_artifact")
    artifact = artifact if isinstance(artifact, str) else ""
    legacy = adapter.get("legacy_hook_surfaces")
    legacy = [s for s in legacy if isinstance(s, str)] if isinstance(legacy, list) else []
    print(
        "|".join(
            (
                str(adapter.get("id", "")),
                str(adapter.get("name", "")),
                column("home"),
                column("skill"),
                column("instruction"),
                column("hook"),
                artifact,
                column("bespoke"),
                ",".join(legacy),
                str(adapter.get("hook_installer") or ""),
            )
        )
    )
PY
}

adapter_surfaces() { # $1=adapter id; prints that adapter's declared instruction_surfaces, one per line
  "$PYTHON_BIN" - "$REGISTRY" "$1" <<'PY'
import json
import sys

registry_path, adapter_id = sys.argv[1], sys.argv[2]
sys.stdout.reconfigure(newline="\n")
with open(registry_path, encoding="utf-8") as handle:
    registry = json.load(handle)
for adapter in registry.get("adapters") or []:
    if str(adapter.get("id", "")) == adapter_id:
        for surface in adapter.get("instruction_surfaces") or []:
            if isinstance(surface, str) and surface:
                print(surface)
        break
PY
}

MANIFEST_ROWS=$(manifest_query all) \
  || { echo "FATAL: saipen/MANIFEST.json is invalid"; exit 1; }
[ -n "$MANIFEST_ROWS" ] \
  || { echo "FATAL: saipen/MANIFEST.json produced an empty inventory"; exit 1; }
ADAPTER_ROWS=$(registry_query) \
  || { echo "FATAL: adapter registry is invalid"; exit 1; }
[ -n "$ADAPTER_ROWS" ] \
  || { echo "FATAL: adapter registry produced an empty inventory"; exit 1; }
if [ -n "$ADAPTER_FILTER" ]; then
  printf '%s\n' "$ADAPTER_ROWS" | cut -d'|' -f1 | grep -qxF "$ADAPTER_FILTER" \
    || { echo "FATAL: unknown adapter id '$ADAPTER_FILTER'"; exit 1; }
fi

install_rel() {
  case "$1" in
    saipen/*) printf '%s\n' "${1#saipen/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

backup_file() {
  if [ -f "$1" ] && [ ! -f "$1.bak" ]; then
    cp "$1" "$1.bak" || { echo "backup FAILED ($1)"; return 1; }
  fi
}

# ONE activation template (SRC-028:R009 / SRC-030 Part 8): rendered from
# saipen/ACTIVATION_BLOCK.md with only the SAIPEN home substituted. Bash
# parameter expansion, not sed, so a home path containing backslashes or
# ampersands cannot corrupt the render.
TEMPLATE_TEXT="$(cat "$TEMPLATE")"
BLOCK="${TEMPLATE_TEXT//\{\{SAIPEN_HOME\}\}/$SKILL_HOME}"
BLOCK="${BLOCK%$'\n'}"
BLOCK="${BLOCK%$'\r'}"

add_block() { # $1=file
  # Compare content instead of stripping unconditionally, or every re-run
  # would rewrite an already-current block for no reason.
  local marker_status=1
  if [ -f "$1" ]; then
    grep -q "SAIPEN:BEGIN" "$1"
    marker_status=$?
    [ "$marker_status" -le 1 ] \
      || { echo "block marker read FAILED ($1)"; return 1; }
  fi
  if [ "$marker_status" -eq 0 ]; then
    local existing canonical
    existing=$(sed -n '/<!-- SAIPEN:BEGIN -->/,/<!-- SAIPEN:END -->/p' "$1") \
      || { echo "block read FAILED ($1)"; return 1; }
    canonical=$(printf '%s\n' "$BLOCK" | sed -n '/<!-- SAIPEN:BEGIN -->/,/<!-- SAIPEN:END -->/p') \
      || { echo "block render FAILED ($1)"; return 1; }
    if [ "$existing" = "$canonical" ]; then echo "already"; return; fi
    backup_file "$1" || return 1
    # sed's in-place suffix MUST NOT be plain .bak: backup_file() above owns
    # "$1.bak" and put the user's ORIGINAL, pre-SAIPEN file there on the FIRST
    # install. Using -i.bak here would overwrite that original with the
    # current, already-SAIPEN-containing content on every later refresh --
    # silently destroying the only copy of what the user had before us.
    # (Reproduced live 2026-07-26. uninstall.sh:6-10 carries the same warning
    # and inject.ps1's Write-NoBom is guarded; this was the last of the four.)
    if sed -i.saipen-strip-tmp '/<!-- SAIPEN:BEGIN -->/,/<!-- SAIPEN:END -->/d' "$1" 2>/dev/null \
       || sed -i '' '/<!-- SAIPEN:BEGIN -->/,/<!-- SAIPEN:END -->/d' "$1"; then
      rm -f "$1.saipen-strip-tmp" \
        || { echo "block cleanup FAILED ($1)"; return 1; }
    else
      rm -f "$1.saipen-strip-tmp" 2>/dev/null || true
      echo "block refresh FAILED ($1)"
      return 1
    fi
    printf '%s\n' "$BLOCK" >> "$1" \
      || { echo "block write FAILED ($1)"; return 1; }
    echo "block refreshed"
    return 0
  fi
  backup_file "$1" || return 1
  mkdir -p "$(dirname "$1")" \
    || { echo "directory create FAILED ($1)"; return 1; }
  # ACTIVATION_BLOCK.md begins at BEGIN. Own one separator explicitly so
  # uninstall.sh removes our byte, never the user's final newline.
  printf '\n%s\n' "$BLOCK" >> "$1" \
    || { echo "block write FAILED ($1)"; return 1; }
  echo "block added"
}

# SAIPEN-CLI-LAUNCHER-OWNERSHIP:BEGIN
# The canonical installer OWNS the installed `saipen` launcher surface: the
# `bin/saipen` / `bin/saipen.cmd` files are rendered from the ONE source owner
# (bootstrap/cli_launcher.py) into the STAGED skill before the atomic swap, so a
# render failure aborts the install and preserves the active copy. The OpenCode
# guard only verifies them, never writes them.
write_cli_launchers() { # $1=stage dir, $2=final skill dir
  local stage="$1" final_dst="$2" renderer py cli out
  [ -n "$stage" ] && [ -n "$final_dst" ] \
    || { echo "cli launcher render FAILED: stage/dst missing"; return 1; }
  renderer="$ROOT/bootstrap/cli_launcher.py"
  [ -f "$renderer" ] \
    || { echo "cli launcher render FAILED: renderer missing"; return 1; }
  py="${SAIPEN_PYTHON:-$PYTHON_BIN}"
  [ -n "$py" ] \
    || { echo "cli launcher render FAILED: no Python runtime"; return 1; }
  cli="$final_dst/tools/saipen.py"
  out="$stage/bin"
  "$PYTHON_BIN" "$renderer" --python "$py" --cli "$cli" --out-dir "$out" >/dev/null 2>&1 \
    || { echo "cli launcher render FAILED: renderer exited nonzero"; return 1; }
  [ -f "$out/saipen" ] && [ -f "$out/saipen.cmd" ] \
    || { echo "cli launcher render FAILED: files missing"; return 1; }
  echo "rendered"
}
# SAIPEN-CLI-LAUNCHER-OWNERSHIP:END

build_skill_stage() { # $1=empty stage, $2=final skill dir
  local stage="$1" final_dst="$2"
  local kind src rel target symlink
  while IFS='|' read -r kind src rel; do
    case "$kind" in
      M|P) ;;
      T)
        [ -d "$ROOT/$src" ] \
          || { echo "runtime manifest tree missing: $src"; return 1; }
        symlink=$(find "$ROOT/$src" -type l -print -quit) \
          || { echo "runtime manifest tree scan failed: $src"; return 1; }
        [ -z "$symlink" ] \
          || { echo "runtime manifest tree contains symlink: $symlink"; return 1; }
        target="$stage/$rel"
        mkdir -p "$(dirname "$target")" \
          && cp -R "$ROOT/$src" "$target" \
          || { echo "tree copy failed: $src"; return 1; }
        ;;
      F)
        rel="$(install_rel "$src")"
        [ -f "$ROOT/$src" ] \
          || { echo "runtime manifest file missing: $src"; return 1; }
        [ ! -L "$ROOT/$src" ] \
          || { echo "runtime manifest file is a symlink: $src"; return 1; }
        target="$stage/$rel"
        mkdir -p "$(dirname "$target")" \
          && cp "$ROOT/$src" "$target" \
          || { echo "file copy failed: $src"; return 1; }
        ;;
      *) echo "runtime manifest cache contains unknown row: $kind"; return 1 ;;
    esac
  done <<< "$MANIFEST_ROWS"

  find "$stage" -type d -name __pycache__ -prune -exec rm -rf {} + \
    && find "$stage" -type f \( -name '*.pyc' -o -name '*.pyo' \) -exec rm -f {} + \
    || { echo "bytecode cleanup failed"; return 1; }

  while IFS='|' read -r kind src rel; do
    case "$kind" in
      F)
        rel="$(install_rel "$src")"
        [ -f "$stage/$rel" ] \
          || { echo "staged runtime file missing: $src"; return 1; }
        ;;
      P)
        [ -f "$stage/phases/$src" ] \
          || { echo "staged phase document missing: $src"; return 1; }
        ;;
    esac
  done <<< "$MANIFEST_ROWS"

  # SAIPEN-CLI-LAUNCHER-OWNERSHIP:BEGIN
  local _launcher_out
  _launcher_out="$(write_cli_launchers "$stage" "$final_dst" 2>&1)" \
    || { echo "cli launcher render failed: $_launcher_out"; return 1; }
  # SAIPEN-CLI-LAUNCHER-OWNERSHIP:END
}

copy_skill() { # $1=dst
  # Build and verify a sibling stage before moving the old install. A failed
  # copy therefore leaves the active skill byte-for-byte untouched.
  local dst="${1%/}"
  [ -n "$dst" ] && [ "$dst" != "/" ] && [ "$dst" != "." ] || {
    echo "copy FAILED ($1) -- unsafe destination"; return 1
  }
  local parent leaf stage backup had_old=0
  parent="$(dirname "$dst")"
  leaf="$(basename "$dst")"
  stage="$parent/.$leaf.saipen-stage-$$"
  backup="$parent/.$leaf.saipen-backup-$$"
  mkdir -p "$parent" \
    || { echo "copy FAILED ($1) -- create destination parent"; return 1; }
  if [ -e "$stage" ] || [ -L "$stage" ] || [ -e "$backup" ] || [ -L "$backup" ]; then
    echo "copy FAILED ($1) -- stale staging/backup path exists; inspect before retry"
    return 1
  fi
  mkdir "$stage" \
    || { echo "copy FAILED ($1) -- create staging directory"; return 1; }
  if ! build_skill_stage "$stage" "$dst"; then
    rm -rf "$stage" 2>/dev/null || true
    echo "copy FAILED ($1) -- staged copy or verification failed"
    return 1
  fi
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    mv "$dst" "$backup" \
      || { rm -rf "$stage" 2>/dev/null || true; echo "copy FAILED ($1) -- preserve active install"; return 1; }
    had_old=1
  fi
  if ! mv "$stage" "$dst"; then
    [ "$had_old" -eq 0 ] || mv "$backup" "$dst" 2>/dev/null || true
    rm -rf "$stage" 2>/dev/null || true
    echo "copy FAILED ($1) -- activate staged install; old install restored"
    return 1
  fi
  if [ "$had_old" -eq 1 ] && ! rm -rf "$backup"; then
    echo "copy FAILED ($1) -- new install active but old backup cleanup failed: $backup"
    return 1
  fi
  echo "copied (re-run after updates)"
}

report() { # $1=label, remaining=function + args
  local label="$1" output status
  shift
  output=$("$@" 2>&1)
  status=$?
  printf '%-28s %s\n' "$label" "$output"
  [ "$status" -eq 0 ] || FAILURES=1
}

configure_aider() { # $1=config
  local A="$1" P="$SKILL_HOME/BOOT.md" S="$SKILL_HOME/STYLE.md"
  if [ ! -f "$A" ]; then
    mkdir -p "$(dirname "$A")" \
      && printf '# saipen protocol auto-loaded\nread:\n  - %s\n  - %s\n' "$P" "$S" > "$A" \
      || { echo "create FAILED ($A)"; return 1; }
    echo "created"
  else
    local p_status s_status read_status
    grep -qF "$P" "$A"; p_status=$?
    grep -qF "$S" "$A"; s_status=$?
    [ "$p_status" -le 1 ] && [ "$s_status" -le 1 ] \
      || { echo "read check FAILED ($A)"; return 1; }
    if [ "$p_status" -eq 0 ] && [ "$s_status" -eq 0 ]; then
      echo "already"
      return 0
    fi
    grep -q "^read:" "$A"; read_status=$?
    [ "$read_status" -le 1 ] \
      || { echo "read key check FAILED ($A)"; return 1; }
    if [ "$read_status" -eq 1 ]; then
      backup_file "$A" || return 1
      # Always add one separator byte. uninstall.sh removes that exact byte
      # with byte offsets, preserving CRLF/LF and surrounding user content.
      printf '\n# saipen protocol auto-loaded\nread:\n  - %s\n  - %s\n' "$P" "$S" >> "$A" \
        || { echo "write FAILED ($A)"; return 1; }
      echo "read: appended"
    else
      echo "has own read: - add manually: $P + $S"
    fi
  fi
}

copy_hook() { # $1=artifact source, $2=destination, $3=adapter id
  # One artifact file, copied over on every run (idempotent); uninstall
  # removes exactly this file and nothing else.
  local src="$1" dst="${2%/}" id="${3:-}"
  [ -f "$src" ] || { echo "hook FAILED -- artifact missing: $src"; return 1; }
  [ -n "$dst" ] && [ "$dst" != "/" ] && [ "$dst" != "." ] \
    || { echo "hook FAILED -- unsafe destination"; return 1; }
  mkdir -p "$(dirname "$dst")" \
    || { echo "hook FAILED -- create destination parent"; return 1; }
  cp "$src" "$dst" || { echo "hook FAILED ($dst)"; return 1; }
  local shipped_hash installed_hash
  shipped_hash="$("$PYTHON_BIN" -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$src")" \
    || { echo "hook FAILED -- shipped hash unreadable"; return 1; }
  installed_hash="$("$PYTHON_BIN" -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$dst")" \
    || { echo "hook FAILED -- installed hash unreadable"; return 1; }
  [ "$installed_hash" = "$shipped_hash" ] \
    || { echo "hook FAILED -- installed SHA-256 differs from shipped artifact"; return 1; }
  if [ "$id" = "opencode" ]; then
    echo "guard hook installed sha256=$installed_hash; already-running OpenCode processes require restart"
  else
    echo "guard hook installed sha256=$installed_hash"
  fi
}

remove_legacy_hook() { # $1=registry-declared legacy surface
  # The supported OpenCode runtime discovers BOTH the singular `plugin/` and
  # the plural `plugins/` global directories, so a stale copy of this one
  # artifact on the legacy surface would load the guard hook twice. The
  # injector removes that exact stale copy -- never a directory, never
  # anything else.
  local legacy="${1%/}"
  [ -n "$legacy" ] || { echo "clean"; return 0; }
  [ -f "$legacy" ] || { echo "clean"; return 0; }
  rm -f "$legacy" || { echo "legacy hook remove FAILED ($legacy)"; return 1; }
  echo "legacy hook removed"
}

expand_home() { # $1=registry path starting with ~
  printf '%s\n' "${1/#\~/$HOME}"
}

# --- T-1319 TARGET 2: install-time runtime provenance (mirrors inject.ps1) --
PROVENANCE_NAME=".saipen_runtime.json"

# T-1342: the installer generation label and the runtime fingerprint come from
# the ONE owner in this source tree's engine (runtime_bootstrap.GENERATION and
# runtime_surface), never from a private inventory here. Prints
# "<generation> <fingerprint>" for the root in $1; -I isolates the interpreter
# from PYTHONPATH/user site, -B keeps bytecode out of the tree being proven.
runtime_identity() { # $1=runtime root to prove
  "$PYTHON_BIN" -I -B - "$ROOT/tools" "$1" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from saipen_engine.runtime_bootstrap import GENERATION
from saipen_engine.runtime_surface import require_runtime_generation_identity
print(GENERATION, require_runtime_generation_identity(sys.argv[2]))
PY
}

write_provenance() { # $1=skill dst, $2=adapter id
  # Provenance is REQUIRED recovery state, not optional diagnostics: this
  # function surfaces a write/read-back failure so `report` marks the host
  # migration non-successful. Never `|| true` away the failure.
  local dst="$1" id="$2" version="" head="" fp="" generation="" source_id="" installed_id=""
  if [ -z "$dst" ] || [ ! -d "$dst" ]; then
    echo "provenance FAILED: skill dir missing"; return 1
  fi
  [ -f "$ROOT/VERSION" ] && version="$(tr -d '\r\n' < "$ROOT/VERSION")"
  head="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" || head=""
  source_id="$(runtime_identity "$ROOT" 2>/dev/null)" \
    || { echo "provenance FAILED: source runtime identity unprovable"; return 1; }
  installed_id="$(runtime_identity "$dst" 2>/dev/null)" \
    || { echo "provenance FAILED: installed runtime identity unprovable"; return 1; }
  generation="${source_id%% *}"
  fp="${source_id#* }"
  # The copy just made must BE the source generation, proven over its own
  # declared surface -- not assumed from a successful cp.
  [ "${installed_id#* }" = "$fp" ] \
    || { echo "provenance FAILED: installed runtime identity differs from source"; return 1; }
  SKILL_DST="$dst" ADAPTER_ID="$id" SOURCE_ROOT="$ROOT" SRC_VERSION="$version" \
    SRC_HEAD="$head" RUNTIME_FP="$fp" GENERATION="$generation" \
    PROV_NAME="$PROVENANCE_NAME" "$PYTHON_BIN" - <<'PY'
import json, os, pathlib, sys

root = os.path.abspath(os.environ["SOURCE_ROOT"])
expected = {
    "schema_version": 1,
    "adapter_id": os.environ["ADAPTER_ID"],
    "canonical_source_root": root,
    "source_version": os.environ.get("SRC_VERSION", ""),
    "source_build": os.environ.get("SRC_HEAD", ""),
    "runtime_fingerprint": os.environ.get("RUNTIME_FP", ""),
    "installer_generation": os.environ["GENERATION"],
}
marker = pathlib.Path(os.environ["SKILL_DST"]) / os.environ["PROV_NAME"]
try:
    marker.write_text(json.dumps(expected, indent=2) + "\n", encoding="utf-8")
except OSError as exc:
    sys.exit("provenance FAILED: write: %s" % exc)
if not marker.is_file():
    sys.exit("provenance FAILED: marker not written")
try:
    doc = json.loads(marker.read_text(encoding="utf-8"))
except (OSError, ValueError) as exc:
    sys.exit("provenance FAILED: unreadable marker: %s" % exc)
if not isinstance(doc, dict):
    sys.exit("provenance FAILED: marker not an object")
problems = []
if str(doc.get("adapter_id", "")) != expected["adapter_id"]:
    problems.append("adapter_id")
if str(doc.get("canonical_source_root", "")) != expected["canonical_source_root"]:
    problems.append("canonical_source_root")
if str(doc.get("installer_generation", "")) != expected["installer_generation"]:
    problems.append("installer_generation")
if not str(doc.get("runtime_fingerprint", "")).strip():
    problems.append("runtime_fingerprint-missing")
elif expected["runtime_fingerprint"] and str(doc["runtime_fingerprint"]) != expected["runtime_fingerprint"]:
    problems.append("runtime_fingerprint-mismatch")
if problems:
    sys.exit("provenance FAILED: invalid: " + ",".join(problems))
print("verified")
PY
}

echo "saipen injector (source: $SKILL_HOME)"
echo "------------------------------------------------------------"

# --- Data-driven host loop (extensions/adapters/registry.json is the only
# --- host inventory). Adapters without an `install` object install nothing.
while IFS='|' read -r id name home skill instruction hook artifact bespoke legacy installer; do
  [ -n "$id" ] || continue
  [ -n "$ADAPTER_FILTER" ] && [ "$id" != "$ADAPTER_FILTER" ] && continue
  if [ -n "$bespoke" ]; then
    case "$bespoke" in
      freebuff-backstop)
        # Generic ~/.agents/skills - positive host detection (not directory-exists-only)
        _agents_supported=0
        [ -d "$HOME/.config/opencode" ] && _agents_supported=1
        [ -d "$HOME/.codex" ] && _agents_supported=1
        [ -d "$HOME/.gemini" ] && _agents_supported=1
        [ -d "$HOME/.codebuddy" ] && _agents_supported=1
        [ -d "$HOME/.claude" ] && _agents_supported=1
        [ -d "$HOME/.agents" ] && _agents_supported=1
        command -v freebuff >/dev/null 2>&1 && _agents_supported=1
        command -v codebuddy >/dev/null 2>&1 && _agents_supported=1
        _agents_skill_dir="$HOME/.agents/skills/saipen"
        _agents_skill_installed=0
        if [ -d "$HOME/.agents/skills" ]; then
          report "~/.agents skills" copy_skill "$_agents_skill_dir" && _agents_skill_installed=1
        elif [ "$_agents_supported" -eq 1 ]; then
          report "~/.agents skills" copy_skill "$_agents_skill_dir" && _agents_skill_installed=1
        else printf '%-28s %s\n' "~/.agents" "not installed - skip"; fi
        if [ "$_agents_skill_installed" -eq 1 ]; then
          report "~/.agents provenance" write_provenance "$_agents_skill_dir" "$id"
        fi

        # FreeBuff always-on activation backstop
        # T-1426 live RED: FreeBuff ships TWO loaders with DIFFERENT home
        # knowledge contracts, so installing ONE surface leaves the other
        # loader blind:
        #   * the freebuff CLI reads the FIRST existing of ~/.knowledge.md,
        #     ~/.AGENTS.md, ~/.claude.md;
        #   * FreeBuff Desktop (orchestrator loadUserKnowledgeFiles) scans the
        #     home for DOT-prefixed entries only and reads the FIRST of
        #     .AGENTS.md, .CLAUDE.md -- ~/.knowledge.md is not a home surface
        #     for it at all.
        # Install ALL registry-declared instruction_surfaces; an either/or
        # choice here is exactly the defect class this backstop removes.
        _freebuff_detected=0
        [ -d "$HOME/.agents" ] && _freebuff_detected=1
        command -v freebuff >/dev/null 2>&1 && _freebuff_detected=1
        [ -d "$HOME/.agents/skills" ] && _freebuff_detected=1
        if [ "$_freebuff_detected" -eq 1 ]; then
          _fb_surfaces="$(adapter_surfaces freebuff)"
          if [ -z "$_fb_surfaces" ]; then
            printf '%-28s %s\n' "FreeBuff" "FAILED: registry declares no instruction_surfaces"
          fi
          for _surface in $_fb_surfaces; do
            report "FreeBuff $_surface" add_block "$(expand_home "$_surface")"
          done
        else printf '%-28s %s\n' "FreeBuff" "not installed - skip"; fi
        ;;
      aider-conf)
        # Aider boot set is BOOT.md + STYLE.md, same promise as every platform.
        if command -v aider >/dev/null 2>&1; then
          report "Aider conf" configure_aider "$HOME/.aider.conf.yml"
        else printf '%-28s %s\n' "Aider" "not installed - skip"; fi
        ;;
      antigravity-plugins)
        # Antigravity plugins (copy: IDE locks dirs, junction impossible while open)
        PLUG_ROOT="$HOME/.gemini/config/plugins"
        if [ -d "$PLUG_ROOT" ]; then
          for plugin_dir in "$PLUG_ROOT"/*/; do
            [ -d "$plugin_dir" ] || continue
            plugin_name="$(basename "$plugin_dir")"
            skills_dir="${plugin_dir}skills"
            if [ -d "$skills_dir" ]; then
              report "Antigravity [$plugin_name]" copy_skill "$skills_dir/saipen"
            fi
          done
        fi
        ;;
      *)
        printf '%-28s %s\n' "$name" "unknown bespoke installer '$bespoke' - skip"
        ;;
    esac
    continue
  fi

  _home=""
  [ -n "$home" ] && _home="$(expand_home "$home")"
  if [ -z "$_home" ] || [ ! -d "$_home" ]; then
    printf '%-28s %s\n' "$name" "not installed - skip"
    continue
  fi
  if [ -n "$skill" ]; then
    _skill_dst="$(expand_home "$skill")"
    report "$name skill" copy_skill "$_skill_dst"
    report "$name provenance" write_provenance "$_skill_dst" "$id"
  fi
  [ -n "$instruction" ] && report "$name instructions" add_block "$(expand_home "$instruction")"
  if [ -n "$installer" ]; then
    report "$name guard hook" "$PYTHON_BIN" "$ROOT/$installer" "$id" --home "$HOME"
  elif [ -n "$hook" ]; then
    report "$name guard hook" copy_hook "$ROOT/$artifact" "$(expand_home "$hook")" "$id"
  fi
  if [ -n "$legacy" ]; then
    IFS=',' read -r -a _legacy_surfaces <<< "$legacy"
    for _legacy_surface in "${_legacy_surfaces[@]}"; do
      [ -n "$_legacy_surface" ] || continue
      report "$name legacy hook" remove_legacy_hook "$(expand_home "$_legacy_surface")"
    done
  fi
done <<< "$ADAPTER_ROWS"

echo "------------------------------------------------------------"
if [ "$FAILURES" -ne 0 ]; then
  echo "FAILED. Fix reported errors and re-run."
  exit 1
fi
echo "Done. Test: open any project in any agent, say: saipen set"
