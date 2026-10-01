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

ZAICODE er en operatørbenk for å kjøre mange AI-kodingsagenter samtidig over
mange prosjekter, uten å passe på dem. Det er en modifisert bygning av
[ZCode](https://github.com/zai-org/ZCode) (skrivebordsapp, nettlesergrensesnitt og agent-
CLI) med et produktlag på toppen: hvert prosjekt styres av
[SAIPEN](https://github.com/vacterro/saipen)-protokollen, arbeid startes, fortsettes
og planlegges fra ett vindu, og abonnements-CLI-ene du allerede betaler for
(Claude Code, Codex, Antigravity) kjøres som dokkede arbeidere ved siden av
agentene i appen.

**0.0.1** er det første taggede øyeblikksbildet: en personlig, Windows-først-bygging som
brukes daglig.

## Installering med ett klikk

1. Last ned **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Dobbeltklikk på den og trykk **INSTALL**.

Det er alt. Oppsettet henter det maskinen mangler (Git, Node.js, Python, som
private kopier: ingen administratorrettigheter), henter ZAICODE, SAIPEN og SAIMAIL fra GitHub,
bygger appen på maskinen og legger en ZAICODE-snarvei på skrivebordet. Første
kjøring tar 15–30 minutter; vinduet viser hvert trinn.

Gratismodeller virker med én gang: ZAICODE starter sin egen ruter og fyller **SAIFREN**-
poolen fra nøkkeløse gratisnivåer, så en oppgave skrevet inn i Ny oppgave får svar uten
nøkkel, konto eller innstilling. Claude Code, Codex og Antigravity-abonnementer er
valgfrie og kan logges inn når som helst.

**Én helhet, fire deler.** Arbeidsområdet (opplaster, installasjon), appen, SAIPEN og
SAIMAIL er fire repositorier. Hvert oppdaterer seg selv: *Innstillinger -> ZAICODE ->
Oppdateringer* viser alle delene, oppdaterer dem manuelt eller automatisk (sjekket noen få
minutter etter oppstart og hver sjette time). En ny appbygging forberedes mens ZAICODE kjører
og starter ved neste oppstart; egne endringer i en klon overskrives aldri.
Fra en terminal: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Autofeilsøking: `install\Doctor.cmd`. Detaljer: [docs/ZAICODE_INSTALL.md](docs/ZAICODE_INSTALL.md).

## Grensesnittomvisning

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

## Hva den legger til i ZCode

- **Prosjekter med en MAIN-sesjon.** Hvert prosjekt har én MAIN-sesjon (START,
  `/goal cc all`) og hjelpesesjoner (subSaipens: WIKI, TEST, AUDIT, …). Standard
  sidepanelvisning viser prosjektraden som MAIN; ▶ fortsetter MAIN
  i stedet for å åpne en ny sesjon. CONTINUE ALL, DONE og CLEAR ALL DONE
  går gjennom alle prosjekter; en sesjon som ble avbrutt midt i en tur viser INTERRUPTED, aldri DONE.
- **Krasjsikkerhet.** Sesjoner en død prosess avbrakte, og mål fortsatt aktive,
  fortsetter av seg selv etter omstart; kjørende arbeidere starter på nytt. Agenter
  inne i ZAICODE kan ikke drepe ZAICODE på prosessnavn.
- **Arbeidere.** Abonnements-CLI-er kjører i terminaler festet til hvilken som helst kant
  av vinduet (eller i egne snap-vinduer). Førstekjør-spørsmål «Stol på denne mappen?»
  besvares; en arbeider som når bruksgrensen rapporteres og blir,
  avhengig av innstilling, lukket eller startet på nytt etter tilbakestillingen.
- **Grenser og tilbakestillinger.** Kvotamålere per konto og basseng, en tittelfelt-timer
  for neste tilbakestilling med hele listen over kommende tilbakestillinger ved å holde over.
- **SCHEDULER.** Prompter som starter av seg selv: på et tidspunkt, daglig, hvert N.
  minutt eller når et kvotavindu fylles på; i ett prosjekt eller en hel sidepanelseksjon, verste prosjekter (mest blokkert / åpne SAIPEN-saker) først. Betingelser
  kan stoppe nødlarbeid (sesjoner i fribasseng, svakere arbeidere) først, bare kjøre på
  inaktive prosjekter, eller fortsette bare merkede sesjoner. Prompter har ingen praktisk
  lengdebegrensning.
- **Ruting.** Innbundet 9router (MIT) gir basseng uten oppsett: SAIFREN
  (nøkkeløse gratisnivåer) og SAIOPP (dine abonnementer).
- **SAIHOME, timere, lyder, markeringer.** Operatør-hjem med statistikk,
  FastPrompter-lignende timere og alarmer, lyder per handling og et Win95 mørkt
  gull, pikselrikt grensesnitt.

## Bygging

Krav: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) er fasiten).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Den pakkede appen starter alltid i ZAICODE-modus. Mens en eldre ZAICODE kjører,
legger bundleren den nye byggingen i `packages/desktop/dist-next`; rot-
startprogrammet (gren `master`, `tools/launcher`) bytter den inn ved neste start.
Den skarpe bitmap-Verdana-varianten UI-et bruker, er ikke en del av dette repositoriet;
uten den faller grensesnittet tilbake til systemets Verdana.

Kontroller: `pnpm typecheck`, `pnpm lint`, samt ZAICODEs tester, for eksempel
`node --import tsx --test test/zaicode*.test.ts` fra `packages/ui`.

## Repositoriestruktur

| Gren      | Innhold                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | det kanoniske arbeidsområdet: launcher, installatør (`install/`), produktdokumenter (`UI.md`, `docs/`), SAIPEN-tilstand og CHANGELOG |
| `zaicode`   | den kanoniske appkilden: ZCode-historie oppstrøms pluss ZAICODE-produktlaget som brukes til bygg og oppdateringer |

Legacy- eller automatiseringslagde refs kan fortsatt dukke opp midlertidig, men de er
ikke kanoniske produktgrener. Nytt arbeid i arbeidsområdet hører til `master`; arbeid i appkilden
hører til `zaicode`.

ZAICODE-eid appkode ligger hovedsakelig i `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` og
`packages/desktop/src/main/zaicode*.ts` på grenen `zaicode`. Arbeidsområdets
dokumentasjon og launcher/update-verktøy ligger på `master`.

## Oppstrøms og lisens

ZAICODE er avledet fra ZCode fra Z.ai og distribueres under samme
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); upstream-merknader beholdes i
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) og [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Filer ble endret av ZAICODE-forfatteren. ZAICODE er et uavhengig prosjekt,
ikke tilknyttet Z.ai eller godkjent av Z.ai. Den opprinnelige ZCode README beholdes som
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) og [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Prosjektnettverk

Dette repositoriet er en del av det bredere **SAIPEN / vacterro**-prosjektøkosystemet.

[**Forfattersenter**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN Community**](https://discord.gg/SEYaYkuVgN)

For reproduserbare feil og varige funksjonsforespørsel, bruk [dette repositoriets GitHub Issues](https://github.com/vacterro/zaicode/issues). Bruk Discord for rask diskusjon, skjermbilder og tilbakemeldinger på tvers av prosjekter.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
