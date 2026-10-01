# Instalace ZAICODE

ZAICODE jsou tři projekty, které fungují jako jeden: aplikace ZAICODE, SAIPEN
(protokol, který drží práci agentů na správné cestě) a SAIMAIL (pošta, kterou si
agenti posílají zprávy). Ruční instalace znamená tři klonování, Node.js
nástrojový řetězec, prostředí Python a build. Instalátor udělá vše:
spusťte ho, počkejte a na ploše je zástupce ZAICODE.

## Jedním kliknutím

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  stáhněte, dvakrát klikněte, stiskněte **INSTALL**. Okno (zlaté na tmavém,
  s bannerem SAIPEN) zobrazuje každý krok při běhu, dosavadní čas a na
  vyžádání i log; na konci **START ZAICODE**, nebo **TRY AGAIN** /
  **Autotroubleshoot** / **Open log**, pokud některý krok nedoběhl. Je-li
  nasměrováno na existující složku ZAICODE, má tlačítko nápis **UPDATE**: stejný běh
  zároveň aktualizuje a opraví. Exe obsahuje instalační skripty a nepotřebuje
  nic vedle sebe; sestavuje ho `install\setup\build.cmd` (kompilátor .NET Framework, který
  má každý Windows 10/11).
- `install\Setup-ZAICODE.cmd` (dvakrát kliknout): stejná instalace v konzoli.
- Z nuly, v PowerShellu:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Možnosti instalace: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (předvolená složka),
`/auto` (spustí se hned), `/quiet` (bez okna: konzolový instalátor, návratový kód
= výsledek). První běh sestaví aplikaci na tomto stroji, chvíli to trvá;
další běhy jen aktualizují a opravují.

## Bezplatné modely, nic nenastavuješ

Aplikace má vlastní 9router. Na stroji bez něj ho ZAICODE spustí
privátně (izolovaný režim, port 20138), naplní **SAIFREN** z bezklíčových bezplatných
úrovní a nastaví `SAIRoute / SAIFREN` jako model nových úloh, takže první úloha
napsaná do Nová úloha dostane odpověď: žádný klíč, žádek, nastavení. Přihlášení
Claude Code, Codex a Antigravity jsou volitelná; přihlášení, které na stroji nikdy nenastalo,
ukáže se jako "volitelné, přihlas se kdykoliv", ne jako "vyžaduje tě".
Důkaz: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
spustí zabalenou aplikaci na prázdném profilu (vlastní HOME, APPDATA a
LOCALAPPDATA) a projde jen když je router izolovaný, SAIFREN odpoví na
první testovací token a úloha v Nová úloha dostane odpověď.

## Aktualizace: čtyři části, jeden ZAICODE

Pracovní prostor (spouštěč, instalátor), aplikace, SAIPEN a SAIMAIL jsou čtyři
klony. Každý se aktualizuje sám: **Nastavení -> ZAICODE -> Aktualizace** je
vypisuje s verzí a commitem, aktualizuje jeden po druhém nebo všechny a má
pro každou část přepínač "sám" (v instalovaném ZAICODE zapnutý, ve vývojářském
checkoutu vypnutý). ZAICODE se podívá pár minut po startu a pak každých šest
hodin. Po aktualizaci dostane každá část, co potřebuje: aplikace závislosti (když se
`pnpm-lock.yaml` přesunul) a nový build (připravený, zatímco ZAICODE běží, spuštěný při
dalším startu), SAIPEN svůj spouštěč, SAIMAIL svou
`.venv` instalaci, pracovní prostor nový kořenový spouštěč. Klon na jiné větvi,
s lokálními commity nebo s úpravami, které by aktualizace přepsala, se nahlásí
a zůstane beze změny.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Co dělá

Instalátor jsou kontroly Autotroubleshoot spuštěné s "repair" na prázdné
složce, v tomto pořadí. Každý krok je idempotentní, takže opakovaný běh
aktualizuje instalaci a opraví, co se rozbilo.

| Kontrola | Oprava |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | použije kopii ze stroje, když vyhovuje; jinak privátní kopii v `.tools\` (MinGit z Git for Windows, Node.js 24.14.0 z nodejs.org, Python z jeho NuGet balíčku). Bez administrátorských práv. |
| pnpm | připnutý pnpm 10.33.2 v `.tools\pnpm10` |
| Pracovní prostor ZAICODE | klon větve `vacterro/zaicode` `master` (zdroj spouštěče, instalátor, dokumentace; `.saipen/` paměť vývojáře se vynechává; větev `workspace` do 2026-09-27) |
| Zdroj aplikace ZAICODE | klon větve `zaicode` do `zcode\` |
| SAIPEN | klon `vacterro/saipen` do `saipen\`; jeho `bin\saipen.cmd` je psaný pro tento klon a tento Python |
| SAIMAIL | klon `vacterro/saimail` do `saimail\`, nainstalováno do `.venv\` |
| saimail-local | CLI klient SAIMAILu, který používají panely SAIMAIL v ZAICODE (od SAIMAIL `0.0.2a3`; kontrola `saimail-cli` hlásí OK) |
| Balíček 9router | `9router` z npm do `.tools\router`, zabundlovaný, ať SAIFREN funguje bez nastavení (WARN, když na něj npm nedosáhne) |
| Závislosti aplikace | `pnpm install --frozen-lockfile` (znovu, když se změní `pnpm-lock.yaml`) |
| Build aplikace | `pnpm bundle:zaicode`; když ZAICODE běží, nový build se připraví a vymění při dalším startu |
| Výměna připraveného buildu | vymaže `win-unpacked.previous` po neúspěšné výměně s dlouhou cestou a nasadí čekající build, když je ZAICODE zavřený |
| Kořenový spouštěč | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Zástupci | na ploše a v nabídce Start `ZAICODE` -> `ZAICODE.exe` |
| Přihlášení Claude / Codex | jen hlášeno: každé přihlášení `~\.claude*` / `~\.codex*` je vlastní engine v ZAICODE (A1, A2, C1, ...); přihlášení vyžaduje tě, v prohlížeči |

Kořenový spouštěč nasměruje ZAICODE na nainstalovaný SAIPEN (`saipen\`) a dá
`.tools\` a `.venv\Scripts` na začátek PATH aplikace, takže aplikace, její agenti
i workeři používají nainstalované kopie.

## Několik předplatných

Každý login Claude Code nebo Codex žije ve vlastním home: `~\.claude`,
`~\.claude-account2`, ... a `~\.codex`, `~\.codex-account2`, ... ZAICODE je
najde všechny. Připravit další při instalaci:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Instalátor vytvoří homes a vypíše přesný příkaz pro každý login
(`$env:CODEX_HOME = '...'; codex login`). Totéž je v ZAICODE: Settings ->
Engines & limits -> přidat další login.

## Autodiagnostika

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Stav každé kontroly: OK, FIXED (bylo rozbité, opraveno), WARN (funguje, ale něco
volitelného chybí), INFO (vyžaduje vás: login), FAIL. Logy jsou v
`install\logs\`; souhrn poslední instalace je `install\install-report.json`.
V aplikaci Router -> Autotroubleshoot opraví běžící router a pooly.

## Možnosti

| Parametr | Výchozí | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | kam všechno patří |
| `-ShortcutDir` | Desktop | kam jde zástupce ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | přeskočit tyto zástupce |
| `-PortableTools` | | vlastní Git / Node.js / Python, i když je stroj má |
| `-Launch` | | spustit ZAICODE po dokončení |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | repozitáře na GitHubu | jiný zdroj (fork, cesta k lokálnímu klonu) |

## Ověření

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
kontroluje čerstvou instalaci, nasadí poruchy (zástupce a launcher smazán, launcher
SAIPEN ukazuje na chybějící Python, venv SAIMAIL smazán, node_modules
zaznamenaný pro jiný lockfile, zbytková build složka hlubší než MAX_PATH),
assertuje, že doctor nahlásí a opraví každou z nich, pak spustí cíl zástupce
s izolovaným profilem a zastaví přesně procesní strom, který spustil.

`install\tests\Test-ZaicodeUpdate.ps1` postaví čtyři jednorázové repozitáře
na disku a instalaci jejich klonů, pak dokáže, že kontrola nic nemění,
že jedna část aktualizuje samostatně se svým navazujícím krokem (launcher SAIPEN, kořenový
launcher), že se překrývající lokální úpravy a lokální commity zachovají, a že se neznámý název části odmítne. Bez sítě.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
