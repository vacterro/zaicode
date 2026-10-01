# ZAICODE SAIPEN cloudtransport

Hoe deze checkout en een Claude Code Cloud-sessie één SAIPEN-werkruimte draaien
met verschillende executor-locatie, en waar de grens tussen beide ligt.

## De vorm

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Eén tak draagt de protocolstatus. Geen merge-stap, geen rebase-stap
en geen tweede lokale tak om bij te houden: de executor met een geverifieerd
checkpoint commit en pusht het, en de andere kant haalt het op met
een fast-forward.

`master` is de geschiedenis vóór transport en de gepubliceerde standaardtak. Wordt
niet met force bijgewerkt door het transport.

## Wat wel en niet meereist

Een checkpoint in deze repository bevat de SAIPEN-protocolstatus, de root
launcher, de installer, de documentatie en deze transportscripts. Dat is de
hele werkruimtelayer.

Het bevat **geen enkel productbyte**. `zcode/` is een aparte Git-repository, vermeld
in `.saipen/source-nested-repos.json` en op dit rootniveau gitignored
(`/zcode/`). Productwerk heeft een eigen clone van `vacterro/zaicode` op tak
`zaicode`, en die clone is een tweede, onafhankelijk object met eigen geschiedenis.

Het gevolg is makkelijk verkeerd te lezen: een schone `git status` op dit rootniveau zegt
niets over ongecommit productwerk, en een fast-forward van `saipen-live` zegt
niets over productcode. Controleer `git -C zcode status` expliciet.

## Lokale helft

Twee scripts, allebei repo-eigendom, zodat een nieuwe machine ze uit de repository haalt
in plaats van uit het geheugen:

| File | Rol |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | valideert, brengt de branch in overeenstemming, installeert en start de watcher, schrijft de autostartvermelding, bewijst lokaal == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | de lus: ophalen, vergelijken, fast-forward of push, loggen, pauzeren; daarna de productieronde en self-update |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | round-trip vanaf een onafhankelijke executor plus bewijs van koude herstelbaarheid |
| `tools/saipen-cloud/Test-ProductSync.ps1` | productieronde en self-update tegen wegwerpen-Git-repositories (geen netwerk, geen echte remote) |

Installeren en repareren:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Het is idempotent. Machine-lokale staat staat in `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (een kopie), `ZAICODE_cloud-sync.log` (gerotated bij
2 MB naar `.log.1`), `ZAICODE_cloud-sync.lock` (één instantie),
`ZAICODE_cloud-sync.pid`, en een entry in de Startup-map
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Het installatieprogramma weigert een vuile tree en maakt hem nooit schoon. Is elk vuil pad
canonieke SAIPEN-staat onder `.saipen/`, dan zegt het dat en print het de exacte
checkpoint-commando's; dat is een protocolstatus zonder checkpoint, geen transportfout,
en het installatieprogramma commit het niet achter de rug van het protocol om.

## Gedrag van de watcher

| Situatie | Actie |
|-----------|------|
| schoon, lokaal is een voorouder van remote | `git merge --ff-only` |
| schoon, remote is een voorouder van lokaal | `git push` |
| vuil | pauzeren; zelfs geen fetch |
| op een andere branch | pauzeren |
| beide vooruit, geen gedeelde voorouder | pauzeren, beide commit-ids loggen, niets mergen |
| fetch of netwerk mislukt | degraded loggen, volgende tick opnieuw proberen |
| een merge/rebase/cherry-pick is bezig | pauzeren |

Nooit: force push, hard reset, stash, clean, checkout van een vreemde branch,
commit, of stop op procesnaam. Het installatieprogramma stopt een watcher alleen via de
pid die het zelf in zijn eigen pid-bestand heeft vastgelegd.

Een vuile tree kost niets, want de watcher controleert vuil vóór het ophalen.
Een inactieve checkout doet dus helemaal geen netwerkoproepen.

### Productpass (T-90)

`zcode/` is een eigen repository, dus verplaatst de tabel hierboven nooit product-
code. Daarna behandelt dezelfde tick de productcheckout (`-ProductRepo`,
standaard `<repo>\zcode`; branch `-ProductBranch`, standaard `zaicode`). De
productpass draait of de buitenste tree nu vuil is of niet. Hij trekt altijd alleen.

| Situatie | Actie |
|-----------|------|
| remote vooruit, geen binnenkomend bestand is hier dirty | `git merge --ff-only`; niet-gecommit productiewerk blijft zoals het is |
| remote vooruit, een binnenkomend bestand is hier dirty | HELD: log de bestanden, merge niets |
| lokaal vooruit | log; **nooit gepusht** (product wordt gepubliceerd door SAIPEN SHIP) |
| uiteengelopen | pauzeer, log beide ids, merge niets |
| andere branch, een git-bewerking bezig, fetch mislukt | pauzeer |
| geen `zcode/` checkout, of `-NoProduct` | overgeslagen |

git weigert zelf een fast-forward die een lokale wijziging zou overschrijven,
dus de HELD-controle is een eerdere, duidelijkere vangnet, niet de enige. Een product
fast-forward herbouwt niets: test door `pnpm bundle:zaicode` te draaien (of
de dev-preview).

### Zelfupdate (T-90)

De watcher draait als kopie onder `%APPDATA%\SAIPEN`, dus een nieuwere watcher in
de repository is nooit zonder herinstallatie gedraaid. In loopmodus vergelijkt hij
nu elke ronde zijn eigen bestand met de gecommitte kopie in de repository. Hij
installeert die kopie over zichzelf en herstart exact één keer, met dezelfde
argumenten, alleen wanneer al dit geldt:

- de twee bestanden verschillen;
- de repositorykopie heeft geen niet-gecommitte wijzigingen;
- de repositorykopie parseert zonder fouten.

Een kopie die niet parseert wordt geweigerd en gelogd, en de draaiende watcher
gaat verder.

Watchers geïnstalleerd vóór T-90 missen zowel de productronde als zelfupdate.
Draai op zo'n machine één keer `Install-SaipenLiveSync.ps1`; daarna
werkt de watcher zichzelf bij.

## Cloudhelft

`CLAUDE.md` in de root is de entryregel en
`.claude/skills/saipen/SKILL.md` is de uitvoeringsprocedure. De skill haalt
de SAIPEN-kernel op van `github.com/vacterro/saipen` en draait die via
de opgegeven enginesurface `tools/saipen.py`. De kernel is vastgezet op commit
(`3088eff`), nooit op tag. Tag `v8.0.1` is een oudere kernel met dezelfde
`VERSION`; de `validate` ervan wijzigt state, en de validator van die kernel
weigert dit bord.

`STATE.saipen_home` legt het kernelpad vast van de uitvoerder die als laatste
checkpointte. In de cloud convergeert de eerste `saipen continue` op kernel `3088eff`
dit naar de draaiende kernel als één gelogde `DEC` (E-1410). Op de
operatormachine komt de pointer op dezelfde manier dood aan. Een kernel met
automatische convergentie repareert dit bij `continue`; draai anders
`saipen rebind-home --auto`.

**De terugweg wordt waargenomen.** E-1562 (cloud) convergeerde de pointer naar `/home/user/zaicode/.claude/saipen-protocol`; E-1571 (operatormachine) convergeerde hem automatisch recht terug naar `V:/.../_SAIPEN`, zonder handmatige `rebind-home`. Beide richtingen zijn dezelfde automatische convergentie: reken per locality-switch op één `saipen_home` `DEC` en behandel dat als verwachte ruis, niet als defect. Het blijft ruis tot P1-2 (`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) de pointer uit de versied status haalt; implementeer P1-2 niet als neveneffect van het waarnemen. Nooit de pointer handmatig bewerken.

`STATE.saipen_home` kan wijzen naar een kernel-**ontwikkelcheckout** die voor de pin ligt, niet naar een schone `3088eff`-clone — op de operatormachine is het de `accepted-debt-rebind`-branch met ongecommit werk. Een kernel die niet op de gepinde commit staat is niet automatisch fout, maar ook geen clean-room-bron; de regel hieronder over het voice-contract geldt dus volledig. Nooit committen, stashen, resetten, checken of cleanen in zo'n checkout; alleen een gerichte herstelactie van één bestand `saipen/STYLE.md` is toegestaan, en alleen als de operator erom vraagt.

### STYLE.md is geen lokale instelling

`saipen/STYLE.md` moet op elke machine, in elke kopie, **byte-identiek zijn aan het bestand van de gepinde kernel** — zonder uitzonderingen, zonder lokale edits. Op een operatormachine bestaan er meer dan één kopie:

- de kernel-checkout op `STATE.saipen_home` (een Git-clone, op de operatormachine een ontwikkelcheckout);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, gevuld door de geplande taak `saipen-inject` (`bootstrap/schedule-run.ps1`). Dit is **geen**
  Git-repository, dus `git checkout` kan het nooit repareren — alleen een re-sync via de injector
  of een directe schrijfactie van de gepubliceerde inhoud.

Het `style_contract`-token in `.saipen/STATE.md` is een hash van de tekst van dat bestand (`tools/validate.py`, `style_contract_token`: CRLF genormaliseerd, de `style_contract:`-regel uitgesloten). Bewerk `reply_language` in één kopie en het token verschuift; de andere kopie en de cloud, die de gepubliceerde kernel ophalen, houden het gepubliceerde token, en elke CLI-schrijfactie aan de mismatchende kant wordt geweigerd met `style_contract ... does not match the installed STYLE.md marker`.
Dat is de hele storing: de lokale kant schrijft status die de cloud niet kan schrijven.

**Antwoordtaal wijzigen is een kernel-commit plus opnieuw pinnen**, nooit een lokale edit. Wijzig hem in de kernel-repository, publiceer hem, pin de commit opnieuw in SKILL.md en werk `STATE.style_contract` bij via `saipen recover`. Een lokale edit van `STYLE.md` desynchroniseert elke machine behalve degene die hem maakt.

Een valkuil om te noemen: de gepubliceerde `bin/saipen` is een machine-gebonden shim die de absolute interpreter- en checkoutpaden van één operator hardcodeert. Hij draait op precies één machine. De cloud moet `python3 tools/saipen.py` gebruiken.

Snelpaden: `cc`zet het huidige Work voort; `cc all <text>` neemt het hele bericht als bron/appends op en zet elk geschikt Work voort. Geen van beide vraagt om routinebevestiging.

## Capability-classificatie

**AVAILABLE_IN_CLOUD** — protocolstatus en de werkruimtelayer. Lezen en schrijven van `.saipen/`, de launcher (`tools/launcher/ZaicodeLauncher.cs`), de installer onder `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/`, en de transportscripts. Git read, commit, push en fetch op `saipen-live`. Elke gate die een bestandsassertie, diff-review of tekstcontrole is.


**LOCAL_WINDOWS_ONLY** — de gates die deze machine nodig hebben.


| Gate | Waarom |
|------|-----|
| `tools\launcher\build.cmd` | compileert `ZaicodeLauncher.cs` met het .NET Framework `csc`; geen Windows SDK op een cloudimage |
| packaged Electron E2E (`zcode` desktop, Solo → queue → dispatch) | vereist een desktopsessie en een voorzien providerprofiel |
| de live 9router | een Windows-service op deze machine |
| interactieve desktop-clickthrough | een mens en een scherm |
| de eigen runtime-cases van de watcher | de watcher draait alleen op de machine met de checkout |


Deze staan vast als lokale acceptatiegrenzen. Ze worden nooit als geslaagd
gerapporteerd omdat de diff er goed uitzag.


**SAFE_TO_DEFER** — de productlaag. Een cloudsessie kan `vacterro/zaicode` branch
`zaicode` klonen en daar werken. Werk op de werkruimtelaag vereist geen
productwerk, maar wel de clone: `.saipen/source-nested-repos.json` declareert `zcode/`, en
zonder dat faalt de validator met `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. `pnpm`-gates vereisen
de vastgezette pnpm 10.33.2 en een voorbereide werkruimte. `pnpm bootstrap` op
een fris cloudimage is de gedocumenteerde ingang, en de `package.json` van het
product declareert het al.

De cloud kan alleen productbytes verifiëren die op `origin/zaicode` staan. Een
productdelta die alleen in de `zcode/`-checkout van de operator bestaat, is
hier onzichtbaar, dus elke productgate daarvoor is NOT RUN in de cloud, wat
de gate ook is. T-84 is het eerste geval (E-1411): de fix was alleen lokaal,
terwijl `origin/zaicode` nog de pre-fix code had.


**UNSAFE_TO_EMULATE** — alles wat een lokale gate groen zou laten lijken.
Niet de launcher-build stubben, geen verpakte app-run faken, geen opgeslagen
`pnpm verify:pre-push`-resultaat herhalen alsof het net draaide, en niet "de code
ziet er correct uit" omzetten naar een PASS-regel in `.saipen/LOG.md`.


**KNOWN_CLOUD_DIVERGENCE** — conformiteit die afhangt van waar de checkout
staat. Op kernel `3088eff` meldt de cloudvalidator `closure-evidence`
FAILs (T-47, T-62, T-76, T-78 op het moment van schrijven) die de
operatormachine niet heeft.


De kernel verplaatst elk LOG-event groter dan 1024 bytes naar een
`.saipen/recovery/log-detail/`-sidecar. Bij lezen herstelt hij de sidecar alleen als het absolute
pad van de checkout gelijk is aan het pad waarvandaan hij geschreven is. Een
lang VERIFY-verdict geschreven op Windows is dus onleesbaar in de cloud, en
omgekeerd geldt hetzelfde.


Het defect zit in de kernel en is gefileerd als P1-1 in
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Tot die erinkomt:


- citeer het cloud-oordeel en classificeer het per ticket als deze grens
  (`SKILL.md` § 6 bevat de controle);
- sidecars nooit herschrijven, nooit enkel opnieuw verifiëren om groen te scoren, of de kernelkopie
  patchen;
- houd LOG-events aan beide kanten onder 1024 bytes.

Dezelfde machinepadbinding blokkeert ook werk. De pre-BUILD-schuldbaseline wordt vastgelegd de eerste keer dat een ticket BUILD betreedt en bij elke latere toetreding opnieuw gecontroleerd. Een ticket dat voor het eerst BUILD betreedt op de operator-machine kan daarom niet in de cloud BUILD binnengaan: de overgang wordt geweigerd met `DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 is het geval op record: DEBT-000079 werd vastgelegd bij E-1377 en de overgang geweigerd bij E-1446. Laat zo'n ticket over aan de machine die de baseline heeft vastgelegd.

## Afwijking

Als lokaal en remote geen gemeenschappelijke voorouder meer delen, stopt de watcher. Hij merged niet, rebased niet en forceert niet. Beide commit-ids komen in het log terecht, de fix wordt met de hand `git log --left-right --cherry-pick <branch>...origin/<branch>`, en het
resultaat wordt net als elke andere wijziging als checkpoint vastgelegd.

## De exacte cloudzijdige actie

### Installatiescript voor de omgeving (eenmalig, in de instellingen van de cloudomgeving)

Cloudomgevingsmenu in de sessietitelbalk -> Bewerken -> Installatiescript. Het draait vóór elke nieuwe sessie, dus elke sessie start met de producttoolchain klaar:

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

### De prompt voor elke nieuwe sessie

Start de sessie op repository `vacterro/zaicode`, branch `saipen-live`, en
zorg dat de agent op de operator-machine niet tegelijk schrijft.
Vervang de laatste regel door `cc all <new list>` om nieuw werk over te dragen.

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

Op de operator-machine fast-forwardt de watcher `zcode` vanuit
`origin/zaicode`; `REBUILD.cmd` (of `REBUILD_fast.lnk`) bouwt het, en de
volgende start van ZAICODE wisselt de nieuwe build in.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
