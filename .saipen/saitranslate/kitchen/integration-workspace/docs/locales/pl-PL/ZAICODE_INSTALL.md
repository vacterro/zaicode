# Instalowanie ZAICODE

ZAICODE to trzy projekty działające jako jedno: aplikacja ZAICODE, SAIPEN (protokół,
który pilnuje, by praca agentów nie rozjeżdżała się) i SAIMAIL (poczta, którą agenci
komunikują się ze sobą). Ręczna instalacja oznacza trzy klony, łańcuch narzędzi Node.js,
środowisko Pythona i build. Instalator robi to wszystko:
uruchom go, poczekaj, a skrót ZAICODE znajdziesz na pulpicie.

## Jedno kliknięcie

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  pobierz, kliknij dwukrotnie, naciśnij **INSTALL**. Okno (złote na ciemnym tle,
  baner SAIPEN) pokazuje każdy krok w trakcie, czas dotychczasowy i log na żądanie;
  na koniec **START ZAICODE**, albo **TRY AGAIN** / **Autotroubleshoot**
  / **Open log**, gdy któryś krok się nie dokończył. Wskazane na istniejący folder ZAICODE
  przycisk zmienia się w **UPDATE**: ten sam przebieg aktualizuje i naprawia. Plik
  exe zawiera skrypty instalacyjne i nie wymaga niczego obok; buduje go
  `install\setup\build.cmd` (kompilator .NET Framework dostępny w każdym Windows 10/11).
- `install\Setup-ZAICODE.cmd` (podwójne kliknięcie): ta sama instalacja w konsoli.
- Od zera, w PowerShellu:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Opcje konfiguracji: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (folder presetów),
`/auto` (uruchamia się od razu), `/quiet` (bez okna: instalator konsolowy, kod wyjścia
= wynik). Pierwsze uruchomienie buduje aplikację na tej maszynie, co trwa chwilę;
późniejsze tylko aktualizują i naprawiają.

## Darmowe modele, zero konfiguracji

Aplikacja ma własny 9router. Na maszynie bez niego ZAICODE uruchamia go
prywatnie (tryb izolowany, port 20138), wypełnia **SAIFREN** z kluczowych darmowych
tierów i ustawia `SAIRoute / SAIFREN` jako model nowych zadań, więc pierwsze zadanie
wpisane w Nowe zadanie dostaje odpowiedź: bez klucza, bez konta, bez ustawień. Logowania
Claude Code, Codex i Antigravity są opcjonalne; logowanie, którego nie skonfigurowano
na maszynie, pokazuje się jako „opcjonalne, zaloguj się kiedykolwiek”, a nie jako pozycja
„wymaga Cię”. Dowód: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
uruchamia spakowaną aplikację na pustym profilu (własne HOME, APPDATA i
LOCALAPPDATA) i przechodzi tylko wtedy, gdy router jest izolowany, SAIFREN odpowiada
na sondę pierwszego tokenu, a zadanie w Nowe zadanie dostaje odpowiedź.

## Aktualizacje: cztery części, jeden ZAICODE

Obszar roboczy (launcher, instalator), aplikacja, SAIPEN i SAIMAIL to cztery klony. Każdy z nich aktualizuje się osobno: **Ustawienia -> ZAICODE -> Aktualizacje** wymienia je wraz z wersją i commitem, aktualizuje pojedynczo ręcznie lub wszystkie naraz i ma przełącznik „samodzielnie" dla każdej części (domyślnie włączony w zainstalowanym ZAICODE, wyłączony w kopii deweloperskiej). ZAICODE sprawdza aktualizacje kilka minut po starcie, a potem co sześć godzin. Po aktualizacji każda część dostaje to, czego potrzebuje: aplikacja swoje zależności (gdy `pnpm-lock.yaml` się przestawił) i nowy build (przygotowany, gdy ZAICODE działa, uruchamiany przy następnym starcie), SAIPEN swój launcher, SAIMAIL swoją instalację `.venv`, obszar roboczy nowy launcher główny. Klon na innej gałęzi, z lokalnymi commitami lub z edycjami, które aktualizacja by nadpisała, jest zgłaszany i pozostawiany dokładnie taki, jaki jest.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Co to robi

Instalator to sprawdzenia Autotroubleshoot uruchamiane z „naprawą” na pustym
folderze, w tej kolejności. Każdy krok jest idempotentny, więc ponowne uruchomienie
aktualizuje instalację i naprawia to, co się zepsuło.

| Sprawdzenie | Naprawa |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | używa kopii z maszyny, gdy pasuje; w przeciwnym razie prywatna kopia w `.tools\` (MinGit z Git for Windows, Node.js 24.14.0 z nodejs.org, Python z jego pakietu NuGet). Bez uprawnień administratora. |
| pnpm | przypięty pnpm 10.33.2 w `.tools\pnpm10` |
| Przestrzeń robocza ZAICODE | klon `vacterro/zaicode` branch `master` (źródło launchera, instalator, dokumentacja; pamięć `.saipen/` dewelopera pominięta; branch `workspace` do 2026-09-27) |
| Kod źródłowy aplikacji ZAICODE | klon brancha `zaicode` do `zcode\` |
| SAIPEN | klon `vacterro/saipen` do `saipen\`; jego `bin\saipen.cmd` jest pisany dla tego klonu i tego Pythona |
| SAIMAIL | klon `vacterro/saimail` do `saimail\`, instalowany do `.venv\` |
| saimail-local | klient wiersza poleceń SAIMAIL, używany przez panele SAIMAIL w ZAICODE (dostępny od SAIMAIL `0.0.2a3`; sprawdzenie `saimail-cli` raportuje OK) |
| Pakiet 9router | `9router` z npm do `.tools\router`, dołączony, aby SAIFREN działał bez konfiguracji (WARN, gdy npm nie może go pobrać) |
| Zależności aplikacji | `pnpm install --frozen-lockfile` (ponownie, gdy zmieni się `pnpm-lock.yaml`) |
| Build aplikacji | `pnpm bundle:zaicode`; gdy ZAICODE działa, nowy build jest przygotowy i podmieniany przy następnym starcie |
| Podmiana przygotowanego buildu | czyści `win-unpacked.previous` pozostawiony po błędzie podmiany z długą ścieżką i podmienia oczekujący build, gdy ZAICODE jest zamknięty |
| Launcher główny | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Skróty | Pulpit i menu Start `ZAICODE` -> `ZAICODE.exe` |
| Logowania Claude / Codex | tylko raportowane: każde logowanie `~\.claude*` / `~\.codex*` to własny engine w ZAICODE (A1, A2, C1, ...); logowanie wymaga Cię, w przeglądarce |

Launcher główny wskazuje ZAICODE zainstalowany SAIPEN (`saipen\`) i ustawia
`.tools\` oraz `.venv\Scripts` na początku PATH aplikacji, więc aplikacja, jej agenci
i jej workery używają zainstalowanych kopii.

## Kilka subskrypcji

Każde logowanie Claude Code lub Codex ma własny katalog domowy: `~\.claude`,
`~\.claude-account2`, ... oraz `~\.codex`, `~\.codex-account2`, ... ZAICODE znajduje
je wszystkie. Aby przygotować więcej w czasie instalacji:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Installer tworzy te katalogi i wypisuje dokładne polecenie logowania dla każdego
(`$env:CODEX_HOME = '...'; codex login`). Tak samo w ZAICODE: Ustawienia ->
Silniki i limity -> dodaj kolejne logowanie.

## Autodiagnostyka

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Status dla każdego sprawdzenia: OK, FIXED (było zepsute, naprawione), WARN (działa, ale brakuje
czegoś opcjonalnego), INFO (potrzebuje Ciebie: logowanie), FAIL. Logi są w
`install\logs\`; podsumowanie ostatniej instalacji to `install\install-report.json`.
W aplikacji Router -> Autotroubleshoot naprawia uruchomiony router i pule.

## Opcje

| Parametr | Domyślnie | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | gdzie trafia wszystko |
| `-ShortcutDir` | Desktop | gdzie trafia skrót ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | pomiń te skróty |
| `-PortableTools` | | prywatne Git / Node.js / Python nawet gdy maszyna je ma |
| `-Launch` | | uruchom ZAICODE po zakończeniu |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | repozytoria GitHub | inne źródło (fork, ścieżka lokalnego klonu) |

## Dowód

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
sprawdza świeżą instalację, wprowadza uszkodzenia (usunięty skrót i launcher, launcher SAIPEN
wskazujący na brakujący Python, usunięty venv SAIMAIL, node_modules
zapisany dla innego lockfile, pozostały folder build głębiej niż MAX_PATH),
sprawdza, że doctor zgłasza i naprawia każde z nich, następnie uruchamia cel skrótu
z izolowanym profilem i zatrzymuje dokładnie uruchomione drzewo procesów.

`install\tests\Test-ZaicodeUpdate.ps1` tworzy cztery jednorazowe repozytoria na
dysku oraz instalację ich klonów, następnie dowodzi, że sprawdzenie nic nie zmienia,
że jedna część aktualizuje się sama wraz ze swoją zależnością (launcher SAIPEN, launcher
root), że nakładające się lokalne edycje i lokalne commity są zachowywane oraz że nieznana
nazwa części jest odrzucana. Bez sieci.
<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
