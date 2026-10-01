# ZAICODE

**v0.0.2**

<div align="center">
  <img src="https://raw.githubusercontent.com/vacterro/zaicode/zaicode/packages/ui/src/assets/zaicode-working.png" alt="ZAICODE" width="96" height="96" />
</div>
<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.2-c9a227" alt="version 0.0.2" />
  <img src="https://img.shields.io/badge/platform-Windows-3b3527" alt="Windows" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-3b3527" alt="Apache-2.0" />
</p>
<p align="center">
  ZAICODE · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md">ZCode (简体中文)</a> · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.en.md">ZCode (English)</a>
</p>

<img width="1440" height="860" alt="ZAICODE hero — Do your best." src="../../screenshots/01-do-your-best.png" />

ZAICODE är en operatörsarbetsbänk för att köra många AI-kodningsagenter samtidigt över
många projekt, utan att behålla öga på dem. Det är en modifierad version av
[ZCode](https://github.com/zai-org/ZCode) (skrivbordsapp, webbläsargränssnitt och agent-
CLI) med ett produktlager ovanpå: varje projekt drivs av
[SAIPEN](https://github.com/vacterro/saipen)-protokollet, arbete startas, fortsätts
och schemaläggs från ett fönster, och de prenumerations-CLI:er du redan betalar för
(Claude Code, Codex, Antigravity) körs som dockade workers bredvid agenterna i appen.

**0.0.1** är den första taggade ögonblicksbilden: en personlig, Windows-först-byggd version som
används dagligen.

## Installera med ett klick

1. Ladda ner **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Dubbelklicka och tryck **INSTALL**.

Klart. Installationen tillför det maskinen saknar (Git, Node.js, Python, som privata
kopior: inga administratörsrättigheter), hämtar ZAICODE, SAIPEN och SAIMAIL från GitHub,
bygger appen på maskinen och lägger en ZAICODE-genväg på skrivbordet. Första
körningen tar 15–30 minuter; fönstret visar varje steg.

Gratismodeller fungerar direkt: ZAICODE startar en egen router och fyller **SAIFREN**
poolen med nyckellösa fria nivåer, så ett uppdrag som skrivs i New task får svar utan
nyckel, konto eller inställning. Claude Code, Codex och Antigravity-prenumerationer är
valfria och kan loggas in när som helst.

**En helhet, fyra delar.** Arbetsytan (launcher, installerare), appen, SAIPEN och
SAIMAIL är fyra repositorier. Varje uppdateras separat: *Settings -> ZAICODE ->
Updates* visar alla delar, uppdaterar dem manuellt eller automatiskt (kontrolleras några
minuter efter start och var sjätte timme). En ny appbyggning förbereds medan ZAICODE kör
och startar vid nästa start; dina egna ändringar i en klon skrivs aldrig över.
Från en terminal: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Autofelsökning: `install\Doctor.cmd`. Detaljer: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Guidning genom gränssnittet

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>SAIHOME</strong><br />
      The operator dashboard: quotas, health, projects, streaks, activity, and the live clock in one place.<br /><br />
      <img src="../../screenshots/02-saihome-dashboard.png" alt="SAIHOME dashboard" />
    </td>
    <td width="50%" valign="top">
      <strong>Agents &amp; tasks</strong><br />
      Create roles, inspect queues, and see what is idle, running, finished, or waiting for you.<br /><br />
      <img src="../../screenshots/03-agents-and-tasks.png" alt="Agents and tasks" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Scheduler</strong><br />
      Arm quota-aware autonomous runs and recurring prompts across one project or a whole sidebar section.<br /><br />
      <img src="../../screenshots/04-scheduler.png" alt="Scheduler" />
    </td>
    <td width="50%" valign="top">
      <strong>Audits</strong><br />
      Run Quick 3 Waves audits, watch progress live, and jump straight to reports when something stops.<br /><br />
      <img src="../../screenshots/05-audits.png" alt="Audits" />
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <strong>Active session</strong><br />
      The full working view: transcript, branch, prompt composer, state inspector, board, and backlog at the same time.<br /><br />
      <img src="../../screenshots/06-active-session.png" alt="Active session" />
    </td>
  </tr>
</table>

## Vad det tillför ZCode

- **Project med en MAIN-session.** Varje projekt har en MAIN-session (START,
  `/goal cc all`) och hjälpsessioner (subSaipens: WIKI, TEST, AUDIT, …). Som
  standard visar sidopanelen projektet som dess MAIN; ▶ fortsätter MAIN
  i stället för att öppna en ny session. CONTINUE ALL, DONE och CLEAR ALL
  DONE går igenom alla projekt; en session som avbryts mitt i en tur visas
  som INTERRUPTED, aldrig DONE.
- **Kraschsäkerhet.** Sessioner som en död process avbröt och mål som fortfarande
  är aktiva fortsätter själva efter omstart; körande workers startar om. Agenter
  inuti ZAICODE kan inte döda ZAICODE via processnamn.
- **Workers.** Prenumerations-CLIs körs i terminaler fästade mot valfri kant av
  fönstret (eller i egna fönster med snapping). Första-körningens "Lita på
  den här mappen?" besvaras; en worker som når sin användningsgräns rapporteras
  och stängs, per inställning, eller startas om efter återställningen.
- **Gränser och återställningar.** Quotamätare per konto och pool, en timer i
  titelfältet för närmaste återställning med hela listan på hover.
- **SCHEDULER.** Prompter som startar av sig själva: vid en tidpunkt, dagligen,
  var N:e minut eller när ett kvotfönster fylls på; i ett projekt eller en hel
  sidopanelsektion, värst av först (mest blockerade / flest öppna SAIPEN-ärenden).
  Villkor kan stoppa nödlösningarbete först (free-pool-sessioner, svagare
  workers), bara köra på inaktiva projekt eller bara fortsätta markerade sessioner.
  Prompter har ingen praktisk längdgräns.
- **Routning.** En inbakad 9router (MIT) ger pools utan konfiguration: SAIFREN
  (nyckellösa fria nivåer) och SAIOPP (dina prenumerationer).
- **SAIHOME, timers, ljud, markeringar.** En operatörshemmas med statistik,
  FastPrompter-liknande timers och larm, ljud per åtgärd och ett Win95-mörkt
  gyllene, pixelskarp gränssnitt.

## Bygga

Krav: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) är sanningskällan).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Den paketerade appen startar alltid i ZAICODE-läge. Medan en äldre ZAICODE körs
ställer bundlern inbygget i `packages/desktop/dist-next`; rotlaunchern (gren `master`, `tools/launcher`)
byter ut det vid nästa start.
Den skarpa bitmap-Verdana-variant som gränssnittet använder ingår inte i det här
repositoriet; utan den faller gränssnittet tillbaka på systemets Verdana.

Kontroller: `pnpm typecheck`, `pnpm lint` och ZAICODE-testerna, exempelvis
`node --import tsx --test test/zaicode*.test.ts` från `packages/ui`.

## Repositoriets struktur

| Gren       | Innehåll                                                                 |
| ---------- | ------------------------------------------------------------------------ |
| `master`    | den kanoniska arbetsytan: launcher, installer (`install/`), produktdokument (`UI.md`, `docs/`), SAIPEN-tillstånd och CHANGELOG |
| `zaicode`   | den kanoniska appkällan: ZCode-historik uppströms plus ZAICODE-produktlagret som används för byggen och uppdateringar |

Äldre eller automationsskapade refs kan fortfarande dyka upp tillfälligt, men de är
inte kanoniska produktgrenar. Nytt arbete i arbetsytan hör hemma på `master`;
arbete i appkällan på `zaicode`.

ZAICODE-ägd appkod ligger främst i `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` och
`packages/desktop/src/main/zaicode*.ts` på grenen `zaicode`. Arbetsytans
dokumentation och launcher/update-verktyg ligger på `master`.

## Upströms och licens

ZAICODE är härledd från ZCode av Z.ai och distribueras under samma
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); upstream-notiser finns kvar i
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) och [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Filer har ändrats av ZAICODE-författaren. ZAICODE är ett oberoende projekt,
inte kopplat till eller godkänt av Z.ai. Originalets ZCode README finns kvar som
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) och [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Projektnätverk

Det här repot är en del av det bredare **SAIPEN / vacterro**-projektekosystemet.

[**Författarhubb**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN Community**](https://discord.gg/SEYaYkuVgN)

För reproducerbara buggar och bestående funktionsförfrågan, använd [GitHub Issues i det här repot](https://github.com/vacterro/zaicode/issues). Använd Discord för snabba diskussioner, skärmbilder och återkoppling mellan projekt.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
