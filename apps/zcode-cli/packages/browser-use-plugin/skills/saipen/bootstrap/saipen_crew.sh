#!/usr/bin/env sh
# saipen_crew.sh -- open three crew terminals at the project root (Unix/macOS).
# Each window shows the one command to type into the agent you start there.
# See extensions/subs/crew.md. Falls back to printing the commands if no
# terminal emulator is found.
PROJ="$(cd "$(dirname "$0")/.." && pwd)"

run_detached() {
  "$@" &
  pid=$!
  sleep "${SAIPEN_CREW_LAUNCH_GRACE:-1}"
  if kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  wait "$pid"
}

launch() { # $1=title  $2=hint line
  attempted=0
  if command -v gnome-terminal >/dev/null 2>&1; then
    attempted=1
    if run_detached gnome-terminal --title="$1" --working-directory="$PROJ" \
        -- sh -c "echo '$2'; exec sh"; then return 0; fi
  fi
  if command -v konsole >/dev/null 2>&1; then
    attempted=1
    if run_detached konsole --new-tab -p tabtitle="$1" --workdir "$PROJ" \
        -e sh -c "echo '$2'; exec sh"; then return 0; fi
  fi
  if command -v xterm >/dev/null 2>&1; then
    attempted=1
    if run_detached xterm -T "$1" \
        -e "cd '$PROJ'; echo '$2'; exec sh"; then return 0; fi
  fi
  if [ "$(uname)" = "Darwin" ] && command -v osascript >/dev/null 2>&1; then
    attempted=1
    if run_detached osascript -e \
        "tell application \"Terminal\" to do script \"cd '$PROJ'; echo '$2'\""; then
      return 0
    fi
  fi
  if [ "$attempted" -eq 0 ]; then
    echo "  [$1]  cd '$PROJ'  then type in your agent:  $2"
    return 2
  fi
  echo "FAILED: no terminal launcher accepted [$1]" >&2
  return 1
}

echo "SAIPEN crew launcher -- optional manual multi-window helper "
        "(never what \`saipen crew\` means; project: $PROJ)"
launched=0
printed=0
failed=0
for crew_spec in \
  "SAIPEN MAIN|MAIN / Core writer  -> type: saipen continue" \
  "SAIPEN saihunt|saihunt / sensor    -> type: saihunt   (spawn+adopt, hunt on loop)" \
  "SAIPEN saipython|saipython / fixer   -> type: saipython (spawn+adopt, fix in pen, OUTBOX)"
do
  title=${crew_spec%%|*}
  hint=${crew_spec#*|}
  launch "$title" "$hint"
  status=$?
  case "$status" in
    0) launched=$((launched + 1)) ;;
    2) printed=$((printed + 1)) ;;
    *) failed=$((failed + 1)) ;;
  esac
done

if [ "$failed" -ne 0 ]; then
  echo "FAILED: $failed of 3 crew windows were not launched" >&2
  exit 1
fi
if [ "$launched" -eq 3 ]; then
  echo "Done. Launched 3 crew windows. In MAIN, gather workers with: saipen sub collect"
else
  echo "No terminal emulator found. Printed $printed crew commands; launched 0 windows."
fi
