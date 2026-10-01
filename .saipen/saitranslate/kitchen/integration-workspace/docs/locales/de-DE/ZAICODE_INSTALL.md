# ZAICODE installieren

ZAICODE besteht aus drei Projekten, die wie eines funktionieren: die ZAICODE-App, SAIPEN (das
Protokoll, das die Agentenarbeit auf Kurs hält) und SAIMAIL (die Post, mit der sich
Agenten gegenseitig informieren). Manuelles Installieren bedeutet drei Clones, eine Node.js
Toolchain, eine Python-Umgebung und einen Build. Der Installer erledigt das alles:
starten, warten, und eine ZAICODE-Verknüpfung liegt auf dem Desktop.

## Ein Klick

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  herunterladen, doppelklicken, **INSTALL** drücken. Das Fenster (Gold auf Dunkel,
  das SAIPEN-Banner) zeigt jeden Schritt beim Ausführen, die bisherige Zeit und
  das Protokoll auf Abruf; am Ende **START ZAICODE**, oder **TRY AGAIN** /
  **Autotroubleshoot** / **Open log**, wenn ein Schritt nicht fertig wurde. Auf einen
  vorhandenen ZAICODE-Ordner zeigt die Schaltfläche **UPDATE**: derselbe Lauf
  aktualisiert und repariert. Die exe enthält die Installationsskripte und
  benötigt nichts daneben; sie wird von `install\setup\build.cmd` gebaut (dem .NET-Framework-Compiler,
  den jedes Windows 10/11 hat).
- `install\Setup-ZAICODE.cmd` (Doppelklick): dieselbe Installation in der Konsole.
- Aus dem Nichts, in PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Setup-Optionen: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (voreingestellter Ordner),
`/auto` (startet sofort), `/quiet` (ohne Fenster: der Konsolen-Installer, Exit-Code
= Ergebnis). Der erste Lauf baut die App auf diesem Rechner, das dauert;
spätere Läufe aktualisieren und reparieren nur.

## Kostenlose Modelle, nichts einzurichten

Die App bringt ihr eigenes 9router mit. Auf einem Rechner ohne 9router startet
ZAICODE es privat (isolierter Modus, Port 20138), befüllt **SAIFREN** aus
 schlüsselosen Free-Tiers und macht `SAIRoute / SAIFREN` zum Modell neuer Aufgaben,
sodass die erste in Neue Aufgabe eingegebene Aufgabe eine Antwort bekommt:
kein Key, kein Konto, keine Einstellung. Logins für Claude Code, Codex und
Antigravity sind optional; ein nicht eingerichteter Login erscheint als
"optional, jederzeit anmelden", nicht als Punkt "benötigt dich".
Nachweis: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
startet die mitgelieferte App mit leerem Profil (eigenes HOME, APPDATA und
LOCALAPPDATA) und besteht nur, wenn der Router isoliert ist, SAIFREN seine
First-Token-Sonde beantwortet und eine Aufgabe in Neue Aufgabe beantwortet wird.

## Updates: vier Teile, ein ZAICODE

Der Workspace (Launcher, Installer), die App, SAIPEN und SAIMAIL sind vier
Klone. Jeder aktualisiert sich selbst: **Settings -> ZAICODE -> Updates** listet
sie mit Version und Commit, aktualisiert einzeln oder alle und hat pro Teil
einen Schalter "selbstständig" (in einer installierten ZAICODE an, in einem
Entwickler-Checkout aus). ZAICODE prüft wenige Minuten nach dem Start und
danach alle sechs Stunden. Nach einem Update bekommt jeder Teil, was er
braucht: die App ihre Abhängigkeiten (wenn `pnpm-lock.yaml` umgezogen ist) und
einen neuen Build (bereitgestellt, während ZAICODE läuft, gestartet beim
nächsten Start), SAIPEN seinen Launcher, SAIMAIL sein `.venv`-Install,
der Workspace einen neuen Root-Launcher. Ein Klon auf einem anderen Branch, mit
lokalen Commits oder mit Änderungen, die das Update überschreiben würde, wird
gemeldet und exakt so belassen.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Was es tut

Der Installer ist die Autotroubleshoot-Prüfungen, die mit "repair" auf einem
leeren Ordner in dieser Reihenfolge laufen. Jeder Schritt ist idempotent, ein
erneuter Lauf aktualisiert die Installation und repariert, was kaputt ist.

| Check | Reparatur |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | nutzt die Kopie des Rechners, wenn sie passt; sonst eine private Kopie in `.tools\` (MinGit aus Git for Windows, Node.js 24.14.0 von nodejs.org, Python aus seinem NuGet-Paket). Keine Administratorrechte. |
| pnpm | das festgelegte pnpm 10.33.2 in `.tools\pnpm10` |
| ZAICODE-Arbeitsbereich | Klon von `vacterro/zaicode`, Branch `master` (Launcher-Quellen, Installer, Doku; der `.saipen/` des Entwicklers bleibt außen vor; Branch `workspace` bis 2026-09-27) |
| ZAICODE-App-Quellen | Klon von Branch `zaicode` nach `zcode\` |
| SAIPEN | Klon von `vacterro/saipen` nach `saipen\`; dessen `bin\saipen.cmd` ist für diesen Klon und dieses Python geschrieben |
| SAIMAIL | Klon von `vacterro/saimail` nach `saimail\`, installiert nach `.venv\` |
| saimail-local | Kommandozeilen-Client von SAIMAIL, den die SAIMAIL-Bedienfelder von ZAICODE verwenden (seit SAIMAIL `0.0.2a3` enthalten; die `saimail-cli`-Prüfung meldet OK) |
| 9router-Paket | `9router` aus npm nach `.tools\router`, gebündelt, damit SAIFREN ohne Einrichtung läuft (WARN, wenn npm es nicht erreicht) |
| App-Abhängigkeiten | `pnpm install --frozen-lockfile` (erneut, wenn sich `pnpm-lock.yaml` ändert) |
| App-Build | `pnpm bundle:zaicode`; solange ZAICODE läuft, wird der neue Build bereitgestellt und beim nächsten Start übernommen |
| Übernahme des bereitgestellten Builds | entfernt eine `win-unpacked.previous`, die ein Fehlschlag der Übernahme wegen langer Pfade hinterlassen hat, und übernimmt einen wartenden Build, während ZAICODE geschlossen ist |
| Root-Launcher | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Verknüpfungen | Desktop und Startmenü `ZAICODE` -> `ZAICODE.exe` |
| Claude-/Codex-Anmeldungen | nur gemeldet: jede `~\.claude*`-/`~\.codex*`-Anmeldung ist eine eigene Engine in ZAICODE (A1, A2, C1, ...); eine Anmeldung braucht dich, im Browser |

Der Root-Launcher zeigt ZAICODE auf das installierte SAIPEN (`saipen\`) und
stellt `.tools\` und `.venv\Scripts` an die Spitze des PATH der App, damit
App, Agenten und Worker die installierten Kopien nutzen.

## Mehrere Abos

Jeder Claude-Code- oder Codex-Login hat sein eigenes Home: `~\.claude`,
`~\.claude-account2`, ... und `~\.codex`, `~\.codex-account2`, ... ZAICODE findet
sie alle. Weitere zur Installationszeit vorbereiten:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Der Installer legt die Homes an und gibt für jedes den genauen Login-Befehl aus
(`$env:CODEX_HOME = '...'; codex login`). Dasselbe in ZAICODE: Settings ->
Engines & limits -> weiteren Login hinzufügen.

## Automatische Fehlerbehebung

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Status pro Prüfung: OK, FIXED (war defekt, repariert), WARN (funktioniert, aber es fehlt
etwas Optionales), INFO (braucht dich: ein Login), FAIL. Logs liegen in
`install\logs\`; die Zusammenfassung der letzten Installation ist `install\install-report.json`.
In der App repariert Router -> Autotroubleshoot den laufenden Router und die Pools.

## Optionen

 Parameter | Standard | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | wohin alles kommt |
| `-ShortcutDir` | Desktop | wo der ZAICODE-Shortcut hin soll |
| `-NoStartMenu`, `-NoShortcut` | | diese Shortcuts überspringen |
| `-PortableTools` | | eigenes Git / Node.js / Python, auch wenn der Rechner sie hat |
| `-Launch` | | ZAICODE starten, wenn fertig |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | die GitHub-Repos | andere Quelle (ein Fork, ein lokaler Clone-Pfad) |

## Nachweis

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
prüft eine frische Installation, bringt Fehler ein (Shortcut und Launcher gelöscht, SAIPEN
Launcher zeigt auf fehlendes Python, venv von SAIMAIL gelöscht, node_modules
für eine andere Lockfile vermerkt, übrig gebliebene Build-Mappe tiefer als MAX_PATH),
prüft, dass der Doctor jeden meldet und repariert, startet dann das Ziel des Shortcuts
mit isoliertem Profil und beendet genau den Prozessbaum, den er gestartet hat.

`install\tests\Test-ZaicodeUpdate.ps1` baut vier Wegwerf-Repos auf
der Festplatte und eine Installation ihrer Klone und beweist dann: Eine Prüfung ändert nichts, ein einzelnes
Teil wird mit Folge-Update nur für sich aktualisiert (SAIPEN-Launcher, Root-Launcher),
überlappende lokale Änderungen und lokale Commits bleiben erhalten, und ein unbekannter
Teilname wird abgelehnt. Kein Netzwerk.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
