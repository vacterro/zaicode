# ZAICODE SAIPEN pilvensiirto

Miten tämä kassa ja Claude Code Cloud -istunto ajavat yhtä SAIPEN-työtilaa
eri suorittimen sijainnilla, ja missä niiden raja on.

## Muoto

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Yksi haara kantaa protokolltatilan. Ei merge-vaihetta, ei rebase-vaihetta
eikä toista paikallista haaraa pidettävässä synkissä: kumpikin suoritin
commitoi ja puskee varmennetun checkpointin, ja toinen puoli ottaa sen
fast-forwardilla.

`master` on ennen siirtoa oleva historia ja julkaistu oletushaara. Siirto
ei päivitä sitä force-asetuksella.

## Mikä liikkuu ja mikä ei

Checkpoint tässä repositoriossa kantaa SAIPEN-protokolltatilan, juurisuorittimen,
asennimen, dokumentit ja nämä siirtoskriptit. Se on koko työtilakerros.

Se ei sisällä **yhtään tuotetavuetta**. `zcode/` on erillinen Git-repositorio,
listattu `.saipen/source-nested-repos.json`-kohteessa ja gitignorattu tässä juuressa
(`/zcode/`). Tuotetyö tarvitsee oman `vacterro/zaicode`-klonensa haaralla
`zaicode`, ja tuo klooni on toinen, riippumaton olio omine historioineen.

Seuraus on helppo mennessä väärin: siisti `git status` tässä juuressa ei
sanottua mitään tuomatyöstä, joka on commitoimatta, eikä `saipen-live`-fast-forward
sanottua mitään tuotekoodista. Tarkista `git -C zcode status` erikseen.

## Paikallinen puoli

Kaksi skriptiä, molemmat repositorion omia, jotta uusi kone saa ne
repositoriosta eikä muistista:

| File | Rooli |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | validoi, sovittaa haaran, asentaa ja käynnistää watcherin, kirjoittaa automaattikäynnistyksen, todistaa paikallinen == etä |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | silmukka: haku, vertailu, fast-forward tai push, loki, tauko; sitten tuotepassi ja päivitys |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | kierto riippumattomasta suorittajasta sekä kylmäkäynnistyksen todiste |
| `tools/saipen-cloud/Test-ProductSync.ps1` | tuotepassi ja päivitys kertakäyttöisiin Git-repositorioihin (ei verkkoa, ei oikeaa etäpistettä) |

Asenna ja korjaa:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Se on idempotentti. Konekohtainen tila sijaitsee `%APPDATA%\SAIPEN`:ssa
`ZaicodeSaipenLiveWatcher.ps1` (kopio), `ZAICODE_cloud-sync.log` (kierretään
2 MB kohdassa `.log.1`), `ZAICODE_cloud-sync.lock` (yksi instanssi),
`ZAICODE_cloud-sync.pid`, ja Käynnistys-kansion merkintä
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Asennusohjelma kieltää likaisen työpuun eikä koskaan puhdista sitä. Jos kaikki likaiset polut ovat
kanonisia SAIPEN-tiloja hakemistossa `.saipen/`, se kertoo sen ja tulostaa täsmälliset
checkpoint-komennot: kyseessä on tarkistuspisteistä vapaa protokollatila, ei siirtotapahtumavirhe,
eikä asennusohjelma tee sitä commitiksi protokollan selän takana.

## Watcherin toiminta

| Tilanne | Siirto |
|-----------|------|
| puhdas, paikallinen on remote-esi-isä | `git merge --ff-only` |
| puhdas, remote on paikallisen esi-isä | `git push` |
| likainen | tauko; ei edes hakua |
| toisella haaralla | tauko |
| molemmat edenneet, ei yhteistä esi-isää | tauko, molemmat commit-idit lokiin, ei yhdistetä mitään |
| haku tai verkko epäonnistui | kirjaa heikentynyt tila, yritä seuraavalla kierroksella |
| merge/rebase/cherry-pick käynnissä | tauko |

Ei koskaan: pakotettu push, kovaa palautusta, stash, clean, vieraan haaran checkout,
commit, tai pysäytystä prosessinimen perusteella. Asennusohjelma pysäyttää watcherin vain
omaan pid-tiedostoonsa kirjaamastaan pidistä.

Likainen työpuu ei maksa mitään, koska watcher tarkistaa likaisuuden ennen hakua.
Jouten oleva checkout ei siis tee lainkaan verkkohakua.

### Tuotepassi (T-90)

`zcode/` on oma repositorioonsa, joten yllä oleva taulukko ei koskaan siirrä tuote
koodia. Sen jälkeen sama kierros käsittelee tuotteen checkoutin (`-ProductRepo`,
oletus `<repo>\zcode`; haara `-ProductBranch`, oletus `zaicode`). Tuotepassi
suoritetaan riippumatta ulkoisen työpuun likaisuudesta. Se vain vetää.

| Tilanne | Siirto |
|-----------|------|
| remote edellä, yksikään saapuva tiedosto ei ole likainen täällä | `git merge --ff-only`; committoimaton tuotetyö pysyy sellaisenaan |
| remote edellä, saapuva tiedosto on likainen täällä | HELD: kirjaa tiedostot, älä yhdistä mitään |
| paikallinen edellä | kirjaa; **ei koskaan pushattu** (tuotteen julkaisee SAIPEN SHIP) |
| eronnut | keskeytä, kirjaa molemmat id:t, älä yhdistä mitään |
| muu haara, git-operaatio käynnissä, fetch epäonnistui | keskeytä |
| ei `zcode/` checkouttia, tai `-NoProduct` | ohitettu |

git torjuu itse fast-forwardin, joka ylikirjoittaisi paikallisen muutoksen, joten
HELD-tarkistus on aikaisempi ja selkeämpi suoja, ei ainoa. Tuotteen
fast-forward ei rakenna mitään uudelleen: testaa komennolla `pnpm bundle:zaicode` (tai
dev-esikatselulla).

### Päivitys itselleen (T-90)

Watcher toimii kopiona hakemistossa `%APPDATA%\SAIPEN`, joten repossa oleva uudempi
watcher ei koskaan käynyt ilman uudelleenasennusta. Silmukkatilassa se vertaa
nyt omaa tiedostoaan repon commitoituun kopioon joka kierroksella. Se asentaa
kyseisen kopion itsensä päälle ja käynnistää itsensä täsmälleen kerran, samoilla
argumenteilla, vain kun kaikki nämä ehdot täyttyvät:

- kaksi tiedostoa eroavat;
- repon kopiossa ei ole committoimattomia muutoksia;
- repon kopio jäsennöityy virheettömästi.

Kopio, joka ei jäsennöidy, torjutaan ja kirjataan, ja käynnissä oleva watcher
jatkää.

Ennen T-90:aa asennetut watcherit ovat sekä tuotepassista että itsensä
päivittämisestä vailla. Aja `Install-SaipenLiveSync.ps1` kerran uudelleen tällaisella
koneella; sen jälkeen watcher päivittää itsensä.

## Pilvipuoli

`CLAUDE.md` juuressa on sisääntulosääntö ja
`.claude/skills/saipen/SKILL.md` on suoritusohje. Skill hakee
SAIPEN-ytimen osoitteesta `github.com/vacterro/saipen` ja suorittaa sen
ilmoitetun moottoripinnan `tools/saipen.py` kautta. Ydin on sidottu commitilla
(`3088eff`), ei koskaan tagilla. Tagi `v8.0.1` on vanhempi ydin, jolla on
sama `VERSION`; sen `validate` muuttaa tilaa, ja sen validaattori hylkää
tämän taulun.

`STATE.saipen_home` tallentaa sen suorittajan ytimen polun, joka
tarkistuspisteistoi viimeksi. Pilvessä ensimmäinen `saipen continue` ytimen
`3088eff` päällä yhdistää sen käynnissä olevaan ytimeen yhtenä kirjattuna
`DEC`:na (E-1410). Ylläpitäjän koneella osoitin saapuu samalla tavalla
kuolleena. Ydin, jossa on automaattinen yhdistäminen, korjaa sen
`continue`; muutoin aja `saipen rebind-home --auto`.

**Paluumatka havaitaan.** E-1562 (pilvi) vei osoittimen kohtaan `/home/user/zaicode/.claude/saipen-protocol`; E-1571 (operaattorikone)
palautti sen suoraan kohtaan `V:/.../_SAIPEN`, automaattisesti, ilman manuaalista
`rebind-home`. Molemmat suunnat ovat sama automaattinen konvergointi, joten odota
yksi `saipen_home` `DEC` paikallisuuden vaihtoa kohden ja käsittele sitä odotettuna kohlana
eikä virheenä. Se pysyy kohlanа, kunnes P1-2
(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) siirtää osoittimen versioituksesta
uuteen tilaan; älä toteuta P1-2:ta sivuvaikutuksena havainnosta. Älä koskaan muokkaa osoitinta käsin.

`STATE.saipen_home` voi osoittaa ytimen **kehitysklooniin**, joka on pin-version edellä, ei siistään `3088eff`-klonaan — operaattorikoneella se on
`accepted-debt-rebind`-haara keskeneräisellä työllä. Ydin, joka ei ole pin- commitissa, ei automaattisesti ole väärin, mutta ei myöskään clean-room-lähde,
joten alla oleva sääntö äänisopimuksesta koskee sitä täydellä
voimalla. Älä koskaan commitoi, stashaa, resetoi, checkoutaa tai siivoa mitään tällaisessa
kloonissa; kohdennetuin yksittäisen tiedoston palautus `saipen/STYLE.md`:lle on ainoa
sallittu poikkeus, ja vain kun operaattori on pyytänyt sitä.

### STYLE.md ei ole paikallinen asetus

`saipen/STYLE.md`:n on oltava **tavutarkasti identtinen pin- ytimen tiedoston kanssa** jokaisella
koneella, jokaisessa kopiassa, poikkeuksetta ja ilman paikallisia muutoksia. Operaattorikoneella on
useampi kopio:

- ytimen klooni kohdassa `STATE.saipen_home` (Git-klooni, operaattorikoneella
  kehitysklooni);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, joka täytetään
  `saipen-inject`-ajastetulla tehtävällä (`bootstrap/schedule-run.ps1`). Se **ei ole
  Git-repositorio**, joten `git checkout` ei voi koskaan korjata sitä — uudelleensynkronointi injektorin kautta tai julkaistun sisällön suora kirjoitus on ainoa tie.

`style_contract`-token `.saipen/STATE.md`:ssä on kyseisen tiedoston tekstin tiiviste
(`tools/validate.py`, `style_contract_token`: CRLF normalisoitu, `style_contract:`
rivi poisluettuna). Muokkaa `reply_language` yhdessä kopiassa ja
token siirtyy; toinen kopio ja pilvi, jotka noutavat julkaistun ytimen,
säilyttävät julkaistun tokenin, ja jokainen CLI-kirjoitus eri puolella
hylätään:lla `style_contract ... does not match the installed STYLE.md marker`.
Koko vika on tämä: paikallinen puoli kirjoittaa tilaa, jota pilvi ei voi kirjoittaa.

**Vastauskielen vaihto on ytimen commitointi ja uudelleenpinnitys**, ei koskaan paikallinen
muutos. Vaihda se ytimen repositorioissa, julkaise, pinnaa commit uudelleen
SKILL.md:ssä ja päivitä `STATE.style_contract` kautta `saipen recover`. Paikallinen
muutos tiedostoon `STYLE.md` desynkronoi jokaisen koneen, joka ei ole muutoksen tekijä.

Yksi ansa on mainittava: julkaistu `bin/saipen` on koneeseen sidottu shim, joka
kovakoodaa yhden operaattorin absoluuttiset tulkinta- ja kloonipolut. Se toimii
tarkalleen yhdellä koneella. Pilven on käytettävä `python3 tools/saipen.py`.

Pikakuvakkeet: `cc` jatkaa nykyistä Workia; `cc all <text>` lukee koko
viestin lähteenä/appends ja jatkaa jokaista kelpoista Workia. Kumpikaan ei pyydä
rutiinista vahvistusta.

## Kyvykkyysluokitus

**AVAILABLE_IN_CLOUD** — protokollatila ja työtila-kerros. `.saipen/` lukeminen ja kirjoittaminen, käynnistin (`tools/launcher/ZaicodeLauncher.cs`), asennin hakemistossa `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` sekä siirtoskriptit. Git-luku, commit, push ja fetch kohteessa `saipen-live`. Mikä tahansa portti, joka on tiedostoassertio, diff-katselmus tai tekstitarkistus.


**LOCAL_WINDOWS_ONLY** — portit, jotka vaativat tämän koneen.


| Portti | Miksi |
|------|-----|
| `tools\launcher\build.cmd` | kääntää `ZaicodeLauncher.cs` .NET Frameworkilla `csc`; ei Windows SDK:tta pilvikuvassa |
| pakatun Electronin E2E (`zcode` desktop, Solo → jono → lähetys) | vaatii työpöytäistuntoa ja alustettua toimittajaprofiilia |
| live 9router | Windows-palvelu tällä koneella |
| vuorovaikutteinen työpöytäklikkaus | ihminen ja näyttö |
| watcherin omat ajonaikaiset tapaukset | watcher ajetaan vain koneella, jossa checkout sijaitsee |


Nämä kirjataan paikallisiksi hyväksymisrajoiksi. Niitä ei koskaan raportoida
läpäistyneeksi, vaikka diff näytti oikealta.


**SAFE_TO_DEFER** — tuotekerros. Pilvi-istunto voi kloonata
`vacterro/zaicode`-haaran `zaicode` ja työskennellä siellä. Työtilakerroksen työ ei
vaadi tuotetyötä, mutta se vaatii kloonin:
`.saipen/source-nested-repos.json` ilmoittaa `zcode/`, ja ilman sitä
validaatori epäonnistuu `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. `pnpm`-portit vaativat pinnatun pnpm 10.33.2
ja valmistellun työtilan. `pnpm bootstrap` tuoreessa pilvikuvassa on
dokumentoitu sisääntulotapa, ja tuotteen `package.json` ilmoittaa sen jo.

Pilvi voi varmistaa vain tuotteen tavut, jotka ovat kohteessa `origin/zaicode`. Tuotedelta,
joka on vain operaattorin `zcode/`-checkoutissa, on täällä
näkymätön, joten jokainen sen tuoteportti on pilvessä NOT RUN, riippumatta
portista. T-84 on ensimmäinen tapaus (E-1411): sen korjaus oli paikallinen, kun
`origin/zaicode` vielä sisälsi korjausta edeltävän koodin.


**UNSAFE_TO_EMULATE** — mitään, mikä saisi paikallisen portin näyttämään vihreältä.
Älä stubbaa käynnistimen buildiä, älä teeskennele pakatun sovelluksen ajoa,
älä toista tallennettua `pnpm verify:pre-push`-tulosta ikään kuin se olisi juuri ajettu,
älä muunna "koodi näyttää oikealta" PASS-riviksi tiedostossa `.saipen/LOG.md`.


**KNOWN_CLOUD_DIVERGENCE** — vaatimustenmukaisuus, joka riippuu siitä, missä
checkout sijaitsee. Ytimellä `3088eff` pilvivalidaatori raportoi `closure-evidence`
FAILit (T-47, T-62, T-76, T-78 kirjoitushetkellä), joita operaattorikone
ei raportoi.


Ydin siirtää kaikki yli 1024 tavun LOG-tapahtumat
`.saipen/recovery/log-detail/`-sivutiedostoon. Luvussa se palauttaa sivutiedoston vain,
kun checkoutin absoluuttinen polku vastaa polkua, josta se kirjoitettiin. Windowsissa
kirjoitettu pitkä VERIFY-tulos on siis pilvissä lukukelvoton, ja
päinvastoin myös.


Vika on ytimessä ja kirjattu P1-1:llä kohteessa
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Kunnes se merkitään:


- siteera pilven tuomiota ja luokittele se tälle rajalle lipun mukaan
  (`SKILL.md` § 6 sisältää tarkistuksen);
- älä koskaan kirjoita sidecar-tiedostoja uudelleen, älä tee uutta tarkistusta
  vain vihreän tuloksen vuoksi, äläkä paikkaa kernel-kopiota;
- pidä LOG-tapahtumat alle 1024 tavun molemmilla puolilla.

Sama konepolun sitominen estää myös työt. Velkojen perusluku ennen
BUILD-vaihetta tallennetaan ensimmäisen kerran, kun lippu siirtyy
BUILD-tilaan, ja tarkistetaan uudelleen jokaisella myöhemmällä siirtymällä.
Lippu, joka siirtyi ensimmäisen kerran BUILD-tilaan
koneella, ei siis voi siirtyä BUILD-tilaan pilvessä: siirtymä
hylätään (`DEBT_SNAPSHOT_FOREIGN_PROJECT`). T-84 on kirjattu tapaus: DEBT-000079
tallennettiin kohdassa E-1377 ja siirtymä hylättiin kohdassa E-1446.
Jätä tällainen lippu sille koneelle, joka tallensi sen perusluvun.

## Erimiis

Jos paikallinen ja etäinen eivät enää jaa yhteistä esi-isää, watcher
pysähtyy. Se ei yhdistä, uudelleenperusta eikä pakota. Molemmat
commit-tunnukset menevät lokiin, korjaus tehdään `git log --left-right --cherry-pick <branch>...origin/<branch>` käsin ja
tulos tallennetaan kuin mikään muu muutos.

## Tarkka pilvipuolen toimi

### Ympäristön asennuskomento (kerran, pilviympäristön asetuksissa)

Pilviympäristön valikko istunnon otsikkorivillä -> Edit -> Setup script.
Se suoritetaan ennen jokaista uutta istuntoa, joten jokainen istunto
alkaa tuotteen työkaluketjun ollessa valmis:

```bash
#!/usr/bin/env bash
# ZAICODE cloud toolchain: Node 24 + pnpm 10.33.2 (product gates),
# 9router 0.5.91 (real-router tests), mono mcs (launcher compile check).
set -u
NODE=v24.14.0
if ! command -v node >/dev/null || ! node -v | grep -q '^v24\.'; then
  curl -fsSL "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" | tar -xJ -C /opt
  ln -sf /opt/node-$NODE-linux-x64/bin/node /opt/node-$NODE-linux-x64/bin/npm /opt/node-$NODE-linux-x64/bin/npx /usr/local/bin/
fi
npm install -g pnpm@10.33.2 && ln -sf "$(npm prefix -g)/bin/pnpm" /usr/local/bin/pnpm
mkdir -p /opt/9router && cd /opt/9router && npm pack 9router@0.5.91 >/dev/null && tar -xzf 9router-0.5.91.tgz
(apt-get update -qq && apt-get install -y -qq mono-mcs) || echo "no mono-mcs: the launcher compile check is NOT RUN"
exit 0
```

### Aloituskäsky jokaiseen uuteen istuntoon

Aloita istunto repositoriossa `vacterro/zaicode`, haarassa `saipen-live`, ja
varmista, ettei koneen agentti kirjoita samanaikaisesti.
Korvaa viimeinen rivi merkillä `cc all <new list>` luodaksesi uuden työn.

```
Read CLAUDE.md and .claude/skills/saipen/SKILL.md, then cold-recover SAIPEN
state from .saipen/ on branch saipen-live (STATE.md, BOARD.md, tail of LOG.md).
Chat memory is not state; docs/ZAICODE_SAIPEN_CLOUD.md is the transport contract.

Setup (skip what already exists):
- saipen = python3 .claude/saipen-protocol/tools/saipen.py --project-root <repo root>
  (fetch the kernel per SKILL.md if it is missing); run `saipen rebind-home --auto`
  when saipen_home points at another machine.
- Product clone: git clone -b zaicode https://github.com/vacterro/zaicode zcode
  (gitignored here), then `pnpm install` inside zcode (Node 24, pnpm 10.33.2).
- Real-router tests: export ZAICODE_ROUTER_PACKAGE=/opt/9router/package if it exists.

Rules:
- Fetch origin/saipen-live and origin/zaicode before every commit and every push.
  If the other side moved, merge; never rebase, reset or force. If .saipen/
  histories diverged: keep ours on saipen-live-cloud-<sha>, write both ids to
  .saipen/LOG.md, stop and ask me.
- Product gates in zcode: pnpm typecheck, pnpm lint (0 errors),
  pnpm run architecture:check -- --changed, pnpm test. A gate that cannot run
  here is NOT RUN with the reason; a failure blamed on the environment must be
  shown to fail the same without the change.
- I authorize publishing verified product commits to origin/zaicode and SAIPEN
  checkpoints to origin/saipen-live.
- Nothing is PASS until I test on Windows and say PASS. A finished ticket waits
  in VERIFY with .saipen/evidence/T-###-*.md: its commits and the exact manual
  test steps.
- One writer at a time: if LOG shows the local agent mid-work, stop and ask.

cc
```

Koneella watcher tekee pik Hyppyr-forwardin `zcode` kohteesta
`origin/zaicode`; `REBUILD.cmd` (tai `REBUILD_fast.lnk`) kokoaa sen, ja
ZAICODEn seuraava käynnistys vaihtaa uuden koontiversion paikalleen.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
