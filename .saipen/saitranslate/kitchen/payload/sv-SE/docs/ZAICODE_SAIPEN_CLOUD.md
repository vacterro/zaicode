# ZAICODE SAIPEN molntransport

Hur den här utcheckningen och en Claude Code Cloud-session kör en enda SAIPEN-arbetsyta
med olika exekveringsort, och var gränsen mellan dem går.

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

En gren bär protokollstillståndet. Det finns ingen merge-steg, ingen rebase-steg
och ingen andra lokal gren att hålla i synk: vilken exekutor som har en verifierad
checkpoint committar och pushar den, och den andra sidan tar den med en
fast-forward.

`master` är förhistoriken före transporten och den publicerade standardgrenen. Den
tvingas inte uppdateras av transporten.

## Vad som färdas och vad som inte gör det

En checkpoint i det här repot bär SAIPEN-protokollstillståndet, rot-startaren,
installationsprogrammet, dokumentationen och dessa transportskript. Det är
hela arbetsytelagret.

Den bär **ingen produktbyte**. `zcode/` är ett separat Git-repo, listat
i `.saipen/source-nested-repos.json` och gitignorat i den här roten
(`/zcode/`). Produktarbete behöver sin egen klon av `vacterro/zaicode` på grenen
`zaicode`, och den klonen är ett andra, oberoende objekt med sin egen historik.

Följden är lätt att ta fel på: en ren `git status` i den här roten säger
ingenting om ocommittat produktarbete, och en `saipen-live` fast-forward säger
ingenting om produktionskod. Kontrollera `git -C zcode status` uttryckligen.

## Den lokala halvan

Två skript, båda ägda av repot så att en ny maskin får dem från repot
istället för från minnet:

| Fil | Roll |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | validerar, sammanställer branchen, installerar och startar bevakaren, skriver autostart-posten, bevisar lokal == fjärr |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | loopen: hämta, jämför, fast-forward eller pusha, logga, pausa; sedan produktgenomgång och självuppdatering |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | rundtur från en oberoende exekverare plus bevis för kallåterhämtning |
| `tools/saipen-cloud/Test-ProductSync.ps1` | produktgenomgång och självuppdatering mot engångs-Git-repositorier (inget nätverk, ingen riktig fjärr) |

Installera och reparera:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Den är idempotent. Maskinlokal tillstånd ligger i `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (en kopia), `ZAICODE_cloud-sync.log` (roteras vid
2 MB till `.log.1`), `ZAICODE_cloud-sync.lock` (en enda instans),
`ZAICODE_cloud-sync.pid` och en post i Startup-mappen
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Installationsprogrammet vägrar ett smutsigt träd och rensar det aldrig. Om alla smutsiga sökvägar är
kanonisk SAIPEN-tillstånd under `.saipen/`, säger det detta och skriver ut exakta
checkpunktskommandon; det är ett protokolstillstånd utan checkpoint, inte en transport-
fel, och installationsprogrammet kommer inte att committa det bakom protokollets rygg.

## Bevakarens beteende

| Situation | Åtgärd |
|----------|------|
| rent, lokal är en förfader till fjärr | `git merge --ff-only` |
| rent, fjärr är en förfader till lokal | `git push` |
| smutsigt | pausa; inte ens en hämtning |
| på en annan branch | pausa |
| båda gått framåt, ingen gemensam förfader | pausa, logga båda commit-id, slå inte ihop något |
| hämtning eller nätverk misslyckades | logga försämrat läge, försök igen nästa tick |
| en merge/rebase/cherry-pick pågår | pausa |

Aldrig: force push, hard reset, stash, clean, checkout av främmande branch,
commit eller stopp via processnamn. Installationsprogrammet stoppar bara en bevakare med
det pid den registrerat i sin egen pid-fil.

Ett smutsigt träd kostar ingenting, eftersom bevakaren kontrollerar smutsighet innan den hämtar.
En inaktiv checkout gör alltså inga nätverksanrop alls.

### Produktgenomgång (T-90)

`zcode/` är ett eget repositorium, så tabellen ovan flyttar aldrig produkt-
kod. Efter den hanterar samma tick produkt-checkouten (`-ProductRepo`,
standard `<repo>\zcode`; branch `-ProductBranch`, standard `zaicode`). 
Produktgenomgången körs oavsett om det yttre trädet är smutsigt. Den drar bara.

| Situation | Åtgärd |
|-----------|------|
| remote före, ingen inkommande fil är ändrad här | `git merge --ff-only`; ocommittat produktarbete lämnas som det är |
| remote före, en inkommande fil är ändrad här | HELD: logga filerna, merge ingenting |
| lokal före | logga; **aldrig pushad** (produkten publiceras av SAIPEN SHIP) |
| divergerat | pausa, logga båda id:n, merge ingenting |
| annan branch, en git-åtgärd pågår, fetch misslyckades | pausa |
| ingen `zcode/`-checkout, eller `-NoProduct` | hoppad |

git vägrar själv en fast-forward som skulle skriva över en lokal ändring, så HELD-kontrollen är ett tidigare, tydligare skydd, inte det enda. En produkt-fast-forward bygger inte om något: för att testa, kör `pnpm bundle:zaicode` (eller dev-förhandsvisningen).

### Självuppdatering (T-90)

Watchern körs som en kopia under `%APPDATA%\SAIPEN`, så en nyare watcher i repot har aldrig körts utan reinstallering. I loop-läge jämför den nu sin egen fil med repots committade kopia varje omgång. Den installerar den kopian över sig själv och startar om exakt en gång, med samma argument, endast när allt av detta stämmer:

- filerna skiljer sig åt;
- repokopian har inga ocommittade ändringar;
- repokopian parsas utan fel.

En kopia som inte parsas avvisas och loggas, och den körande watchern fortsätter.

Watchers installerade före T-90 saknar både produktgenomgången och självuppdateringen. Kör `Install-SaipenLiveSync.ps1` en gång på en sådan maskin; efter det uppdaterar watchern sig själv.

## Molnhalvan

`CLAUDE.md` i roten är intreregeln och `.claude/skills/saipen/SKILL.md` är utförandeförfarandet. Skillen hämtar SAIPEN-kerneln från `github.com/vacterro/saipen` och kör den via den deklarerade motorytan `tools/saipen.py`. Kerneln låses fast på commit (`3088eff`), aldrig på tagg. Tagg `v8.0.1` är en äldre kernel med samma `VERSION`; dess `validate` muterar state, och dess validator avvisar den här boarden.

`STATE.saipen_home` registrerar kernelvägen för den executor som checkpointade sist. I molnet konvergerar den första `saipen continue` på kernel `3088eff` den till den körande kerneln som en enda journaliserad `DEC` (E-1410). På operatörmaskinen kommer pekaren in död på samma sätt. En kernel med automatisk konvergens reparerar den vid `continue`; annars kör `saipen rebind-home --auto`.

**Återvägen observeras.** E-1562 (molnet) konvergerade pekaren till `/home/user/zaicode/.claude/saipen-protocol`; E-1571 (operatörsmaskinen) konvergerade den rakt tillbaka till `V:/.../_SAIPEN`, automatiskt, utan manuell `rebind-home`. Båda riktningarna är samma automatiska konvergens, så räkna med en `saipen_home` `DEC` per lokplatsbyte och behandla det som förväntat brus, inte som ett fel. Det förblir brus tills P1-2 (`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) flyttar pekaren ur versionsstyrd state; implementera inte P1-2 som en sidoeffekt av att du märker det. Redigera aldrig pekaren för hand.

`STATE.saipen_home` kan peka på en kernel-**utvecklingskopia** som ligger före pinnningen, inte på en ren `3088eff`-klon — på operatörsmaskinen är det `accepted-debt-rebind`-grenen med ocommittat arbete. En kernel som inte står på den pinnade committen är inte automatiskt fel, men den är inte heller en clean-room-källa, så regeln nedan om röstkontraktet gäller med full kraft. Committa, stash, resetta, checka ut eller städa aldrig något i en sådan kopia; en riktad återställning av en enda fil, `saipen/STYLE.md`, är det enda tillåtna undantaget, och endast när operatören ber om det.

### STYLE.md är inte en lokal inställning

`saipen/STYLE.md` måste vara **byte-identisk med den pinnade kernens fil** på varje maskin, i varje kopia, utan undantag och utan lokala ändringar. Det finns mer än en kopia på en operatörsmaskin:

- kernelkopian på `STATE.saipen_home` (en Git-klon, på operatörsmaskinen en utvecklingskopia);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, fylld av den schemalagda uppgiften `saipen-inject` (`bootstrap/schedule-run.ps1`). Den är **inte ett Git-repositorium**, så `git checkout` kan aldrig reparera den — en synkronisering om via injektorn, eller en direkt skrivning av det publicerade innehållet, är den enda vägen.

`style_contract`-token i `.saipen/STATE.md` är ett hash över den filens text (`tools/validate.py`, `style_contract_token`: CRLF-normaliserat, `style_contract:`-raden utesluten). Ändra `reply_language` i en kopia och token flyttas; den andra kopian och molnet, som hämtar den publicerade kerneln, behåller den publicerade token, och varje CLI-skrivning på den missmatchande sidan avvisas med `style_contract ... does not match the installed STYLE.md marker`.
Det är hela felet: den lokala sidan skriver state som molnet inte kan skriva.

**Att byta svarsspråk är en kernel-commit plus en ompinnning**, aldrig en lokal ändring. Ändra det i kernelrepositoriet, publicera, pinn om committen i SKILL.md och uppdatera `STATE.style_contract` via `saipen recover`. En lokal ändring i `STYLE.md` desynkar varje maskin som inte är den som gör ändringen.

En fälla värd att nämna: den publicerade `bin/saipen` är en maskinbunden shim som hårdkodar en operatörs absoluta interpretator- och kopia-sökvägar. Den körs på exakt en maskin. Molnet måste använda `python3 tools/saipen.py`.

Kortkommandon: `cc` fortsätter det aktuella Worket; `cc all <text>` tar in hela meddelandet som source/appends och fortsätter varje berättigat Work. Ingen av dem begär rutinmässig bekräftelse.

## Förmågeklassificering

**AVAILABLE_IN_CLOUD** — protokollstillstånd och arbetsytelager. Läsning och
skrivning av `.saipen/`, startprogrammet (`tools/launcher/ZaicodeLauncher.cs`),
installationsprogrammet under `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` och
transportskripten. Git-läsning, commit, push och fetch på `saipen-live`. Alla
grindar som är filpåståenden, diffgranskning eller textkontroll.

**LOCAL_WINDOWS_ONLY** — grindarna som kräver den här maskinen.

| Grind | Varför |
|------|-----|
| `tools\launcher\build.cmd` | kompilerar `ZaicodeLauncher.cs` med .NET Framework `csc`; ingen Windows SDK i molnbilden |
| paketerad Electron E2E (`zcode` desktop, Solo → kö → dispatch) | kräver en desktop-session och en initierad providerprofil |
| den levande 9router | en Windows-tjänst på den här maskinen |
| interaktiv desktop-klickgenomgång | en människa och en skärm |
| watcherns egna runtime-fall | watchern körs bara på maskinen som innehar utcheckningen |

Dessa registreras som lokala acceptansgränser. De rapporteras aldrig som
godkända enbart för att diffen såg rätt ut.

**SAFE_TO_DEFER** — produktlagret. En molnsession kan klona
`vacterro/zaicode` gren `zaicode` och arbeta där. Arbetsytelagerarbete kräver
inte produktarbete, men det kräver klonen:
`.saipen/source-nested-repos.json` deklarerar `zcode/`, och utan den misslyckas
validatorn med `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. `pnpm` gates kräver den fästade pnpm 10.33.2
och en förberedd arbetsyta. `pnpm bootstrap` på en färsk molnbild är det
dokumenterade sättet in, och produktens `package.json` deklarerar den redan.

Molnet kan bara verifiera produktbyte som finns på `origin/zaicode`. En
produktdelta som bara finns i operatörens `zcode/`-utcheckning är
osynlig här, så varje produktgrind för den är INTE KÖRD i molnet, oavsett
vilken grind det är. T-84 är det första fallet (E-1411): dess fix var lokal medan
`origin/zaicode` fortfarande bar koden före fixen.

**UNSAFE_TO_EMULATE** — allt som skulle få en lokal grind att se grön ut.
Stubba inte launcherbygget, hitta inte på en körning av en paketerad app, spela
inte upp ett registrerat `pnpm verify:pre-push`-resultat som om det just körts, och
konvertera inte "koden ser korrekt ut" till en PASS-rad i `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — överensstämmelse som beror på var utcheckningen
ligger. På kernel `3088eff` rapporterar molnvalidatorn `closure-evidence` FAIL
(T-47, T-62, T-76, T-78 vid tidpunkten för skrivandet) som operatörsmaskinen
inte gör.

Kerneln flyttar varje LOGG-händelse över 1024 byte till en
`.saipen/recovery/log-detail/`-sidofil. Vid läsning återställer den sidofilen endast
när utcheckningens absoluta sökväg är lika med den sökväg den skrevs från. Ett
långt VERIFY-utslag skrivet på Windows är därför oläsbart i molnet, och
tvärtom gäller också.

Felet ligger i kerneln och är registrerat som P1-1 i
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Tills det landar:

- citera molndomen och klassificera den ticket för ticket som denna gräns
  (`SKILL.md` § 6 har kontrollen);
- skriv aldrig om sidecars, verifiera inte om bara för att få grönt, och patcha
  inte kernelkopian;
- håll LOG-händelser under 1024 byte på båda sidor.

Samma maskinvägsbindning blockerar också arbete. Skuldbaslinjen före
BUILD fångas första gången en ticket går in i BUILD och kontrolleras om vid
varje senare inträde. En ticket som första gången gick in i BUILD på
operatörsmaskinen kan därför inte gå in i BUILD i molnet: övergången nekas
med `DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 är fallet som finns registrerat: DEBT-000079
fångades vid E-1377 och övergången nekades vid E-1446. Lämna sådana
tickets till maskinen som fångade dess baslinje.

## Divergens

Om lokalt och fjärrbart slutar dela en förfader stannar watcher. Den
mergar, rebasar eller tvingar inte. Båda commit-id:n loggas, fixen görs
`git log --left-right --cherry-pick <branch>...origin/<branch>` manuellt, och
resultatet checkpointas som vilken annan ändring.

## Den exakta åtgärden i molnet

### Miljösetup-skript (en gång, i molnmiljöns inställningar)

Molnmiljö-menyn i sessionens titelfält -> Edit -> Setup script. Det
körs före varje ny session, så varje session startar med produktens
verktygskedja redo:

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

### Prompten för varje ny session

Starta sessionen på repositorium `vacterro/zaicode`, gren `saipen-live`, och
se till att operatörsmaskinens agent inte skriver samtidigt.
Ersätt sista raden med `cc all <new list>` för att lämna över nytt arbete.

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

På operatörsmaskinen gör watcher fast-forward av `zcode` från
`origin/zaicode`; `REBUILD.cmd` (eller `REBUILD_fast.lnk`) bygger den, och
nästa start av ZAICODE byter in den nya byggningen.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
