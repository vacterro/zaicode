#!/usr/bin/env bash
set -eu
cd /v/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/zcode
export PATH="/v/_TEMP_/t220-pinned-node:/v/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/.tools/pnpm10/node_modules/.bin:$PATH"
node='/v/_TEMP_/t220-pinned-node/node.exe'
log='/v/_TEMP_/t220-phase0-gates.log'
status='/v/_TEMP_/t220-phase0-gates.status'
printf 'RUNNING\n' > "$status"
exec > "$log" 2>&1
trap 'code=$?; printf "EXIT=%s\n" "$code" > "$status"' EXIT
"$node" ../.tools/pnpm10/node_modules/pnpm/bin/pnpm.cjs --version
"$node" --test scripts/zaicode-build-identity.test.mjs
"$node" --import tsx --test packages/desktop/test/zaicodeRuntimeIdentity.test.ts packages/desktop/test/zaicodeSubscriptionProxy.test.ts
"$node" ../.tools/pnpm10/node_modules/pnpm/bin/pnpm.cjs test
export ZCODE_DESKTOP_DIST_DIR=dist-t220
export ZAICODE_BUILD_CHANNEL=test
"$node" scripts/bundle-zaicode.mjs --os win --arch x64
printf 'ALL_GATES_PASSED\n'
