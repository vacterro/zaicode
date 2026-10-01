# ZAICODE SAIPEN felhős átvitel

Hogyan futtatja ez a checkout és egy Claude Code Cloud munkamenet ugyanazt a SAIPEN munkaterületet különböző végrehajtási helyiséggel, és hol húzódik a köztük lévő határ.

## A forma

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Egyetlen ág hordozza a protokollállapotot. Nincs merge lépés, nincs rebase lépés
és nincs második helyi ág, amit szinkronban kellene tartani: bármelyik végrehajtó,
amelyiknél van ellenőrzött checkpoint, commitolja és pusholja azt, a másik
oldal pedig fast-forwardelt veszi át.

`master` a tranzszport előtti előzmény és a kiadott alapértelmezett ág. A tranzszport
nem frissíti erőszakkal.

## Mi utazik és mi nem

A checkpoint ebben a repóban a SAIPEN protokollállapotot, a root launchert, a
telepítőt, a dokumentációt és ezeket a tranzszport szkripteket tartalmazza. Ez a
teljes munkaterületi réteg.

**Egyetlen termékbyteot sem** tartalmaz. `zcode/` különálló Git repository,
a `.saipen/source-nested-repos.json` listában szerepel, és ezen a gyökéren gitignore-olt
(`/zcode/`). A termékmunkához saját `vacterro/zaicode` klón kell a `zaicode` ágon,
és az a klón második, független objektum, saját előzménnyel.

A következményt könnyű rosszul értendő: a tiszta `git status` ezen a gyökéren semmit
nem mond a nem commitolt termékmunkáról, a `saipen-live` fast-forward pedig semmit a
termékkódról. Ellenőrizd `git -C zcode status`-t kifejezetten.

## Helyi fél

Két szkript, mindkettő a repó tulajdona, hogy egy új gép a repóból szerezze meg őket,
nem emlékezetből:

| Fájl | Szerep |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | validál, egyezteti az ágat, telepíti és elindítja a watchert, megírja az automatikus indítási bejegyzést, bizonyítja: helyi == távoli |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | a ciklus: fetch, összehasonlítás, fast-forward vagy push, napló, szünet; majd a termékátvezetés és az önfrissítés |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | oda-vissza teszt független végrehajtóval, plusz hidegindítási helyreállítási bizonyíték |
| `tools/saipen-cloud/Test-ProductSync.ps1` | termékátvezetés és önfrissítés eldobható Git repókkal (nincs hálózat, nincs valódi távoli repo) |


Telepítés és javítás:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Idempotens. A gépszintű állapot itt él: `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (másolat), `ZAICODE_cloud-sync.log` (forog
2 MB-nál `.log.1` helyett), `ZAICODE_cloud-sync.lock` (egy példány),
`ZAICODE_cloud-sync.pid`, és egy Startup-mappás bejegyzés
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

A telepítő elutasítja a szennyezett fát, és soha nem tisztítja. Ha minden szennyezett út
kanonikus SAIPEN állapot `.saipen/` alatt, ezt kimondja, és kiírja a pontos
checkpoint parancsokat; ez nem checkpointolt protokollállapot, nem szállítási hiba,
és a telepítő nem commitolja a protokoll háta mögött.

## Watcher működése

| Helyzet | Lépés |
|-----------|------|
| tiszta, a local őse a remote-nak | `git merge --ff-only` |
| tiszta, a remote őse a local-nak | `git push` |
| szennyezett | szünet; még fetch sincs |
| más branchen | szünet |
| mindkettő előrement, nincs közös ős | szünet, mindkét commit id naplózása, semmi merge |
| fetch vagy hálózat hibázott | napló: degraded, újra a következő tickben |
| merge/rebase/cherry-pick folyamatban | szünet |

Soha: force push, hard reset, stash, clean, idegen branch checkout,
commit, vagy leállítás processznév alapján. A telepítő a watchert csak a
saját pid fájljában rögzített pid állítja le.

A szennyezett fa nem kerül semmibe, mert a watcher fetch előtt nézi a tisztaságot.
Egy üresjárati checkout így egyáltalán nem hív hálózatot.

### Termékpasszus (T-90)

`zcode/` önálló repó, tehát a fenti táblázat soha nem mozgat termékkódot.
Utána ugyanaz a tick kezeli a termék checkoutot (`-ProductRepo`,
alapértelmezett `<repo>\zcode`; branch `-ProductBranch`, alapértelmezett `zaicode`). A
termékpasszus fut akkor is, ha a külső fa szennyezett. Kizárólag pullt végez.

| Helyzet | Lépés |
|-----------|------|
| távoli előrébb, egy bejövő fájl itt nem módosított | `git merge --ff-only`; a nem commitolt termékmunka változatlan marad |
| távoli előrébb, egy bejövő fájl itt módosított | HELD: fájlok naplózva, semmi nem merge-elt |
| lokális előrébb | napló; **soha nem pusholva** (a terméket a SAIPEN SHIP publikálja) |
| szétvált | szünet, mindkét id naplózva, semmi nem merge-elt |
| másik branch, folyamatban lévő git művelet, fetch hiba | szünet |
| nincs `zcode/` checkout, vagy `-NoProduct` | kihagyva |

A git önként megtagadja azt a fast-forwardot, ami egy lokális módosítást felülírna,
így a HELD ellenőrzés korábbi, világosabb őr, nem az egyetlen. A termék
fast-forward nem épít újra semmit: teszteléshez futtasd a `pnpm bundle:zaicode`-at (vagy
a dev előnézetet).

### Önmaga-frissítés (T-90)

A watcher másolatként fut a `%APPDATA%\SAIPEN` alatt, így a repóban lévő újabb watcher
soha nem futott újratelepítés nélkül. Hurok módban mostantól minden menetben
összeveti a saját fájlát a repó commitolt másolatával. Pontosan egyszer
telepíti azt maga fölé, és ugyanazokkal az argumentumokkal újraindul,
de csak akkor, ha mindhárom feltétel teljesül:

- a két fájl különbözik;
- a repó másolata nem tartalmaz nem commitolt szerkesztést;
- a repó másolata hibamentesen parse-ol.

A nem parse-oló másolatot elutasítja és naplózza, a futó watcher pedig folytatja.

A T-90 előtt telepített watcherekben sem a termékmenet, sem az önmaga-frissítés
hiányzik. Futtasd egyszer a `Install-SaipenLiveSync.ps1`-at egy ilyen gépen; utána a
watcher magát frissíti.

## Felhő fele

`CLAUDE.md` a gyökérben a belépési szabály, a
`.claude/skills/saipen/SKILL.md` pedig a végrehajtási eljárás. A skill a SAIPEN kernelt
a `github.com/vacterro/saipen`-ról tölti le, és a megadott engine felületen `tools/saipen.py`-on
keresztül futtatja. A kernel commit-pinned
(`3088eff`), sosem tag alapján. A `v8.0.1` tag egy régebbb kernel ugyanazzal
a `VERSION`-val; a `validate`-ja állapotot módosít, és a validátora
elutasítja ezt a boardot.

`STATE.saipen_home` azt a kernel útvonalat rögzíti, amelyik checkpointolt utoljára.
A felhőben az első `saipen continue` a `3088eff` kernelen egy naplózott `DEC`-ként
egyezteti a futó kernelre (E-1410). Az operátor gépen a mutató ugyanígy hol érkezik.
Az automatikus egyeztetéssel rendelkező kernel `continue` közben javítja;
különben futtasd a `saipen rebind-home --auto`-öt.

**A visszirány is megfigyelhető.** Az E-1562 (cloud) a mutatót `/home/user/zaicode/.claude/saipen-protocol` értékére állította; az E-1571 (operátor gép)
automatikusan, minden kézi `rebind-home` nélkül visszaállította `V:/.../_SAIPEN` értékére. Mindkét irány ugyanaz az
automatikus konvergencia, tehát telephelyváltásonként egy `saipen_home` `DEC` várható — ez zaj, nem hiba.
Addig marad zaj, amíg a P1-2 (`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) ki nem mozgatja a mutatót a verziózott állapotból; ne a jelzés
mellékhatásaként implementáld a P1-2-t. A mutatót soha ne szerkeszd kézzel.

`STATE.saipen_home` egy kernel **fejlesztői checkoutra** is mutathat, amely a rögzített pinnél előrébb jár, nem tiszta `3088eff` klónra — az operátor gépén ez a `accepted-debt-rebind` ág a nemcommitolt munkával. Az a kernel, amely nem a rögzített commiton van, nem automatikusan hibás, de sem tiszta forrás, ezért a hang szerződéséről szóló szabály rá teljes erővel érvényes. Semmit ne commitolj, ne stash-elj, ne reset-elj, ne checkoutolj és ne tisztíts ilyen checkoutban; az egyetlen megengedett kivétel a `saipen/STYLE.md` célzott, egyfájlos visszaállítása, és csak akkor, ha az operátor kérte.

### A STYLE.md nem helyi beállítás

`saipen/STYLE.md` minden gépen, minden példányban, kivétel nélkül és helyi szerkesztés nélkül **bitre azonos** kell legyen a rögzített kernel fájljával. Egy operátor gépen több példány is van:

- a kernel checkout a `STATE.saipen_home` helyen (Git klón, az operátor gépén fejlesztői checkout);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, amelyet a `saipen-inject` ütemezett feladat (`bootstrap/schedule-run.ps1`) tölt fel. **Nem Git adattár**, ezért `git checkout` soha nem tudja javítani — csak az injektoron át végzett újraszinkron vagy a publikált tartalom közvetlen kiírása jöhet szóba.

A `style_contract` token a `.saipen/STATE.md` fájlban ennek a szövegnek a hash-e (`tools/validate.py`, `style_contract_token`: CRLF normalizálva, a `style_contract:` sor kizárva). Ha egy példányban szerkeszted `reply_language`-öt, a token elmozdul; a másik példány és a cloud, amelyk a publikált kernelt kéri le, megtartja a publikált tokent, és minden CLI írás az eltérő oldalon `style_contract ... does not match the installed STYLE.md marker` hibával utasításra.
Ez a teljes hiba: a helyi oldal olyan állapotot ír, amelyet a cloud nem tud.

**A válasznyelv megváltoztatása kernel commit plusz újrarögzítés**, soha helyi szerkesztés. Változtasd meg a kernel repóban, publikáld, rögzítsd újra a commitot a SKILL.md-ben, majd frissítsd `STATE.style_contract`-öt `saipen recover`-n keresztül. A `STYLE.md` helyi szerkesztése deszinkronizál minden gépet, amely nem az, amelyik éppen szerkeszt.

Egy érdemes megnevezni csapda: a publikált `bin/saipen` géphez kötött shim, amely egy operátor abszolút interpreter- és checkout-útvonalait égeti be. Pontosan egy gépen fut. A cloudnak `python3 tools/saipen.py`-et kell használnia.

Gyorsparancsok: `cc` folytatja az aktuális Work-et; `cc all <text>` a teljes üzenetet forrásként/appends ingestálja, és minden jogosult Work-et folytat. Egyik sem kér megszokott megerősítést.

## Képesség szerinti besorolás

**AVAILABLE_IN_CLOUD** — protokollállapot és munkaterület-réteg. `.saipen/` olvasása és írása, az indító (`tools/launcher/ZaicodeLauncher.cs`), a `install/` alatti telepítő, `docs/`, `CLAUDE.md`, `.claude/skills/`, valamint a szállítási szkriptek. Git olvasás, commit, push és fetch a `saipen-live` repón. Minden kapu, amely fájlellenőrzés, diff-átnézés vagy szöveges ellenőrzés.


**LOCAL_WINDOWS_ONLY** — azok a kapuk, amelyekhez ez a gép kell.


| Kapu | Miért |
|------|-----|
| `tools\launcher\build.cmd` | a .NET Framework `csc` fordításával fordítja a `ZaicodeLauncher.cs`-et; nincs Windows SDK a felhőképen |
| csomagolt Electron E2E (`zcode` desktop, Solo → queue → dispatch) | desktop munkamenetet és előkészített szolgáltatói profilt igényel |
| az élő 9router | Windows szolgáltatás ezen a gépen |
| interaktív desktop kattintásos áttesztelés | egy ember és egy képernyő kell hozzá |
| a figyelő saját futásidejű esetei | a figyelő csak azon a gépen fut, amelyen a checkout van |


Ezek helyi elfogadási határként rögzített állapotok. Soha nem számítanak átvittnek, mert a diff jól néz ki.


**SAFE_TO_DEFER** — a termékréteg. A felhőmunkamenet klónozhatja a `vacterro/zaicode` `zaicode` ágat és dolgozhat rajta. A munkaterület-réteg munkája nem igényel termékmunkát, de igényli a klónt:
`.saipen/source-nested-repos.json` deklarálja a `zcode/` értéket, és enélkül a
validátor a következő hibával fut le: `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. A `pnpm` kapukhoz a rögzített pnpm 10.33.2
és egy előkészített munkaterület szükséges. A `pnpm bootstrap` egy friss felhőképen a
dokumentált belépési mód, és a termék `package.json` már deklarálja.

A felhő csak azokat a termékbájtokat tudja ellenőrizni, amelyek a `origin/zaicode`-on vannak. Az
termékdelta, amely csak az operátor `zcode/` checkoutjában létezik, itt
láthatatlan, ezért minden termékkapuja NOT RUN a felhőben, bármi is a kapu.
A T-84 az első eset (E-1411): a javítása helyi volt, miközben a
`origin/zaicode` még a javítás előtti kódot hordozta.


**UNSAFE_TO_EMULATE** — bármi, ami egy csak helyben futó kaput zöldnek láttatna.
Ne stubbold a launcher buildet, ne imitáld a csomagolt alkalmazás futását, ne játssz le egy rögzített
`pnpm verify:pre-push` eredményt úgy, mintha most futott volna, és ne alakítsd a "a kód
úgy tűnik helyes"-t PASS sorrá itt: `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — az a megfelelőség, amely attól függ, hol van a checkout.
A `3088eff` kernelen a felhővalidátor `closure-evidence`
FAIL eredményeket jelent (az írás pillanatában T-47, T-62, T-76, T-78), amelyeket az
operátorgép nem.


A kernel minden 1024 bájtnál nagyobb LOG eseményt `.saipen/recovery/log-detail/` sidecarba
mozgat. Olvasáskor a sidecart csak akkor állítja vissza, ha a checkout abszolút
útvonala megegyezik azzal az útvonallal, ahonnan írták. Ezért egy Windowson
megírt hosszú VERIFY ítélet a felhőben olvashatatlan, és fordítva is.


A hiba a kernelben van, és P1-1-ként van bejegyezve a
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`-ban. Amíg ez nem kerül bele:


- idézd fel az.cloud ítéletet, és ticketenként minősítsd e határra,
  (`SKILL.md` § 6 tartalmazza az ellenőrzést);
- soha ne írd át a sidecar fájlokat, ne csak azért újra-ellenőrizd, hogy zöld legyen, és ne
  foltozd be a kernel
  másolatát;
- a LOG események maradjanak 1024 bájt alatt mindkét oldalon.

Ugyanez a gépút-kötés a munkát is blokkolja. A BUILD előtti adósság-alap
akkor rögzül, amikor egy ticket először belép a BUILD-be, és minden későbbi
belépéskor újra-ellenőrzik. Az a ticket tehát, amely először az operátor gépén lépett
be BUILD-be, nem léphet be BUILD-be a felhőben: az átmenetet
`DEBT_SNAPSHOT_FOREIGN_PROJECT` elutasítja. A T-84 a nyilvántartott eset: a DEBT-000079
E-1377-nél rögzült, az átmenetet E-1446-nél utasították el. Az ilyen ticketet
hagyd azon a gépen, amely rögzítette az alapját.

## Elágazás

Ha a helyi és a távoli ág nem osztozik ősben, a watcher leáll. Nem
merge-el, nem rebase-el és nem kényszerít. Mindkét commit id bekerül a naplóba, a javítást
`git log --left-right --cherry-pick <branch>...origin/<branch>` kézzel kell elvégezni,
az eredményt pedig mint bármely más változtatást checkpointoljuk.

## A pontos felhőoldali művelet

### Környezetbeállító script (egyszer, a felhő környezet beállításaiban)

A felhő környezet menü a munkamenet címsorában -> Szerkesztés -> Beállító script. Ez
minden új munkamenet előtt fut, így minden munkamenet a termék
toolchainnel indul készen:

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

### A prompt minden új munkamenethez

Indítsd a munkamenetet a `vacterro/zaicode` repón, `saipen-live` ágon,
és győződj meg róla, hogy az operátor gépének agente nem ír ugyanakkor.
Az utolsó sort cseréld `cc all <new list>`-ra az átadáshoz.

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

Az operátor gépén a watcher gyorsan előretölti a(z) `zcode`-t `origin/zaicode`-ből;
a `REBUILD.cmd` (vagy `REBUILD_fast.lnk`) buildeli, és
a ZAICODE következő indítására becsúszik az új build.
<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
