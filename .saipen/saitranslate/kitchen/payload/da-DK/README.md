# ZAICODE

<div align="center">
  <img src="https://raw.githubusercontent.com/vacterro/zaicode/zaicode/packages/ui/src/assets/zaicode-working.png" alt="ZAICODE" width="96" height="96" />
</div>
<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.1-c9a227" alt="version 0.0.1" />
  <img src="https://img.shields.io/badge/platform-Windows-3b3527" alt="Windows" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-3b3527" alt="Apache-2.0" />
</p>
<p align="center">
  ZAICODE · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md">ZCode (简体中文)</a> · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.en.md">ZCode (English)</a>
</p>

<img width="1440" height="860" alt="ZAICODE hero — Do your best." src="docs/screenshots/01-do-your-best.png" />

ZAICODE er en operatør-arbejdsplads til at køre mange AI-kodningsagenter på én gang på tværs af
mange projekter uden at passe dem. Det er en modificeret build af
[ZCode](https://github.com/zai-org/ZCode) (desktopapp, browser-UI og agent-
CLI) med et produktlag oveni: hvert projekt styres via
[SAIPEN](https://github.com/vacterro/saipen)-protokollen, arbejde startes, fortsættes
og planlægges fra ét vindue, og de abonnements-CLI'er du allerede betaler for
(Claude Code, Codex, Antigravity) kører som dokkede workers ved siden af indbyggede
agenter.

**0.0.1** er det første taggede snapshot: en personlig, Windows-fokuseret build der
bruges dagligt.

## Installér med ét klik

1. Download **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Dobbeltklik på den og tryk på **INSTALL**.

Det er alt. Setup henter det, maskinen mangler (Git, Node.js, Python som private
kopier: uden administratorrettigheder), henter ZAICODE, SAIPEN og SAIMAIL fra GitHub,
bygger appen på maskinen og lægger en ZAICODE-genvej på skrivebordet. Første
kørsel tager 15-30 minutter; vinduet viser hvert trin.

Gratis modeller virker med det samme: ZAICODE starter sin egen router og fylder **SAIFREN**-
puljen fra nøglefri gratis niveau, så en opgave skrevet ind i New task får et svar uden
nøgle, konto og indstillinger. Claude Code-, Codex- og Antigravity-abonnementer er
valgfrie og kan logges ind når som helst.

**Ét hele, fire dele.** Workspace (launcher, installer), appen, SAIPEN og
SAIMAIL er fire repositories. Hver opdaterer sig selv: *Settings -> ZAICODE ->
Updates* viser alle dele, opdaterer dem manuelt eller automatisk (tjekket et par minutter
efter start og hver sjette time). En ny app-build forberedes mens ZAICODE kører
og starter ved næste opstart; dine egne ændringer i et clone overskrives aldrig.
Fra en terminal: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Autotroubleshoot: `install\Doctor.cmd`. Detaljer: [docs/ZAICODE_INSTALL.md](docs/ZAICODE_INSTALL.md).

## Rundtur i brugerfladen

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>SAIHOME</strong><br />
      The operator dashboard: quotas, health, projects, streaks, activity, and the live clock in one place.<br /><br />
      <img src="docs/screenshots/02-saihome-dashboard.png" alt="SAIHOME dashboard" />
    </td>
    <td width="50%" valign="top">
      <strong>Agents &amp; tasks</strong><br />
      Create roles, inspect queues, and see what is idle, running, finished, or waiting for you.<br /><br />
      <img src="docs/screenshots/03-agents-and-tasks.png" alt="Agents and tasks" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Scheduler</strong><br />
      Arm quota-aware autonomous runs and recurring prompts across one project or a whole sidebar section.<br /><br />
      <img src="docs/screenshots/04-scheduler.png" alt="Scheduler" />
    </td>
    <td width="50%" valign="top">
      <strong>Audits</strong><br />
      Run Quick 3 Waves audits, watch progress live, and jump straight to reports when something stops.<br /><br />
      <img src="docs/screenshots/05-audits.png" alt="Audits" />
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <strong>Active session</strong><br />
      The full working view: transcript, branch, prompt composer, state inspector, board, and backlog at the same time.<br /><br />
      <img src="docs/screenshots/06-active-session.png" alt="Active session" />
    </td>
  </tr>
</table>

## Hvad det tilføjer til ZCode

- **Projekter med en MAIN-session.** Hvert projekt har én MAIN-session (START,
  `/goal cc all`) og hjælpesessioner (subSaipens: WIKI, TEST, AUDIT, …). Den
  forvalgte sidevisning viser projektlinjen som dens MAIN; ▶ fortsætter MAIN
  i stedet for at åbne endnu en session. FORTSÆT ALLE, FÆRDIG og RYD ALLE
  FÆRDIGE gennemgår hvert projekt; en session, der afbrydes midt i en tur, viser
  AFBRUDT, aldrig FÆRDIG.
- **Crash-sikkerhed.** Sessioner, som en død proces afbryder, og mål, der stadig er
  aktive, fortsætter af sig selv efter en genstart; kørende workers starterigen.
  Agents i ZAICODE kan ikke dræbe ZAICODE på processnavn.
- **Workers.** Abonnements-CLI'er kører i terminaler, der er låst til en hvilken som
  helst kant af vinduet (eller i deres egne snap-vinduer). Første kørsel
  "Stol på denne mappe?" besvares automatisk; en worker, der rammer sin
  forbrugsgrænse, rapporteres og – efter indstilling – lukkes eller genstartes ved
  nulstillingen.
- **Grænser og nulstillinger.** Forbrugsmålere pr. konto og pool, en titellinje-timer
  til den nærmeste nulstilling med hele listen over kommende nulstillinger ved
  svævning.
- **SCHEDULER.** Prompts, der starter af sig selv: på et tidspunkt, dagligt, hvert
  N. minut eller når et kvotalåb genopfyldes; i ét projekt eller en hel
  sidebarsektion, de værste projekter (flest blokerede / åbne SAIPEN-sager)
  først. Betingelser kan sætte stop i pludselige arbejder (sessions på gratis-
  pools, svagere workers) først, køre kun på inaktive projekter eller fortsætte kun
  markerede sessioner. Prompts har ingen praktisk længdegrænse.
- **Routing.** Indbygget 9router (MIT) giver pools uden opsætning: SAIFREN
  (nøglefri gratisniveauer) og SAIOPP (dine abonnementer).
- **SAIHOME, timere, lyde, markeringer.** Et operatørhjem med statistik,
  FastPrompter-lignende timere og alarmer, lyde pr. handling og et Win95 mørkt
  guld, pixelskarp grænseflade.

## Byg

Krav: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) er den sande kilde).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Den pakkede app starter altid i ZAICODE-tilstand. Mens en ældre ZAICODE kører,
placerer bundleren den nye build i `packages/desktop/dist-next`; root
launcheren (gren `master`, `tools/launcher`) skifter den ind ved næste start.
Den skarpe bitmap-Verdana-variant, UI'et bruger, er ikke en del af dette repository;
uden den falder interfacet tilbage til systemets Verdana.

Kontroller: `pnpm typecheck`, `pnpm lint` samt ZAICODE-tests, for eksempel
`node --import tsx --test test/zaicode*.test.ts` fra `packages/ui`.

## Repositorylayout

| Gren        | Indhold                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | det kanoniske workspace: launcher, installer (`install/`), produktdokumentation (`UI.md`, `docs/`), SAIPEN-tilstand og CHANGELOG |
| `zaicode`   | den kanoniske app-kilde: upstream ZCode-historik plus ZAICODE-produktlaget, der bruges til builds og opdateringer |

Legacy- eller automatikskabte refs kan stadig forekomme midlertidigt, men de er
ikke kanoniske produktgrene. Nyt workspace-arbejde hører til `master`; app-kildearbejde
hører til `zaicode`.

ZAICODE-ejet appkode ligger hovedsageligt i `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` og
`packages/desktop/src/main/zaicode*.ts` på grenen `zaicode`. Workspace-
dokumentationen og launcher/update-værktøjet ligger på `master`.

## Upstream og licens

ZAICODE er udledt fra ZCode af Z.ai og distribueres under den samme
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); upstream-notices er bevaret i
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) og [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Filer blev ændret af ZAICODE-forfatteren. ZAICODE er et uafhængigt projekt,
ikke tilknyttet Z.ai eller godkendt af dem. Den oprindelige ZCode README er bevaret som
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) og [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Projektnetværk

Dette repository er en del af det bredere **SAIPEN / vacterro**-projektøkosystem.

[**Forfatterhub**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN Community**](https://discord.gg/SEYaYkuVgN)

Brug [dette repositorys GitHub Issues](https://github.com/vacterro/zaicode/issues) til reproducerbare bugs og holdbare feature-ønsker. Brug Discord til hurtig diskussion, skærmbilleder og feedback på tværs af projekter.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
