# ZAICODE SAIPEN-skytransport

Hvordan denne utsjekkingen og en Claude Code Cloud-sesjon driver én SAIPEN-arbeidsplass med ulik executor-lokalitet, og hvor grensen mellom dem går.

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

Én gren bærer protokolltilstanden. Ingen merge-steg, ingen rebase-steg
og ingen sekundær lokal gren å holde i takt: den executoren som har et verifisert
sjekkepunkt, commiter og pusher det, og den andre siden henter det med
fast-forward.

`master` er historikken før transporten og den publiserte standardgrenen. Den
blir ikke tvangsoppdateret av transporten.

## Hva som transporteres, og hva som ikke gjør det

Et sjekkepunkt i dette repositoriet bærer SAIPEN-protokolltilstanden, rotlanseren,
installasjonsprogrammet, dokumentasjonen og disse transportkriptene. Det er hele
arbeidsplasslaget.

Det bærer **ingen produktbyte**. `zcode/` er et separat Git-repositorium,
oppført i `.saipen/source-nested-repos.json` og gitignored på dette rotnivået
(`/zcode/`). Produktarbeid trenger sin egen klon av `vacterro/zaicode` på gren
`zaicode`, og den klonen er et separat, uavhengig objekt med egen historikk.

Konsekvensen er lett å ta feil av: en ren `git status` på dette rotnivået sier
ingenting om ikke-kommittet produktarbeid, og en `saipen-live` fast-forward sier
ingenting om produktkoden. Sjekk `git -C zcode status` eksplisitt.

## Lokal halvdel

To skript, begge eid av repoet, slik at en ny maskin får dem fra repositoriet
i stedet for fra hukommelsen:

| File | Role |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | validerer, forliker branchen, installerer og starter watcheren, skriver autostart-oppføringen, beviser at lokal == fjern |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | loopen: hent, sammenlign, fast-forward eller push, logg, pause; deretter produktrunden og selvoppdateringen |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | tur-retur fra en uavhengig executor pluss bevis på gjenoppretting fra kald tilstand |
| `tools/saipen-cloud/Test-ProductSync.ps1` | produktrunde og selvoppdatering mot engangskast-Git-lagre (ingen nettverk, ingen ekte fjerntier) |


Installer og reparer:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Den er idempotent. Maskinlokal tilstand ligger i `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (en kopi), `ZAICODE_cloud-sync.log` (roteres ved
2 MB til `.log.1`), `ZAICODE_cloud-sync.lock` (én instans),
`ZAICODE_cloud-sync.pid`, og en oppføring i Startmappen
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Installasjonsprogrammet nekter et skittent tre og renser det aldri. Hvert skittent spor er
kanonisk SAIPEN-tilstand under `.saipen/`, sier det fra og skriver ut de eksakte
checkpoint-kommandoene; det er en protokolltilstand uten checkpoint, ikke en transportfeil,
og installasjonsprogrammet vil ikke committe den bak protokollens rygg.

## Watcher-atferd

| Situasjon | Handling |
|-----------|------|
| rent, lokal er forfader til fjern | `git merge --ff-only` |
| rent, fjern er forfader til lokal | `git push` |
| skittent | pause; ikke engang et hent |
| på en annen branch | pause |
| begge fremede, ingen felles forfader | pause, logg begge commit-id-er, ikke merk noe |
| hent eller nettverk feilet | logg degradert, prøv igjen neste tikk |
| en merge/rebase/cherry-pick pågår | pause |

Aldri: force push, hard reset, stash, clean, checkout av fremmed branch,
commit, eller stopp etter prosessnavn. Installasjonsprogrammet stopper en watcher bare
med pid-en den lagret i sin egen pid-fil.

Et skittent tre koster ingenting, fordi watcher sjekker skitt før den henter.
En inaktiv checkout foretar derfor ingen nettverkskall i det hele tatt.

### Produktrunde (T-90)

`zcode/` er sitt eget repositorium, så tabellen ovenfor flytter aldri produktkode.
Etter den håndterer samme tikk produkt-checkouten (`-ProductRepo`,
standard `<repo>\zcode`; branch `-ProductBranch`, standard `zaicode`). Produktrunden
kjøres uansett om det ytre treet er skittent. Den bare puller noe.

| Situasjon | Handling |
|-----------|------|
| fjern foran, ingen innkommende fil endret her | `git merge --ff-only`; ucommitted produktarbeid forblir som det er |
| fjern foran, en innkommende fil er endret her | HELD: logg filene, slå sammen ingenting |
| lokal foran | logg; **aldri pushet** (produktet publiseres av SAIPEN SHIP) |
| avviket | pause, logg begge id-er, slå sammen ingenting |
| annen gren, git-operasjon pågår, fetch mislyktes | pause |
| ingen `zcode/`-utpakking, eller `-NoProduct` | hoppet over |

git nekter selv en fast-forward som ville overskrevet en lokal endring, så
HELD-sjekken er en tidligere og tydeligere vakt, ikke den eneste. En
produkt-fast-forward bygger ikke om noe: for å teste, kjør `pnpm bundle:zaicode` (eller
forhåndsvisningen for utvikling).

### Selvoppdatering (T-90)

Watcheren kjøres som kopi under `%APPDATA%\SAIPEN`, så en nyere watcher i
repositoriet kjørte aldri uten reinstallering. I løkkemodus sammenligner den
nå sin egen fil med repositoriets innsendte kopi hver runde. Den
installerer den kopien over seg selv og starter på nytt nøyaktig én gang,
med de samme argumentene, bare når alle disse gjelder:

- de to filene er ulike;
- repositoriekopien har ingen ucommittede endringer;
- repositoriekopien tolkes uten feil.

En kopi som ikke tolkes, avvises og logges, og watcheren som kjører
fortsetter.

Watchere installert før T-90 mangler både produktpassering og
selvoppdatering. Kjør `Install-SaipenLiveSync.ps1` én gang på en slik maskin; etterpå
oppdaterer watcheren seg selv.

## Skydelen

`CLAUDE.md` i roten er inngangsregelen, og `.claude/skills/saipen/SKILL.md` er
utførelsesprosedyren. Skillen henter SAIPEN-kjernen fra `github.com/vacterro/saipen` og kjører
den gjennom den deklarerte motorflaten `tools/saipen.py`. Kjernen er festet til
commit (`3088eff`), aldri til tag. Tag `v8.0.1` er en eldre kjerne med
samme `VERSION`; `validate` endrer tilstand, og validatoren avviser
dette brettet.

`STATE.saipen_home` registrerer kjernestien til den executor som sist tok et
checkpoint. I skyen konvergerer den første `saipen continue` på kjerne `3088eff`
den til kjernen som kjører, som én journalført `DEC` (E-1410). På
operatørmaskinen kommer pekeren død på samme måte. En kjerne med automatisk
konvergenser retter den i `continue`; ellers kjør `saipen rebind-home --auto`.

**Returturen er observert.** E-1562 (sky) konvergerte pekeren til `/home/user/zaicode/.claude/saipen-protocol`; E-1571 (operatørmaskin) konvergerte den rett tilbake til `V:/.../_SAIPEN`, automatisk, uten manuell `rebind-home`. Begge retninger er samme automatiske konvergens, så forvent én `saipen_home` `DEC` per lokalitetsbytte og behandle det som forventet støy, ikke som en feil. Det forblir støy til P1-2 (`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) flytter pekeren ut av versjonert tilstand; ikke implementer P1-2 som en bivirkning av å merke det. Rediger aldri pekeren for hånd.

`STATE.saipen_home` kan peke på en kernel-**utviklingssjekkout** som er foran pinen, ikke på en ren `3088eff`-klone — på operatørmaskinen er det `accepted-debt-rebind`-grenen med ucommitted arbeid. En kernel som ikke står på den pinnede commit-en er ikke automatisk feil, men er heller ikke en renromskilde, så regelen nedenfor om stemmekontrakten gjelder for den med full kraft. Foreta aldri commit, stash, reset, checkout eller clean i en slik sjekkout; en målrettet gjenoppretting av én fil, `saipen/STYLE.md`, er eneste tillatte unntak, og bare når operatøren ber om det.

### STYLE.md er ikke en lokal innstilling

`saipen/STYLE.md` må være **byte-identisk med den pinnede kernelens fil** på hver maskin, i hver kopi, uten unntak og uten lokale endringer. Det finnes mer enn én kopi på en operatørmaskin:

- kernel-sjekkouten på `STATE.saipen_home` (en Git-klone, på operatørmaskinen en utviklingssjekkout);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, fylt av den `saipen-inject` planlagte oppgaven (`bootstrap/schedule-run.ps1`). Den er **ikke et Git-repositorium**, så `git checkout` kan aldri reparere den — ny synkronisering via injektoren, eller direkte skriving av det publiserte innholdet, er eneste vei.

`style_contract`-tokenet i `.saipen/STATE.md` er en hash av filens tekst (`tools/validate.py`, `style_contract_token`: CRLF normalisert, `style_contract:`-linjen utelatt). Rediger `reply_language` i én kopi, og tokenet flytter seg; den andre kopien og skyen, som henter den publiserte kernelen, beholder det publiserte tokenet, og alle CLI-skrivinger på den avvikende siden avvises med `style_contract ... does not match the installed STYLE.md marker`.
Det er hele feilen: den lokale siden skriver tilstand som skyen ikke kan skrive.

**Å endre svarspråket er en kernel-commit pluss en ny pin, aldri en lokal redigering.** Endre det i kernel-repositoriet, publiser det, pinn commit-en på nytt i SKILL.md, og oppdater `STATE.style_contract` via `saipen recover`. En lokal redigering av `STYLE.md` desynkroniserer alle maskiner som ikke er den som gjør endringen.

Én felle verdt å nevne: den publiserte `bin/saipen` er en maskinbundet shim som hardkoder én operatørs absolutte tolknings- og sjekkoutstier. Den kjører på nøyaktig én maskin. Skyen må bruke `python3 tools/saipen.py`.

Snarveier: `cc` fortsetter den pågående Work-en; `cc all <text>` leser inn hele meldingen som kilde/appends og fortsetter hver kvalifiserte Work. Ingen ber om rutinemessig bekreftelse.

## Kapabilitetsklassifisering

**AVAILABLE_IN_CLOUD** — protokolltilstand og arbeidsområdelaget. Lesing og
skriving av `.saipen/`, launcheren (`tools/launcher/ZaicodeLauncher.cs`),
installasjonen under `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` og
transportskriptene. Git-lesing, commit, push og fetch på `saipen-live`. Alle
gates som er filpåstand, diff-gjennomgang eller tekstkontroll.

**LOCAL_WINDOWS_ONLY** — portene som trenger denne maskinen.

| Port | Hvorfor |
|------|-----|
| `tools\launcher\build.cmd` | kompilerer `ZaicodeLauncher.cs` med .NET Framework `csc`; ingen Windows SDK i skybilde |
| pakket Electron E2E (`zcode` desktop, Solo → kø → dispatch) | krever øktsessjon og en forberedt leverandørprofil |
| den levende 9router | en Windows-tjeneste på denne maskinen |
| interaktiv desktop-klikk gjennom | et menneske og en skjerm |
| watcherens egne kjøretidstilfeller | watcheren kjøres bare på maskinen som har utsjekkingen |

Disse registreres som kun-lokale akseptansegrenser. De rapporteres aldri
som bestått fordi diffen så riktig ut.

**SAFE_TO_DEFER** — produktlaget. En skyøkt kan klone
`vacterro/zaicode`-grenen `zaicode` og jobbe der. Arbeid i arbeidsområdelaget krever
ikke produktarbeid, men krever kloningen:
`.saipen/source-nested-repos.json` deklarerer `zcode/`, og uten den feiler
validatoren med `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. `pnpm`-porter trenger den pinnede pnpm 10.33.2
og et forberedt arbeidsområde. `pnpm bootstrap` på et ferskt skybilde er den
 dokumenterte veien inn, og produktets `package.json` deklarerer den allerede.

Skyen kan bare verifisere produktbyte som finnes på `origin/zaicode`. En
produktdelta som bare finnes i operatørens `zcode/`-utsjekking er
usynlig her, så alle produktporter for det er IKKE KJØRT i skyen, uansett
port. T-84 er det første tilfellet (E-1411): fiksen var lokal mens
`origin/zaicode` fortsatt bar koden før fiksen.

**UNSAFE_TO_EMULATE** — alt som ville fått en kun-lokal port til å se grønn ut.
Ikke stubb launcher-byggingen, ikke foreta en falsk kjøring av en pakket app,
ikke spille av en registrert `pnpm verify:pre-push`-resultat som om det nettopp var kjørt,
og ikke gjøre «koden ser riktig ut» om til en PASS-linje i `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — samsvar som avhenger av hvor utsjekkingen
ligger. På kjernen `3088eff` rapporterer skyvalidatoren `closure-evidence`
FEIL (T-47, T-62, T-76, T-78 ved skrivetid) som operatørmaskinen
ikke gjør.

Kjernen flytter alle LOG-hendelser over 1024 byte til en
`.saipen/recovery/log-detail/`-sidecar ved lesing. Den gjenoppretter sidecaren bare
når utsjekkingens absolutte sti er lik stien den ble skrevet fra. En lang
VERIFY-dom skrevet på Windows er derfor uleselig i skyen, og motsatt
gjelder også.

Feilen ligger i kjernen og er meldt inn som P1-1 i
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Inntil den lander:

- siter sky-dommen og klassifiser den som denne grensen, billett for billett
  (`SKILL.md` § 6 har sjekken);
- aldri skriv om sidecars, verifiser ikke på nytt bare for å få grønt, og ikke patch kjernen
  kopien;
- hold LOG-hendelser under 1024 byte på begge sider.

Samme maskinbane-binding blokkerer også arbeid. Gjeldsbaselinen før BUILD
blir fanget første gang et billett går inn i BUILD, og kontrolleres på nytt ved
hvert senere inngang. Et billett som første gang gikk inn i BUILD på operatormaskinen
kan derfor ikke gå inn i BUILD i skyen: overgangen avvises med
`DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 er saken på registeret: DEBT-000079 ble
fanget ved E-1377, og overgangen avvist ved E-1446. La slike billetter være
på maskinen som fanget baselinen.

## Avvik

Hvis lokal og ekstern slutter å dele en stamfar, stopper overvåkeren. Den
slår ikke sammen, rebaserer eller tvinger. Begge commit-id-ene havner i loggen, og retningen
`git log --left-right --cherry-pick <branch>...origin/<branch>` for hånd, mens
resultatet sjekkepunktes som enhver annen endring.

## Den eksakte handlingen i skyen

### Oppsettsskript for miljøet (én gang, i sky-miljøets innstillinger)

Sky-miljømenyen i sesjonens tittelfelt -> Edit -> Setup script. Det
kjører før hver ny sesjon, slik at hver sesjon starter med verktøysettet klart:

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

### Prompten for hver ny sesjon

Start sesjonen på repositoriet `vacterro/zaicode`, grenen `saipen-live`, og
pass på at agenten på operatormaskinen ikke skriver samtidig.
Bytt ut siste linje med `cc all <new list>` for å gi fra deg nytt arbeid.

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

På operatormaskinen spoler overvåkeren `zcode` fremover fra
`origin/zaicode`; `REBUILD.cmd` (eller `REBUILD_fast.lnk`) bygger den, og
neste start av ZAICODE bytter inn den nye versjonen.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
