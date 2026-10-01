# Instalarea ZAICODE

ZAICODE sunt trei proiecte care funcționează ca unul singur: aplicația ZAICODE, SAIPEN (protocolul care ține munca agenților sub control) și SAIMAIL (poșta prin care agenții își comunică unii altora lucruri). Instalarea lor manual înseamnă trei clonări, un toolchain Node.js, un mediu Python și o compilare. Installerul face toate acestea: rulați-l, așteptați, iar scurtătura ZAICODE apare pe desktop.

## Un singur clic

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  descărcați, faceți dublu clic, apăsați **INSTALL**. Fereastra (auriu pe fundal
  închis, bannerul SAIPEN) arată fiecare pas pe măsură ce rulează, timpul scurs
  și jurnalul la cerere; la final **START ZAICODE**, sau **TRY AGAIN** /
  **Autotroubleshoot** / **Open log** dacă un pas nu s-a încheiat. Dacă este
  indicat un folder ZAICODE existent, butonul scrie **UPDATE**: aceeași rulare
  actualizează și repară. Exe-ul conține scripturile de instalare și nu are nevoie
  de nimic alături; este construit cu `install\setup\build.cmd` (compilatorul .NET
  Framework prezent pe orice Windows 10/11).
- `install\Setup-ZAICODE.cmd` (dublu clic): aceeași instalare într-o consolă.
- De la zero, în PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Opțiuni de instalare: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (folder presetat),
`/auto` (pornește imediat), `/quiet` (fără fereastră: instalatorul din consolă, cod de ieșire
= rezultat). Prima rulare construiește aplicația pe această mașină, ceea ce durează;
rulările următoare doar actualizează și repară.

## Modele gratuite, nimic de configurat

Aplicația include propriul 9router. Pe o mașină fără 9router, ZAICODE îl rulează
privat (mod izolat, port 20138), completează **SAIFREN** din nivelurile gratuite
fără cheie și face din `SAIRoute / SAIFREN` modelul sarcinilor noi, deci prima sarcină
introdusă în Sarcină nouă primește răspuns: fără cheie, fără cont, fără setare. Logările
Claude Code, Codex și Antigravity sunt opționale; o autentificare neconfigurată pe
mașină apare ca "opțional, conectează-te oricând", nu ca element "necesită atenție".
Dovadă: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
pornește aplicația împachetată pe un profil gol (propriul HOME, APPDATA și
LOCALAPPDATA) și trece doar dacă routerul e izolat, SAIFREN răspunde la
sonda de primul token și o sarcină din Sarcină nouă primește răspuns.

## Actualizări: patru părți, un ZAICODE

Spațiul de lucru (lansator, instalator), aplicația, SAIPEN și SAIMAIL sunt patru
clone. Fiecare se actualizează separat: **Setări -> ZAICODE -> Actualizări** le
listează cu versiune și commit, actualizează pe rând sau pe toate, și are un comutator
"de unul singur" per parte (activ implicit într-un ZAICODE instalat, oprit într-un
checkout de dezvoltator). ZAICODE se uită la câteva minute după pornire, apoi la fiecare
șase ore. După o actualizare fiecare parte primește ce îi trebuie: aplicația dependențele
(când `pnpm-lock.yaml` s-a mutat) și un build nou (pregătit cât timp rulează ZAICODE, pornit la
următoarea pornire), SAIPEN lansatorul, SAIMAIL instalarea `.venv`, spațiul de
lucru un nou lansator root. Un clone pe altă ramură, cu commit-uri locale sau cu
modificări pe care actualizarea le-ar suprascrie este raportat și lăsat exact cum este.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Ce face

Instalatorul execută verificările Autotroubleshoot cu "repair" într-un folder gol,
în această ordine. Fiecare pas e idempotent, deci rularea din nou actualizează instalarea
și repară ce s-a stricat.

| Verificare | Reparare |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | folosește copia mașinii dacă e potrivită; altfel o copie privată în `.tools\` (MinGit din Git for Windows, Node.js 24.14.0 de pe nodejs.org, Python din pachetul său NuGet). Fără drepturi de administrator. |
| pnpm | pnpm 10.33.2 fixat în `.tools\pnpm10` |
| Spațiu de lucru ZAICODE | clone din `vacterro/zaicode`, ramura `master` (sursa lansatorului, instalator, documentație; memoria dezvoltatorului `.saipen/` e exclusă; ramura `workspace` până la 2026-09-27) |
| Sursa aplicației ZAICODE | clone al ramurii `zaicode` în `zcode\` |
| SAIPEN | clone din `vacterro/saipen` în `saipen\`; `bin\saipen.cmd` se scrie pentru acest clone și acest Python |
| SAIMAIL | clone din `vacterro/saimail` în `saimail\`, instalat în `.venv\` |
| saimail-local | clientul din linie de comandă al SAIMAIL, folosit de panourile SAIMAIL din ZAICODE (livrat din SAIMAIL `0.0.2a3`; verificarea `saimail-cli` raportează OK) |
| Pachetul 9router | `9router` din npm în `.tools\router`, împachetat ca SAIFREN să funcționeze fără nicio configurare (WARN dacă npm nu îl poate descărca) |
| Dependențele aplicației | `pnpm install --frozen-lockfile` (din nou când `pnpm-lock.yaml` se schimbă) |
| Build-ul aplicației | `pnpm bundle:zaicode`; cât timp rulează ZAICODE, build-ul nou e pregătit și schimbat la următoarea pornire |
| Schimbarea build-ului pregătit | șterge un `win-unpacked.previous` rămas în urma unei schimbări eșuate pe căi lungi și pune un build în așteptare cât timp ZAICODE e închis |
| Lansator root | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Comenzi rapide | `ZAICODE` pe Desktop și în meniul Start -> `ZAICODE.exe` |
| Autentificări Claude / Codex | doar raportate: fiecare autentificare `~\.claude*` / `~\.codex*` e motor propriu în ZAICODE (A1, A2, C1, ...); o autentificare te necesită, în browser |

Lansatorul root indică ZAICODE către SAIPEN instalat (`saipen\`) și pune
`.tools\` și `.venv\Scripts` la începutul PATH-ului aplicației, ca aplicația, agenții și
workerii ei să folosească copiile instalate.

## Mai multe abonamente

Fiecare login Claude Code sau Codex trăiește în propriul home: `~\.claude`,
`~\.claude-account2`, ... și `~\.codex`, `~\.codex-account2`, ... ZAICODE le găsește
pe toate. Pentru a pregăti mai multe la instalare:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Instalatorul creează home-urile și afișează comanda exactă de login pentru fiecare
(`$env:CODEX_HOME = '...'; codex login`). Același lucru e în ZAICODE: Setări ->
Engines & limits -> adaugă alt login.

## Depanare automată

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Stare per verificare: OK, FIXED (era stricat, reparat), WARN (merge, dar lipsește
ceva opțional), INFO (nevoie de tine: un login), FAIL. Logurile sunt în
`install\logs\`; rezumatul ultimei instalări e `install\install-report.json`.
În aplicație, Router -> Autotroubleshoot repară routerul și pool-urile în execuție.

## Opțiuni

| Parametru | Implicit | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | unde merge tot |
| `-ShortcutDir` | Desktop | unde ajunge shortcut-ul ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | sar peste shortcut-urile astea |
| `-PortableTools` | | Git / Node.js / Python privat chiar dacă mașina le are |
| `-Launch` | | pornește ZAICODE când gata |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | repo-urile GitHub | altă sursă (fork, cale de clone local) |

## Demonstrație

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
verifică o instalare curată, injectează defecțiuni (shortcut și launcher șterse, launcher
SAIPEN care indică spre un Python lipsă, venv-ul SAIMAIL șters, node_modules
înregistrate pentru alt lockfile, un folder build rămas mai adânc decât MAX_PATH),
verifică că doctor raportează și repară fiecare, apoi pornește ținta shortcut-ului
cu profil izolat și oprește exact arborele de procese pornit.

`install\tests\Test-ZaicodeUpdate.ps1` construiește patru repo-uri de unică folosință
pe disc plus o instalare a clonelor lor, apoi demonstrează că o verificare nu schimbă
nimic, că o singură parte se actualizează singură cu follow-up-ul ei (launcher SAIPEN,
launcher root), că editările locale suprapuse și commit-urile locale se păstrează, și că un
nume de parte necunoscut e refuzat. Fără rețea.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
