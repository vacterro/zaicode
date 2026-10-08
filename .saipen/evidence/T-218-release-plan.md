# T-218 — public Windows test release

User authority: SRC-149 requests publishing the current stable ZAICODE version to GitHub for public testing.

Selected product source: existing committed `522f5a5a`, 15 commits ahead of `origin/zaicode` at preflight. The remote is established, public `vacterro/zaicode`; publication is authorized. Preserve the unfinished T-217 delta and T-188 diagnostic corrections in the original working tree. Use an isolated detached worktree and normal production build/package commands. Publish the existing source commit to `origin/zaicode` by fast-forward, an immutable test tag, and a GitHub prerelease with a Windows installer, checksums, and verification metadata.

This publishes a tested engineering snapshot for public testing. It does not promote the managed stable update manifest or claim clean-Windows-VM acceptance (T-144), real idle-window acceptance (T-188), or real paid-vendor exhaustion/reset acceptance (T-216). These limitations must remain explicit in the release notes. No paid subscription request is needed.

Required verification: clean source tree at the selected commit; production backend/ZAICODE identity; frozen dependency install; typecheck; lint/architecture/full repository tests; production build/package dependency and size checks; packaged boot in an isolated profile with paid window starts disabled; checksum verification after upload; remote branch/tag/asset identities verified. No force push, broad staging, or operator application/process interruption.
