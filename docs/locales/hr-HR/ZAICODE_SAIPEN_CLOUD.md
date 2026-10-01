# ZAICODE SAIPEN prijenos u oblak

Kako ovaj checkout i Claude Code Cloud sesija pokreću isti SAIPEN workspace
s različitom lokalnošću izvršitelja i gdje je granica između njih.

## Oblik

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Jedna grana nosi stanje protokola. Nema koraka merge, nema koraka rebase
i nema druge lokalne grane koju treba održavati usklađenom: izvršitelj koji
ima verificiran checkpoint commit-a ga i push-a, a druga strana preuzima
ga fast-forward-om.

`master` je povijest prije transporta i objavljena zadana grana.
Transport ga ne mijenja force-om.

## Što putuje i što ne putuje

Checkpoint u ovom repozitoriju nosi stanje SAIPEN protokola, root
launcher, installer, dokumentaciju i ove transport skripte. To je
cijeli sloj workspacea.

Ne nosi **nijedan product byte**. `zcode/` je zaseban Git repozitorij, naveden
u `.saipen/source-nested-repos.json` i gitignoriran u ovom rootu
(`/zcode/`). Product rad treba vlastiti klon `vacterro/zaicode` na grani
`zaicode`, a taj klon je drugi, neovisan objekt s vlastitom poviješću.

Posljedica se lako shvaća pogrešno: čist `git status` u ovom rootu ne govori
ništa o necommitiranom product radu, a `saipen-live` fast-forward ne govori
ništa o product kodu. Provjeri `git -C zcode status` izričito.

## Lokalna polovica

Dvije skripte, obje dio repozitorija, pa novi stroj dobiva ih iz repozitorija
a ne iz sjećanja:

| Datoteka | Uloga |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | validira, usklađuje granu, instalira i pokreće watcher, piše unos za automatsko pokretanje, dokazuje local == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | petlja: fetch, usporedba, fast-forward ili push, zapis, pauza; zatim product pass i self-update |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | round-trip iz neovisnog izvršitelja plus dokaz cold-recovery |
| `tools/saipen-cloud/Test-ProductSync.ps1` | product pass i self-update nad jednokratnim Git repozitorijima (bez mreže, bez pravog remote-a) |

Instalacija i popravak:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Idempotentno je. Stanje lokalno na stroju živi u `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (kopija), `ZAICODE_cloud-sync.log` (rotira se na
2 MB u `.log.1`), `ZAICODE_cloud-sync.lock` (jedna instanca),
`ZAICODE_cloud-sync.pid`, i unos u Startup folderu
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Installer odbija prljivo stablo i nikad ga ne čisti. Ako je svaki prljavi put
kanonsko SAIPEN stanje pod `.saipen/`, kaže to i ispiše točne
naredbe za checkpoint; to je stanje protokola bez checkpointa, a ne
greška prijevoza, i Installer ga neće commitati iza leđa protokola.

## Ponašanje watchera

| Situacija | Premještaj |
|----------|-----------|
| čisto, lokalna je predak udaljene | `git merge --ff-only` |
| čisto, udaljena je predak lokalne | `git push` |
| nečisto | pauziraj; ni samo fetch |
| na drugoj grani | pauziraj |
| obje napredovale, nema zajedničkog pretka | pauziraj, zabilježi oba commit id, ne spajaj ništa |
| fetch ili mreža pali | zabilježi kvar, pokušaj ponovno sljedeći tick |
| merge/rebase/cherry-pick u tijeku | pauziraj |

Nikad: force push, hard reset, stash, clean, checkout strane grane,
commit, ni zaustavljanje po nazivu procesa. Installer zaustavlja watcher
samo prema pid-u zapisanom u vlastitom pid fileu.

Prljivo stablo ne košta ništa, jer watcher provjeri prljavost prije fetch-a.
Zato idle checkout uopće ne radi mrežne pozive.

### Productski prolaz (T-90)

`zcode/` je vlastiti repozitorij, pa tablica gore nikad ne pomiče product
kod. Nakon njega isti tick obrađuje product checkout (`-ProductRepo`,
default `<repo>\zcode`; grana `-ProductBranch`, default `zaicode`). Product
pass se izvršava bez obzira na to je li vanjsko stablo prljivo. Samo pull-uje.

| Situacija | Postupak |
|-----------|------|
| udaljeni naprijed, nijedan dolazni file ovdje nije nečist | `git merge --ff-only`; nedovršeni product rad ostaje kakav jeste |
| udaljeni naprijed, dolazni file ovdje je nečist | HELD: evidentiraj fileove, nemergeaj ništa |
| lokalni naprijed | evidentiraj; **nikad pushano** (product objavljuje SAIPEN SHIP) |
| divergirano | pauziraj, evidentiraj oba id-a, nemergeaj ništa |
| druga grana, git operacija u tijeku, fetch pao | pauziraj |
| nema `zcode/` checkouta, ili `-NoProduct` | preskočeno |

git sam odbija fast-forward koji bi preprepisao lokalnu promjenu,
pa je HELD provjera ranija, jasnija zaštita, ne jedina. Product
fast-forward ne gradi ništa ispočetka: za test pokrenite `pnpm bundle:zaicode` (ili
dev preview).

### Samo-ažuriranje (T-90)

Watcher radi kao kopija pod `%APPDATA%\SAIPEN`, pa noviji watcher u
repozitoriju nikad nije radio bez ponovne instalacije. U loop modu sada
uspoređuje vlastiti file s commitiranom kopijom u repozitoriju pri svakom
prolasku. Tu kopiju instalira preko sebe i restarta točno jednom, s istim
argumentima, i to samo ako vrijede svi ovi uvjeti:

- dvije file se razlikuju;
- kopija u repozitoriju nema nedovršenih izmjena;
- kopija u repozitoriju se parsira bez grešaka.

Kopija koja se ne parsira odbija se i evidentira, a pokrenuti watcher
nastavlja s radom.

Watcheri instalirani prije T-90 nemaju ni product pass ni samo-ažuriranje.
Na takvom stroju jednom pokrenite `Install-SaipenLiveSync.ps1`; nakon toga se watcher
ažurira sam.

## Cloud dio

`CLAUDE.md` u rootu je pravilo ulaza, a
`.claude/skills/saipen/SKILL.md` je postupak izvršavanja. Skill dohvaća
SAIPEN kernel s `github.com/vacterro/saipen` i izvršava ga kroz
deklarirani engine surface `tools/saipen.py`. Kernel je zaključen commitom
(`3088eff`), nikad tagom. Tag `v8.0.1` je stariji kernel s istim
`VERSION`; njegov `validate` mijenja stanje, a njegov validator odbija ovu
ploču.

`STATE.saipen_home` evidentira putanju kernela čiji je executor zadnji zapisao
checkpoint. U cloudu prvi `saipen continue` na kernelu `3088eff` konvergira
ga na pokrenuti kernel kao jedan evidentirani `DEC` (E-1410). Na stroju
operatera pokazivač stiže mrtav na isti način. Kernel s automatskom
konvergencijom popravlja ga na `continue`; inače pokrenite
`saipen rebind-home --auto`.

**Povratni put je zapažen.** E-1562 (oblak) doveo je pokazivač do
`/home/user/zaicode/.claude/saipen-protocol`; E-1571 (operatorska mašina)
doveo ga je izravno natrag na `V:/.../_SAIPEN`, automatski, bez ručnog
`rebind-home`. Oba smjera isti su automatski konvergencija, pa očekujte
jedan `saipen_home` `DEC` po svakoj promjeni lokacije i tretirajte to kao očekivani šum,
a ne kao kvar. Ostaje šum dok P1-2
(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) ne premjesti pokazivač iz verzioniranog
stanja; ne implementirajte P1-2 kao nuspojadu uočavanja. Nikad ne uređujte
pokazivač rukom.

`STATE.saipen_home` može pokazivati na **razvojni checkout** jezgre koji je ispred
pin-a, a ne na čisti `3088eff` klon — na operatorskoj mašini to je
`accepted-debt-rebind` grana s necommitiranim radom. Jezgra koja nije na zakačenom commitu
nije automatski pogrešna, ali nije ni čist izvor,
pa se pravilo ispod o glasovnom ugovoru primjenjuje na nju u punom
opsegu. Nikad nemojte commitati, stash-ati, resetirati, checkoutati ni čistiti
ništa u takvom checkoutu; ciljani restore jedne datoteke za `saipen/STYLE.md` jedina je
dopuštena iznimka, i samo kada to operator zatraži.

### STYLE.md nije lokalna postavka

`saipen/STYLE.md` mora biti **bajt-po-bajt identičan datoteci zakačene jezgre** na
svakoj mašini, u svakoj kopiji, bez iznimaka i bez lokalnih uređivanja. Na
operatorskoj mašini postoji više od jedne kopije:

- checkout jezgre na `STATE.saipen_home` (Git klon; na operatorskoj
  mašini razvojni checkout);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, koji popunjava `saipen-inject` zakazani zadatak (`bootstrap/schedule-run.ps1`). To **nije
  Git repozitorij**, pa ga `git checkout` nikad ne može popraviti — ponovna sinkronizacija
  kroz injector ili izravno zapisivanje objavljenog sadržaja jedini je put.

Token `style_contract` u `.saipen/STATE.md` hash je teksta te datoteke
(`tools/validate.py`, `style_contract_token`: CRLF normaliziran, linija `style_contract:` izuzeta).
Uredite `reply_language` u jednoj kopiji i token se pomakne; druga kopija i oblak,
koji dohvaćaju objavljenu jezgru, zadržavaju objavljeni token,
a svaki CLI zapis na neskladnoj strani odbijen je s `style_contract ... does not match the installed STYLE.md marker`.
To je cijeli kvar: lokalna strana zapisuje stanje koje oblak ne može zapisati.

**Promjena jezika odgovora znači commit jezgre i ponovno zakljanje**, nikad lokalnu
izmjenu. Promijenite ga u repozitoriju jezgre, objavite, ponovno zakačite commit
u SKILL.md i ažurirajte `STATE.style_contract` kroz `saipen recover`. Lokalna
izmjena `STYLE.md` desinkronizira svaku mašinu koja nije ona koja je provodi.

Jedna zamka vrijedna imena: objavljeni `bin/saipen` je shim vezan uz mašinu koji
hardkodira apsolutne putanje interpretera i checkauta jednog operatora. Radi na
točno jednoj mašini. Oblak mora koristiti `python3 tools/saipen.py`.

Prečaci: `cc` nastavlja trenutni Work; `cc all <text>` uzima cijelu
poruku kao izvor/appends i nastavlja svaki prikladni Work. Nijedan ne
traži rutinsku potvrdu.

## Klasifikacija mogućnosti

**AVAILABLE_IN_CLOUD** — stanje protokola i sloj radnog prostora. Čitanje i
zapisivanje `.saipen/`, pokretanja (`tools/launcher/ZaicodeLauncher.cs`), instalatera pod `install/`,
`docs/`, `CLAUDE.md`, `.claude/skills/` i skripti za prijenos. Git read, commit,
push i fetch na `saipen-live`. Svaki
gate koji je provjera datoteke, pregled diff-a ili provjera teksta.

**LOCAL_WINDOWS_ONLY** — gate-ovi koji trebaju ovaj stroj.

| Vrata | Zašto |
|------|-----|
| `tools\launcher\build.cmd` | kompajlira `ZaicodeLauncher.cs` s .NET Frameworkom `csc`; nema Windows SDK-a na cloud imageu |
| pakirani Electron E2E (`zcode` desktop, Solo → queue → dispatch) | zahtijeva desktop sesiju i inicijalizirani provider profil |
| živi 9router | Windows servis na ovom računalu |
| interaktivni desktop klik-po-klik | čovjek i ekran |
| vlastiti runtime testovi watchera | watcher se pokreće samo na računalu koje drži checkout |

Ovi se bilježe kao lokalne granice prihvaćanja. Nikada se
ne prijavljuju kao prošli samo zato što je diff izgledao ispravno.

**SAFE_TO_DEFER** — sloj proizvoda. Cloud sesija može klonirati
`vacterro/zaicode` granu `zaicode` i raditi ondje. Rad na sloju radnog prostora
ne zahtijeva rad na proizvodu, ali zahtijeva klon:
`.saipen/source-nested-repos.json` deklarira `zcode/`, a bez njega
validator pada s `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. Gate-ovi `pnpm` trebaju pinovani
pnpm 10.33.2 i pripremljen radni prostor. `pnpm bootstrap` na novoj cloud slici
je dokumentirani način ulaska, a proizvodni `package.json` ga već deklarira.

Cloud može verificirati samo bajtove proizvoda koji su na `origin/zaicode`.
Promjena proizvoda koja postoji samo u checkoutu operatera `zcode/`
ovdje je nevidljiva, pa je svaki proizvodni gate za nju u oblaku NOT RUN,
bez obzira na gate. T-84 je prvi slučaj (E-1411): njegov je fix bio
lokalni dok je `origin/zaicode` još nosio kod prije fixa.

**UNSAFE_TO_EMULATE** — sve što bi lokalni gate prikazalo kao zeleni.
Ne stubiraj build pokretanja, ne伪造 pakirani app run, ne replay-aj zabilježeni
`pnpm verify:pre-push` rezultat kao da je upravo pokrenut, i ne pretvaraj "kod
izgleda ispravno" u PASS liniju u `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — usklađenost koja ovisi o tome gdje se
checkout nalazi. Na kernelu `3088eff` cloud validator prijavljuje `closure-evidence`
FAIL-ove (T-47, T-62, T-76, T-78 u vrijeme pisanja) koje operaterski
stroj ne prijavljuje.

Kernel svaki LOG događaj veći od 1024 bajta premješta u
`.saipen/recovery/log-detail/` sidecar. Pri čitanju vraća sidecar samo
ako apsolutna putanja checkouta odgovara putanji s koje je pisan. Dugački
VERIFY verdict napisan na Windowsu zato je nečitljiv u oblaku, i obrnuto vrijedi.

Defekt je u kernelu i prijavljen kao P1-1 u
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Dok ne dođe:

- navedi odluku oblaka i klasificiraj je kao ovu granicu, ticket po ticket
  (`SKILL.md` § 6 ima provjeru);
- nikad ne prepisuj sidecar-ove, ne reverificiraj samo da bude zeleno, niti
  krpaj kernel kopiju;
- drži LOG događaje ispod 1024 bajtova s obje strane.

Isto vezivanje putanja stroja blokira rad. Početno stanje duga prije
BUILD-a snima se prvi put kad ticket uđe u BUILD i provjerava se prije svakog
sljedećeg ulaska. Ticket koji je prvi put ušao u BUILD na stroju operatera
zato ne može ući u BUILD u oblaku: prijelaz se odbija s
`DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 je zabilježeni slučaj: DEBT-000079 je
snimljen na E-1377, a prijelaz odbijen na E-1446. Takav ticket ostavi
stroju koji je snimio njegovo početno stanje.

## Odstupanje

Ako lokalna i udaljena kopija prestanu dijeliti pretka, watcher prestaje. Ne
spaja, ne rebasa, ne forsira. Oba commit id-a idu u log, ispravak se
`git log --left-right --cherry-pick <branch>...origin/<branch>` ručno, a
rezultat se checkpointa kao i svaka druga promjena.

## Točna radnja na strani oblaka

### Skripta za postavljanje okruženja (jednom, u postavkama oblaka)

Izbornik oblakovnog okruženja u traci naslova sesije -> Edit -> Setup script. Pokreće
se prije svake nove sesije, pa svaka sesija kreće s gotovim alatom proizvoda:

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

### Prompt za svaku novu sesiju

Započni sesiju na repozitoriju `vacterro/zaicode`, grani `saipen-live`, i
provjeri da agent na stroju operatera u međuvremenu ne piše.
Zamijeni zadnji redak s `cc all <new list>` da predaš novi rad.

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

Na stroju operatera watcher brzo premješta `zcode` s
`origin/zaicode`; `REBUILD.cmd` (ili `REBUILD_fast.lnk`) ga gradi, a
sljedeće pokretanje ZAICODE-a ubacuje novu build-u.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
