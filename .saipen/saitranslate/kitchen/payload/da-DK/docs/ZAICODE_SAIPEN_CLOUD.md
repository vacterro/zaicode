# ZAICODE SAIPEN cloudtransport

Hvordan denne checkout og en Claude Code Cloud-session kører én SAIPEN-workspace
med forskellig executor-placering, og hvor grænsen mellem dem går.

## Formen

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Én gren bærer protokoltilstanden. Der er intet merge-trin, intet rebase-trin
og ingen anden lokal gren at holde i takt: den executor, der har en verificeret
checkpoint, committer og pusher den, og den anden side tager den med en
fast-forward.

`master` er historikken før transporten og den publicerede standardgren. Den
opdateres ikke med force af transporten.

## Hvad der rejser, og hvad der ikke gør

En checkpoint i dette repository bærer SAIPEN-protokoltilstanden, rod-launcheren,
installeren, dokumentationen og disse transportscripts. Det er hele
workspacelaget.

Den bærer **ingen eneste produktbyte**. `zcode/` er et separat Git-repository, der står
i `.saipen/source-nested-repos.json` og er gitignoreret i denne rod
(`/zcode/`). Produktarbejde kræver sin egen klon af `vacterro/zaicode` på gren
`zaicode`, og den klon er et andet, uafhængigt objekt med sin egen historik.

Konsekvensen er let at tage fejl i: en ren `git status` i denne rod siger
intet om ucommittet produktarbejde, og en `saipen-live` fast-forward siger
intet om produktkode. Tjek `git -C zcode status` eksplicit.

## Lokal halvdel

To scripts, begge ejet af repoet, så en ny maskine får dem fra repository
i stedet for fra hukommelsen:

| File | Rolle |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | validerer, forsoner grenen, installerer og starter watcher, skriver autostart-pointen, beviser lokal == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | sløjfen: hent, sammenlign, fast-forward eller push, log, pause; derefter produktrunden og selvopdateringen |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | tur-retur fra en uafhængig executor plus bevis på cold-recovery |
| `tools/saipen-cloud/Test-ProductSync.ps1` | produktrunde og selvopdatering mod midlertidige Git-repositorier (intet netværk, intet rigtigt remote) |

Installation og reparation:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Den er idempotent. Maskinlokal tilstand ligger i `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (en kopi), `ZAICODE_cloud-sync.log` (roteret ved
2 MB til `.log.1`), `ZAICODE_cloud-sync.lock` (én instans),
`ZAICODE_cloud-sync.pid` samt en post i Startmappen
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Installeren nægter et beskidt træ og renser det aldrig. Hvis alle beskidte stier er
kanonisk SAIPEN-tilstand under `.saipen/`, siger den det og udskriver de præcise
checkpoint-kommandoer; det er en protocoltilstand uden checkpoint, ikke en transportfejl,
og installeren vil ikke committe den bag protokollens ryg.

## Watcher-adfærd

| Situation | Handling |
|-----------|------|
| rent, lokal er forfader til remote | `git merge --ff-only` |
| rent, remote er forfader til lokal | `git push` |
| beskidt | pause; ikke engang et fetch |
| på en anden gren | pause |
| begge er fremskreden, ingen fælles forfader | pause, log begge commit-id'er, merge intet |
| fetch eller netværk mislykkedes | log nedbrud, prøv igen næste tick |
| en merge/rebase/cherry-pick er i gang | pause |

Aldrig: force push, hard reset, stash, clean, checkout af en fremmed gren,
commit eller stop via processnavn. Installeren stopper kun en watcher med
det pid, den selv har registreret i sin egen pid-fil.

Et beskidt træ koster intet, fordi watcher tjekker beskidhed, før den henter.
En inaktiv checkout laver derfor ingen netværkskald overhovedet.

### Produktrunde (T-90)

`zcode/` er sit eget repository, så tabellen ovenfor flytter aldrig produktkode
. Derefter håndterer samme tick produkt-checkouten (`-ProductRepo`,
standard `<repo>\zcode`; gren `-ProductBranch`, standard `zaicode`).
Produktrunden kører, uanset om det ydre træ er beskidt. Den puller udelukkende.

| Situation | Bevægelse |
|-----------|------|
| remote foran, ingen indgående fil er dirty her | `git merge --ff-only`; ucommittet produktarbejde bliver som det er |
| remote foran, en indgående fil er dirty her | HELD: log filerne, merge intet |
| lokal foran | log; **aldrig pushet** (produktet udgives af SAIPEN SHIP) |
| divergeret | pause, log begge id'er, merge intet |
| anden branch, en git-operation i gang, fetch mislykkedes | pause |
| ingen `zcode/`-checkout, eller `-NoProduct` | sprunget over |

git afviser selv en fast-forward, der ville overskrive en lokal ændring,
så HELD-kontrollen er en tidligere, klarere vagt, ikke den eneste. En
produkt-fast-forward genbygger intet: for at teste, kør `pnpm bundle:zaicode` (eller
dev-previewen).

### Selvopdatering (T-90)

Watcheren kører som en kopi under `%APPDATA%\SAIPEN`, så en nyere watcher i
repositoriet kørte aldrig uden geninstallation. I loop-tilstand sammenligner
den nu sin egen fil med repositoriets committede kopi hver omgang. Den
installerer den kopi over sig selv og genstarter præcis én gang, med de
samme argumenter, kun når alle disse er opfyldt:

- de to filer afviger;
- repositoriekopien har ingen ucommittede ændringer;
- repositoriekopien parser uden fejl.

En kopi, der ikke parser, afvises og logges, og den kørende watcher
fortsætter.

Watchere installeret før T-90 mangler både produktrunden og selvopdateringen.
Kør `Install-SaipenLiveSync.ps1` én gang på sådan en maskine; derefter opdaterer
watcheren sig selv.

## Cloud-halvdelen

`CLAUDE.md` i roden er indgangsreglen, og
`.claude/skills/saipen/SKILL.md` er udførelsesproceduren. Skill'en henter
SAIPEN-kernelen fra `github.com/vacterro/saipen` og kører den gennem
den erklærede engine-overflade `tools/saipen.py`. Kernelen er fastlåst på commit
(`3088eff`), aldrig på tag. Tag `v8.0.1` er en ældre kernel med samme
`VERSION`; dens `validate` muterer tilstand, og dens validator afviser
dette board.

`STATE.saipen_home` registrerer kernelstien for den executor, der checkpointede
sidst. I skyen konvergerer den første `saipen continue` på kernel `3088eff` den
til den kørende kernel som én journalført `DEC` (E-1410). På
operatørmaskinen ankommer pointeren død på samme måde. En kernel med
automatisk konvergens reparerer den ved `continue`; kør ellers
`saipen rebind-home --auto`.

**Returturen observeres.** E-1562 (cloud) konvergerede pointeren til
`/home/user/zaicode/.claude/saipen-protocol`; E-1571 (operatørmaskinen)
konvergerede den lige tilbage til `V:/.../_SAIPEN`, automatisk, uden manuel
`rebind-home`. Begge retninger er samme automatiske konvergens, så forvent
én `saipen_home` `DEC` pr. lokalitetsskift og behandl det som forventet støj
ikke som en fejl. Det er støj, indtil P1-2
(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) flytter pointeren ud af versioneret
tilstand; implementér ikke P1-2 som sideeffekt af at opdage det. Redigér aldrig
pointeren manuelt.

`STATE.saipen_home` kan pege på en kernel-**udviklingskopi** der er foran
pinnen, ikke på en ren `3088eff`-klon — på operatørmaskinen er det
`accepted-debt-rebind`-branchen med ucommittet arbejde. En kernel der ikke er på
den pinnede commit er ikke automatisk forkert, men den er heller ikke en
renrums-kilde, så reglen nedenfor om stemmekontrakten gælder for den
fuldt ud. Committ, stash, reset, check out eller clean aldrig noget i en sådan
kopi; en målrettet gendannelse af én fil, `saipen/STYLE.md`, er det eneste
tilladte undtagelse, og kun når operatøren beder om det.

### STYLE.md er ikke en lokal indstilling

`saipen/STYLE.md` skal være **byte-identisk med den pinnede kernels fil** på
every maskine, i hver kopi, uden undtagelser og uden lokale redigeringer. Der
er mere end én kopi på en operatørmaskine:

- kernel-kopien i `STATE.saipen_home` (en Git-klon, på operatørmaskinen en udviklingskopi);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, befolket af den
  `saipen-inject` planlagte opgave (`bootstrap/schedule-run.ps1`). Den er **ikke et
  Git-repository**, så `git checkout` kan aldrig reparere den — en ny synkronisering
gennem injektoren eller en direkte skrivning af det publicerede indhold er
eneste vej.

`style_contract`-tokenet i `.saipen/STATE.md` er et hash af filens tekst
(`tools/validate.py`, `style_contract_token`: CRLF normaliseret, `style_contract:`
linjen ekskluderet). Redigér `reply_language` i én kopi, og tokenet flytter sig;
den anden kopi og skyen, som henter den publicerede kernel, beholder det
publicerede token, og alle CLI-skrivninger på den afvigende side afvises med
`style_contract ... does not match the installed STYLE.md marker`.
Det er hele fejlen: den lokale side skriver tilstand, skyen ikke kan skrive.

**At ændre svarsproget er en kernel-commit plus en repinning**, aldrig en lokal
redigering. Ændr det i kernel-repositoryet, publicér det, pin committen
igen i SKILL.md, og opdatér `STATE.style_contract` gennem `saipen recover`. En lokal
redigering af `STYLE.md` desynkroniserer alle maskiner undtagen den, der laver den.

Én fælde værd at nævne: det publicerede `bin/saipen` er en maskinbundet shim,
der hardkoder én operatørs absolutte fortolker- og sti. Den kører på
præcis én maskine. Skyen skal bruge `python3 tools/saipen.py`.

Genveje: `cc` fortsætter det nuværende Work; `cc all <text>` indlæser hele
beskeden som kilde/appends og fortsætter alle berettigede Work. Ingen af dem
beder om rutinebekræftelse.

## Capability-klassificering

**AVAILABLE_IN_CLOUD** — protokoltilstand og workspace-laget. Læsning og
skrivning af `.saipen/`, launcheren (`tools/launcher/ZaicodeLauncher.cs`),
installeren under `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` og
transport scripts. Git read, commit, push og fetch på `saipen-live`. Alle
gates, der er fil-påstand, diff-gennemgang eller tekstkontrol.

**LOCAL_WINDOWS_ONLY** — de gates, der kræver denne maskine.

| Gate | Hvorfor |
|------|-----|
| `tools\launcher\build.cmd` | kompilerer `ZaicodeLauncher.cs` med .NET Framework `csc`; intet Windows SDK på et cloud-image |
| pakket Electron E2E (`zcode` desktop, Solo → kø → dispatch) | kræver en desktop-session og et seedet provider-profil |
| den live 9router | en Windows-tjeneste på denne maskine |
| interaktiv desktop klik-igennem | et menneske og en skærm |
| watcher's egne runtime-cases | watcheren kører altid kun på maskinen, der holder checkout'en |

Disse registreres som lokale acceptansgrænser. De rapporteres aldrig
som bestået, fordi diff'en så rigtig ud.

**SAFE_TO_DEFER** — produktlaget. En cloud-session kan klone
`vacterro/zaicode` branch `zaicode` og arbejde der. Workspace-lagsarbejde kræver
ikke produktarbejde, men kræver clone'en:
`.saipen/source-nested-repos.json` deklarerer `zcode/`, og uden den fejler
validatoren med `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. `pnpm` gates kræver den pinned pnpm 10.33.2
og et forberedt workspace. `pnpm bootstrap` på et friskt cloud-image er den
dokumenterede vej ind, og produktets `package.json` deklarerer den allerede.

Skyen kan kun verificere produktbytes, der ligger på `origin/zaicode`. En
produktdelta, der kun findes i operatørens `zcode/` checkout, er
usynlig her, så alle produktgates for den er NOT RUN i skyen, uanset
gaten. T-84 er det første tilfælde (E-1411): dens fix var lokal-only, mens
`origin/zaicode` stadig bar koden før fixen.

**UNSAFE_TO_EMULATE** — alt, der ville få en lokal-only gate til at se grøn ud.
Stub ikke launcher-buildet, forfalsk ikke en pakket-app-kørsel, afspil ikke en
registreret `pnpm verify:pre-push`-resultat, som om den lige var kørt, og omvend ikke "koden
ser korrekt ud" til en PASS-linje i `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — overholdelse, der afhænger af, hvor checkout'en
ligger. På kernel `3088eff` rapporterer cloud-validatoren `closure-evidence`
FAILs (T-47, T-62, T-76, T-78 ved skrivetidspunktet), som
operatørmaskinen ikke gør.

Kernelen flytter alle LOG-events over 1024 bytes ind i en
`.saipen/recovery/log-detail/`-sidecar. Ved læsning genskaber den kun sidecar'en,
når checkout'ens absolutte sti er lig den sti, den blev skrevet fra. Et langt
VERIFY-resultat skrevet på Windows er derfor ulæseligt i skyen, og
omvendt gælder det samme.

Fejlen ligger i kernelen og er registreret som P1-1 i
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Indtil den lander:

- citér cloud-verdiktet og klassificér det som denne grænse, ticket for ticket
  (`SKILL.md` § 6 har checken);
- skriv aldrig sidecars om, genverificér kun for at få grønt, og patch ikke
  kernel-kopien;
- hold LOG-events under 1024 bytes på begge sider.

Den samme maskinsti-binding blokerer også arbejde. Gælds-baslinen før BUILD
registreres, første gang en ticket går ind i BUILD, og kontrolleres igen ved
hvert senere indtog. En ticket, der første gang gik ind i BUILD på
operatørmaskinen, kan derfor ikke gå ind i BUILD i clouden: overgangen afvises
med `DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 er det registrerede tilfælde: DEBT-000079 blev
registreret ved E-1377, og overgangen blev afvist ved E-1446. Lad en sådan
ticket blive hos den maskine, der registrerede dens baseline.

## Divergens

Hvis lokal og remote hold op med at dele en stamfader, stopper watcher'en. Den
merger ikke, rebaser ikke og force-pusher ikke. Begge commit-id'er skrives i
loggen, rettelsen laves `git log --left-right --cherry-pick <branch>...origin/<branch>` i hånden, og
resultatet checkpointes som enhver anden ændring.

## Den præcise handling i clouden

### Script til opsætning af miljøet (én gang, i cloudmiljøets indstillinger)

Cloud-miljø-menuen i sessionens titelbjælke -> Rediger -> Opsætningsscript. Det
kører før hver ny session, så hver session starter med produktværktøjskæden
klar:

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

### Prompten til hver ny session

Start sessionen på repository `vacterro/zaicode`, branch `saipen-live`, og sørg for, at
agenten på operatørmaskinen ikke skriver samtidig. Erstat den sidste linje med
`cc all <new list>` for at afgive nyt arbejde.

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

På operatørmaskinen fast-forwarder watcher'en `zcode` fra
`origin/zaicode`; `REBUILD.cmd` (eller `REBUILD_fast.lnk`) bygger den, og
næste start af ZAICODE skifter den nye build ind.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
