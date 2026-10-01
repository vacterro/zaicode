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

A ZAICODE egy üzemeltetői munkaállomás: egyszerre sok AI-kódoló ügynök futtatható sok projekten, felügyelet nélkül. A [ZCode](https://github.com/zai-org/ZCode) módosított buildje (asztali alkalmazás, böngészős felület és ügynök
CLI), ráépülő termékréteggel: minden projektet a [SAIPEN](https://github.com/vacterro/saipen) protokoll hajt, a munkát egyetlen ablakból indítod, folytatod és ütemezed, a már előfizetett CLI-k
(Claude Code, Codex, Antigravity) pedig dokkolt végrehajtóként futnak az alkalmazáson belüli
ügynökök mellett.

A **0.0.1** az első címkézett pillanatkép: személyes, Windowsra elsőként készült build, amit
naponta használok.

## Telepítés egy kattintással

1. Töltsd le a **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)** fájlt.
2. Kattints rá duplán, majd nyomd meg az **INSTALL** gombot.

Ennyi az egész. A telepítő pótolja, amiből a gépen hiányzik (Git, Node.js, Python, privát példányként: nem kell rendszergazdai jog), letölti a ZAICODE-ot, a SAIPEN-t és a SAIMAIL-t a GitHubról,
felépíti az alkalmazást a gépen, és ikont tesz az asztalra. Az első
indítás 15-30 perc; az ablak minden lépést megmutat.

Az ingyenes modellek rögtön működnek: a ZAICODE elindítja a saját routerét, és feltölti a **SAIFREN** készletet kulcs nélküli ingyenes sávokból, így az Új feladat mezőbe beírt feladat kulcs, fiók és
beállítás nélkül kap választ. A Claude Code, Codex és Antigravity előfizetések
opcionálisak, bármikor bejelentkezhetsz velük.

**Egy egész, négy rész.** A munkaterület (indító, telepítő), az alkalmazás, a SAIPEN és a
SAIMAIL négy külön tároló. Mindegyik önállóan frissül: a *Beállítások -> ZAICODE ->
Frissítések* megjeleníti az összes részt, kézzel vagy magától frissíti (indítás után
néhány perccel, majd hatóránként). Az új alkalmazás-build a ZAICODE futása közben készül el,
és a következő indítással lép életbe; a saját módosításaid egy klónban soha nem
íródnak felül.
Terminálból: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Automatikus hibakeresés: `install\Doctor.cmd`. Részletek: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Felületi túra

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

## Mit ad hozzá a ZCode-hoz

- **Projektek MAIN munkamenettel.** Minden projektnek egy MAIN munkamenete van (START,
  `/goal cc all`) és segédmunkamenetei (subSaipens: WIKI, TEST, AUDIT, …). Az alapértelmezett
  oldalsáv nézet a projekt sort MAIN-ként mutatja; a ▶ a MAIN-t folytatja,
  nem nyit új munkamenetet. A CONTINUE ALL, DONE és CLEAR ALL DONE
  minden projektet átfésül; a félbeszakadt munkamenet INTERRUPTED jelölést kap, sosem DONE-t.
- **Összeomlás-biztosság.** A halott folyamat által megszakított munkamenetek és az
  még aktív célok újraindítás után maguktól folytatódnak; a futó workerek újraindulnak.
  A ZAICODE-on belüli agentek nem tudják folyamatnév alapján megölni a ZAICODE-ot.
- **Workerek.** Az előfizetéses CLI-k a window bármely széléhez dokkolt terminálban futnak
  (vagy saját, snapelhető ablakukban). Az első futáskori „Megbízolod ezt a mappát?”
  kérdések megválaszolásra kerülnek; a használati limitet elérő worker jelentésre kerül, és
  beállítástól függően lezárólik vagy újraindul a reset után.
- **Limittek és resetek.** Kvótamérők fiókonként és készenként, címsáv-időzítő
  a legközelebbi resethez, hoverre a teljes lista a következő resetekről.
- **SCHEDULER.** Maguktól induló promptok: adott időpontban, naponta, minden N
  percben, vagy amikor egy kvótaablak feltöltődik; egy projektben vagy a teljes
  oldalsávszekcióban, a legrosszabb projektek (legtöbb blokkolt / nyitott SAIPEN ticket) elöl.
  A feltételek először leállíthatják az ideiglenes munkát (ingyenes készen lévő munkamenetek,
  gyengébb workerek), csak üresjárati projekteken futhatnak, vagy csak megjelölt
  munkameneteket folytathatnak. A promptoknak nincs gyakorlati hosszkorlátja.
- **Routing.** A csomagolt 9router (MIT) nulla beállítást igénylő készleteket ad:
  SAIFREN (kulcs nélküli ingyenes szintek) és SAIOPP (a saját előfizetéseid).
- **SAIHOME, időzítők, hangok, kiemelések.** Operátor kezdőlap statisztikákkal,
  FastPrompter-stílusú időzítőkkel és riasztásokkal, műveletenkénti hangokkal és
  Win95-ös sötét arany, pixelsharp felülettel.

## Fordítás

Követelmények: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) az igazság forrása).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

A csomagolt app mindig ZAICODE módban indul. Amíg egy régebbi ZAICODE fut,
a bundler az új buildet ide állítja: `packages/desktop/dist-next`; a root
launcher (`master`, `tools/launcher`) a következő indításkor becseréli.
A UI által használt éles bitmap Verdana variáns nem része ennek a repónak;
nélküle a felület a rendszer Verdana-jára esik vissza.

Ellenőrzések: `pnpm typecheck`, `pnpm lint`, valamint a ZAICODE tesztek, például
`node --import tsx --test test/zaicode*.test.ts` innen: `packages/ui`.

## Repó elrendezés

| Branch      | Tartalom                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | a kanonikus workspace: launcher, installer (`install/`), termékdokumentáció (`UI.md`, `docs/`), SAIPEN állapot és CHANGELOG |
| `zaicode`   | a kanonikus app forrás: upstream ZCode előzmény plusz a buildekhez és frissítésekhez használt ZAICODE termékréteg |

Legacy vagy automatizálás által létrehozott refek még ideiglenesen felbukhannak, de nem
kanonikus termékbranchek. Új workspace munka a `master` branchre tartozik; app-forrás
munka a `zaicode` branchre.

A ZAICODE-hoz tartozó appkód főként itt található: `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` és
`packages/desktop/src/main/zaicode*.ts`, a `zaicode` branchen. A workspace
dokumentáció és a launcher/update eszközlánc a `master` branchen él.

## Upstream és licenc

A ZAICODE a Z.ai ZCode-jából származik, és ugyanazon
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE) licenc szerint terjesztjük; az upstream értesítések a
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) és a [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md) fájlban maradtak.
A fájlokat a ZAICODE szerzője módosította. A ZAICODE független projekt,
nem kapcsolódik a Z.ai-hez, és nem támogatottja azt. Az eredeti ZCode README megmaradt mint
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) és [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Projekthálózat

Ez a repository a tágabb **SAIPEN / vacterro** projektökoszisztém része.

[**Szerzőközpont**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN Közösség**](https://discord.gg/SEYaYkuVgN)

A reprodukálható hibák és tartós funkciókérelmek bejelentéséhez a [repository GitHub Issues oldalát](https://github.com/vacterro/zaicode/issues) használd. A Discordot gyors megbeszéléshez, képernyőképekhez és projektek közötti visszajelzéshez használd.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
