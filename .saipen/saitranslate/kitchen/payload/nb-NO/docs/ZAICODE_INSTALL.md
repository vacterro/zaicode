# Installere ZAICODE

ZAICODE er tre prosjekter som fungerer som ett: ZAICODE-appen, SAIPEN (protokollen som holder agentarbeid på sporet) og SAIMAIL (posten agentene bruker til å si ifra om ting til hverandre). Å installere dem for hånd betyr tre kloninger, et Node.js-verktøysett, et Python-miljø og en bygging. Installasjonsprogrammet gjør alt dette:
kjør det, vent, og en ZAICODE-hurtigvei ligger på skrivebordet.

## Ett klikk

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  last ned, dobbeltklikk, trykk **INSTALL**. Vinduet (gull på mørk bakgrunn, SAIPEN-banneret) viser hvert trinn mens det kjører, tiden så langt og loggen ved behov; til slutt **START ZAICODE**, eller **TRY AGAIN** / **Autotroubleshoot**
  / **Open log** når et trinn ikke ble fullført. Peker du på en eksisterende ZAICODE-mappe heter knappen **UPDATE**: samme kjøring oppdaterer og reparerer. Eksen
  filen inneholder installasjonsskriptene og trenger ingenting ved siden av seg; den bygges av
  `install\setup\build.cmd` (.NET Framework-kompilatoren som alle Windows 10/11 har).
- `install\Setup-ZAICODE.cmd` (dobbeltklikk): samme installasjon i en konsoll.
- Fra bunnen av, i PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Oppsettsvalg: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (forhåndsmalt mappe),
`/auto` (starter med én gang), `/quiet` (ingen vindu: konsollinstallatøren, avslutningskode
= resultat). Første kjøring bygger appen på denne maskinen, og det tar litt tid;
senere kjøringer oppdaterer og reparerer bare.

## Gratis modeller, ingenting å sette opp

Appen har sin egen 9router. På en maskin uten kjører ZAICODE den
privat (isolert modus, port 20138), fyller **SAIFREN** med nøkkeløse gratis
nivåer og gjør `SAIRoute / SAIFREN` til modell for nye oppgaver, slik at den første oppgaven
skrevet i Ny oppgave får svar: ingen nøkkel, ingen konto, ingen innstilling. Claude
Code-, Codex- og Antigravity-innlogginger er valgfrie; en innlogging som aldri er
satt opp på maskinen vises som "valgfri, logg inn når du vil", ikke som en "trenger
deg"-oppføring.
Bevis: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
starter den pakkede appen på en tom profil (sin egen HOME, APPDATA og
LOCALAPPDATA) og består bare når ruteren er isolert, SAIFREN svarer på
første-token-proben og en oppgave i Ny oppgave er besvart.

## Oppdateringer: fire deler, én ZAICODE

Arbeidsområdet (startprogram, installatør), appen, SAIPEN og SAIMAIL er fire
klone. Hver del oppdaterer seg selv: **Innstillinger -> ZAICODE -> Oppdateringer**
viser dem med versjon og commit, oppdaterer én om gangen eller alle sammen,
og har en "på egen hånd"-bryter per del (på som standard i en installert ZAICODE, av
i en utviklerutgave). ZAICODE ser etter oppdateringer noen minutter etter oppstart,
så hver sjette time. Etter en oppdatering får hver del det den trenger: appen
sine avhengigheter (når `pnpm-lock.yaml` flyttet seg) og en ny bygging (klargjort mens
ZAICODE kjører, startet ved neste oppstart), SAIPEN sitt startprogram, SAIMAIL sin
`.venv`-installasjon, og arbeidsområdet et nytt rot-startprogram. En klone på en annen
gren, med lokale commits, eller med endringer oppdateringen ville overskrevet
rapporteres og blir liggende nøyaktig som den er.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Hva den gjør

Installatøren er Autotroubleshoot-sjekkene som kjøres med "reparer" i en tom
mappe, i denne rekkefølgen. Hvert trinn er idempotent, så å kjøre det igjen
oppdaterer installasjonen og reparerer det som har gått i stykker.

| Sjekk | Reparasjon |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | bruker maskinens kopi når den passer; ellers en privat kopi i `.tools\` (MinGit fra Git for Windows, Node.js 24.14.0 fra nodejs.org, Python fra sin NuGet-pakke). Ingen administratorrettigheter. |
| pnpm | den pinnede pnpm 10.33.2 i `.tools\pnpm10` |
| ZAICODE-arbeidsområde | klone av `vacterro/zaicode`-grenen `master` (startprogram-kilde, installatør, docs; utviklerens `.saipen/`-minne er utelatt; gren `workspace` til 2026-09-27) |
| ZAICODE-appkilde | klone av gren `zaicode` inn i `zcode\` |
| SAIPEN | klone av `vacterro/saipen` inn i `saipen\`; `bin\saipen.cmd` er skrevet for denne klonen og denne Python-en |
| SAIMAIL | klone av `vacterro/saimail` inn i `saimail\`, installert inn i `.venv\` |
| saimail-local | SAIMAILs kommandolinjeklient, som ZAICODEs SAIMAIL-paneler bruker (levert siden SAIMAIL `0.0.2a3`; `saimail-cli`-sjekken rapporterer OK) |
| 9router-pakke | `9router` fra npm inn i `.tools\router`, bunnet slik at SAIFREN virker med null oppsett (WARN hvis npm ikke får tak i den) |
| Appavhengigheter | `pnpm install --frozen-lockfile` (på nytt når `pnpm-lock.yaml` endres) |
| Appbygging | `pnpm bundle:zaicode`; mens ZAICODE kjører klargjøres den nye byggingen og tas i bruk ved neste oppstart |
| Bytting av klargjort bygging | fjerner en `win-unpacked.previous` som ble igjen etter feil ved bytting av lange baner, og bytter inn en ventende bygging mens ZAICODE er lukket |
| Rot-startprogram | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Snarveier | Skrivebordet og Start-menyen `ZAICODE` -> `ZAICODE.exe` |
| Claude-/Codex-innlogginger | rapporteres bare: hver `~\.claude*`-/ `~\.codex*`-innlogging er sin egen motor i ZAICODE (A1, A2, C1, ...); en innlogging trenger deg, i nettleseren |

Rot-startprogrammet peker ZAICODE mot den installerte SAIPEN (`saipen\`) og setter
`.tools\` og `.venv\Scripts` først i appens PATH, slik at appen, agentene
og workerne bruker de installerte kopiene.

## Flere abonnementer

Hver Claude Code- eller Codex-innlogging bor i sitt eget hjem: `~\.claude`,
`~\.claude-account2`, ... og `~\.codex`, `~\.codex-account2`, ... ZAICODE finner
dem alle. For å forberede flere ved installasjonstidspunkt:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Installasjonsprogrammet oppretter hjemmene og skriver ut den nøyaktige innloggingskommandoen for hvert (`$env:CODEX_HOME = '...'; codex login`). Det samme finnes i ZAICODE: Innstillinger ->
Motorer & grenser -> legg til en annen innlogging.

## Autofeilsøking

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Status per sjekk: OK, FIXED (var ødelagt, reparert), WARN (fungerer, men noe
valgfritt mangler), INFO (krever deg: en innlogging), FAIL. Loggene ligger i
`install\logs\`; siste installasjons sammendrag er `install\install-report.json`.
I appen reparerer Ruter -> Autotroubleshoot den kjørende ruteren og poolene.

## Alternativer

| Parameter | Standard | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | hvor alt havner |
| `-ShortcutDir` | Desktop | hvor ZAICODE-snarveien havner |
| `-NoStartMenu`, `-NoShortcut` | | hopp over de snarveiene |
| `-PortableTools` | | egne Git / Node.js / Python selv når maskinen har dem |
| `-Launch` | | start ZAICODE når ferdig |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | GitHub-reposene | annen kilde (en fork, en lokal klonsti) |

## Bevis

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
sjekker en fersk installasjon, planter feil (snarvei og launcher slettet, SAIPEN-
launcher peker på en manglende Python, SAIMAILs venv slettet, node_modules
registrert for en annen lockfil, en igjenlevende byggemappe dypere enn MAX_PATH),
hever at doctoren rapporterer og reparerer hver enkelt, starter deretter snarveiens
mål med en isolert profil og stopper nøyaktig prosess-treet den startet.

`install\tests\Test-ZaicodeUpdate.ps1` bygger fire engangsrepositorier på
disk og en installasjon av klonene deres, beviser så at en sjekk ikke endrer noe, at én del alene oppdateres med sin følge (SAIPEN-launcher, rot-
launcher), at overlappende lokale endringer og lokale commits beholdes, og at et
ukjent delnavn avvises. Ingen nettverk.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
