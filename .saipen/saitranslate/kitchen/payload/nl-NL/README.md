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

ZAICODE is een operatorwerkplek om veel AI-codingagents tegelijk over
veel projecten te draaien, zonder ze in de gaten te houden. Het is een aangepaste build van
[ZCode](https://github.com/zai-org/ZCode) (desktopapp, browser-UI en agent-
CLI) met een productlaag erbovenop: elk project wordt aangestuurd via het
[SAIPEN](https://github.com/vacterro/saipen)-protocol, werk wordt gestart, hervat
en gepland vanuit één venster, en de abonnements-CLI's die je al betaalt
(Claude Code, Codex, Antigravity) draaien als gedockte workers naast de in-app
agents.

**0.0.1** is de eerste getagde snapshot: een persoonlijke, Windows-eerst build die
dagelijks gebruikt wordt.

## Installatie in één klik

1. Download **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Dubbelklik erop en druk op **INSTALL**.

Dat is alles. Setup haalt op wat de machine mist (Git, Node.js, Python, als privékopieën: geen beheerdersrechten), haalt ZAICODE, SAIPEN en SAIMAIL op van GitHub, bouwt de app op de machine en zet een ZAICODE-snelkoppeling op het bureaublad. De eerste
start duurt 15-30 minuten; het venster toont elke stap.

Gratis modellen werken meteen: ZAICODE start zijn eigen router en vult de **SAIFREN**-
pool uit de gratis tiers zonder sleutel, dus een taak die je in Nieuwe taak typt krijgt antwoord zonder sleutel, account of instelling. Claude Code-, Codex- en Antigravity-abonnementen zijn
optioneel en kunnen op elk moment worden ingelogd.

**Eén geheel, vier delen.** De werkplek (launcher, installer), de app, SAIPEN en
SAIMAIL zijn vier repositories. Elk werkt zichzelf bij: *Instellingen -> ZAICODE -> Updates* toont elk deel, werkt het handmatig of automatisch bij (gecontroleerd enkele minuten
na de start en elke zes uur). Een nieuwe app-build wordt klaargemaakt terwijl ZAICODE draait
en start bij de volgende start; je eigen wijzigingen in een clone worden nooit overschreven.
Vanaf een terminal: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Autotroubleshoot: `install\Doctor.cmd`. Details: [docs/ZAICODE_INSTALL.md](docs/ZAICODE_INSTALL.md).

## Rondleiding door de interface

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

## Wat het toevoegt aan ZCode

- **Projecten met een MAIN-sessie.** Elk project heeft één MAIN-sessie (START,
  `/goal cc all`) en hulpsessies (subSaipens: WIKI, TEST, AUDIT, …). De
  standaardzijbalk toont de projectrij als zijn MAIN; ▶ zet MAIN voort in
  plaats van een nieuwe sessie te openen. ALLES VOORTZETTEN, KLAAR en WYS
  ALLES KLAAR lopen alle projecten langs; een sessie die halverwege een beurt
  stopt toont ONDERBROKEN, nooit KLAAR.
- **Crashveiligheid.** Sessies die een dood proces afkapte en nog actieve doelen
  gaan na een herstart vanzelf verder; draaiende workers starten opnieuw. Agents
  in ZAICODE kunnen ZAICODE niet op procesnaam doden.
- **Workers.** Abonnement-CLI's draaien in terminals die aan elke rand van het
  venster zijn vastgezet (of in eigen vensters die snapping gebruiken). De
  eerste-run-vragen als "Vertrouwen we deze map?" zijn beantwoord; een worker
  die zijn gebruikslimiet haalt wordt gemeld en wordt, volgens de instelling,
  gesloten of herstart na de reset.
- **Limieten en resets.** Quotameters per account en per pool, plus een timer in
  de titelbalk voor de dichtstbijzijnde reset, met de volledige lijst van
  komende resets bij hover.
- **SCHEDULER.** Prompts die uit zichzelf starten: op een tijdstip, dagelijks, elke
  N minuten of wanneer een quotavenster zich vult; in één project of een hele
  zijbalksectie, slechtste projecten eerst (meest geblokkeerd / meest open
  SAIPEN-tickets). Voorwaarden kunnen noodwerk eerst stoppen (sessies op de
  vrije pool, zwakkere workers), alleen op inactieve projecten draaien, of alleen
  gemarkeerde sessies laten doorgaan. Prompts hebben geen praktische
  lengtelimiet.
- **Routing.** Een meegeleverde 9router (MIT) levert pools zonder setup: SAIFREN
  (keyless freetiers) en SAIOPP (jouw abonnementen).
- **SAIHOME, timers, geluiden, markeringen.** Een operator-homedashboard met
  statistieken, FastPrompter-stijl timers en alarmen, geluid per actie en een
  donkergouden, pixelscherp Win95-interface.

## Bouwen

Vereisten: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) is de bron van waarheid).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

De gebouwde app start altijd in ZAICODE-modus. Terwijl een oudere ZAICODE draait,
plaatst de bundler de nieuwe build in `packages/desktop/dist-next`; de root-
launcher (branch `master`, `tools/launcher`) wisselt hem in bij de volgende start.
De scherpe bitmap-Verdana-variant die de UI gebruikt zit niet in deze repository;
zonder die valt de interface terug op de systeem-Verdana.

Checks: `pnpm typecheck`, `pnpm lint` en de ZAICODE-tests, bijvoorbeeld
`node --import tsx --test test/zaicode*.test.ts` vanuit `packages/ui`.

## Repository-indeling

| Branch      | Inhoud                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | de canonieke workspace: launcher, installer (`install/`), productdocs (`UI.md`, `docs/`), SAIPEN-status en CHANGELOG |
| `zaicode`   | de canonieke appbron: upstream ZCode-historie plus de ZAICODE-productlaag die voor builds en updates wordt gebruikt |

Legacy of door automatisering aangemaakte refs kunnen tijdelijk nog opduiken, maar
zijn geen canonieke productbranches. Nieuw werk in de workspace hoort op `master`;
werk aan de appbron hoort op `zaicode`.

ZAICODE-eigen appcode staat grotendeels in `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` en
`packages/desktop/src/main/zaicode*.ts` op branch `zaicode`. De workspace-
documentatie en de launcher/update-tooling staan op `master`.

## Upstream en licentie

ZAICODE is afgeleid van ZCode door Z.ai en wordt verspreid onder dezelfde
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); upstream-notities blijven in
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) en [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Bestanden zijn gewijzigd door de ZAICODE-auteur. ZAICODE is een onafhankelijk project,
niet verbonden aan of onderschreven door Z.ai. De originele ZCode-README blijft als
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) en [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Projectnetwerk

Deze repository maakt deel uit van het bredere **SAIPEN / vacterro**-projectecosysteem.

[**Auteurshub**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN Community**](https://discord.gg/SEYaYkuVgN)

Voor reproduceerbare bugs en duurzame featureverzoeken: gebruik de [GitHub Issues van deze repository](https://github.com/vacterro/zaicode/issues). Gebruik Discord voor snelle discussie, screenshots en feedback over projecten heen.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
