# ZAICODE SAIPEN pilvetransport

Kuidas see checkout ja Claude Code Cloudi sessioon käitavad sama SAIPEN tööala
erineva täitja asukohaga ning kus nende piir paikneb.

## Kuju

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Üks haru kannab protokolli olekut. Sammhaaval ühitamist, rebase'i ega teist sünkroonitavat kohalikku haru pole: üks täitja salvestab kontrollpunkti, teeb commiti ja push'i; teine pool võtab selle fast-forward'iga vastu.

`master` on eel-transpordi ajalugu ja avaldatud vaikeharu. Transport seda
jõuga ei uuenda.

## Mis liigub ja mis mitte

Selle hoidla kontrollpunkt sisaldab SAIPENi protokolli olekut, juurkäivitajat, paigaldajat, dokumente ja transpordiskripte. See moodustab kogu tööalakihi.

See ei kanna ühtki tootebaiti. `zcode/` on eraldi Git hoidla, mis on
loetletud failis `.saipen/source-nested-repos.json` ja siin gitignoreeritud
(`/zcode/`). Tootetöö vajab oma `vacterro/zaicode` klooni harul
`zaicode`, ning see kloon on teine, sõltumatu objekt oma ajaluguga.

Tagajärg on kergesti valesti tõlgendatav: puhas `git status` selles juures ei ütle
midagi kommitimata tootetöö kohta ning `saipen-live` kiire ülekanne ei ütle
midagi tootekoodi kohta. Kontrolli `git -C zcode status` eraldi.

## Kohalik pool

Kaks skripti, mõlemad repo omad, nii et uus masin saab need hoidlast,
ei mälust:

| Fail | Roll |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | valideerib, kooskõlastab haru, paigaldab ja käivitab watcheri, kirjutab automaatkäivituse kirje, tõestab kohalik == kaug |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | tsükkel: fetch, võrdlus, fast-forward või push, log, paus; seejärel toote-pass ja iseuuendus |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | edasi-tagasi liikumine sõltumatu executoriga ning külma taastumise tõend |
| `tools/saipen-cloud/Test-ProductSync.ps1` | toote-pass ja iseuuendus ajutiste Git hoidlatega (võrku pole, päris kauge pole) |

Paigaldamine ja parandamine:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

See on idempotentne. Masin lokaalne seisund asub `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (koopia), `ZAICODE_cloud-sync.log` (pööratakse
2 MB juures `.log.1` asendile), `ZAICODE_cloud-sync.lock` (üks eksemplar),
`ZAICODE_cloud-sync.pid` ja Startup-kausta kirje
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Paigaldaja keeldub salvestamata muudatustega puust ega puhasta seda. Kui kõik muutunud failid kuuluvad kanonilise SAIPENi oleku alla kaustas `.saipen/`, teatab see põhjusest ja kuvab täpsed kontrollpunkti käsud: tegemist on kontrollpunktina salvestamata protokolli olekuga, mitte transpordiveaga. Paigaldaja ei tee protokolli selja taga commiti.

## Watcheri käitumine

| Olukord | Liigutus |
|-----------|------|
| puhas, kohalik on kauge eellane | `git merge --ff-only` |
| puhas, kauge on kohaliku eellane | `git push` |
| määrdunud | paus; isegi mitte fetch |
| teisel harul | paus |
| mõlemad edasi liikunud, ühist eellast pole | paus, logi mõlemad commit id, ära ühenda midagi |
| fetch või võrk ebaõnnestus | logi degradeerunud, korda järgmises tikus |
| merge/rebase/cherry-pick käib | paus |

Mitte kunagi: force push, hard reset, stash, clean, võõra haru checkout,
commit ega peatamine protsessi nime järgi. Paigaldaja peatab watcheri ainult
enda pid failis kirjutatud pid järgi.

Muutunud failidega jõude töökoopia ei põhjusta võrguliiklust: jälgija kontrollib kohalikke muudatusi enne fetch'i.

### Toote-pass (T-90)

`zcode/` on omaette hoidla, seega ülalolev tabel ei liiguta kunagintootekoodi. Pärast seda käsitleb sama tik toote checkouti (`-ProductRepo`,
vaikimisi `<repo>\zcode`; haru `-ProductBranch`, vaikimisi `zaicode`). Toote-pass
käib olenemata sellest, kas välimine puu on määrdunud. See tõmbab ainult.

| Olukord | Tegevus |
|-----------|------|
| remote ees, ükski tulev fail pole siin muudetud | `git merge --ff-only`; salvestamata tootetöö jääb selliseks nagu on |
| remote ees, tulev fail on siin muudetud | HELD: logi failid, ära ühenda midagi |
| lokaal ees | logi; **ei lükatud kunagi üles** (toote avaldab SAIPEN SHIP) |
| lahknenud | peata, logi mõlemad id-d, ära ühenda midagi |
| teine branch, git-operatsioon pooleli, fetch ebaõnnestus | peata |
| pole `zcode/` väljavõttu, või `-NoProduct` | jäetud vahele |

git keelab iseenesest kiire ületõmbe, mis kustutaks kohaliku muudatuse, nii
et HELD-kontroll on varem ja selgem kaitse, mitte ainus. Toote kiire
ületõmme ei ehitagi midagi ümber: testimiseks käivita `pnpm bundle:zaicode` (või
dev-eelvaatus).

### Iseuuendus (T-90)

Vaatleja töötab koopiana `%APPDATA%\SAIPEN` all, nii et hoidikus olev uuem vaatleja
ei ole kunagi ilma uuesti paigaldamiseta käivitunud. Loop-režiimis võrdleb
ta nüüd iga käigu oma faili hoidiku committitud koopiaga. See paigaldab
koopia enda peale ja taaskäivitub täpselt üks kord, samade argumentidega,
ainult kui kõik järgmised tingimused on täidetud:

- kaks faili erinevad;
- hoidlas oleval koopial pole salvestamata muudatusi;
- hoidlas olev koopia läbib süntaksikontrolli.

Vigase süntaksiga koopia lükatakse tagasi ja logitakse; töötav jälgija jätkab tööd.

Enne T-90 paigaldatud vaatlejatel puuduvad nii toote kontroll kui ka
iseuuendus. Käivita sellisel masinal üks kord `Install-SaipenLiveSync.ps1`; pärast seda
uuendab vaatleja ise end.

## Pilve pool

`CLAUDE.md` juures on sisenemisreegel ja
`.claude/skills/saipen/SKILL.md` on täitmisprotseduur. Skill toob
SAIPEN tuuma `github.com/vacterro/saipen`-st ja käitab selle läbi
deklareeritud mootoripinna `tools/saipen.py`. Tuum on kinnitatud committi
(`3088eff`), mitte kunagi tagi järgi. Tag `v8.0.1` on vanem tuum
sama `VERSION`-ga; selle `validate` muudab olekut ja selle
validaja lükkab selle boardi tagasi.

`STATE.saipen_home` salvestab viimase kontrollpunkti kirjutanud täitja tuuma tee. Pilves viib esimene `saipen continue` tuumal `3088eff` selle ühe logitud `DEC` toiminguna töötava tuuma juurde (E-1410). Operaatori masinas jõuab sama osutaja tagasi kehtetu teena. Automaatset ühtlustamist toetav tuum parandab selle `continue` käigus; muidu käivita `saipen rebind-home --auto`.

**Tagasitee on vaadeldud.** E-1562 (pilv) ühtlustas osutaja asukohaga `/home/user/zaicode/.claude/saipen-protocol`; E-1571 (operaatori masin) ühtlustas selle automaatselt tagasi asukohaga `V:/.../_SAIPEN`, ilma `rebind-home` käsitsi muutmata. Mõlemad suunad kasutavad sama automaatset ühtlustamist: oota iga masinavahetuse kohta üht kohalikku `saipen_home` `DEC` sündmust ja käsitle seda ootuspärase logimürana, mitte veana. See jääb müraks, kuni P1-2 (`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) viib osutaja versioonitud olekust välja. Ära lahenda P1-2 kõrvalülesandena ega muuda osutajat käsitsi.

`STATE.saipen_home` võib osutada tuuma **arendustöökoopiale**, mis on pinist
eespool, mitte puhtale `3088eff` kloonile — operaatori masinal on see
`accepted-debt-rebind` haru poolcommiteeritud tööga. Tuum, mis pole pinitud
commitil, ei ole automaatselt vale, aga pole ka puhas tootmiseallikas,
seega kehtib allpool toodud reegel häälekoostise kohta sellele täies ulatuses.
Ära selles arendustöökoopias kunagi commiti, stashi, reseti, checkouti
ega puhasta midagi; ainus lubatud erand on `saipen/STYLE.md` sihtlik
ühe faili taastamine ja ainult siis, kui operaator seda soovis.

### STYLE.md ei ole kohalik seadistus

`saipen/STYLE.md` peab olema **baitide kaupa identne pinitud tuuma failiga**
igal masinal, igas koopias, ilma eranditeta ja ilma kohalike redaktsioonideta.
Operaatori masinal on seda koopiat rohkem kui üks:

- tuuma töökoopia asendis `STATE.saipen_home` (Git-kloon, operaatori
  masinal arendustöökoopia);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, mida täidab
  `saipen-inject` ajastatud ülesanne (`bootstrap/schedule-run.ps1`). See **ei ole
  Giti hoidla**, seega `git checkout` ei saa seda kunagi parandada — ainus tee
  on uuendussünk injektori kaudu või avaldatud sisu otsene kirjutamine.

`style_contract` token failis `.saipen/STATE.md` on selle faili teksti
(`tools/validate.py`, `style_contract_token`: CRLF normaliseeritud, `style_contract:`
rida välja jäetud). Redigeeri `reply_language` ühes koopias ja
token nihkub; teine koopia ja pilv, mis võtavad avaldatud tuuma,
jätavad alles avaldatud tokeni ning iga CLI kirjutamine poolel, mis ei sobi, on
tagasi lükatud `style_contract ... does not match the installed STYLE.md marker`.
See on kogu viga: kohalik pool kirjutab olekut, mida pilv ei saa kirjutada.

**Vastuse keele muutmine nõuab tuuma commiti ja uue revisjoni kinnitamist**, mitte kohalikku redaktsiooni. Muuda tuuma hoidlat, avalda, kinnita uus commit SKILL.md-s ning uuenda `STATE.style_contract` toiminguga `saipen recover`. Kohalik muudatus failis `STYLE.md` viib kõik ülejäänud masinad sünkroonist välja.

Üks lõks, mida tasub nimetada: avaldatud `bin/saipen` on masinaga seotud shim,
mis kõvakodeerib ühe operaatori absoluutsed tõlgendaja ja töökoopia teed.
See töötab täpselt ühel masinal. Pilv peab kasutama `python3 tools/saipen.py`.

Otseteed: `cc` jätkab praegust tööd; `cc all <text>` võtab kogu sõnumi allikaks/appends ja jätkab kõiki sobivaid töid. Kumbki ei küsi rutiinset kinnitust.

## Võimekuse klassifitseerimine

**AVAILABLE_IN_CLOUD** — protokoli olek ja tööruumi kiht. `.saipen/` lugemine ja kirjutamine, käivitaja (`tools/launcher/ZaicodeLauncher.cs`), paigaldaja `install/` all, `docs/`, `CLAUDE.md`, `.claude/skills/` ja transpordiskriptid. `saipen-live` lugemine, commit, push ja fetch. Iga värav, mis on faili kontroll, diffi ülevaatus või tekstikontroll.

**LOCAL_WINDOWS_ONLY** — väravad, mis vajavad seda masinat.

| Kontroll | Põhjus |
|------|-----|
| `tools\launcher\build.cmd` | kompileerib `ZaicodeLauncher.cs` .NET Frameworki `csc` abil; pilvekeskkonnas pole Windows SDK-d |
| pakendatud Electroni E2E (`zcode` töölaud, Solo → järjekord → käivitamine) | vajab töölauaseanssi ja varem seadistatud teenusepakkuja profiili |
| töötav 9router | Windowsi teenus selles masinas |
| töölaualiidese interaktiivne läbiklikutamine | inimene ja ekraan |
| jälgija enda käivitusraja testid | jälgija töötab ainult masinas, kus asub töökoopia |

Need on kirjas kohalikuks piirajaks. Neid ei märgita läbinuks ainult selle põhjal, et diff näitas õiget.

**SAFE_TO_DEFER** — produktikiht. Pilvesessioon saab kloonida
`vacterro/zaicode` haru `zaicode` ja töötada seal. Tööruumikihi töö
ei nõua produktitööd, kuid nõuab klooni:
`.saipen/source-nested-repos.json` deklareerib `zcode/` ning ilma selleta
ebaõnnestub validaator veaga `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. `pnpm` väravad vajavad lukustatud pnpm 10.33.2
ja ettevalmistatud tööruumi. `pnpm bootstrap` värskel pilvepildil on
dokumenteeritud sissepääs ning produkti `package.json` deklareerib selle juba.

Pilv saab kontrollida ainult toote revisjone, mis on `origin/zaicode`. Tootemuutus, mis on ainult operaatori `zcode/` checkoutis,
on siin nähtamatu, nii et iga selle tootevärav on pilves NOT RUN, sõltumata väravast. T-84 on esimene juhtum (E-1411): selle parandus oli kohalik,
kui `origin/zaicode` kannatas veel paranduseelset koodi.

**UNSAFE_TO_EMULATE** — toimingud, mis näitaksid kohalikku kontrolli ekslikult läbituna. Ära asenda käivitaja kompileerimist stubiga, jäljenda pakendatud rakenduse käivitust, esita salvestatud `pnpm verify:pre-push` tulemust uue jooksuna ega muuda väidet „kood tundub õige” PASS-reaks `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — vastavus, mis sõltub sellest, kus checkout asub.
Tuumal `3088eff` teatab pilvevalidaator `closure-evidence`
FAIL-e (T-47, T-62, T-76, T-78 kirjutamise hetkel), mida operaatori
masin ei näita.

Tuum viib iga üle 1024 baidi pikkuse LOGi sündmuse `.saipen/recovery/log-detail/` kõrvalfaili. Lugemisel taastatakse see ainult siis, kui töökoopia absoluutne tee on sama mis kirjutamise ajal. Seetõttu pole Windowsis kirjutatud pikk VERIFY otsus pilves loetav ega vastupidi.

Viga on tuumas ja on `docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md` failitud P1-1-na. Kuni see ei jõua sisse:

- tsiteeri pilve otsust ja liigita see piletikaupa selle keskkonnapiirangu alla (`SKILL.md` § 6 sisaldab kontrolli);
- ära kirjuta kõrvalfaile ümber, korda kontrolli üksnes rohelise tulemuse saamiseks ega paranda tuuma kohalikku koopiat;
- hoia LOGi sündmused mõlemal poolel alla 1024 baidi.

Sama masinateega sidumine blokeerib ka tööd. BUILD-i eelne võlgade lähteseis salvestatakse pileti esimesel BUILD-i sisenemisel ja kontrollitakse igal järgmisel sisenemisel. Operaatori masinas esimest korda BUILD-i jõudnud pilet ei saa seetõttu pilves BUILD-i siseneda: üleminek lükatakse tagasi veaga `DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 on dokumenteeritud juhtum: DEBT-000079 salvestati E-1377 juures ning üleminek lükati tagasi E-1446 juures. Jäta selline pilet masinale, mis salvestas selle lähteseisu.

## Lahknevus

Kui kohalik ja kauge ei jaga enam ühist eellast, peatub jälgimine. See ei ühenda, ei rebaseeri ega sunni. Mõlemad commiti id-id lähevad logi, parandus tehakse `git log --left-right --cherry-pick <branch>...origin/<branch>` käsitsi ja
tulemus talletatakse kontrollpunktina nagu iga muu muudatus.

## Täpne pilvepoolne toiming

### Keskkonna seadistusskript (üks kord pilvekeskkonna seadetes)

Pilvekeskkonna menüü sessiooni pealkirjaribal -> Edit -> Setup script. See
käib enne iga uut sessiooni, nii et iga sessioon algab toote
tööriistaga valmis:

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

### Iga uue sessiooni alguskäsk

Alusta sessioon hoidlas `vacterro/zaicode`, harul `saipen-live`, ja
veendu, et operaatori masina agent samal ajal ei kirjuta.
Asenda viimane rida `cc all <new list>`-ga, et uus töö üle anda.

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

Operaatori masinas jälgimine teeb kiire edasiviigu `zcode` alates
`origin/zaicode`; `REBUILD.cmd` (või `REBUILD_fast.lnk`) ehitab selle ning
ZAICODE järgmine käivitus vahetab uue ehituse sisse.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
