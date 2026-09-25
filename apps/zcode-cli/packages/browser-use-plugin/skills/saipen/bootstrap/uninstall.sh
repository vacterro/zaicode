#!/usr/bin/env bash
# saipen uninstaller (macOS/Linux)
set -u
FAILURES=0
END_MARKER='<!-- SAIPEN:END -->'

strip_block() {
  # sed's in-place suffix MUST NOT be plain .bak: inject.sh's backup_file()
  # already owns "$1.bak" and put the user's ORIGINAL, pre-SAIPEN file there.
  # Using -i.bak here would overwrite that original with the current
  # SAIPEN-containing content, and the cleanup rm would then delete it --
  # uninstalling would silently destroy the very backup installing made.
  local marker_status=1
  if [ -f "$1" ]; then
    grep -q "SAIPEN:BEGIN" "$1"
    marker_status=$?
    [ "$marker_status" -le 1 ] \
      || { echo "block marker read FAILED ($1)"; return 1; }
  fi
  if [ "$marker_status" -eq 0 ]; then
    # Deleting only BEGIN..END is not a clean reverse of what inject.sh did:
    # its $BLOCK starts with a newline, so each install adds one blank line
    # that a plain range-delete leaves behind. Measured: install+uninstall
    # five times grew a 2-line CLAUDE.md to 7 lines, one stray line per
    # cycle, forever -- while README promises we leave the rest of the file
    # alone. Drop exactly ONE newline immediately before BEGIN (the one we
    # added) and the newline after END, copying every other byte untouched.
    # Text processors are wrong here: Git Bash awk converts CRLF to LF.
    cp "$1" "$1.uninstalled.bak" \
      || { echo "backup FAILED ($1)"; return 1; }
    local begin_line end_line begin end file_size prefix_count suffix_start
    begin_line=$(grep -b -m1 '^<!-- SAIPEN:BEGIN -->' "$1") \
      || { echo "block BEGIN read FAILED ($1)"; return 1; }
    end_line=$(grep -b -m1 '^<!-- SAIPEN:END -->' "$1") \
      || { echo "block END read FAILED ($1)"; return 1; }
    begin=${begin_line%%:*}
    end=${end_line%%:*}
    file_size=$(wc -c < "$1") \
      || { echo "block size read FAILED ($1)"; return 1; }
    prefix_count=$((begin > 0 ? begin - 1 : 0))
    suffix_start=$((end + ${#END_MARKER} + 1))
    : > "$1.saipen-strip-tmp" \
      && { [ "$prefix_count" -eq 0 ] || head -c "$prefix_count" "$1" >> "$1.saipen-strip-tmp"; } \
      && { [ "$suffix_start" -ge "$file_size" ] || tail -c "+$((suffix_start + 1))" "$1" >> "$1.saipen-strip-tmp"; } \
      && mv "$1.saipen-strip-tmp" "$1" \
      || { rm -f "$1.saipen-strip-tmp" 2>/dev/null || true; echo "block remove FAILED ($1)"; return 1; }
    echo "block removed"
  else
    echo "clean"
  fi
}

rm_skill() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    if rm -rf "$1"; then
      echo "skill removed"
    else
      echo "remove FAILED ($1)"
      return 1
    fi
  else
    echo "clean"
  fi
}

rm_aider() {
  # Remove exactly the block the injector wrote: the comment line, the
  # read: key that immediately follows it, and the consecutive saipen
  # BOOT/STYLE items -- never any other read: line the user owns.
  if [ -f "$1" ]; then
    local managed_status manual_status
    grep -q "# saipen protocol auto-loaded" "$1"; managed_status=$?
    [ "$managed_status" -le 1 ] \
      || { echo "aider marker read FAILED ($1)"; return 1; }
    if [ "$managed_status" -eq 0 ]; then
      cp "$1" "$1.uninstalled.bak" \
        || { echo "backup FAILED ($1)"; return 1; }
      # Byte offsets, not sed/awk: Git Bash text processors normalize CRLF in
      # untouched user lines. The injector adds LF before BEGIN; an editor may
      # normalize that managed separator and its block to CRLF.
      local begin_line end_line begin end file_size line_size
      local begin_number read_number boot_number style_number
      local begin_no prefix_count suffix_start separator_hex
      begin_line=$(grep -b -m1 '^# saipen protocol auto-loaded[[:space:]]*$' "$1") \
        || { echo "aider BEGIN read FAILED ($1)"; return 1; }
      begin=${begin_line%%:*}
      begin_number=$(grep -n -m1 '^# saipen protocol auto-loaded[[:space:]]*$' "$1")
      begin_no=${begin_number%%:*}
      read_number=$(grep -n '^read:[[:space:]]*$' "$1" | awk -F: -v at="$((begin_no + 1))" '$1 == at { print; exit }')
      boot_number=$(grep -n 'saipen[/\\]BOOT\.md[[:space:]]*$' "$1" | awk -F: -v at="$((begin_no + 2))" '$1 == at { print; exit }')
      style_number=$(grep -n 'saipen[/\\]STYLE\.md[[:space:]]*$' "$1" | awk -F: -v at="$((begin_no + 3))" '$1 == at { print; exit }')
      [ -n "$read_number" ] && [ -n "$boot_number" ] && [ -n "$style_number" ] \
        || { echo "aider managed BOOT/STYLE block malformed ($1)"; return 1; }
      end_line=$(grep -b 'saipen[/\\]STYLE\.md[[:space:]]*$' "$1" |
        awk -F: -v floor="$begin" '$1 > floor { print; exit }')
      [ -n "$end_line" ] || { echo "aider END read FAILED ($1)"; return 1; }
      end=${end_line%%:*}
      file_size=$(wc -c < "$1") \
        || { echo "aider size read FAILED ($1)"; return 1; }
      line_size=$(tail -c "+$((end + 1))" "$1" | head -n 1 | wc -c) \
        || { echo "aider END size FAILED ($1)"; return 1; }
      separator_hex=$(head -c "$begin" "$1" | tail -c 2 | od -An -tx1 | tr -d ' \r\n')
      if [ "$separator_hex" = "0d0a" ]; then
        prefix_count=$((begin > 1 ? begin - 2 : 0))
      else
        prefix_count=$((begin > 0 ? begin - 1 : 0))
      fi
      suffix_start=$((end + line_size))
      : > "$1.tmp" \
        && { [ "$prefix_count" -eq 0 ] || head -c "$prefix_count" "$1" >> "$1.tmp"; } \
        && { [ "$suffix_start" -ge "$file_size" ] || tail -c "+$((suffix_start + 1))" "$1" >> "$1.tmp"; } \
        && mv "$1.tmp" "$1" \
        || { rm -f "$1.tmp" 2>/dev/null || true; echo "aider clean FAILED ($1)"; return 1; }
      echo "aider conf cleaned"
    else
      grep -q "saipen/BOOT.md" "$1"; manual_status=$?
      [ "$manual_status" -le 1 ] \
        || { echo "aider path read FAILED ($1)"; return 1; }
      if [ "$manual_status" -eq 0 ]; then
        echo "manual aider conf (please remove manually)"
      else
        echo "clean"
      fi
    fi
  else
    echo "clean"
  fi
}

task_exists() {
  schtasks /Query /TN "$1" >/dev/null 2>&1 && return 0
  # A successful all-task query proves Task Scheduler is reachable, so only
  # this name is absent. If that query also fails, access/service state is
  # unknown and cleanup must fail closed instead of deleting the wrapper.
  schtasks /Query /FO CSV /NH >/dev/null 2>&1 && return 1
  return 2
}

rm_task() {
  # Machine-global: the sandboxed injector probe must not delete a real
  # scheduler entry, so it sets SAIPEN_UNINSTALL_SKIP_TASK (T-531/T-534).
  if [ -n "${SAIPEN_UNINSTALL_SKIP_TASK:-}" ]; then echo "clean"; return 0; fi
  local task rc artifact removed=0 failed=0
  if command -v schtasks >/dev/null 2>&1; then
    for task in saipen-inject saipen-autoinject; do
      task_exists "$task"
      rc=$?
      if [ "$rc" -eq 1 ]; then continue; fi
      if [ "$rc" -ne 0 ]; then
        echo "$task query FAILED"
        failed=1
        continue
      fi
      if schtasks /Delete /TN "$task" /F >/dev/null 2>&1; then
        removed=1
      else
        rc=$?
        echo "$task remove FAILED (schtasks rc $rc)"
        failed=1
      fi
    done
  fi
  [ "$failed" -eq 0 ] || return 1

  local runtime_root="${LOCALAPPDATA:-}" wrapper=""
  if [ -n "$runtime_root" ]; then
    if command -v cygpath >/dev/null 2>&1; then
      runtime_root=$(cygpath -u "$runtime_root") \
        || { echo "runtime path conversion FAILED"; return 1; }
    fi
    wrapper="$runtime_root/saipen/schedule-run-hidden.vbs"
    if [ -e "$wrapper" ]; then
      rm -f "$wrapper" \
        || { echo "wrapper remove FAILED ($wrapper)"; return 1; }
      removed=1
    fi
    for artifact in "$runtime_root/saipen/scheduled-source" \
                    "$runtime_root/saipen"/scheduled-source-previous* \
                    "$runtime_root/saipen"/source-* \
                    "$runtime_root/saipen"/inject-*.log; do
      [ -e "$artifact" ] || continue
      rm -rf -- "$artifact" \
        || { echo "runtime source remove FAILED ($artifact)"; return 1; }
      removed=1
    done
  fi
  if [ "$removed" -eq 1 ]; then echo "scheduler artifacts removed"; else echo "clean"; fi
}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SAIPEN_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
ADAPTER_REGISTRY="$SAIPEN_ROOT/extensions/adapters/registry.json"

json_reader() {
  local candidate
  for candidate in "${PYTHON_BIN:-}" python3 python py; do
    [ -n "$candidate" ] || continue
    command -v "$candidate" >/dev/null 2>&1 && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

remove_hooks() {
  # Hook surfaces come from the ONE adapter registry, never a second
  # handwritten host inventory. A machine with no JSON reader cannot prove
  # which blocking guard hooks it installed, so that is reported as a failure
  # instead of claiming the machine is clean while a hook remains.
  local reader surfaces surface removed=0
  reader=$(json_reader) \
    || { echo "no JSON reader: cannot identify installed guard hooks"; return 1; }
  [ -f "$ADAPTER_REGISTRY" ] \
    || { echo "adapter registry missing: $ADAPTER_REGISTRY"; return 1; }
  surfaces=$("$reader" - "$ADAPTER_REGISTRY" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    registry = json.load(handle)
for adapter in registry.get("adapters") or []:
    install = adapter.get("install") or {}
    hook = install.get("hook")
    if isinstance(hook, str) and hook:
        print(hook)
    legacy = adapter.get("legacy_hook_surfaces") or []
    if isinstance(legacy, list):
        for surface in legacy:
            if isinstance(surface, str) and surface:
                print(surface)
PY
  ) || { echo "adapter registry read FAILED"; return 1; }
  while IFS= read -r surface; do
    [ -n "$surface" ] || continue
    surface="${surface/#\~/$HOME}"
    [ -e "$surface" ] || continue
    rm -f "$surface" \
      || { echo "hook remove FAILED ($surface)"; return 1; }
    removed=1
  done <<< "$surfaces"
  if [ "$removed" -eq 1 ]; then echo "guard hook removed"; else echo "clean"; fi
}

report() { # $1=label, remaining=function + args
  local label="$1" output status
  shift
  output=$("$@" 2>&1)
  status=$?
  printf '%-28s %s\n' "$label" "$output"
  [ "$status" -eq 0 ] || FAILURES=1
}

echo "saipen uninstaller"
echo "------------------------------------------------------------"
report "Claude Code skill" rm_skill "$HOME/.claude/skills/saipen"
report "Claude Code CLAUDE.md" strip_block "$HOME/.claude/CLAUDE.md"
report "OpenCode skill" rm_skill "$HOME/.config/opencode/skills/saipen"
report "OpenCode AGENTS.md" strip_block "$HOME/.config/opencode/AGENTS.md"
# Removes every registry-declared guard hook surface, including the legacy
# singular `plugin/` copy that the supported runtime would load a second time.
report "guard hooks" remove_hooks
report "Codex skill" rm_skill "$HOME/.codex/skills/saipen"
report "Codex AGENTS.md" strip_block "$HOME/.codex/AGENTS.md"
report "Gemini GEMINI.md" strip_block "$HOME/.gemini/GEMINI.md"
report "~/.agents skills" rm_skill "$HOME/.agents/skills/saipen"
PLUG_ROOT="$HOME/.gemini/config/plugins"
if [ -d "$PLUG_ROOT" ]; then
  for plugin_dir in "$PLUG_ROOT"/*/; do
    [ -d "$plugin_dir" ] || continue
    plugin_name="$(basename "$plugin_dir")"
    report "Antigravity [$plugin_name]" rm_skill "${plugin_dir}skills/saipen"
  done
fi
report "Aider conf" rm_aider "$HOME/.aider.conf.yml"
# Task Scheduler is Windows-only; runtime snapshot cleanup is portable.
report "scheduled inject task" rm_task
echo "------------------------------------------------------------"
if [ "$FAILURES" -ne 0 ]; then
  echo "FAILED. Fix reported errors and re-run."
  exit 1
fi
echo "Done. SAIPEN global hooks removed."
