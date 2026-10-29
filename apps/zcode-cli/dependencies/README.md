# Repository dependencies

This directory contains versioned third-party artifacts required by ZCode packaging.
Keep the original archives in Git; extracted binaries and build caches belong in
the existing ignored output directories.

## Native search

`native-search/<tool>-<release>/<archive>` contains the 18 archives selected by
the current Desktop/SEA and remote plans. Unreferenced older binaries are removed
so that the source distribution does not retain unsupported binary dependencies.
macOS metadata (`__MACOSX`, `._*`, `.DS_Store`) is excluded.
`native-search/SHA256SUMS` records every retained archive.

The corresponding license texts and version/source inventory are maintained in
[`third-party/native-search`](../../../third-party/native-search) and included in
the root third-party notices. Preparation also writes complete notices and a
source manifest beside each binary, including cache hits. Newly produced tar/zip
archives carry these files; do not redistribute the original input archives
without the companion notices. See the [maintenance guide](../../../third-party/README.md).

The active releases and SHA-256 pins are defined in
[`scripts/native-search-tools-config.mjs`](../../../scripts/native-search-tools-config.mjs)
and [`scripts/remote-native-search-tools-config.mjs`](../../../scripts/remote-native-search-tools-config.mjs):

| Target | bfs | ugrep | ripgrep |
| --- | --- | --- | --- |
| macOS arm64 / x64 | 4.1.1-1 | 7.8.4-1 | 14.1.1-1 |
| Linux arm64 / x64 | 4.1.1-2 | 7.8.4-1 | 14.1.1-1 |
| Windows arm64 / x64 | — | 7.8.4-1 | 14.1.1-1 |
| Remote macOS arm64 / x64 | — | — | 13.0.0-10 |
| Remote Linux arm64 / x64 | 4.1.1-2 | 7.8.4-1 | 14.1.1-1 |

Remote packaging uses `resolveRemoteNativeSearchPrebuiltPlan` to retain the
deployed macOS rg13 contract. Its component versions come from the same plan as
the extracted archives; the default Desktop / SEA / server-cli plan continues to use rg14.

Desktop, CLI SEA, server-cli staging and remote asset packaging resolve these
archives relative to the repository, independently of the current working
directory. Native search preparation does not download archives or fall back to
a mirror. Other build dependencies retain their own preparation steps.
Server-cli staging prepares its own checked cache instead of reusing remote tool
directories, which may contain the macOS rg13 release.

From the repository root:

```sh
# Prepare the host tools in packages/desktop/bundled-tools/<platform>-<arch>.
pnpm --filter @zcode/desktop prepare:native-search

# Prepare a specific target, optionally into a separate staging directory.
node scripts/prepare-native-search-tools.mjs --platform linux --arch x64 --output-dir /tmp/zcode-native-search

# Package the CLI, including the prepared target tools.
pnpm build:sea

# Verify archives, server-cli staging, SEA assets, and remote component packaging.
node --test scripts/native-search-tools.test.mjs
```

Preparation checks all selected archive hashes before reusing or replacing any
cached binaries, then verifies each extracted executable's target architecture.
Unix execute permissions and binary cache metadata are preserved. Missing or
modified archives fail preparation; restore them from Git before retrying.

To update a dependency, add the new versioned archives, update the release and
SHA-256 pins in the configuration, and update `SHA256SUMS`. The public source
archives and build inputs for bfs and ugrep are recorded in that configuration;
the producer entry points remain `pnpm build:native-search` and
`pnpm pack:native-search`. Recheck every affected target and SEA packaging before
replacing an active release.

## Recovering archives in a source-only mirror

The cleaned source mirror intentionally omits executable archives. Before a
Desktop, SEA, server-cli or remote packaging build, restore its dependencies
explicitly from the immutable GitHub source revision:

```sh
# Restore the current host target; no build step performs this download implicitly.
node scripts/restore-native-search-archives.mjs

# Restore another Desktop/SEA target or the legacy macOS remote target.
node scripts/restore-native-search-archives.mjs --platform linux --arch arm64
node scripts/restore-native-search-archives.mjs --remote --platform darwin --arch x64

# Restore all 18 current and legacy archives.
node scripts/restore-native-search-archives.mjs --all

# Offline recovery and unchanged packaging-refusal controls.
node --test scripts/restore-native-search-archives.test.mjs
```

Recovery uses only `raw.githubusercontent.com/vacterro/zaicode` at revision
`a7b8af79d6819f356275488aa2d40c4416cc8613`. It checks each complete archive
against both the committed source inventory and target configuration pins.
Downloads are all checked before missing archives are written; existing modified
files are preserved and refused. Symlink destinations are refused, and each
verified archive is installed atomically without replacing a concurrent file.
Recovery does not extract or run an executable. Normal preparation still verifies
archive hashes, binary target architecture and the companion third-party notices.

These pins establish the identity of the existing dependency bytes, not an
independent reproducible-build attestation. The original archives contain bare
executables; distribute their companion license/source notices with any derived
binary package. Historical installer and tag exposure is a separate review.
