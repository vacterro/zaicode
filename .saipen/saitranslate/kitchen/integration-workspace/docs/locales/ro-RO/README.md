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

ZAICODE este o bancă de lucru pentru operatori: rulează mulți agenți de codare AI simultan, pe
mai multe proiecte, fără supraveghere. Este o versiune modificată a
[ZCode](https://github.com/zai-org/ZCode) (aplicație desktop, interfață în browser și
CLI pentru agenți), cu un strat de produs adăugat: fiecare proiect este condus prin
protocolul [SAIPEN](https://github.com/vacterro/saipen), lucrul este pornit, continuat
și programat dintr-o singură fereastră, iar CLI-urile de abonament pe care deja le
plătești (Claude Code, Codex, Antigravity) rulează ca lucrători dockați lângă agenții
din aplicație.

**0.0.1** este primul instantaneu etichetat: o versiune personală, orientată pe Windows, folosită
zi de zi.

## Instalare cu un singur clic

1. Descarcă **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Dublu-clic pe el și apasă **INSTALARE**.

Atât. Instalarea aduce ce îi lipsește calculatorului (Git, Node.js, Python, ca
copii private: fără drepturi de administrator), preia ZAICODE, SAIPEN și SAIMAIL de pe GitHub,
compilează aplicația pe calculator și pune o scurtătură ZAICODE pe desktop. Prima
rulare durează 15-30 de minute; fereastra arată fiecare pas.

Modelele gratuite funcționează imediat: ZAICODE pornește propriul router și umple pool-ul **SAIFREN**
din tier-uri gratuite fără cheie, așa că o sarcină tastată în New task primește răspuns fără
cheie, fără cont și fără nicio setare. Abonamentele Claude Code, Codex și Antigravity
sunt opționale și pot fi conectate oricând.

**Un întreg, patru părți.** Workspace-ul (lansatorul, instalatorul), aplicația, SAIPEN și
SAIMAIL sunt patru repositoare. Fiecare se actualizează separat: *Settings -> ZAICODE ->
Updates* arată fiecare parte, o actualizează manual sau automat (verificat la câteva minute
după pornire și la fiecare șase ore). O versiune nouă a aplicației se pregătește cât timp ZAICODE rulează
și pornește la următoarea repornire; modificările tale proprii într-o clonă nu sunt niciodată suprascrise.
Dintr-un terminal: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Depanare automată: `install\Doctor.cmd`. Detalii: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Prezentarea interfeței

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

## Ce adaugă față de ZCode

- **Proiecte cu o sesiune MAIN.** Fiecare proiect are o singură sesiune MAIN (START,
  `/goal cc all`) și sesiuni auxiliare (subSaipens: WIKI, TEST, AUDIT, …). Vizualizarea
  implicită din bara laterală afișează rândul proiectului drept MAIN-ul său; ▶ continuă
  MAIN în loc să deschidă o altă sesiune. CONTINUE TOATE, FINALIZAT și ȘTERGE TOATE
  FINALIZATE parcurg fiecare proiect; o sesiune întreruptă la mijlocul unui tur afișează
  INTERUPIS, niciodată FINALIZAT.
- **Siguranță la blocare.** Sesiunile tăiate de un proces mort și obiectivele încă active
  își reiau automat după repornire; workerii în execuție pornesc din nou. Agenții din
  ZAICODE nu pot omoarâ ZAICODE după numele procesului.
- **Workeri.** CLI-urile din abonamente rulează în terminale ancorate la orice margine a
  ferestrei (sau în ferestre proprii, cu lipire). Întrebările „Încrezi în acest folder?”
  de la prima rulare primesc răspuns automat; un worker care atinge limita de utilizare
  este raportat și, conform setării, închis ori repornit după resetare.
- **Limite și resetări.** Contori de cotă per cont și per pool, plus un cronometru în bara
  de titlu pentru resetarea cea mai apropiată, cu lista completă a resetărilor la hover.
- **SCHEDULER.** Prompturi care pornesc singure: la o oră, zilnic, la fiecare N minute
  sau când o fereastră de cotă se reumple; într-un proiect sau într-o secțiune întreagă
  din bara laterală, primele fiind proiectele cele mai blocate (cele mai multe bilete SAIPEN
  deschise). Condițiile pot opri mai întâi lucrurile provizorii (sesiunile din poolul
  gratuit, workerii mai slabi), pot rula doar pe proiecte inactive sau pot continua doar
  sesiunile marcate. Prompturile nu au limită practică de lungime.
- **Rutare.** Un 9router inclus (MIT) oferă pooluri fără configurare: SAIFREN (niveluri
  gratuite fără cheie) și SAIOPP (abonamentele tale).
- **SAIHOME, cronometre, sunete, evidențieri.** Un panou de operare cu statistici,
  cronometre și alarme în stil FastPrompter, sunete per acțiune și o interfață Win95 dark
  golden, pixel-perfectă.

## Compilare

Cerințe: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) este sursa de adevăr).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Aplicația împachetată pornește întotdeauna în modul ZAICODE. Cât timp rulează un ZAICODE
mai vechi, bundler-ul pregătește noua versiune în `packages/desktop/dist-next`; launcherul
de la rădăcină (ramura `master`, `tools/launcher`) o înlocuiește la următoarea pornire.
Varianta Verdana bitmap, fără estompare, folosită de interfață nu face parte din acest
repository; fără ea, interfața revine la Verdana de sistem.

Verificări: `pnpm typecheck`, `pnpm lint` și testele ZAICODE, de exemplu
`node --import tsx --test test/zaicode*.test.ts` din `packages/ui`.

## Structura repository-ului

| Ramură      | Conținut                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | spațiul de lucru canonic: launcher, installer (`install/`), documentația produsului (`UI.md`, `docs/`), stare SAIPEN și CHANGELOG |
| `zaicode`   | sursa canonică a aplicației: istoricul ZCode din upstream plus stratul de produs ZAICODE folosit pentru builduri și actualizări |

Referințele legacy sau create de automatizări pot apărea încă temporar, dar nu
sunt ramuri de produs canonice. Lucrările noi din workspace intră în `master`; lucrările
la sursa aplicației intră în `zaicode`.

Codul aplicației deținut de ZAICODE se află în principal în `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` și
`packages/desktop/src/main/zaicode*.ts`, pe ramura `zaicode`. Documentația
workspace-ului și tooling-ul launcherului/update se află pe `master`.

## Upstream și licență

ZAICODE este derivat din ZCode de către Z.ai și distribuit sub aceeași
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); notificările din sursa originală se păstrează în
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) și [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Fișierele au fost modificate de autorul ZAICODE. ZAICODE este un proiect independent,
neafiliat cu și neaprobat de Z.ai. README-ul original ZCode este păstrat ca
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) și [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Rețeaua proiectului

Acest depozit face parte din ecosistemul mai larg de proiecte **SAIPEN / vacterro**.

[**Hubul autorului**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**Comunitatea SAIPEN**](https://discord.gg/SEYaYkuVgN)

Pentru bug-uri reproductibile și cereri de funcționalități de durată, folosiți [GitHub Issues din acest depozit](https://github.com/vacterro/zaicode/issues). Folosiți Discord pentru discuții rapide, capturi de ecran și feedback între proiecte.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
