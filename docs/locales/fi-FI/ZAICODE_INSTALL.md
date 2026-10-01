# ZAICODEn asennus

ZAICODE on kolme projektia, jotka toimivat yhtenä: ZAICODE-sovellus, SAIPEN (protokolla, joka pitää agentin työn raiteilla) ja SAIMAIL (posti, jolla agentit kertovat toisilleen asioita). Näiden asentaminen käsin tarkoittaa kolmea kloonausta, Node.js-työkalua, Python-ympäristöä ja buildia. Asentaja tekee kaiken: käynnistä se, odota, ja ZAICODE-pikakuvake on työpöydällä.

## Yksi klikkaus

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  lataa, kaksoisnapsauta, paina **INSTALL**. Ikkuna (kultaa tummalla, SAIPEN-banneri) näyttää jokaisen vaiheen sen kestäessä, kuluneen ajan ja pyydettäessä lokin; lopuksi **START ZAICODE**, tai **TRY AGAIN** / **Autotroubleshoot**
  / **Open log**, jos jokin vaihe ei valmistunut. Kun kohde on olemassa oleva ZAICODE-kansio, painikkeen teksti on **UPDATE**: sama ajo päivittää ja korjaa. Exe sisältää asennusskriptit eikä tarvitse mitään rinnalleen; sen kääntää `install\setup\build.cmd` (.NET Framework -kääntäjä, joka löytyy jokaisesta Windows 10/11:stä).
- `install\Setup-ZAICODE.cmd` (kaksoisnapsauta): sama asennus konsolissa.
- Tyhjästä, PowerShellissa:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Asetusvalinnat: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (esipakattu kansio),
`/auto` (käynnistyy heti), `/quiet` (ei ikkunaa: konsoliasentaja, paluukoodi
= tulos). Ensimmäinen ajoitus kokoaa sovelluksen tälle koneelle, mikä kestää jonkin aikaa;
myöhemmät ajot vain päivittävät ja korjaavat.

## Ilmaiset mallit, ei mitään asetettavaa

Sovellus sisältää oman 9routerinsa. Koneella, jossa ei ole sellaista, ZAICODE käyttää sitä
yksityisesti (eristetty tila, portti 20138), täyttää **SAIFREN**-tunnuksettomilla ilmaisilla
tasoilla ja tekee `SAIRoute / SAIFREN`:stä uusien tehtävien mallin, jotta Uuteen tehtävään
kirjoitettu ensimmäinen tehtävä saa vastauksen: ei avainta, ei tiliä, ei asetuksia. Claude
Code-, Codex- ja Antigravity-kirjautumiset ovat vapaaehtoisia; kirjautuminen, jota koneella ei ole
koskaan tehty, näkyy merkinnän "valinnainen, kirjaudu sisään milloin tahansa" sijaan, ei "tarvitsee
sinua" -merkintänä. Todiste: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
käynnistää pakatun sovelluksen tyhjällä profiililla (oma HOME, APPDATA ja
LOCALAPPDATA) ja menee läpi vain, kun reititin on eristetty, SAIFREN vastaa ensimmäisen
tokenin mittaukselle ja tehtävään Uudessa tehtävässä saadakseen vastaus.

## Päivitykset: neljä osaa, yksi ZAICODE

Työtila (käynnistin, asentaja), sovellus, SAIPEN ja SAIMAIL ovat neljä kloonaa. Jokainen
päivittyy erikseen: **Asetukset -> ZAICODE -> Päivitykset** listaa ne versioineen ja
commit-tunnusteineen, päivittää yhden kerrallaan tai kaikki, ja sisältää kullekin osalle
"itsensä" -kytkimen (oletuksena päällä asennetussa ZAICODESSa, pois päältä kehittäjän
tarkistuksessa). ZAICODE tarkistaa muutaman minuutin kuluttua käynnistyksestä ja sitten
kuuden tunnin välein. Päivityksen jälkeen kukin osa saa tarvitsemansa: sovellus riippuvuutensa
(kun `pnpm-lock.yaml` siirtyi) ja uuden käännöksen (vaihdetaan ZAICODEn käydessä, otetaan käyttöön
seuraavassa käynnistyksessä), SAIPEN käynnistimensä, SAIMAIL `.venv`-asennuksensa,
työtila uuden juurikäynnistimen. Kloona toisella haaralla, paikallisilla commiteilla tai
muutoksilla, jotka päivitys ylikirjoittaisi, ilmoitetaan ja jätetään täysin ennalleen.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Mitä se tekee

Asentaja on vianmääritystarkistukset, jotka ajetaan "korjaa"-toiminnolla tyhjään kansioon
tässä järjestyksessä. Jokainen vaihe on idempotentti, joten uusinta-ajo päivittää asennuksen ja
korjaa rikkuneet osat.

| Tarkistus | Korjaus |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | käyttää koneen omaa versiota, jos se sopii; muuten oma kopio hakemistossa `.tools\` (MinGit Git for Windowsista, Node.js 24.14.0 nodejs.orgista, Python NuGet-paketistaan). Ei vaadi ylläpito-oikeuksia. |
| pnpm | kiinnitetty pnpm 10.33.2 hakemistossa `.tools\pnpm10` |
| ZAICODE-työtila | klooni haarasta `vacterro/zaicode`, haara `master` (käynnistimen lähde, asennusohje, dokumentit; kehittäjän `.saipen/` muisti jätetään ulkopuolelle; haara `workspace` asti 2026-09-27) |
| ZAICODE-sovelluksen lähde | klooni haarasta `zaicode` hakemistoon `zcode\` |
| SAIPEN | klooni `vacterro/saipen` hakemistoon `saipen\`; sen `bin\saipen.cmd` on kirjoitettu tätä kloonia ja tätä Pythonia varten |
| SAIMAIL | klooni `vacterro/saimail` hakemistoon `saimail\`, asennettu hakemistoon `.venv\` |
| saimail-local | SAIMAILin komentorivityökalu, jota ZAICODEen SAIMAIL-paneelit käyttävät (tullut mukaan SAIMAIL-versiosta `0.0.2a3`; tarkistus `saimail-cli` ilmoittaa OK) |
| 9router-paketti | `9router` npmista hakemistoon `.tools\router`, mukana toimituksessa, jotta SAIFREN toimii ilman asennusta (WARN, jos npm ei tavoita sitä) |
| Sovelluksen riippuvuudet | `pnpm install --frozen-lockfile` (uudelleen, kun `pnpm-lock.yaml` muuttuu) |
| Sovelluksen build | `pnpm bundle:zaicode`; ZAICODEen käytön aikana uusi build valmistellaan ja vaihdetaan seuraavalla käynnistyksellä |
| Valmistellun buildin vaihto | poistaa `win-unpacked.previous`, joka jäi pitkän polun vaihtovirheen jäljelle, ja vaihtaa odottavan buildin kun ZAICODE on suljettu |
| Juurikäynnistin | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Pikakuvakkeet | työpöydän ja Käynnistä-valikon `ZAICODE` -> `ZAICODE.exe` |
| Claude / Codex -kirjautumiset | vain ilmoitetaan: jokainen `~\.claude*` / `~\.codex*` kirjautuminen on oma moottorinsa ZAICODEessa (A1, A2, C1, ...); kirjautuminen vaatii sinut selaimessa |

Juurikäynnistin ohjaa ZAICODEn asennettuun SAIPENiin (`saipen\`) ja asettaa
`.tools\`:n ja `.venv\Scripts`:n sovelluksen PATH-muuttujan kärkeen, jotta sovellus, sen
agentit ja sen työntekijät käyttävät asennettuja kopioita.

## Useita tilauksia

Jokainen Claude Coden tai Codexin kirjautuminen elää omassa kotikansiossaan: `~\.claude`,
`~\.claude-account2`, ... sekä `~\.codex`, `~\.codex-account2`, ... ZAICODE löytää
ne kaikki. Valmistele lisää asennuksen yhteydessä:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Asennusohjelma luo kotikansiot ja tulostaa tarkan kirjautumiskomennon jokaiselle
(`$env:CODEX_HOME = '...'; codex login`). Sama löytyy ZAICODEsta: Asetukset ->
Moottorit & rajat -> lisää toinen kirjautuminen.

## Automaattinen vianmääritys

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Tila per tarkistus: OK, FIXED (oli rikki, korjattu), WARN (toimii, mutta jotain
valinnaisesta puuttuu), INFO (vaatii sinua: kirjautuminen), FAIL. Lokit ovat
`install\logs\`; viimeisimmän asennuksen yhteenveto on `install\install-report.json`.
Sovelluksessa Router -> Autotroubleshoot korjaa käynnissä olevan reitittimen ja poolit.

## Asetukset

| Parametri | Oletusarvo | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | minne kaikki menee |
| `-ShortcutDir` | Desktop | mihin ZAICODE-pikakuvake menee |
| `-NoStartMenu`, `-NoShortcut` | | jätä nämä pikakuvakkeet pois |
| `-PortableTools` | | oma Git / Node.js / Python vaikka koneella ne olisivatkin |
| `-Launch` | | käynnistä ZAICODE valmistuessa |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | GitHub-repositoriot | toinen lähde (forkki, paikallinen kloonauspolku) |

## Todistus

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
tarkistaa tuoreen asennuksen, luo viat (pikakuvake ja käynnistin poistettu, SAIPENin
käynnistin osoittaa puuttuvaan Pythoniin, SAIMAILin venv poistettu, node_modules kirjattu
toiselle lukitustiedostolle, jäänyt build-kansio MAX_PATHia syvemmä),
varmistaa, että lääkäri raportoi ja korjaa jokaisen, ja sitten käynnistää pikakuvakkeen
kohteen eristetyllä profiililla ja pysäyttää tarkalleen sen käynnistämän prosessipuun.

`install\tests\Test-ZaicodeUpdate.ps1` rakentaa neljä kertakäyttöistä repositoria
levylle ja asennuksen niiden klooneista, sitten todistaa, että tarkistus ei muuta mitään, että yksi osa päivittyy yksin seuraavansa mukaan (SAIPEN-käynnistin, juuri-
käynnistin), että päällekkäiset paikalliset muutokset ja paikalliset commitit säilyvät, ja että tuntemattoman osan nimi hylätään. Ei verkkoa.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
