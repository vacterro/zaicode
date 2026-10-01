# ZAICODE installeren

ZAICODE is drie projecten die als één werken: de ZAICODE-app, SAIPEN (het protocol dat agentwerk op koers houdt) en SAIMAIL (de mail die agents gebruiken om elkaar dingen te vertellen). Handmatig installeren betekent drie clones, een Node.js-toolchain, een Python-omgeving en een build. De installer doet dat allemaal: draai hem, wacht, en er staat een ZAICODE-snelkoppeling op het bureaublad.

## Eén klik

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  download, dubbelklik, druk op **INSTALL**. Het venster (goud op donker, de
  SAIPEN-banner) toont elke stap terwijl die draait, de tijd tot nu toe en het log
  op aanvraag; aan het einde **START ZAICODE**, of **TRY AGAIN** / **Autotroubleshoot**
  / **Open log** als een stap niet klaar was. Op een bestaande ZAICODE-map
  leest de knop **UPDATE**: dezelfde run werkts bij en repareert. De
  exe bevat de installscripts en heeft er niets naast nodig; hij is gebouwd door
  `install\setup\build.cmd` (de .NET Framework-compiler die elke Windows 10/11 heeft).
- `install\Setup-ZAICODE.cmd` (dubbelklik): dezelfde installatie in een console.
- Vanaf niets, in PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Installatie-opties: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (voorgezette map),
`/auto` (start meteen), `/quiet` (geen venster: de console-installer, exitcode
= resultaat). De eerste run bouwt de app op deze machine, dat duurt even;
latere runs alleen updaten en repareren.

## Gratis modellen, niets in te richten

De app levert zijn eigen 9router mee. Op een machine zonder 9router laat ZAICODE hem
privat draaien (geïsoleerde modus, poort 20138), vult **SAIFREN** vanuit sleutelvrije
gratis lagen en maakt `SAIRoute / SAIFREN` het model van nieuwe taken, zodat de eerste taak
in Nieuwe taak een antwoord krijgt: geen sleutel, geen account, geen instelling.
Claude Code-, Codex- en Antigravity-logins zijn optioneel; een login die nooit op de
machine is ingericht toont "optioneel, meld je aan wanneer je wilt", niet als een item
dat "jouw aandacht" vraagt.
Bewijs: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
start de verpakte app met een leeg profiel (eigen HOME, APPDATA en LOCALAPPDATA) en
slaagt alleen als de router geïsoleerd is, SAIFREN zijn probe met het eerste token
beantwoordt en een taak in Nieuwe taak beantwoord wordt.

## Updates: vier delen, één ZAICODE

De workspace (launcher, installer), de app, SAIPEN en SAIMAIL zijn vier clones. Elk
werkt zelf bij: **Instellingen -> ZAICODE -> Updates** toont ze met versie en commit,
werkt ze één voor één of allemaal bij, en heeft per deel een "zelfstandig"-schakelaar
(standaard aan in een geïnstalleerde ZAICODE, uit in een ontwikkelaarscheckout).
ZAICODE kijkt een paar minuten na de start en daarna elke zes uur. Na een update
krijgt elk deel wat het nodig heeft: de app zijn dependencies (als `pnpm-lock.yaml` is
verplaatst) en een nieuwe build (geïntstage terwijl ZAICODE draait, gestart bij de
volgende start), SAIPEN zijn launcher, SAIMAIL zijn `.venv`-installatie, de
workspace een nieuwe rootlauncher. Een clone op een andere branch, met lokale commits,
of met wijzigingen die de update zou overschrijven wordt gemeld en precies gelaten zoals hij is.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Wat het doet

De installer is de Autotroubleshoot-controles die met "repair" op een lege map draaien,
in deze volgorde. Elke stap is idempotent, dus opnieuw draaien werkt de installatie bij
en herstelt wat er kapot is.

| Controle | Herstel |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | gebruikt de versie op de machine als die voldoet; anders een private kopie in `.tools\` (MinGit uit Git for Windows, Node.js 24.14.0 van nodejs.org, Python uit het NuGet-pakket). Geen beheerdersrechten. |
| pnpm | de vastgezette pnpm 10.33.2 in `.tools\pnpm10` |
| ZAICODE-workspace | clone van `vacterro/zaicode` branch `master` (launcherbron, installer, docs; het geheugen van de ontwikkelaar `.saipen/` blijft buiten beschouwing; branch `workspace` tot 2026-09-27) |
| ZAICODE-appbron | clone van branch `zaicode` in `zcode\` |
| SAIPEN | clone van `vacterro/saipen` in `saipen\`; zijn `bin\saipen.cmd` is geschreven voor deze clone en deze Python |
| SAIMAIL | clone van `vacterro/saimail` in `saimail\`, geïnstalleerd in `.venv\` |
| saimail-local | commandlineclient van SAIMAIL, gebruikt door de SAIMAIL-panelen van ZAICODE (meegeleverd sinds SAIMAIL `0.0.2a3`; de `saimail-cli`-controle meldt OK) |
| 9router-pakket | `9router` uit npm in `.tools\router`, gebundeld zodat SAIFREN werkt zonder enige setup (WARN als npm het niet kan bereiken) |
| App-dependencies | `pnpm install --frozen-lockfile` (opnieuw als `pnpm-lock.yaml` verandert) |
| App-build | `pnpm bundle:zaicode`; terwijl ZAICODE draait wordt de nieuwe build geïntstage en bij de volgende start ingewisseld |
| Inwisselen van geïntstage build | wist een `win-unpacked.previous` die door een mislukte wissel met een lang pad is achtergebleven en wisselt een wachtende build in terwijl ZAICODE gesloten is |
| Rootlauncher | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Snelkoppelingen | Bureaublad en Startmenu `ZAICODE` -> `ZAICODE.exe` |
| Claude / Codex-logins | alleen gemeld: elke `~\.claude*` / `~\.codex*`-login is een eigen engine in ZAICODE (A1, A2, C1, ...); een login vraagt jouw aandacht, in de browser |

De rootlauncher wijst ZAICODE naar de geïnstalleerde SAIPEN (`saipen\`) en zet
`.tools\` en `.venv\Scripts` vooraan in het PATH van de app, zodat de app, zijn agents
en zijn workers de geïnstalleerde versies gebruiken.

## Meerdere abonnementen

Elke Claude Code- of Codex-login heeft een eigen home: `~\.claude`,
`~\.claude-account2`, ... en `~\.codex`, `~\.codex-account2`, ... ZAICODE vindt
ze allemaal. Meer voorbereiden bij installatie:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Het installatieprogramma maakt de homes aan en toont voor elk
(`$env:CODEX_HOME = '...'; codex login`) het exacte logincommando. In ZAICODE: Instellingen ->
Engines & limits -> nog een login toevoegen.

## Autodiagnose

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Status per controle: OK, FIXED (was defect, gerepareerd), WARN (werkt, maar er mist iets
optioneels), INFO (vereist jouw actie: een login), FAIL. Logs staan in
`install\logs\`; de samenvatting van de laatste installatie is `install\install-report.json`.
In de app herstelt Router -> Autodiagnose de draaiende router en pools.

## Opties

| Parameter | Standaard | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | waar alles terechtkomt |
| `-ShortcutDir` | Desktop | waar de ZAICODE-snelkoppeling komt |
| `-NoStartMenu`, `-NoShortcut` | | die snelkoppelingen overslaan |
| `-PortableTools` | | eigen Git / Node.js / Python, ook als de machine ze al heeft |
| `-Launch` | | ZAICODE starten als het klaar is |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | de GitHub-repos | andere bron (een fork, een lokaal klonepad) |

## Bewijs

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
controleert een verse installatie, injecteert storingen (snelkoppeling en launcher verwijderd, SAIPEN-
launcher wijst naar een ontbrekende Python, venv van SAIMAIL verwijderd, node_modules
vastgelegd voor een ander lockfile, een overgebleven buildmap dieper dan MAX_PATH),
verifieert dat de diagnose elke storing meldt én repareert, en start daarna het doel
van de snelkoppeling met een geïsoleerd profiel en stopt precies de procesboom die
hij zelf heeft gestart.

`install\tests\Test-ZaicodeUpdate.ps1` bouwt vier tijdelijke repositories op
schijf plus een installatie van hun klonen en bewijst dan dat een controle niets wijzigt, dat één onderdeel
alleen met zijn vervolg bijwerkt (SAIPEN-launcher, root-
launcher), dat overlappende lokale wijzigingen en lokale commits behouden blijven, en dat een onbekende
onderdeelnaam wordt geweigerd. Geen netwerk.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
