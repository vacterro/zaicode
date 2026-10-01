# ZAICODE paigaldamine

ZAICODE koosneb kolmest ühtse tervikuna töötavast projektist: ZAICODE rakendus, SAIPEN (agentide tööd juhtiv protokoll) ja SAIMAIL (agentidevaheline post). Käsitsi paigaldamiseks on vaja kolme klooni, Node.js tööriistaahelat, Pythoni keskkonda ja rakenduse kompileerimist. Paigaldaja teeb selle sinu eest: käivita, oota ning töölauale ilmub ZAICODE otsetee.

## Ühe klõpsuga

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  laadi alla, topeltklõpsa, vajuta **INSTALL**. Aken (kuldne tume taustal,
  SAIPENi bänner) näitab iga sammu käivitamisel, kulunud aega ja logi
  nõudmisel; lõpus **START ZAICODE** või **TRY AGAIN** / **Autotroubleshoot**
  / **Open log**, kui mõni samm ei lõpetatud. Olemasoleva ZAICODE
  kausta puhul on nupul tekst **UPDATE**: sama käivitus nii uuendab kui ka
  parandab. exe sisaldab paigaldusskripte ega vaja enda kõrval midagi; selle
  ehitab `install\setup\build.cmd` (.NET Frameworki kompileerija, mis on igal Windows 10/11
  olemas).
- `install\Setup-ZAICODE.cmd` (topeltklõpsa): sama paigaldus konsoolis.
- Nullist, PowerShellis:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Paigaldusvalikud: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (kausta eelseadistus), `/auto` (alusta kohe), `/quiet` (aknaga liidese asemel konsoolipaigaldaja; väljumiskood näitab tulemust). Esimene käivitus kompileerib rakenduse sellel masinal ja võtab aega; järgnevad käivitused ainult uuendavad ning parandavad.

## Tasuta mudelid, seadistamist pole vaja

Rakendusega kaasneb oma 9router. Masinas, kus seda pole, käivitab ZAICODE selle privaatselt (isoleeritud režiimis, pordil 20138), täidab **SAIFREN**-i võtmeta tasuta teenustega ning seab `SAIRoute / SAIFREN` uute ülesannete mudeliks. Seega saab esimene väljale New task sisestatud ülesanne vastuse ilma võtme, konto ja seadistamiseta. Claude Code, Codex ja Antigravity sisselogimised on valikulised; seadistamata konto olek on „valikuline, logi sisse igal ajal”, mitte kasutaja sekkumist vajav ülesanne.
Tõend: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>` käivitab pakendatud rakenduse tühja profiiliga (eraldi HOME, APPDATA ja LOCALAPPDATA) ning läbib kontrolli ainult siis, kui marsruuter on isoleeritud, SAIFREN vastab esimese tokeni proovile ja New task ülesanne saab vastuse.

## Uuendused: neli osa, üks ZAICODE

Tööala (käivitaja, paigaldaja), rakendus, SAIPEN ja SAIMAIL on neli klooni. Igaüks
uueneb eraldi: **Settings -> ZAICODE -> Updates** loetleb need koos versiooni ja
commitiga, uuendab ühehaaval või kõik korraga ning iga osa jaoks on lüliti "ise"
(vaikimisi sisse lülitatud paigaldatud ZAICODE-s, välja arendaja checkoutis). ZAICODE
vaatab mõni minut pärast käivitumist ja siis iga kuue tunni tagant. Pärast uuendust saab
iga osa vajaliku: rakendus oma sõltuvused (kui `pnpm-lock.yaml` muutus) ja uue ehituse
(etapiviisiliselt ZAICODE töötamise ajal, käivitub järgmisel käivitusel), SAIPEN oma
käivitaja, SAIMAIL oma `.venv` paigalduse, tööala uue juurkäivitaja. Kloon teisel
harul, kohalike commitega või muudatustega, mille uuendus ületaks, teavitatakse ja jäetakse
täpselt nii nagu on.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Mida see teeb

Paigaldaja käivitab allolevas järjekorras automaatse veaotsingu kontrollid koos parandustega tühjas kaustas. Iga samm on idempotentne: uuesti käivitamine uuendab paigalduse ja parandab pooleli jäänud sammud.

| Kontroll | Parandus |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | kasutab masina koopiat, kui see sobib; muidu privaatne koopia asukohas `.tools\` (MinGit Git for Windowsist, Node.js 24.14.0 nodejs.org-st, Python oma NuGeti paketist). Administraatoriõigusi pole vaja. |
| pnpm | fikseeritud pnpm 10.33.2 asukohas `.tools\pnpm10` |
| ZAICODE tööala | `vacterro/zaicode` haru `master` kloon (käivitaja lähtekood, paigaldaja, dokumentatsioon; arendaja `.saipen/` mälus jäetakse välja; haru `workspace` kuni 2026-09-27) |
| ZAICODE rakenduse lähtekood | haru `zaicode` kloon asukohta `zcode\` |
| SAIPEN | `vacterro/saipen` kloon asukohta `saipen\`; selle `bin\saipen.cmd` on kirjutatud selle klooni ja selle Pythoni jaoks |
| SAIMAIL | `vacterro/saimail` kloon asukohta `saimail\`, paigaldatud asukohta `.venv\` |
| saimail-local | SAIMAILi käsuklient, mida ZAICODE'i SAIMAILi paneelid kasutavad (lisatud alates SAIMAIL `0.0.2a3`-st; `saimail-cli` kontroll annab tulemuse OK) |
| 9routeri pakett | `9router` npmist asukohta `.tools\router`, pakkitud kaasa, nii et SAIFREN töötab ilma seadistamiseta (WARN, kui npm ei saa seda kätte) |
| Rakenduse sõltuvused | `pnpm install --frozen-lockfile` (uuesti, kui `pnpm-lock.yaml` muutub) |
| Rakenduse ehitus | `pnpm bundle:zaicode`; ZAICODE töötamise ajal uus ehitus ette valmistatakse ja vahetatakse välja järgmisel käivitamisel |
| Ettevalmistatud ehituse vahetus | eemaldab pikade radade vahetamisel tekkinud tõrke järel jäänud `win-unpacked.previous` ja vahetab ootava ehituse välja, kui ZAICODE on suletud |
| Juurkäivitaja | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Otseteed | Töölaual ja Start menüüs `ZAICODE` -> `ZAICODE.exe` |
| Claude / Codexi loginsessioonid | ainult raportitakse: iga `~\.claude*` / `~\.codex*` loginsessioon on ZAICODE'is oma mootor (A1, A2, C1, ...); loginsessioon vajab sind, brauseris |

Juurkäivitaja suunab ZAICODE paigaldatud SAIPENile (`saipen\`) ning lisab `.tools\` ja `.venv\Scripts` rakenduse PATH-i algusesse. Nii kasutavad rakendus, selle agendid ja töölised paigaldatud versioone.

## Mitu tellimust

Iga Claude Code või Codex sisselogimine elab omaette kodus: `~\.claude`,
`~\.claude-account2`, ... ja `~\.codex`, `~\.codex-account2`, ... ZAICODE leiab
need kõik. Et installimisel rohkem ette valmistada:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Paigaldaja loob need kodukaustad ja kuvab igaühe täpse sisselogimiskäsu (`$env:CODEX_HOME = '...'; codex login`). Sama võimalus on ZAICODE-s: Settings -> Engines & limits -> lisa veel üks sisselogimine.

## Automaatne veaotsing

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Iga kontrolli olek: OK, FIXED (oli katki, parandati), WARN (töötab, kuid mõni valikuline osa puudub), INFO (vajab sinu sisselogimist), FAIL. Logid asuvad `install\logs\`; viimase paigalduse kokkuvõte on `install\install-report.json`. Rakenduses parandab Router -> Autotroubleshoot töötava marsruuteri ja mudelikogumid.

## Valikud

| Parameeter | Vaikeväärtus | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | kuhu kõik läheb |
| `-ShortcutDir` | Desktop | kuhu ZAICODE otsetee läheb |
| `-NoStartMenu`, `-NoShortcut` | | jäta need otseteed vahele |
| `-PortableTools` | | privaatne Git / Node.js / Python isegi kui masinal on need olemas |
| `-Launch` | | käivita ZAICODE, kui valmis |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | GitHubi hoidlad | teine allikas (fork, kohalik klooni tee) |

## Tõend

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke` kontrollib värsket paigaldust, tekitab sihilikult tõrked (kustutatud otsetee ja käivitaja, puuduvat Pythonit kasutav SAIPENi käivitaja, kustutatud SAIMAILi venv, teise lockfile-i jaoks paigaldatud node_modules ning MAX_PATH-ist pikema teega allesjäänud ehituskaust). See kinnitab, et veaotsing leiab ja parandab iga tõrke, käivitab seejärel otsetee sihtmärgi isoleeritud profiiliga ning peatab ainult enda käivitatud protsessipuu.

`install\tests\Test-ZaicodeUpdate.ps1` loob kettal neli ajutist hoidlat ja nende kloonidel põhineva paigalduse. See tõestab, et pelk kontroll ei muuda midagi, ühe osa uuendamisele järgnevad vajalikud toimingud (SAIPENi käivitaja, juurkäivitaja), kohalikud muudatused ja commitid säilivad ning tundmatu osa nimi lükatakse tagasi. Võrku ei kasutata.
<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
