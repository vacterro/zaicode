# Installation af ZAICODE

ZAICODE er tre projekter, der fungerer som ét: ZAICODE-appen, SAIPEN (protokollen, der holder agentarbejde på sporet) og SAIMAIL (posten, agenterne bruger til at fortælde hinanden ting). At installere dem manuelt betyder tre clones, en Node.js-toolchain, et Python-miljø og et build. Installationsprogrammet gør alt det:
kør det, vent, og en ZAICODE-genvej ligger på skrivebordet.

## Ét klik

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  download, dobbeltklik, tryk på **INSTALL**. Vinduet (guld på mørk baggrund,
  SAIPEN-banneret) viser hvert trin undervejs, den forløbne tid og loggen
  efter behov; til sidst **START ZAICODE**, eller **TRY AGAIN** / **Autotroubleshoot**
  / **Open log**, hvis et trin ikke blev færdigt. Peget på en eksisterende
  ZAICODE-mappe hedder knappen **UPDATE**: samme kørsel opdaterer og reparerer.
  Exe'en indeholder installationsscripts og kræver intet ved siden af sig; den
  er bygget af `install\setup\build.cmd` (.NET Framework-compileren, som alle Windows 10/11
  har).
- `install\Setup-ZAICODE.cmd` (dobbeltklik): samme installation i en konsol.
- Fra bunden, i PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Installationsvalg: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (forudstillet mappe),
`/auto` (starter med det samme), `/quiet` (intet vindue: konsolinstallatøren, exit code
= resultat). Første kørsel bygger appen på denne maskine, hvilket tager tid;
senere kørsel opdaterer og reparerer kun.

## Gratis modeller, intet at opsætte

Appen leverer sin egen 9router. På en maskine uden en kører ZAICODE den privat
(isoleret tilstand, port 20138), fylder **SAIFREN** fra nøglefri gratis
niveauer og gør `SAIRoute / SAIFREN` til model for nye opgaver, så den første opgave,
der skrives i Ny opgave, får et svar: ingen nøgle, ingen konto, ingen indstilling.
Claude Code-, Codex- og Antigravity-logins er valgfrie; et login, der aldrig er
sat op på maskinen, vises som "valgfrit, log ind når som helst", ikke som et
"kræver dig"-element.
Bevis: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
starter den pakkede app på en tom profil (sin egen HOME, APPDATA og
LOCALAPPDATA) og består kun, når routeren er isoleret, SAIFREN svarer på sin
første token-probe, og en opgave i Ny opgave besvares.

## Opdateringer: fire dele, ét ZAICODE

Arbejdsområdet (launcher, installatør), appen, SAIPEN og SAIMAIL er fire
kloner. Hver del opdaterer sig selv: **Indstillinger -> ZAICODE -> Opdateringer**
viser dem med version og commit, opdaterer enkeltvis eller alle, og har en
"af sig selv"-kontakt per del (til som standard i en installeret ZAICODE, fra i et
udviklerudtjek). ZAICODE tjekker et par minutter efter start og derefter hver
sjette time. Efter en opdatering får hver del, hvad den skal have: appen sine
afhængigheder (når `pnpm-lock.yaml` flyttede) og en ny build (staged mens ZAICODE
kører, startet ved næste start), SAIPEN sin launcher, SAIMAIL sin `.venv`
installering, arbejdsområdet en ny root-launcher. En klon på en anden gren, med
lokale commits eller med ændringer, opdateringen ville overskrive, rapporteres og
efterlades præcis som den er.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Hvad det gør

Installatøren er Autotroubleshoot-kontrollerne kørt med "reparation" på en tom
mappe, i denne rækkefølge. Hvert trin er idempotent, så en ny kørsel opdaterer
installationen og retter, hvad der gik i stykker.

| Check | Reparation |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | bruger maskinens kopi, hvis den passer; ellers en privat kopi i `.tools\` (MinGit fra Git for Windows, Node.js 24.14.0 fra nodejs.org, Python fra sin NuGet-pakke). Ingen administratorrettigheder. |
| pnpm | den fastlåste pnpm 10.33.2 i `.tools\pnpm10` |
| ZAICODE-arbejdsområde | klon af `vacterro/zaicode`-grenen `master` (launcher-kilde, installer, docs; udviklerens `.saipen/`-hukommelse er ikke med; gren `workspace` indtil 2026-09-27) |
| ZAICODE-appkilde | klon af grenen `zaicode` ind i `zcode\` |
| SAIPEN | klon af `vacterro/saipen` ind i `saipen\`; dens `bin\saipen.cmd` er skrevet til denne klon og denne Python |
| SAIMAIL | klon af `vacterro/saimail` ind i `saimail\`, installeret ind i `.venv\` |
| saimail-local | SAIMAILs kommandolinjeklient, som ZAICODEs SAIMAIL-paneler bruger (kommer med siden SAIMAIL `0.0.2a3`; `saimail-cli`-kontrollen rapporterer OK) |
| 9router-pakke | `9router` fra npm ind i `.tools\router`, samlet så SAIFREN fungerer uden opsætning (WARN, hvis npm ikke kan nå den) |
| App-afhængigheder | `pnpm install --frozen-lockfile` (igen, når `pnpm-lock.yaml` ændres) |
| App-build | `pnpm bundle:zaicode`; mens ZAICODE kører, iscenesættes den nye build og skiftes ind ved næste start |
| Iscenesat build-skift | rydder en `win-unpacked.previous`, der er efterladt af en fejl i skift på lange stier, og skifter en ventende build ind, mens ZAICODE er lukket |
| Root-launcher | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Genveje | Skrivebord og Start-menu `ZAICODE` -> `ZAICODE.exe` |
| Claude / Codex-login | rapporteres kun: hvert `~\.claude*` / `~\.codex*`-login er sin egen motor i ZAICODE (A1, A2, C1, ...); et login kræver dig i browseren |

Root-launcheren peger ZAICODE på den installerede SAIPEN (`saipen\`) og sætter
`.tools\` og `.venv\Scripts` først på appens PATH, så appen, dens agenter og dens
workers bruger de installerede kopier.

## Flere abonnementer

Hver Claude Code- eller Codex-login har sit eget home: `~\.claude`,
`~\.claude-account2`, ... og `~\.codex`, `~\.codex-account2`, ... ZAICODE finder
dem alle. Sådan forbereder du flere ved installation:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Installeren opretter homes og udskriver den præcise login-kommando for hver
(`$env:CODEX_HOME = '...'; codex login`). Det samme findes i ZAICODE: Settings ->
Engines & limits -> tilføj endnu en login.

## Autofejlfinding

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Status pr. kontrol: OK, FIXED (var brudt, repareret), WARN (virker, men noget
valgfrit mangler), INFO (kræver dig: et login), FAIL. Logfiler ligger i
`install\logs\`; sidste installations oversigt er `install\install-report.json`.
I appen reparerer Router -> Autotroubleshoot den kørende router og pools.

## Valgmuligheder

| Parameter | Standard | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | hvor alt placeres |
| `-ShortcutDir` | Desktop | hvor ZAICODE-genvejen placeres |
| `-NoStartMenu`, `-NoShortcut` | | spring disse genveje over |
| `-PortableTools` | | privat Git / Node.js / Python selvom maskinen har dem |
| `-Launch` | | start ZAICODE når den er færdig |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | GitHub-repos | en anden kilde (en fork, en lokal clone-sti) |

## Bevis

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
kontrollerer en frisk installation, indplanter fejl (genvej og launcher slettet, SAIPEN
launcher pegede på en manglende Python, SAIMAILs venv slettet, node_modules
registreret for en anden lockfile, en tilbageblivende build-mappe dybere end MAX_PATH),
asserer at doctor-rapporteren melder og reparerer hver enkelt, og starter derefter genvejens
mål med en isoleret profil og stopper præcis den procesrige, den startede.

`install\tests\Test-ZaicodeUpdate.ps1` bygger fire midlertidige repos
på disk og en installation af deres clones og beviser derefter, at en kontrol intet ændrer, at én del
alene opdateres med sin opfølgning (SAIPEN-launcher, root-launcher), at overlappende
lokale ændringer og lokale commits bevares, og at et ukendt delnavn afvises. Intet netværk.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
