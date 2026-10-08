# ZAICODE 0.0.3: first install and readable controls

## Defects addressed

The source installer may report success without a working SAIMAIL CLI or a bundled router; the native app installer does not install the companion suite. No component uninstaller exists. Some persistent ordered lists require repeated arrow clicks. Full transcript still limits tool output height, and fades obscure text throughout the app.

## Scope and acceptance

- Supported release target: Windows 10/11 x64, confirmed by the operator. No global Git, Node or Python requirement. The existing `install/` setup/check/repair owner remains the suite installer. Missing mandatory SAIPEN, SAIMAIL CLI or router is a failed installation, with automatic bounded repair and a visible retry/log action.
- Publish one clearly named 0.0.3 suite entry point, with bundled scripts and versioned release metadata. A bare application artifact must not be advertised as a complete suite. Keep upstream ZCode's package version separate from ZAICODE's release version.
- Provide a visible uninstaller beside the launcher and through Windows Installed apps. Default removal is ZAICODE alone; explicit checkboxes allow SAIPEN, SAIMAIL or the whole suite. Keep companion runtime dependencies while any companion survives. Preserve user projects, provider credentials, mail and protocol state. Never recursively delete an unverified install root, foreign directory, reparse point or a component not recorded as installed by this setup. Refuse a running owned process; allow retry after closing it. Do not modify a running developer installation during tests.
- Router pool rows use a larger existing UI font token and the existing sortable list implementation. Drag and keyboard reorder write through the same router owner as arrows. Guard concurrent saves. Add drag to scheduler fallback runners, Dispatch launchers and queued jobs through their existing owners. Already draggable home cards, workers, layouts and providers retain their controls.
- Transcript values remain `compact`, `full`, `only-text`, adding `full-unbounded`. Existing Full preserves its nested scroll behavior. Full without scroll opens all loaded disclosures, uses actual unbounded output height and renders every available output line. No synthetic provider request or implicit history fetch. Stream output remains live without scrolling the outer conversation automatically. Switching back preserves manual disclosure preferences and invalidates measured row heights.
- ZAICODE has no content fade masks, gradient scrims or darkened modal backdrops. Retain modal focus/input blocking and semantic disabled states. Preserve decorative gauges, image transparency grids and actual image pixels.

## Ownership and validation

Reuse `SortableProviderModelList`, `TranscriptViewContext`, UI preferences, jobs service and `install/ZaicodeInstallLib.ps1`; no second persistence or updater. Windows installer and launcher own environment/runtime wiring; renderer uses existing public bridge and service paths.

Native ordering: pointer/keyboard drop -> existing owner mutation -> durable write -> authoritative readback -> rerender. Installation: prerequisites -> component source -> runtime/CLI -> app/package -> launcher -> shortcuts/uninstaller -> recorded ownership -> success. Uninstall: recorded root/components -> validate all targets -> check running processes -> remove chosen owned programs -> retain shared dependencies/data -> update recorded components/shortcuts/registration.

Run meaningful RED/GREEN regressions, typecheck, lint/architecture and full repository tests. Build current ZAICODE and embedded setup scripts. Exercise actual dragging, disclosure heights, fade removal and modal blocking in a browser/Electron fixture; exercise Windows PowerShell 5.1 setup and component removal on isolated paths with a restricted PATH. Record real network/bootstrap failures and clean-VM availability separately; an isolated profile does not prove Windows 10 and Windows 11 compatibility by itself. Produce a release readiness report and hashes; no remote publication is part of this request.

## Installer artwork steering (SRC-178 / T-275)

Use the supplied `q9bt5rq9bt5rq9bt.jpg` as the launch image for two seconds, then `ixkuarixkuarixku.jpg` inside the movable, minimizable installer window. No desktop takeover, always-on-top mode or input blocking outside the installer. The bitmap artwork is an explicit user exception to UI.md's decorative-image restriction. Controls remain opaque Golden Default panels with two-pixel bevels and Verdana without antialiasing. Cover the artwork's baked-in unrelated version with the actual release version in a UI label; keep the supplied files unchanged.

## Self-contained distribution

The suite setup may carry a versioned payload produced from clean public companion clones and the current built app. Its fast path extracts verified payload files and installs SAIMAIL from bundled Python wheels without global development tools or a network request. Regenerate path-bound Python/SAIPEN launchers after extraction. The existing source bootstrap remains the automatic fallback when no payload is embedded. Installed payload metadata tells the existing doctor which source dependencies are intentionally absent; future source updates use the existing dependency repair owner. Record an exact owned-file manifest, excluding protocol memory, mail, profiles and user files. Uninstall removes only unchanged owned files, validates every target and keeps shared runtime files while any component remains.
