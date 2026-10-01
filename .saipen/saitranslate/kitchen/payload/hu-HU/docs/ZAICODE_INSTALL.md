# ZAICODE telepítése

A ZAICODE három projekt, amely együtt működik: a ZAICODE app, a SAIPEN (a
protokoll, ami rendben tartja az ügynökök munkáját) és a SAIMAIL (a post, amit az
ügynökök az egymással való kommunikációra használnak). A kézi telepítéshez három
klón, egy Node.js toolchain, egy Python környezet és egy build kell. A telepítő ezt
mind megcsinálja: futtasd, várj, és a ZAICODE parancsikon már az asztalon van.

## Egy kattintás

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  töltsd le, kattints rá duplán, nyomd meg az **INSTALL** gombot. Az ablak (arany
  sötét háttéren, SAIPEN bannerrel) lépésenként mutatja a futást, az eltelt időt,
  és a naplót igény szerint; a végén **START ZAICODE**, vagy **TRY AGAIN** /
  **Autotroubleshoot** / **Open log**, ha egy lépés nem fejeződött be. Meglévő ZAICODE
  mappára mutatva a gomb felirata **UPDATE**: ugyanaz a futás frissít és javít. Az
  exe tartalmazza a telepítő scripteket, nem kell mellé semmi; `install\setup\build.cmd` építi (a
  .NET Framework fordító, ami minden Windows 10/11-en megvan).
- `install\Setup-ZAICODE.cmd` (dupla kattintás): ugyanez a telepítés konzolban.
- Semmiből, PowerShellben:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Beállítási lehetőségek: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (előre beállított mappa),
`/auto` (azonnal indul), `/quiet` (nincs ablak: konzolos installer, kilépési kód
= eredmény). Az első futás lefordítja az alkalmazást ezen a gépen, ez eltart egy ideig;
a későbbi futások csak frissítenek és javítanak.

## Ingyenes modellek, nincs mit beállítani

Az alkalmazás saját 9routerrel érkezik. Olyan gépen, ahol nincs ilyen, a ZAICODE
privátban futtatja (izolált mód, 20138-as port), a **SAIFREN**-t kulcs nélküli ingyenes
szintekből tölti fel, és `SAIRoute / SAIFREN` lesz az új feladatok modellje, így az Új feladat
mezőbe beírt első feladat is kap választ: nincs kulcs, nincs fiók, nincs beállítás.
A Claude Code, Codex és Antigravity bejelentkezések opcionálisak; a gépen soha nem
beállított bejelentkezés "opcionális, bármikor bejelentkezhetsz" alatt jelenik meg,
nem pedig "rád van szükség" elemként.
Bizonyíték: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>` üres profillal (saját HOME, APPDATA és
LOCALAPPDATA) indítja a csomagolt alkalmazást, és csak akkor adja tovább, ha a router
izolált, a SAIFREN válaszol az első token szondájára, és egy feladat az Új feladatban
megválaszolásra kerül.

## Frissítések: négy rész, egy ZAICODE

A workspace (launcher, installer), az alkalmazás, a SAIPEN és a SAIMAIL négy klón.
Mindegyik maga frissül: a **Beállítások -> ZAICODE -> Frissítések** listázza őket verzióval
és committal, frissíthető egyenként vagy mind egyszerre, és részenként van egy
"magától" kapcsoló (telepített ZAICODE-nál alapból be, fejlesztői checkoutnál ki).
A ZAICODE indulás után néhány perccel, majd hatóránként nézi meg. Frissítés után
minden rész megkapja, amire szüksége van: az alkalmazás a függőségeit (ha
`pnpm-lock.yaml` elmozdult) és az új buildet (a ZAICODE futása alatt előkészítve, a
következő indításkor indul), a SAIPEN a launcherét, a SAIMAIL a `.venv`
telepítését, a workspace az új root launchert. Az a klón, amely másik branchen van,
helyi committal rendelkezik, vagy amelynek a frissítés felülírná a módosításait,
jelentve van, és változatlanul hagyjuk.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Mit csinál

Az installer az Autotroubleshoot ellenőrzései, amelyek "repair" módban, üres mappán
futnak, ebben a sorrendben. Minden lépés idempotens, így az újrafuttatás frissíti a
telepítést és megjavítja, ami elromlott.

| Ellenőrzés | Javítás |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | a gép saját példányát használja, ha megfelel; különben privát példány a `.tools\` mappában (MinGit a Git for Windowsből, Node.js 24.14.0 a nodejs.org-ról, Python a NuGet csomagjából). Nem kell adminisztrátori jog. |
| pnpm | a rögzített pnpm 10.33.2 a `.tools\pnpm10` mappában |
| ZAICODE workspace | a `vacterro/zaicode` repository `master` branchének klónja (launcher forrás, installer, dokumentáció; a fejlesztő `.saipen/` memóriája kimarad; `workspace` branch 2026-09-27-ig) |
| ZAICODE alkalmazásforrás | a(z) `zaicode` branch klónja a(z) `zcode\` mappába |
| SAIPEN | a `vacterro/saipen` klónja a `saipen\` mappába; a `bin\saipen.cmd` ehhez a klónhoz és ehhez a Pythonhoz készül |
| SAIMAIL | a `vacterro/saimail` klónja a `saimail\` mappába, telepítve a `.venv\` helyre |
| saimail-local | a SAIMAIL parancssori kliense, amelyet a ZAICODE SAIMAIL paneljei használnak (a SAIMAIL `0.0.2a3` óta szállítva; a `saimail-cli` ellenőrzés OK-t ad) |
| 9router csomag | `9router` az npm-ből a `.tools\router` mappába, csomagolva, hogy a SAIFREN nulla beállítással működjön (WARN, ha az npm nem éri el) |
| Alkalmazásfüggőségek | `pnpm install --frozen-lockfile` (újra, ha `pnpm-lock.yaml` megváltozik) |
| Alkalmazás build | `pnpm bundle:zaicode`; amíg a ZAICODE fut, az új build előkészül, és a következő indításkor cserélődik be |
| Előkészített build beillesztése | törli a `win-unpacked.previous` hátrahagyott maradékot egy hosszú útvonalas csere hibája után, és beilleszti a váró buildet, miközben a ZAICODE zárva van |
| Root launcher | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Parancsikonok | Asztal és Start menü `ZAICODE` -> `ZAICODE.exe` |
| Claude / Codex bejelentkezések | csak jelentve: minden `~\.claude*` / `~\.codex*` bejelentkezés külön motor a ZAICODE-ban (A1, A2, C1, ...); a bejelentkezés rád van szükség, a böngészőben |

A root launcher a telepített SAIPEN-re mutatja a ZAICODE-ot (`saipen\`), és a
`.tools\` és `.venv\Scripts` elemet teszi az alkalmazás PATH-jának elejére, így az
alkalmazás, az agentei és a workerei a telepített példányokat használják.

## Több előfizetés

Minden Claude Code vagy Codex bejelentkezés saját otthonban él: `~\.claude`,
`~\.claude-account2`, ... és `~\.codex`, `~\.codex-account2`, ... A ZAICODE mindet
megtalálja. Ha telepítéskor többet szeretnél előkészíteni:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

A telepítő létrehozza az otthonokat, és mindegyikhez kiírja a pontos bejelentkezési
parancsot (`$env:CODEX_HOME = '...'; codex login`). Ugyanez a ZAICODE-ban: Settings ->
Engines & limits -> új bejelentkezés hozzáadása.

## Automatikus hibakeresés

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Ellenőrzésenkénti állapot: OK, FIXED (hibás volt, javítva), WARN (működik, de valami
opcionális hiányzik), INFO (rajtad múlik: bejelentkezés), FAIL. A naplók itt vannak:
`install\logs\`; az utolsó telepítés összefoglalója: `install\install-report.json`.
Az alkalmazásban: Router -> Automatikus hibakeresés megjavítja a futó routert és a készleteket.

## Opciók

| Paraméter | Alapérték | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | hová kerül minden |
| `-ShortcutDir` | Desktop | hová kerül a ZAICODE parancsikonja |
| `-NoStartMenu`, `-NoShortcut` | | ezeket a parancsikonokat kihagyja |
| `-PortableTools` | | saját Git / Node.js / Python, akkor is, ha a gépen már van |
| `-Launch` | | a ZAICODE indítása a befejezés után |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | a GitHub repók | másik forrás (fork, helyi klón útvonal) |

## Bizonyíték

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
ellenőrzi a friss telepítést, hibákat ültet be (törölt parancsikon és launcher, a SAIPEN
launcher hiányzó Pythonra mutat, a SAIMAIL venv törölve, egy másik lockfile-hoz rögzített
node_modules, egy MAX_PATH-nál mélyebben maradt build mappa),
assertálja, hogy a doctor minden hibát jelez és megjavít, majd izolált profillal elindítja a
parancsikon célját, és pontosan az általa indított folyamatfát állítja le.

`install\tests\Test-ZaicodeUpdate.ps1` négy eldobható repót épít a lemezen és a klónjuk telepítését, majd
bizonyítja, hogy az egyik ellenőrzés semmit nem változtat, hogy egyetlen alkatrész önmagában frissül
a saját utótevéjével (SAIPEN launcher, root launcher), hogy az átfedő helyi módosítások és a helyi
commitok megmaradnak, és hogy ismeretlen alkatrésznevet elutasít. Hálózat nélkül.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
