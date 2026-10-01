# ZAICODE SAIPEN cloudový transport

Jak toto checkout a relace Claude Code Cloud spouštějí jeden workspace SAIPEN
s různou lokalitou exekutorů a kde leží hranice mezi nimi.

## Tvar

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Jedna větev nese stav protokolu. Žádný krok merge, žádný krok rebase
a žádná druhá lokální větev, kterou by bylo třeba držet v synchronizaci: exekutor,
který má ověřený checkpoint, ten commitne a pushne a druhá strana si ho
vybere fast-forwardem.

`master` je historie před přenosem a publikovaná výchozí větev. Přenos ji
nepřepisuje silou.

## Co se přenáší a co ne

Checkpoint v tomto repozitáři nese stav protokolu SAIPEN, kořenový
launcher, instalátor, dokumentaci a tyto přenosové skripty. To je celá
vrstva workspace.

**Nenesou žádný bajt produktu.** `zcode/` je samostatný repozitář Git,
uvedený v `.saipen/source-nested-repos.json` a ignorovaný gitem v tomto kořenu
(`/zcode/`). Práce na produktu potřebuje vlastní klon `vacterro/zaicode` na větvi
`zaicode` a ten klon je druhý, nezávislý objekt s vlastní historií.

Následující je snadné zaměnit: čistý `git status` v tomto kořenu neříká
nic o necommitnuté práci na produktu a fast-forward `saipen-live` neříká nic o kódu
produktu. `git -C zcode status` ověřte explicitně.

## Lokální polovina

Dva skripty, oba vlastněné repozitářem, aby je nový stroj získal z repozitáře
a ne z paměti:

| Soubor | Role |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | validuje, sjednotí větev, nainstaluje a spustí watcher, zapíše autostart, prokáže local == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | smyčka: fetch, porovnat, fast-forward nebo push, log, pauza; pak průchod produktovým kódem a self-update |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | round-trip z nezávislého executoru plus důkaz obnovy po restartu |
| `tools/saipen-cloud/Test-ProductSync.ps1` | průchod produktovým kódem a self-update nad jednorázovými Git repozitáři (bez sítě, bez skutečného remote) |

Instalace a oprava:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Je idempotentní. Stav na tomto stroji žije v `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (kopie), `ZAICODE_cloud-sync.log` (rotováno na
2 MB do `.log.1`), `ZAICODE_cloud-sync.lock` (jediná instance),
`ZAICODE_cloud-sync.pid` a položka ve složce Startup
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Instalátor odmítne znečištěný strom a nikdy ho nečistí. Pokud je každá znečištěná cesta
kanonický stav SAIPEN v `.saipen/`, oznámí to a vypíše přesné
příkazy pro checkpoint; jde o stav protokolu bez checkpointu, ne o poruchu transportu,
a instalátor ho necommitne za zádům protokolu.

## Chování watcheru

| Situace | Krok |
|-----------|------|
| čisté, local je předek remote | `git merge --ff-only` |
| čisté, remote je předek local | `git push` |
| znečištěné | pauza; ani fetch |
| jiná větev | pauza |
| oba se posunuly, žádný společný předek | pauza, zapsat oba commit id, nemergovat nic |
| fetch nebo síť selhala | zapsat degraded, zkusit v dalším ticku |
| probíhá merge/rebase/cherry-pick | pauza |

Nikdy: force push, hard reset, stash, clean, checkout cizí větve, commit
ani zastavení podle jména procesu. Instalátor zastaví watcher pouze podle
pid, který si zapsal do vlastního pid souboru.

Znečištěný strom nic nestojí, protože watcher kontroluje znečištění před fetchem.
Nečinný checkout tedy nevolá síť vůbec.

### Průchod produktovým kódem (T-90)

`zcode/` je vlastní repozitář, takže tabulka výše nikdy nepohybuje produktovým
kódem. Po něm tentýž tick zpracuje checkout produktu (`-ProductRepo`,
výchozí `<repo>\zcode`; větev `-ProductBranch`, výchozí `zaicode`).
Průchod produktovým kódem běží, ať je vnější strom čistý, nebo znečištěný. Vždy jen pull.

| Situace | Akce |
|-----------|------|
| remote je napřed, žádný přicházející soubor zde není změněný | `git merge --ff-only`; necommitnutá práce produktu zůstává jak je |
| remote je napřed, přicházející soubor je zde změněný | HELD: zapsat soubory, nic nemergeovat |
| lokální je napřed | zapsat; **nikdy nepushováno** (produkt publikuje SAIPEN SHIP) |
| rozdílné historie | pauza, zapsat obě id, nic nemergeovat |
| jiná větev, probíhá git operace, fetch selhal | pauza |
| žádný checkout `zcode/` nebo `-NoProduct` | přeskočeno |

git sám odmítne fast-forward, který by přepsal lokální změnu, takže
kontrola HELD je dřívější a přehlednější pojistka, ne jediná. Fast-forward
produktu nic nepřestavuje: pro test spusť `pnpm bundle:zaicode` (nebo dev náhled).

### Samoaktualizace (T-90)

Watcher běží jako kopie pod `%APPDATA%\SAIPEN`, takže novější watcher v repozitáři nikdy
nespuštěl bez reinstalace. V režimu smyčky nyní při každém průchodu
porovnává vlastní soubor s commitnutou kopií v repozitáři. Instaluje tuto
kopii přes sebe a restartuje se přesně jednou, se stejnými argumenty, a to
jen když platí všechny tyto podmínky:

- se oba soubory liší;
- kopie v repozitáři nemá necommitnuté úpravy;
- kopie v repozitáři se parsluje bez chyb.

Kopie, která se neparsluje, je odmítnuta a zapsána do logu, běžící watcher
pokračuje dál.

Watchery nainstalované před T-90 postrádají jak průchod produktu, tak
samoaktualizaci. Na takovém stroji jednou znovu spusť `Install-SaipenLiveSync.ps1`; potom se
watcher aktualizuje sám.

## Cloudová polovina

`CLAUDE.md` v kořeni je vstupní pravidlo a
`.claude/skills/saipen/SKILL.md` je prováděcí postup. Skill načte
SAIPEN kernel z `github.com/vacterro/saipen` a spustí ho přes
deklarovanou engine surface `tools/saipen.py`. Kernel je připnut commitem
(`3088eff`), nikdy tagem. Tag `v8.0.1` je starší kernel se stejným
`VERSION`; jeho `validate` mění stav a jeho validátor tuto desku odmítá.

`STATE.saipen_home` zapisuje cestu k kernelu toho exekutora, který
udělal poslední checkpoint. V cloudu první `saipen continue` na kernelu `3088eff`
sjednotí ukazatel s běžícím kernelem jako jeden evidovaný `DEC` (E-1410).
Na stroji operátora dorazí ukazatel mrtvý stejně. Kernel s automatickou
konvergencí ho opraví při `continue`; jinak spusť
`saipen rebind-home --auto`.

**Zpětný přechod je pozorován.** E-1562 (cloud) srazilo ukazatel na `/home/user/zaicode/.claude/saipen-protocol`; E-1571 (stroj operátora)
ho automaticky vrátilo zpět na `V:/.../_SAIPEN`, bez ručního
`rebind-home`. Oběma směry jde o stejné automatické sražení, takže očekávej
jedno `saipen_home` `DEC` na každé přepnutí lokality a ber to jako očekávaný
šum, ne jako vadu. Šumem to zůstává, dokud P1-2
(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) nevyvede ukazatel ze stavu s verzí; neimplementuj P1-2 jako vedlejší efekt jeho zpozorování. Nikdy neupravuj
ukazatel ručně.

`STATE.saipen_home` může ukazovat na **vývojový checkout jádra**, který je před
pinem, ne na čistý klon `3088eff` — na stroji operátora to je
větev `accepted-debt-rebind` s necommitnutou prací. Jádro, které není na
připnutém commitu, není automaticky špatně, ale ani to není čistý
zdroj, takže níže uvedené pravidlo o hlasovém kontraktu se na něj vztahuje
v plné síle. Nikdy v takovém checkoutu nic necommituj, nestashuj,
neresetuj, necheckoutuj ani nečišť; cílené obnovení jediného souboru `saipen/STYLE.md` je
jediná povolená výjimka, a to jen když si to operátor vyžádal.

### STYLE.md není lokální úprava

`saipen/STYLE.md` musí být na
každém stroji, v každé kopii **bajtově totožný se souborem připnutého jádra**,
bez výjimek a bez lokálních úprav. Na stroji operátora
existuje více než jedna kopie:

- checkout jádra v `STATE.saipen_home` (Git klon, na stroji operátora
  vývojový checkout);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, naplněná
  naplánovanou úlohou `saipen-inject` (`bootstrap/schedule-run.ps1`). **Není
  Git repozitářem**, takže ho `git checkout` nikdy nemůže opravit — jedinou cestou je
  resync přes injector nebo přímý zápis publikovaného obsahu.

Token `style_contract` v `.saipen/STATE.md` je hash textu toho souboru
(`tools/validate.py`, `style_contract_token`: normalizováno CRLF, řádek
`style_contract:` vyloučen). Upravíš `reply_language` v jedné kopii a
token se posune; druhá kopie i cloud, které stahují publikované jádro,
si ponechají publikovaný token a každý zápis CLI na neodpovídající straně je
odmítnut s `style_contract ... does not match the installed STYLE.md marker`.
To je celá chyba: lokální strana zapisuje stav, který cloud zapsat nedokáže.

**Změna jazyka odpovědi je commit jádra plus přepnutí pinu**, nikdy lokální
úprava. Změň ji v repozitáři jádra, publikuj, znovu připni commit v
SKILL.md a aktualizuj `STATE.style_contract` přes `saipen recover`. Lokální
úprava `STYLE.md` desynchronizuje každý stroj, který není ten, který ji dělá.

Jedna past, kterou stojí za to jmenovně uvést: publikovaný `bin/saipen` je shim vázaný na stroj,
který natvrdo obsahuje absolutní cesty interpretu a checkoutu jednoho operátora. Běží
na přesně jednom stroji. Cloud musí používat
`python3 tools/saipen.py`.

Zkratky: `cc` pokračuje v aktuální práci Work; `cc all <text>` ingestuje celou
zprávu jako source/appends a pokračuje v každé způsobilé Work. Ani jedno
nežádá o rutinní potvrzení.

## Klasifikace schopností

**AVAILABLE_IN_CLOUD** — stav protokolu a vrstva workspace. Čtení a
zápis `.saipen/`, launcher (`tools/launcher/ZaicodeLauncher.cs`),
instalátor pod `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` a
transportní skripty. Git read, commit, push a fetch na `saipen-live`. Jakákoli
brána, která je tvrzení o souboru, revize diffu nebo textová kontrola.

**LOCAL_WINDOWS_ONLY** — brány, které potřebují tento stroj.

| Brána | Proč |
|------|-----|
| `tools\launcher\build.cmd` | kompiluje `ZaicodeLauncher.cs` s .NET Framework `csc`; na cloudovém image není Windows SDK |
| zabalená Electron E2E (`zcode` desktop, Solo → queue → dispatch) | potřebuje desktopovou relaci a předem nastavený profil poskytovatele |
| živý 9router | Windows služba na tomto stroji |
| interaktivní desktopový průchod kliknutími | člověk a obrazovka |
| vlastní runtime testy watcheru | watcher běží vždy jen na stroji, který má checkout |


Tyto se zaznamenávají jako lokální akceptační hranice. Nikdy se
neoznačí jako prošlé, protože diff vypadal správně.

**SAFE_TO_DEFER** — produktová vrstva. Cloudová relace může klonovat
větev `vacterro/zaicode` `zaicode` a pracovat v ní. Práce na vrstvě workspace
nevyžaduje práci na produktu, ale klon vyžaduje:
`.saipen/source-nested-repos.json` deklaruje `zcode/` a bez něj
validátor selže se `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. `pnpm` brány vyžadují připnutý pnpm 10.33.2
a připravený workspace. `pnpm bootstrap` na čerstvém cloudovém image je
dokumentovaný způsob vstupu a produkt ho už deklaruje v `package.json`.

Cloud umí ověřit jen produktové bajty, které jsou na `origin/zaicode`. Produktový
delta, který existuje pouze v `zcode/` checkoutu operátora, je zde
neviditelný, takže každá jeho produktová brána je v cloudu NOT RUN, ať je to
kterákoli brána. T-84 je první případ (E-1411): jeho oprava byla lokální,
zatímco `origin/zaicode` stále nesl kód před opravou.

**UNSAFE_TO_EMULATE** — cokoli, co by nechalo lokální bránu vypadat zeleně.
Nestubuj sestavení launcheru, nefalšuj běh zabalené aplikace, nepřehraj
zaznamenaný výsledek `pnpm verify:pre-push` tak, jako by právě proběhl, ani nepřeměňuj
„kód vypadá správně" na řádek PASS v `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — shoda závisí na tom, kde checkout
žije. Na jádře `3088eff` hlásí cloudový validátor `closure-evidence`
FAILy (v době psaní T-47, T-62, T-76, T-78), které stroj operátora
nemá.

Jádro přesune každou událost LOG delší než 1024 bajtů do
vedlejšího souboru `.saipen/recovery/log-detail/`. Při čtení obnoví tento soubor pouze
tehdy, když absolutní cesta checkoutu odpovídá cestě, z níž byl zapsán. Verdikt
VERIFY dlouhý, zapsaný ve Windows, je tedy v cloudu nečitelný a naopak.

Vada je v jádře a je zaznamenaná jako P1-1 v
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Dokud nepřistane:

- citovat verdikt cloudu a zařadit ho jako tuto hranici, ticket po ticketu
  (`SKILL.md` § 6 má tuto kontrolu);
- nikdy nepřepisovat sidecars, neověřovat znovu jen aby to prošlo, ani nepatchovat
  kernelovou kopii;
- LOG události držet pod 1024 bajty na obou stranách.

Stejná vazba na strojovou cestu blokuje i práci. Baseline dluhu před BUILD se
zachytí při prvním vstupu ticketu do BUILD a znovu se ověří při každém dalším
vstupu. Ticket, který poprvé vstoupil do BUILD na stroji operátora, tedy
nemůže vstoupit do BUILD v cloudu: přechod se odmítne s
`DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 je případ v záznamu: DEBT-000079 byl
zachycen na E-1377 a přechod odmítnut na E-1446. Takový ticket nech
stroji, který zachytil jeho baseline.

## Rozdělení

Pokud lokální a vzdálená větev přestanou sdílet společného předka, watcher se
zastaví. Nemerge, nerebase, neforce. Obě commit ids jdou do logu, oprava
je `git log --left-right --cherry-pick <branch>...origin/<branch>` ručně a
výsledek se uloží jako checkpoint jako každá jiná změna.

## Přesná akce na straně cloudu

### Setup script prostředí (jednou, v nastavení cloud prostředí)

Menu cloud prostředí v titulní liště session -> Edit -> Setup script. Spouští
se před každou novou session, takže každá session začíná s připravenou
produktovou toolchain:

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

### Prompt pro každou novou session

Začni session na repository `vacterro/zaicode`, branch `saipen-live`, a
ujisti se, že agent na stroji operátora zároveň nezapisuje.
Poslední řádek nahraď s `cc all <new list>` pro předání nové práce.

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

Na stroji operátora watcher fast-forwarduje `zcode` z
`origin/zaicode`; `REBUILD.cmd` (nebo `REBUILD_fast.lnk`) ho sestaví a
další start ZAICODE nasadí nový build.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
