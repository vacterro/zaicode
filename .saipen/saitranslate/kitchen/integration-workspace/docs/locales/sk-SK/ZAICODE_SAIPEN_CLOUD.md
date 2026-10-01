# ZAICODE SAIPEN cloudový prenos

Ako tento checkout a relácia Claude Code Cloud spúšťajú jeden workspace SAIPEN
s rôznou lokalitou exekútora a kde je hranica medzi nimi.

## Štruktúra

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Jedna vetva nesie stav protokolu. Žiadny krok merge, žiadny rebase
a žiadna druhá lokálna vetva na synchronizáciu: ten exekútor, ktorý má
overený checkpoint, ho commitne a pushne, druhá strana ho prevezme
fast-forwardom.

`master` je história pred transportom a publikovaná predvolená vetva. Transport ju
neaktualizuje silou.

## Čo putuje a čo nie

Checkpoint v tomto repozitári nesie stav protokolu SAIPEN, root
launcher, installer, dokumentáciu a tieto transport skripty. To je celá vrstva
workspace.

**Nenesie žiadny produktový bajt.** `zcode/` je samostatný Git repozitár,
uvedený v `.saipen/source-nested-repos.json` a gitignorovaný na tomto root
(`/zcode/`). Práca na produkte potrebuje vlastný clone `vacterro/zaicode` na vetve
`zaicode`, pričom ten clone je druhý, nezávislý objekt s vlastnou
históriou.

Tento dôsledok sa ľahko pochopí zle: čistý `git status` na tomto root nehovorí
nič o necommitnutej produktovej práci a fast-forward `saipen-live` nehovorí
nič o produktovom kóde. `git -C zcode status` kontroluj výslovne.

## Lokálna polovica

Dva skripty, obidva vlastnené repozitárom, aby nový stroj dostal skripty z repozitára
a nie z pamäte:

| Súbor | Rola |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | overuje, zosúladí vetvu, nainštaluje a spustí sledovač, zapíše položku autostart, dokazuje, že lokálne == vzdialené |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | slučka: fetch, porovnanie, fast-forward alebo push, log, pauza; potom produktový priechod a samoupdate |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | round-trip z nezávislého executoru plus dôkaz zotavenia po studenom štarte |
| `tools/saipen-cloud/Test-ProductSync.ps1` | produktový priechod a samoupdate voči dočasným Git repozitárom (bez siete, bez skutočného remote) |

Inštalácia a oprava:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Je idempotentný. Stav lokálneho stroja žije v `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (kópia), `ZAICODE_cloud-sync.log` (rotovaný na
2 MB do `.log.1`), `ZAICODE_cloud-sync.lock` (jedna inštancia),
`ZAICODE_cloud-sync.pid` a položka v priečinku Startup
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Inštalátor odmietne znečistený strom a nikdy ho nevyčistí. Ak je každá znečistená cesta kanonickým stavom SAIPEN pod `.saipen/`, oznámi to a vypíše presné príkazy na checkpoint; ide o stav protokolu bez checkpointu, nie o chybu prenosu, a inštalátor ho necommitne za chrbát protokolu.

## Správanie sledovača

| Situácia | Krok |
|-----------|------|
| čisté, lokálne je predchodcom vzdialeného | `git merge --ff-only` |
| čisté, vzdialené je predchodcom lokálneho | `git push` |
| znečistené | pauza; ani fetch nie |
| na inej vetve | pauza |
| obe postúpili, žiadny spoločný predchod | pauza, zapíše obe id commitov, nič nemergeuje |
| fetch alebo sieť zlyhali | zapíše zhoršený stav, skúsi znova v ďalšom ticku |
| prebieha merge/rebase/cherry-pick | pauza |

Nikdy: force push, hard reset, stash, clean, checkout cudzej vetvy,
commit ani zastavenie podľa názvu procesu. Inštalátor zastaví sledovač len podľa
pid, ktorý zapísal do vlastného pid súboru.

Znečistený strom nestojí nič, lebo sledovač overí znečistenie pred fetchom.
Nečinný checkout tak nerobí vôbec žiadne sieťové volania.

### Produktový priechod (T-90)

`zcode/` je sám osebe repozitár, takže tabuľka vyššie nikdy neposunie produktový
kód. Po ňom rovnaký tick spracuje produktový checkout (`-ProductRepo`,
predvolene `<repo>\zcode`; vetva `-ProductBranch`, predvolene `zaicode`). Produktový
priechod beží bez ohľadu na to, či je vonkajší strom znečistený. Vždy len ťahuje.

| Situácia | Krok |
|-----------|------|
| remote napred, žiadny prichádzajúci súbor tu nie je dirty | `git merge --ff-only`; necommitnutá práca na produkte zostáva tak, ako je |
| remote napred, prichádzajúci súbor tu je dirty | HELD: zapísať súbory, nemergovať nič |
| lokálna je napred | zapsať; **nikdy pushnuté** (produkt publikuje SAIPEN SHIP) |
| divergentné | pauza, zapísať obe id, nemergovať nič |
| iná vetva, prebieha git operácia, fetch zlyhal | pauza |
| žiadny `zcode/` checkout, alebo `-NoProduct` | preskočené |

git sám odmietne fast-forward, ktorý by prepísal lokálnu zmenu, takže
kontrola HELD je skoršia a prehľadnejšia poistka, nie jediná. Fast-forward
produktu nič neprebuduje: na test spusti `pnpm bundle:zaicode` (alebo
dev náhľad).

### Samoaktualizácia (T-90)

Watcher beží ako kópia pod `%APPDATA%\SAIPEN`, takže novší watcher v repozitári
nikdy nabehol bez opakovanej inštalácie. V loop režime teraz pri každom
prechode porovnáva svoj súbor s commitnutou kópiou v repozitári. Nainštaluje
tú kópiu cez seba a reštartuje sa presne raz, s rovnakými argumentmi,
iba keď platia všetky z týchto podmienok:

- oba súbory sa líšia;
- kópia v repozitári nemá necommitnuté zmeny;
- kópia v repozitári sa parsuje bez chýb.

Kópia, ktorá sa neparsuje, sa odmietne a zapíše, bežiaci watcher
pokračuje ďalej.

Watchery nainštalované pred T-90 nemajú ani produktový prechod, ani samoaktualizáciu.
Na takomto stroji raz spusti `Install-SaipenLiveSync.ps1`; potom sa watcher aktualizuje sám.

## Cloudová polovica

`CLAUDE.md` v koreni je vstupné pravidlo a
`.claude/skills/saipen/SKILL.md` je vykonávací postup. Skill stiahne
SAIPEN kernel z `github.com/vacterro/saipen` a spustí ho cez
deklarovanú engine plochu `tools/saipen.py`. Kernel je pripnutý commitom
(`3088eff`), nikdy tagom. Tag `v8.0.1` je starší kernel s rovnakým
`VERSION`; jeho `validate` mutuje stav a jeho validátor túto dosku odmieta.

`STATE.saipen_home` zapisuje cestu k kernelu exekútora, ktorý naposledy
checkpointol. V cloude prvý `saipen continue` na kernely `3088eff` ju
zjednotí s bežiacim kernelom ako jeden zdokumentovaný `DEC` (E-1410). Na
stroji operátora dorazí ukazovateľ rovnako mŕtvy. Kernel s automatickou
konvergenciou ju opraví pri `continue`; inak spusti
`saipen rebind-home --auto`.

**Cesta späť je pozorovaná.** E-1562 (cloud) zosúladil ukazovateľ na `/home/user/zaicode/.claude/saipen-protocol`; E-1571 (stroj operátora) ho zosúladil priamo späť na `V:/.../_SAIPEN`, automaticky, bez ručného `rebind-home`. Oba smery sú rovnaké automatické zosúladenie, preto počítajte s jedným `saipen_home` `DEC` na každé prepnutie lokality a považujte ho za očakávaný šum, nie za chybu. Šumom zostáva, kým P1-2 (`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) nevyvedie ukazovateľ z verzionovaného stavu; neimplementujte P1-2 ako vedľajší efekt zistenia. Ukazovateľ nikdy neupravujte ručne.

`STATE.saipen_home` môže ukazovať na **vývojový checkout** kernelu, ktorý je pred pripnutím, nie na čistý klón `3088eff` — na stroji operátora je to vetva `accepted-debt-rebind` s necommitnutou prácou. Kernel, ktorý nie je na pripnutom commite, nie je automaticky nesprávny, ale ani nie je čistým zdrojom, takže pravidlo nižšie o hlasovom kontrakte sa naň vzťahuje v plnej sile. V takomto checkoute nikdy nič necommitujte, neukladajte do stash, neresetujte, necheckoutujte ani nečistite; jedinou povolenou výnimkou je cielená obnova jedného súboru `saipen/STYLE.md`, a to len keď si to operátor vyžiada.

### STYLE.md nie je lokálne nastavenie

`saipen/STYLE.md` musí byť na každom stroji, v každej kórii **bajtovo identický so súborom pripnutého kernelu**, bez výnimiek a bez lokálnych úprav. Na stroji operátora existuje viac ako jedna kópia:

- checkout kernelu v `STATE.saipen_home` (klón Gitu, na stroji operátora vývojový checkout);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, naplnený naplánovanou úlohou `saipen-inject` (`bootstrap/schedule-run.ps1`). **Nie je to Git repozitár**, takže `git checkout` ho nikdy nemôže opraviť — jedinou cestou je opätovná synchronizácia cez injector alebo priamy zápis publikovaného obsahu.

Token `style_contract` v `.saipen/STATE.md` je hash textu súboru (`tools/validate.py`, `style_contract_token`: normalizované CRLF, vylúčený riadok `style_contract:`). Upravíte `reply_language` v jednej kópii a token sa posunie; druhá kópia aj cloud, ktoré načítavajú publikovaný kernel, si ponechajú publikovaný token a každý zápis cez CLI na nesúladnej strane je odmietnutý s `style_contract ... does not match the installed STYLE.md marker`.
To je celá chyba: lokálna strana zapisuje stav, ktorý cloud nedokáže zapísať.

**Zmena jazyka odpovede je commit kernelu plus opätovné pripnutie**, nikdy lokálna úprava. Zmeňte ju v repozitári kernelu, publikujte, znova pripnite commit v SKILL.md a aktualizujte `STATE.style_contract` cez `saipen recover`. Lokálna úprava `STYLE.md` desynchronizuje každý stroj okrem toho, ktorý ju robí.

Jedna pasca, ktorú stojí za pomenovanie: publikovaný `bin/saipen` je shim viazaný na stroj, ktorý natvrdo ukladá absolútne cesty interpreta a checkoutu jedného operátora. Beží na presne jednom stroji. Cloud musí používať `python3 tools/saipen.py`.

Skratky: `cc` pokračuje v aktuálnej práci Work; `cc all <text>` prijíma celú
správu ako zdroj/appends a pokračuje vo všetkých prácach Work, ktoré sú vhodné. Ani jedna
nežiada o bežné potvrdenie.

## Klasifikácia schopností

**AVAILABLE_IN_CLOUD** — stav protokolu a vrstva workspace. Čítanie a zápis `.saipen/`, spúšťač (`tools/launcher/ZaicodeLauncher.cs`), inštalátor v `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` a transportné skripty. Git read, commit, push a fetch na `saipen-live`. Každá brána, ktorá je tvrdenie o súbore, kontrola diffu alebo textová kontrola.

**LOCAL_WINDOWS_ONLY** — brány, ktoré vyžadujú tento stroj.

| Brána | Prečo |
|------|-----|
| `tools\launcher\build.cmd` | kompiluje `ZaicodeLauncher.cs` s .NET Framework `csc`; na cloudovej image nie je Windows SDK |
| zabalený Electron E2E (`zcode` desktop, Solo → queue → dispatch) | potrebuje desktopovú session a nasadený provider profil |
| živý 9router | Windows služba na tomto stroji |
| interaktívny desktopový prechod kliknutiami | človek a obrazovka |
| vlastné runtime testy watchera | watcher beží iba na stroji s checkoutom |

Tieto sú zapísané ako lokálne akceptačné hranice. Nikdy sa neoznačia za prejdené len preto, že diff vyzeral správne.

**SAFE_TO_DEFER** — produktová vrstva. Cloudová session môže naklonovať `vacterro/zaicode` branch `zaicode` a pracovať tam. Práca na vrstve workspace nevyžaduje produktovú prácu, vyžaduje však klon:
`.saipen/source-nested-repos.json` deklaráuje `zcode/` a bez neho
validátor zlyhá s `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. Brány `pnpm` potrebuujú
pinnutý pnpm 10.33.2 a pripravený workspace. `pnpm bootstrap` na čerstvej
cloudovej image je zdokumentovaný vstup a `package.json` produktovej časti ho už
deklaráje.

Cloud môže overiť len produktové byty, ktoré sú na `origin/zaicode`. Produktový
delta, ktorý existuje iba v checkoute operátora `zcode/`, je tu
neviditeľný, takže každá jeho produktová brána je v cloude NOT RUN, bez ohľadu
na bránu. T-84 je prvý prípad (E-1411): jeho oprava bola lokálna, kým
`origin/zaicode` stále obsahoval kód pred opravou.

**UNSAFE_TO_EMULATE** — všetko, čo by lokálnu bránu nechalo vyzerať zelenú.
Nestubuj build spúšťača, nefalzifikuj beh zabalenej aplikácie, neprehrávaj
zaznamenaný výsledok `pnpm verify:pre-push` ako čerstvo prebehnutý ani neprevádzaj
„kód vyzerá správne" na riadok PASS v `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — zhoda závislá od umiestnenia checkoutu.
Na kernel `3088eff` cloudový validátor hlási `closure-evidence`
FAILy (T-47, T-62, T-76, T-78 v čase písania), ktoré stroj
operátora nemá.

Kernel presúva každú LOG udalosť nad 1024 bajtov do
sidecaru `.saipen/recovery/log-detail/`. Pri čítaní obnoví sidecar len
vtedy, keď absolútna cesta checkoutu zodpovedá ceste, z ktorej bol zapísaný. Dlhý
verdikt VERIFY zapísaný na Windows je preto v cloude nečitateľný a
naopak.

Chyba je v kernel a je zapísaná ako P1-1 v
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Kým nie je opravená:

- citovať verdikt cloudu a zaradiť ho ako túto hranicu, ticket po tickete
  (`SKILL.md` § 6 obsahuje kontrolu);
- nikdy neprepisovať sidecars, nepreverovať znova len aby bolo zelené, ani nepatchovať
  kópiu kernelu;
- udržiavať LOG udalosti pod 1024 bajtmi na oboch stranách.

Rovnaké viazanie na stroj blokuje aj prácu. Baseline dlhu pred BUILD sa zachytí pri
prvom vstupe ticketu do BUILD a pri každom neskoršom vstupe sa znova skontroluje.
Ticket, ktorý prvýkrát vstúpil do BUILD na operátorskom stroji, preto nemôže
vstúpiť do BUILD v cloude: prechod sa odmietne s `DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 je prípad
v zázname: DEBT-000079 bol zachytený na E-1377 a prechod odmietnutý na E-1446.
Taký ticket nechajte stroju, ktorý zachytil jeho baseline.

## Divergencia

Ak lokálna a vzdialená vetva už nemajú spoločného predka, watcher sa zastaví.
Nemerge, nerebase, neforce. Obe ID commitov idú do logu, oprava sa `git log --left-right --cherry-pick <branch>...origin/<branch>`
ručne a výsledok sa uloží ako checkpoint ako každá iná zmena.

## Presná akcia na strane cloudu

### Setup skript prostredia (raz, v nastaveni cloud prostredia)

Ponuka cloud prostredia v titulárke session -> Edit -> Setup script. Spúšťa sa
pred každou novou session, takže každá session začne s pripravenou produktovou
toolchain:

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

### Prompt pre každú novú session

Spustite session na repozitári `vacterro/zaicode`, branche `saipen-live` a uistite sa,
že agent operátorskeho stroja zároveň nezapisuje. Nahradte posledný riadok
s `cc all <new list>` pri odovzdaní novej práce.

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

Na operátorskom stroji watcher fast-forward-uje `zcode` z `origin/zaicode`;
`REBUILD.cmd` (alebo `REBUILD_fast.lnk`) ho zostaví a pri nextom štarte ZAICODE sa nový
build nasadí.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
