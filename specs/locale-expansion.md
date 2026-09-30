# Complete locale catalogs

The two-locale guard and cycle currently reject or hide every translated language outside English and Chinese. Locale expansion replaces that closed pair with the installed SAIPEN translation contract: 32 languages and the intentional DED voice.

UI and CLI catalogs keep exact source keys and interpolation tokens. A locale is available only after a complete, source-bound translation package is collected. English copies do not count as translations except deliberate technical tokens. UI locales use the existing shared Locale type; CLI uses its contracts SupportedLocale type with the same explicit tags. Runtime catalogs and persisted settings accept the same set.

IntlProvider remains the sole UI preference owner. User choice writes local storage, broadcasts the existing state:locale event, and persists through ISettingService. Latest-operation sequencing and broadcast-loop suppression remain unchanged. System selection resolves by language tag across the supported catalog; DED is explicitly selected, never inferred from a system language. Arabic and Hebrew set document direction to RTL; other locales reset it to LTR. CLI locale detection preserves its environment-variable precedence and decorator handling.

The language control offers a named selection rather than making users cycle through 33 choices. Settings reuses the same language names. Existing English/Chinese preferences remain valid, unsupported input follows the existing explicit fallback, and no session/profile migration occurs.

Acceptance covers exact catalog/key/token parity, UI and CLI identifiers, persisted/broadcast choices, system detection, RTL transitions, long-label layout, CLI function interpolation and plural branches, and a packaged-app switch/restart smoke on representative languages. Core verifies collection freshness against UI, CLI and user-document source digests before release.
