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

ZAICODE to stanowisko operatorskie do uruchamiania wielu agentów programistycznych AI naraz,
na wielu projektach, bez nadzorowania ich. To zmodyfikowana kompilacja
[ZCode](https://github.com/zai-org/ZCode) (aplikacja desktopowa, interfejs przeglądarkowy i agent
CLI) z dodatkową warstwą produktową: każdy projekt prowadzony jest przez
protokół [SAIPEN](https://github.com/vacterro/saipen), praca jest rozpoczynana, kontynuowana
i planowana z jednego okna, a subskrypcyjne CLI, za które już płacisz
(Claude Code, Codex, Antigravity), działają jako dołączone workery obok agentów w aplikacji.

**0.0.1** to pierwsza oznaczona wersja: osobista kompilacja, przede wszystkim na Windows,
używana codziennie.

## Instalacja jednym kliknięciem

1. Pobierz **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Kliknij dwukrotnie i naciśnij **INSTALL**.

To wszystko. Instalator doinstaluje to, czego brakuje (Git, Node.js, Python, jako kopie
prywatne: bez praw administratora), pobiera ZAICODE, SAIPEN i SAIMAIL z GitHuba,
buduje aplikację na maszynie i umieszcza skrót ZAICODE na pulpicie. Pierwsze
uruchomienie trwa 15-30 minut; okno pokazuje każdy krok.

Darmowe modele działają od razu: ZAICODE uruchamia własny router i napełnia pulę **SAIFREN**
z darmowych tierów bez kluczy, więc zadanie wpisane w New task dostaje odpowiedź bez
klucza, bez konta i bez ustawień. Subskrypcje Claude Code, Codex i Antigravity są
opcjonalne — można się zalogować w dowolnej chwili.

**Jedno całe, cztery części.** Obszar roboczy (launcher, instalator), aplikacja, SAIPEN i
SAIMAIL to cztery repozytoria. Każde aktualizuje się osobno: *Ustawienia -> ZAICODE ->
Aktualizacje* pokazuje każdą część, aktualizuje ją ręcznie lub automatycznie (sprawdzanie
kilka minut po starcie i co sześć godzin). Nowa kompilacja aplikacji przygotowuje się
w trakcie pracy ZAICODE i uruchamia przy następnym starcie; Twoje własne zmiany w klonie
nigdy nie są nadpisywane. Z terminala: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Autodiagnostyka: `install\Doctor.cmd`. Szczegóły: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Przewodnik po interfejsie

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

## Co dodaje do ZCode

- **Projekty z sesją MAIN.** Każdy projekt ma jedną sesję MAIN (START,
  `/goal cc all`) oraz sesje pomocnicze (subSaipens: WIKI, TEST, AUDIT, …).
  Domyślny widok paska bocznego pokazuje wiersz projektu jako jego MAIN; ▶
  kontynuuje MAIN zamiast otwierać kolejną sesję. CONTINUE ALL, DONE i CLEAR ALL
  DONE obsługują wszystkie projekty; sesja przerwana w trakcie tury pokazuje
  INTERRUPTED, nigdy DONE.
- **Odporność na awarie.** Sesje przerwane przez martwy proces i nadal aktywne
  cele wznawiają się po restarcie; działające workery startują ponownie. Agenci
  wewnątrz ZAICODE nie mogą zabić ZAICODE po nazwie procesu.
- **Workery.** CLI subskrypcyjne działają w terminalach dokowanych do dowolnej
  krawędzi okna (lub we własnych oknach z przyciąganiem). Pytania "Trust this
  folder?" przy pierwszym uruchomieniu są odpowiedziane; worker po osiągnięciu
  limitu użycia jest raportowany i — zależnie od ustawienia — zamknięty lub
  zrestartowany po resecie.
- **Limity i resety.** Mierniki limitów per konto i pula, licznik na pasku tytułu
  do najbliższego resetu, a po najechaniu pełna lista nadchodzących resetów.
- **SCHEDULER.** Prompty startujące same: o danej godzinie, codziennie, co N
  minut lub gdy uzupełnia się okno limitu; w jednym projekcie lub całej sekcji
  paska bocznego, najgorsze projekty (najbardziej zablokowane / otwarte tickety
  SAIPEN) najpierw. Warunki mogą najpierw zatrzymać pracę doraźną (sesje z
  darmowej puli, słabsze workery), działać tylko na bezczynnych projektach lub
  kontynuować tylko oznaczone sesje. Prompty nie mają praktycznego limitu
  długości.
- **Routing.** Wbudowany 9router (MIT) daje pule bez konfiguracji: SAIFREN
  (darmowe pakiety bez klucza) i SAIOPP (twoje subskrypcje).
- **SAIHOME, timery, dźwięki, wyróżnienia.** Strona operatora ze statystykami,
  timerami i alarmami w stylu FastPrompter, dźwiękami per akcja oraz ostrym
  pikselowo interfejsem Win95 w złotej, ciemnej tonacji.

## Kompilacja

Wymagania: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) jest źródłem prawdy).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Spakowana aplikacja zawsze startuje w trybie ZAICODE. Gdy działa starszy ZAICODE,
  bundler umieszcza nowy build w `packages/desktop/dist-next`; launcher w katalogu głównym
  (gałąź `master`, `tools/launcher`) podmienia go przy następnym starcie.
  Ostry bitmapowy wariant Verdany używany przez UI nie jest częścią tego repozytorium;
  bez niego interfejs wraca do systemowej Verdany.

Kontrole: `pnpm typecheck`, `pnpm lint` oraz testy ZAICODE, na przykład
`node --import tsx --test test/zaicode*.test.ts` z `packages/ui`.

## Układ repozytorium

| Gałąź      | Zawartość                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | kanoniczny workspace: launcher, instalator (`install/`), dokumentacja produktu (`UI.md`, `docs/`), stan SAIPEN i CHANGELOG |
| `zaicode`   | kanoniczne źródło aplikacji: historia ZCode z upstreamu plus warstwa produktowa ZAICODE używana do buildów i aktualizacji |

Kolejne referencje po legacy lub utworzone przez automatyzację mogą się
pojawiać tymczasowo, ale nie są kanonicznymi gałęziami produktu. Nowa praca nad
workspace trafia na `master`; praca nad źródłem aplikacji na `zaicode`.

Kod aplikacji należący do ZAICODE żyje głównie w `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` i
`packages/desktop/src/main/zaicode*.ts` na gałęzi `zaicode`. Dokumentacja
workspace i tooling launchera/update żyją na `master`.

## Upstream i licencja

ZAICODE pochodzi z ZCode autorstwa Z.ai i jest rozpowszechniane na tych samych
warunkach [Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); notice upstream zachowano w
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) i [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Pliki zostały zmodyfikowane przez autora ZAICODE. ZAICODE to niezależny projekt,
niepowiązany z Z.ai ani przez Z.ai wspierany. Oryginalny README ZCode zachowano jako
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) i [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Sieć projektów

To repozytorium jest częścią szerszego ekosystemu projektów **SAIPEN / vacterro**.

[**Centrum autora**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**Społeczność SAIPEN**](https://discord.gg/SEYaYkuVgN)

Zgłaszaj powtarzalne błędy i trwałe prośby o funkcje przez [Issues na GitHub tego repozytorium](https://github.com/vacterro/zaicode/issues). Discord służy do szybkich dyskusji, zrzutów ekranu i opinii między projektami.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
