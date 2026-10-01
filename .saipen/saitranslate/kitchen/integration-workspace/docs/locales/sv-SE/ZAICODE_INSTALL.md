# Installera ZAICODE

ZAICODE är tre projekt som fungerar som ett: ZAICODE-appen, SAIPEN (protokollet
som håller agentarbetet på rätt spår) och SAIMAIL (posten agenterna använder för
att berätta saker för varandra). Att installera dem manuellt innebär tre kloner,
en Node.js-verktygskedja, en Python-miljö och en byggning. Installationsprogrammet
gör allt det: kör det, vänta, så ligger en ZAICODE-genväg på skrivbordet.

## Ett klick

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  ladda ner, dubbelklicka, tryck **INSTALLERA**. Fönstret (guld på mörkt,
  SAIPEN-bannern) visar varje steg medan det körs, tiden hittills och loggen
  vid förfrågan; till sist **STARTA ZAICODE**, eller **FÖRSÖK IGEN** /
  **Autofelsökning** / **Öppna logg** om ett steg inte avslutades. Pekat mot en
  befintlig ZAICODE-mapp läser knappen **UPPDATERA**: samma körning uppdaterar
  och reparerar. Exe-filen bär på installationsskripten och behöver inget
  intill sig; den byggs av `install\setup\build.cmd` (.NET Framework-kompilatorn som alla
  Windows 10/11 har).
- `install\Setup-ZAICODE.cmd` (dubbelklicka): samma installation i en konsol.
- Från noll, i PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

 installationsval: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (preset-mapp),
`/auto` (startar direkt), `/quiet` (inget fönster: konsolinstallatören, exitkoden
= resultat). Första körningen bygger appen på den här maskinen, vilket tar tid;
senare körningar uppdaterar bara och reparerar.

## Gratismodeller, inget att konfigurera

Appen levererar sin egen 9router. På en maskin utan en kör ZAICODE den
privat (isolerat läge, port 20138), fyller **SAIFREN** från nyckellösa gratisnivåer
och sätter `SAIRoute / SAIFREN` som modell för nya uppgifter, så den första uppgiften
som skrivs i Ny uppgift får ett svar: ingen nyckel, inget konto, ingen inställning. Claude
Code-, Codex- och Antigravity-inloggningar är valfria; en inloggning som aldrig
konfigurerats på maskinen visas som "valfritt, logga in när du vill", inte som en post som
"kräver dig". Bevis: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
startar den paketerade appen med en tom profil (egen HOME, APPDATA och
LOCALAPPDATA) och godkänns bara när routern är isolerad, SAIFREN svarar på sin
första token-probe och en uppgift i Ny uppgift besvaras.

## Uppdateringar: fyra delar, en ZAICODE

Arbetsytan (startprogrammet, installatören), appen, SAIPEN och SAIMAIL är fyra
klonar. Varje del uppdaterar sig själv: **Inställningar -> ZAICODE -> Uppdateringar**
listar dem med version och commit, uppdaterar en i taget eller alla, och har en
knapp "på egen hand" per del (på som standard i en installerad ZAICODE, av i en
utvecklarkopia). ZAICODE tittar några minuter efter starten och sedan var sjätte
timme. Efter en uppdatering får varje del det den behöver: appen sina beroenden
(när `pnpm-lock.yaml` flyttats) och en ny build (stagas medan ZAICODE körs, startas vid
nästa start), SAIPEN sitt startprogram, SAIMAIL sin `.venv`-installation,
arbetsytan en ny rotstartare. En klon på annan branch, med lokala commits eller
med ändringar som uppdateringen skulle skriva över rapporteras och lämnas exakt
som den är.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Vad den gör

Installatören är de Autotroubleshoot-kontroller som körs med "repara" i en tom
mapp, i den här ordningen. Varje steg är idempotent, så en ny körning uppdaterar
installationen och fixar det som gått sönder.

| Kontroll | Reparation |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | använder maskinens egen kopia om den passar; annars en privat kopia i `.tools\` (MinGit från Git for Windows, Node.js 24.14.0 från nodejs.org, Python från dess NuGet-paket). Inga administratörsrättigheter. |
| pnpm | den fästade pnpm 10.33.2 i `.tools\pnpm10` |
| ZAICODE-arbetsyta | klon av `vacterro/zaicode` branch `master` (källkod för startprogrammet, installationsprogram, docs; utvecklarens `.saipen/`-minne utelämnas; branch `workspace` till 2026-09-27) |
| ZAICODE-appkällkod | klon av branch `zaicode` till `zcode\` |
| SAIPEN | klon av `vacterro/saipen` till `saipen\`; dess `bin\saipen.cmd` skrivs för den här klonen och den här Python |
| SAIMAIL | klon av `vacterro/saimail` till `saimail\`, installerad till `.venv\` |
| saimail-local | SAIMAILs kommandoradsklient, som ZAICODEs SAIMAIL-paneler använder (levereras sedan SAIMAIL `0.0.2a3`; `saimail-cli`-kontrollen rapporterar OK) |
| 9router-paket | `9router` från npm till `.tools\router`, paketerad så att SAIFREN fungerar utan konfiguration (VARNAR om npm inte når den) |
| Appberoenden | `pnpm install --frozen-lockfile` (igen när `pnpm-lock.yaml` ändras) |
| Appbygge | `pnpm bundle:zaicode`; medan ZAICODE körs stagas den nya builden och tas i bruk vid nästa start |
| Byte av stagad build | rensar en `win-unpacked.previous` som lämnats kvar efter ett misslyckat byte med långa sökvägar och byter in en väntande build medan ZAICODE är stängd |
| Rotstartare | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Genvägar | Skrivbord och Start-meny `ZAICODE` -> `ZAICODE.exe` |
| Claude-/Codex-inloggningar | rapporteras endast: varje `~\.claude*`-/`~\.codex*`-inloggning är en egen motor i ZAICODE (A1, A2, C1, ...); en inloggning kräver dig, i webbläsaren |

Rotstartaren pekar ZAICODE mot den installerade SAIPEN (`saipen\`) och sätter
`.tools\` och `.venv\Scripts` först i appens PATH, så att appen, dess agenter
dess workers använder de installerade kopiorna.

## Flera prenumerationer

Varje Claude Code- eller Codex-inloggning har sin egen hemkatalog: `~\.claude`,
`~\.claude-account2`, ... och `~\.codex`, `~\.codex-account2`, ... ZAICODE hittar
dem alla. Så här förbereder du fler vid installationstid:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Installationsprogrammet skapar hemkatalogerna och skriver ut exakt inloggningskommando för var och en
(`$env:CODEX_HOME = '...'; codex login`). Samma sak finns i ZAICODE: Inställningar ->
Motorer & gränser -> lägg till en inloggning till.

## Autofelsökning

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Status per kontroll: OK, FIXED (var trasig, reparerad), WARN (fungerar, men något
valfritt saknas), INFO (kräver dig: en inloggning), FAIL. Loggar finns i
`install\logs\`; senaste installationens sammanfattning är `install\install-report.json`.
I appen reparerar Router -> Autofelsökning den körande routern och poolerna.

## Alternativ

| Parameter | Standard | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | dit allt hamnar |
| `-ShortcutDir` | Desktop | dit ZAICODE-genvägen hamnar |
| `-NoStartMenu`, `-NoShortcut` | | hoppa över de genvägarna |
| `-PortableTools` | | eget Git / Node.js / Python även när maskinen har dem |
| `-Launch` | | starta ZAICODE när det är klart |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | GitHub-reposen | annan källa (en fork, en lokal kloningssökväg) |

## Bevis

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
kontrollerar en färsk installation, planterar fel (genväg och launcher borttagen, SAIPEN
launcher pekad på en saknad Python, SAIMAILs venv borttagen, node_modules
registrerad för en annan lockfil, en kvarvarande byggmapp djupare än MAX_PATH),
assertar att doktorn rapporterar och reparerar varje enda, startar sedan genvägens
mål med en isolerad profil och stoppar exakt den processträd den startade.

`install\tests\Test-ZaicodeUpdate.ps1` bygger fyra engångsrepos på
disk och en installation av deras kloner, bevisar sedan att en kontroll inte ändrar något, att en enda del uppdateras ensam med sin följd (SAIPEN-launcher, rotlauncher), att överlappande lokala ändringar och lokala commits bevaras, och att ett okänt delnamn avvisas. Inget nätverk.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
