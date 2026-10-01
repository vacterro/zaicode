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

<img width="1440" height="860" alt="ZAICODE hero — Do your best." src="../../screenshots/01-do-your-best.png" />

ZAICODE je pracovní stůl pro operátory, kde běží mnoho AI programovacích agentů současně nad
mnoha projekty, bez dozoru. Jde o upravenou verzi
[ZCode](https://github.com/zai-org/ZCode) (desktopová aplikace, UI v prohlížeči a
CLI agenta) s produktovou vrstvou navíc: každý projekt řídí
[SAIPEN](https://github.com/vacterro/saipen) protokol, práce se spouští, pokračuje
a plánuje z jednoho okna a předplatné CLI, která už platíte
(Claude Code, Codex, Antigravity) běží jako připojení pracovníci vedle agentů
v aplikaci.

**0.0.1** je první označený snímek: osobní sestavení zaměřené na Windows, které
se používá denně.

## Instalace jedním kliknutím

1. Stáhněte **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Na něj dvakrát klikněte a stiskněte **INSTALL**.

To je vše. Instalace doplní to, co stroj postrádá (Git, Node.js, Python jako soukromé
kopie: bez práv administrátora), stáhne ZAICODE, SAIPEN a SAIMAIL z GitHubu,
sestaví aplikaci na stroji a umístí zástupce ZAICODE na plochu. První
spuštění trvá 15-30 minut; okno zobrazuje každý krok.

Bezplatné modely fungují ihned: ZAICODE spustí vlastní router a plní fond **SAIFREN**
z bezklíčových bezplatných úrovní, takže úkol zadaný v Nová úloha dostane odpověď bez
klíče, bez účtu a bez nastavení. Předplatná Claude Code, Codex a Antigravity jsou
volitelná a přihlásit se lze kdykoli.

**Jedno celé, čtyři části.** Pracovní prostor (spouštěč, instalátor), aplikace, SAIPEN a
SAIMAIL jsou čtyři repozitáře. Každý se aktualizuje samostatně: *Nastavení -> ZAICODE ->
Aktualizace* ukazuje každou část a aktualizuje ji ručně nebo sama (kontrola pár minut
po startu a každých šest hodin). Nové sestavení aplikace se připraví, když ZAICODE běží,
a spustí se při příštím startu; vaše vlastní úpravy v klonu se nikdy nepřepíšou.
Z terminálu: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Autodiagnostika: `install\Doctor.cmd`. Podrobnosti: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Prohlídka rozhraní

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

## Co přidává ZCode

- **Projects with a MAIN session.** Každý projekt má jednu relaci MAIN (START,
  `/goal cc all`) a pomocné relace (subSaipens: WIKI, TEST, AUDIT, …).
  Výchozí zobrazení postranního panelu zobrazuje řádek projektu jako jeho MAIN;
  ▶ pokračuje v MAIN místo otevření další relace. CONTINUE ALL, DONE a CLEAR ALL
  DONE projdou každý projekt; relace přerušená uprostřed tahu ukáže INTERRUPTED,
  nikdy DONE.
- **Crash safety.** Relace, které přerušil mrtvý proces, a stále aktivní cíle se
  po restartu obnoví samy; běžící workeři se znovu spustí. Agenti uvnitř ZAICODE
  nemohou zabít ZAICODE podle názvu procesu.
- **Workers.** Předplacené CLIs běží v terminálech přichycených k libovolné hraně
  okna (nebo ve vlastních oknech s přichycením). Otázky „Trust this folder?“ při
  prvním spuštění se zodpovídají; worker, který narazí na limit použití, se nahlásí
  a podle nastavení se po resetu zavře nebo restartuje.
- **Limits and resets.** Měřiče kvót podle účtu a poolu, časovač v záhlaví okna na
  nejbližší reset s úplným seznamem nadcházejících resetů při najetí.
- **SCHEDULER.** Prompty, které se spouštějí samy: v určitý čas, denně, každých N
  minut nebo když se doplní kvótové okno; v jednom projektu nebo v celé sekci
  postranního panelu, nejdřív nejhorší projekty (nejvíce zablokované / otevřené
  tikety SAIPEN). Podmínky mohou nejdřív zastavit dočasnou práci (relace z
  bezplatných poolů, slabší workeři), běžet jen na nečinných projektech, nebo
  pokračovat jen v označených relacích. Prompty nemají praktické omezení délky.
- **Routing.** Vestavěný 9router (MIT) nabízí pooly bez nastavení: SAIFREN
  (bezklíčové bezplatné tiery) a SAIOPP (vaše předplatné).
- **SAIHOME, timers, sounds, highlights.** Operační domovská stránka se statistikami,
  časovači a poplachy ve stylu FastPrompter, zvuky podle akce a tmavě zlaté
  rozhraní Win95, pixelově ostré.

## Sestavení

Požadavky: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) je jediný zdroj pravdy).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Zabalená aplikace se vždy spustí v režimu ZAICODE. Když běží starší ZAICODE,
bundler připraví nový build v `packages/desktop/dist-next`; kořenový launcher (větev `master`,
`tools/launcher`) ho vymění při příštím spuštění.
Ostrá bitmapová varianta Verdany používaná UI není součástí tohoto repozitáře;
bez ní rozhraní padá na systémovou Verdanu.

Kontroly: `pnpm typecheck`, `pnpm lint` a testy ZAICODE, například
`node --import tsx --test test/zaicode*.test.ts` z `packages/ui`.

## Rozvržení repozitáře

| Větev      | Obsah                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | kanonický workspace: launcher, instalátor (`install/`), produktová dokumentace (`UI.md`, `docs/`), stav SAIPEN a CHANGELOG |
| `zaicode`   | kanonický zdroj aplikace: historie upstream ZCode plus produktová vrstva ZAICODE používaná pro buildy a aktualizace |

Staré nebo automaticky vytvořené refy mohou dočasně stále existovat, ale nejsou
kanonickými produktovými větvemi. Nová práce ve workspace patří na `master`; práce
na zdroji aplikace patří na `zaicode`.

Kód aplikace ve vlastnictví ZAICODE žije převážně v `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` a
`packages/desktop/src/main/zaicode*.ts` na větvi `zaicode`. Dokumentace
workspace a nástroje launcher/update žijí na `master`.

## Upstream a licence

ZAICODE vznikl ze ZCode od Z.ai a je šířen pod stejnou licencí
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); oznámení z původního projektu zůstávají v
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) a [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Soubory upravil autor ZAICODE. ZAICODE je nezávislý projekt,
není spojen se Z.ai ani jím neschválen. Původní README ZCode zůstává jako
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) a [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Projektová síť

Tento repozitář je součástí širšího ekosystému projektů **SAIPEN / vacterro**.

[**Autor hub**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN Community**](https://discord.gg/SEYaYkuVgN)

Pro reprodukovatelné chyby a trvalé požadavky na funkce používejte [GitHub Issues tohoto repozitáře](https://github.com/vacterro/zaicode/issues). Discord slouží k rychlé diskuzi, snímkům obrazovky a zpětné vazbě napříč projekty.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
