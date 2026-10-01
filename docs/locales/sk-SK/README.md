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

ZAICODE je operátorský pracovný stôl na prevádzkovanie viacerých AI programovacích agentov naraz
nad viacerými projektami, bez potreby dohliadať na ne. Je to upravená zostava
[ZCode](https://github.com/zai-org/ZCode) (stolová aplikácia, webové rozhranie a CLI agenta)
s produktovou vrstvou navrchu: každý projekt riadi protokol
[SAIPEN](https://github.com/vacterro/saipen), práca sa začína, pokračuje
a plánuje z jedného okna a predplatné CLI, ktoré už platíte
(Claude Code, Codex, Antigravity), bežia ako pripojení pracovníci vedľa agentov
vnútri aplikácie.

**0.0.1** je prvý označený snímok: osobná zostava zameraná na Windows, ktorá sa
používa denne.

## Inštalácia jedným kliknutím

1. Stiahnite **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Dvakrát naň kliknite a stlačte **INŠTALOVAŤ**.

To je všetko. Inštalátor doplní to, čo stroju chýba (Git, Node.js, Python ako
súkromné kópie: bez administrátorských práv), stiahne ZAICODE, SAIPEN a SAIMAIL
z GitHubu, zostaví aplikáciu na stroji a umiestni na plochu skratku
ZAICODE. Prvé spustenie trvá 15 - 30 minút; okno zobrazuje každý krok.

Bezplatné modely fungujú hneď: ZAICODE spustí vlastný smerovač a naplní zásobu
**SAIFREN** z bezklúčových bezplatných úrovní, takže úloha zadaná do New task
dostane odpoveď bez kľúča, bez účtu a bez akéhokoľvek nastavenia. Predplatné Claude Code,
Codex a Antigravity sú voliteľné a prihlásiť sa do nich možno kedykoľvek.

**Jedno celé, štyri časti.** Pracovný priestor (spúšťač, inštalátor), aplikácia, SAIPEN a
SAIMAIL sú štyri repozitáre. Každý sa aktualizuje samostatne: *Settings -> ZAICODE ->
Updates* zobrazuje všetky časti a umožňuje ich aktualizovať ručne alebo automaticky
(kontrola pár minút po štarte a potom každých šesť hodín). Nová zostava aplikácie sa
pripravuje, kým ZAICODE beží, a spustí sa pri ďalšom štarte; vaše vlastné úpravy
v kloni sa nikdy neprepíšu.
Z terminálu: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Autotroubleshoot: `install\Doctor.cmd`. Podrobnosti: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Prehliadka rozhrania

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

## Čo pridáva oproti ZCode

- **Projekty s reláciou MAIN.** Každý projekt má jednu reláciu MAIN (START,
  `/goal cc all`) a pomocné relácie (subSaipens: WIKI, TEST, AUDIT, …).
  Predvolené zobrazenie postranného panelu zobrazuje riadok projektu ako jeho MAIN; ▶ pokračuje v MAIN
  namiesto otvorenia ďalšej relácie. CONTINUE ALL, DONE a CLEAR ALL DONE
  prejdenú všetky projekty; relácia prerušená uprostred kroku zobrazí INTERRUPTED, nikdy DONE.
- **Bezpečnosť pri páde.** Relácie, ktoré odpojil zoslý proces, a stále aktívne ciele
  po reštarte pokračujú samy; bežiace workery sa spustia znova. Agenti
  bežiaci vnútri ZAICODE nedokážu zabiť ZAICODE podľa názvu procesu.
- **Workery.** Subscription CLI bežia v termináloch pripojených k ľubovoľnej hrane
  okna (alebo vo vlastných snapovacích oknách). Otázky „Dôverovať tomuto priečinku?“
  pri prvom spustení sa zodpovedajú; worker, ktorý dosiahne limit použitia, sa nahlási a
  podľa nastavenia sa po resetovaní zatvorí alebo reštartuje.
- **Limity a resetovanie.** Mierky kvót pre každý účet a fond, časovač v titulovom pruhu
  po najbližší reset s úplným zoznamom blížiacich sa resetov pri prechode myšou.
- **SCHEDULER.** Prompty, ktoré sa spúšťajú samy: v daný čas, denne, každých N
  minút alebo keď sa doplní kvótové okno; v jednom projekte alebo v celej sekcii postranného
  panelu, najhoršie projekty (najviac blokovaných / otvorených ticketov SAIPEN) prvé. Podmienky
  môžu najprv zastaviť dočasné riešenia (relácie z voľného fondu, slabšie workery), bežať
  len na nezaťažených projektoch alebo pokračovať len v označených reláciách. Prompty nemajú praktické
  obmedzenie dĺžky.
- **Smerovanie.** Zabudovaný 9router (MIT) dáva fondy bez nastavenia: SAIFREN
  (bezklíčové bezplatné úrovne) a SAIOPP (vaše predplatné).
- **SAIHOME, časovače, zvuky, zvýraznenia.** Prevádzkový prehľad so štatistikami,
  časovačmi a alarmami v štýle FastPrompter, zvukmi pre jednotlivé akcie a tmavo
  zlatým, pixelovo ostrým rozhraním Win95.


## Zostavenie

Požiadavky: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) je jediným zdrojom pravdy).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Zabalená aplikácia sa vždy spustí v režime ZAICODE. Kým beží staršia ZAICODE,
bundler pripraví nové zostavenie v `packages/desktop/dist-next`; koreňový
launcher (vetva `master`, `tools/launcher`) ju vymení pri najbližšom spustení.
Ostrá bitmapová varianta Verdana, ktorú používa UI, nie je súčasťou tohto repozitára;
bez nej rozhranie použije systémovú Verdana.

Kontroly: `pnpm typecheck`, `pnpm lint` a testy ZAICODE, napríklad
`node --import tsx --test test/zaicode*.test.ts` z `packages/ui`.

## Rozloženie repozitára

| Vetva      | Obsah                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | kanonický workspace: launcher, instalátor (`install/`), produktová dokumentácia (`UI.md`, `docs/`), stav SAIPEN a CHANGELOG |
| `zaicode`   | kanonický zdroj aplikácie: história ZCode z upstreamu plus produktová vrstva ZAICODE používaná na zostavenia a aktualizácie |

Legacy alebo automatizáciou vytvorené refy sa môžu dočasne objaviť, nie sú však
kanonické produktové vetvy. Nová práca na workspaci patrí do `master`; práca na zdroji
aplikácie patrí do `zaicode`.

Kód aplikácie vlastnený ZAICODE žije prevažne v `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` a
`packages/desktop/src/main/zaicode*.ts` na vetve `zaicode`. Dokumentácia
workspacesu a nástroje launcher/update žijú na `master`.

## Upstream a licencia

ZAICODE vychádza zo ZCode od Z.ai a je distribuovaný pod rovnakou
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); pôvodné oznámenia sú v
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) a [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Súbory upravil autor ZAICODE. ZAICODE je nezávislý projekt,
nie je prepojený s Z.ai ani ním podporovaný. Pôvodný README ZCode je zachovaný ako
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) a [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Sieť projektov

Tento repozitár je súčasťou širšieho ekosystému **SAIPEN / vacterro**.

[**Centrum autora**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN Community**](https://discord.gg/SEYaYkuVgN)

Na reprodukovateľné chyby a trvalé požiadavky na funkcie použite [GitHub Issues tohto repozitára](https://github.com/vacterro/zaicode/issues). Discord použite na rýchlu diskusiu, snímky obrazovky a spätnú väzbu medzi projektmi.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
