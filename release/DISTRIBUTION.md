# ZAICODE end-user distribution

The primary download is `ZAICODE-Setup-<version>.exe`, a per-user Windows GUI
installer containing the entire runtime. It never builds source on the user's
computer. The existing `install/Install-ZAICODE.ps1` remains a developer installer.

## Ownership and layout

The release host owns installation and activation. Electron owns application
settings, sessions and router lifecycle. SAIPEN alone owns project protocol
state; SAIMAIL alone owns identity, keys, quarantine and mailbox state.

- `%LOCALAPPDATA%/Programs/ZAICODE`: launcher, uninstaller and installation state.
- `versions/<version>`: immutable Electron application and private Python/Git.
- `managed/<component>/<revision>`: immutable SAIPEN, SAIMAIL and router payloads.
- `%APPDATA%/ZAICODE`: application data, settings, sessions, appearance and mailbox.
- `%LOCALAPPDATA%/ZAICODE`: update staging, cache and diagnostics.
- Projects remain in directories selected by the user. No upgrade rewrites them.

Only the process environment receives private runtime paths. The user's PATH and
the upstream ZCode installation are never changed. No durable state is stored in
temporary directories. Reinstall/repair and uninstall preserve user data.

## Bootstrap

The launcher verifies the active runtime, creates only missing safe directories,
and publishes private component paths to Electron. Electron initializes a missing
default local mailbox through SAIMAIL's canonical CLI. It never pairs a peer or
changes trust. FREE uses the existing isolated router bootstrap and bundled agent.
Unavailable optional components do not prevent the UI from opening.

## Trusted releases and updates

The authoritative channel is the `stable.json` asset on an explicitly promoted
stable release in `vacterro/zaicode`. Manifest schema 1 binds product, channel,
approved status, version, exact component identifiers, immutable release URLs,
SHA-256 and byte sizes. Production accepts only HTTPS assets in this repository's
published releases. Branch HEAD and arbitrary artifact URLs are refused.

Check -> download to durable staging -> verify size and digest -> safely extract
-> verify payload file inventory -> stage immutable directories -> atomically
replace installation state on the next launch. The old state and directories
remain available. A failed startup rolls back to the previous state. Concurrent
operations hold a per-install lock. Partial downloads and failed verification
cannot change the active state. Independent component manifests use the same
trust policy and supported runtime contract. App updates include their compatible
runtime; component updates do not change project or mailbox state. A project
bound to a retained managed SAIPEN revision continues through that revision's
canonical launcher, while new projects use the current managed implementation.

Cryptographic release signing is not yet established. Trusted HTTPS manifest plus
SHA-256 is the minimum boundary for this release; signing is explicit hardening
debt. Nothing claims Authenticode signing unless a real signature is produced.

## Acceptance boundary

The release is publishable only after all current product gates, a real isolated
Windows install -> launch -> FREE answer, restart, state-preserving A -> B update,
corrupted artifact rejection, offline recovery and uninstall/reinstall pass.
An isolated process on the operator's existing account is supplemental evidence,
not a substitute for the required clean Windows acceptance. Historical SAIPEN
bookkeeping is reported independently and is never rewritten to manufacture PASS.
