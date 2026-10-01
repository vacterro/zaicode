# Instalacija ZAICODE-a

ZAICODE su tri projekta koja rade kao jedan: aplikacija ZAICODE, SAIPEN (protokol
koji drži rad agenata na pravom putu) i SAIMAIL (pošta kojom se agenti
međusobno obavještavaju). Ručna instalacija znači tri kloniranja, Node.js
alatni lanac, Python okruženje i build. Instalacijski program sve to napravi:
pokrenite ga, pričekajte i na radnoj površini pojavi se prečac ZAICODE.

## Jednim klikom

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  preuzmite, dvaput kliknite, pritisnite **INSTALL**. Prozor (zlatne boje na tamnoj pozadini,
  SAIPEN baner) prikazuje svaki korak dok se izvršava, proteklo vrijeme i po potrebi
  zapisnik; na kraju **START ZAICODE**, odnosno **TRY AGAIN** / **Autotroubleshoot**
  / **Open log** ako neki korak nije dovršen. Ako pokazujete na postojeću ZAICODE
  mapu, gumb piše **UPDATE**: isti postupak ažurira i popravlja.
  exe datoteka nosi instalacijske skripte i ne treba ništa uz sebe; gradi je
  `install\setup\build.cmd` (kompajler .NET Frameworka koji ima svaki Windows 10/11).
- `install\Setup-ZAICODE.cmd` (dvaput klik): ista instalacija u konzoli.
- Iz ničega, u PowerShellu:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Opcije postavljanja: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (zadana mapa),
`/auto` (pokreće se odmah), `/quiet` (bez prozora: konzolni instalater, kod izlaza
= rezultat). Prvo pokretanje gradi aplikaciju na ovom računalu, što potraje;
kasnija pokretanja samo ažuriraju i popravljaju.

## Besplatni modeli, ništa za postaviti

Aplikacija nosi vlastiti 9router. Na računalu koje ga nema ZAICODE ga pokreće
privatno (izolirani način, port 20138), popunjava **SAIFREN** besplatnim
razinama bez ključeva i postavlja `SAIRoute / SAIFREN` kao model novih zadataka, pa prvi zadatak
upisan u Novi zadatak dobiva odgovor: bez ključa, bez računa, bez postavke. Prijave u
Claude Code, Codex i Antigravity su neobavezne; prijava koja na računalu nije postavljena
prikazuje se kao "neobavezno, prijavite se bilo kada", a ne kao stavka
"treba vas". Dokaz: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
pokreće isporučenu aplikaciju na praznom profilu (vlastiti HOME, APPDATA i
LOCALAPPDATA) i prolazi samo ako je router izoliran, SAIFREN odgovara na probu
prvog tokena i zadatak u Novom zadatku dobiva odgovor.

## Ažuriranja: četiri dijela, jedan ZAICODE

Radni prostor (pokretač, instalater), aplikacija, SAIPEN i SAIMAIL su četiri
klona. Svaki se ažurira zasebno: **Postavke -> ZAICODE -> Ažuriranja** navodi ih s
verzijom i commitom, ažurira ih pojedinačno ili sve odjednom, te ima prekidač "samostalno"
za svaki dio (uključen u instaliranom ZAICODE-u, isključen u razvojnoj kopiji).
ZAICODE provjerava nekoliko minuta nakon pokretanja, a zatim svakih šest sati.
Nakon ažuriranja svaki dio dobije što mu treba: aplikacija svoje ovisnosti (kad se
`pnpm-lock.yaml` promijeni) i novu izgradnju (pripremljenu dok ZAICODE radi, pokrenutu
na sljedećem pokretanju), SAIPEN svoj pokretač, SAIMAIL svoju
`.venv` instalaciju, radni prostor novi korijenski pokretač. Klon na drugoj
grani, s lokalnim commitovima ili s izmjenama koje bi ažuriranje prebrisalo
prijavljuje se i ostavlja se točno kakav jest.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Što radi

Instalater su provjere Autotroubleshoot pokrenute s "popravak" na praznoj
mapi, ovim redoslijedom. Svaki je korak idempotentan, pa ponovno pokretanje
ažurira instalaciju i popravlja ono što se pokvarilo.

| Provjera | Popravak |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | koristi kopiju s računala ako odgovara; inače privatnu kopiju u `.tools\` (MinGit iz Git for Windowsa, Node.js 24.14.0 s nodejs.org, Python iz svog NuGet paketa). Bez administratorskih prava. |
| pnpm | fiksirani pnpm 10.33.2 u `.tools\pnpm10` |
| ZAICODE radni prostor | klon `vacterro/zaicode` grane `master` (izvor pokretača, instalater, dokumentacija; `.saipen/` memorija razvojnika izostavljena; grana `workspace` do 2026-09-27) |
| Izvor aplikacije ZAICODE | klon grane `zaicode` u `zcode\` |
| SAIPEN | klon `vacterro/saipen` u `saipen\`; njegov `bin\saipen.cmd` napisan je za ovaj klon i ovaj Python |
| SAIMAIL | klon `vacterro/saimail` u `saimail\`, instaliran u `.venv\` |
| saimail-local | SAIMAIL-ov naredbeni klijent koji koriste ZAICODE-ovi SAIMAIL paneli (isporučen od SAIMAIL `0.0.2a3`; provjera `saimail-cli` prijavljuje OK) |
| 9router paket | `9router` s npm-a u `.tools\router`, uključen da SAIFREN radi bez postavljanja (WARN ako ga npm ne može dohvatiti) |
| Ovisnosti aplikacije | `pnpm install --frozen-lockfile` (ponovno kad se `pnpm-lock.yaml` promijeni) |
| Izgradnja aplikacije | `pnpm bundle:zaicode`; dok ZAICODE radi, nova izgradnja se priprema i zamjenjuje staru pri sljedećem pokretanju |
| Zamjena pripremljene izgradnje | briše `win-unpacked.previous` zaostao nakon neuspjele zamjene zbog predugačke putanje i ugrađuje čekajuću izgradnju dok je ZAICODE zatvoren |
| Pokretač u korijenu | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Prečaci | Radna površina i izbornik Start `ZAICODE` -> `ZAICODE.exe` |
| Prijave Claude / Codex | samo se izvještavaju: svaka prijava `~\.claude*` / `~\.codex*` zaseban je pogon u ZAICODE-u (A1, A2, C1, ...); prijava treba vas, u pregledniku |

Korijenski pokretač usmjerava ZAICODE na instalirani SAIPEN (`saipen\`) i stavlja
`.tools\` i `.venv\Scripts` na prvo mjesto u PATH-u aplikacije, pa aplikacija,
njezini agenti i radnici koriste instalirane kopije.

## Nekoliko pretplata

Svaka prijava za Claude Code ili Codex živi u vlastitom home direktoriju: `~\.claude`,
`~\.claude-account2`, ... i `~\.codex`, `~\.codex-account2`, ... ZAICODE ih pronalazi
sve. Za pripremu više pri instalaciji:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Instalacijski program kreira home direktorije i ispisuje točnu naredbu prijave za svaki
(`$env:CODEX_HOME = '...'; codex login`). Isto je i u ZAICODE-u: Postavke ->
Motori i granice -> dodaj još jednu prijavu.

## Automatsko rješavanje problema

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Status po provjeri: OK, FIXED (bilo pokvareno, popravljeno), WARN (radi, ali nešto
opcijsko nedostaje), INFO (treba te: prijava), FAIL. Logovi su u
`install\logs\`; sažetak zadnje instalacije je `install\install-report.json`.
U aplikaciji: Router -> Autotroubleshoot popravlja aktivni router i poolove.

## Opcije

| Parametar | Zadano | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | gdje se sve instalira |
| `-ShortcutDir` | Desktop | gdje ide prečac ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | preskoči te prečice |
| `-PortableTools` | | privatni Git / Node.js / Python čak i kad ih stroj ima |
| `-Launch` | | pokreni ZAICODE po završetku |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | GitHub repozitoriji | drugi izvor (fork, lokalna putanja klona) |

## Dokaz

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
provjerava svježu instalaciju, ubacuje kvarove (obrisan prečac i pokretač, SAIPEN
pokretač usmjeren na nepostojeći Python, obrisan SAIMAIL venv, node_modules
zapisan za drugu lockfile datoteku, zaostala build mapa dublja od MAX_PATH),
potvrđuje da doctor prijavljuje i popravlja svaki, zatim pokreće metu prečaca
s izoliranim profilom i zaustavlja točno stablo procesa koje je pokrenuo.

`install\tests\Test-ZaicodeUpdate.ps1` gradi četiri privremena repozitorija na
disku i instalaciju njihovih klona, zatim dokazuje da provjera ne mijenja ništa,
da se jedan dio samostalno ažurira sa svojim pratećim dijelom (SAIPEN pokretač, root
pokretač), da se preklapajuće lokalne izmjene i lokalni commitovi čuvaju te da se
naziv nepoznate komponente odbija. Bez mreže.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
