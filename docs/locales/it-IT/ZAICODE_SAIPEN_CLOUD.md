# ZAICODE trasporto cloud SAIPEN

Come questo checkout e una sessione Claude Code Cloud eseguono un workspace SAIPEN
con località di esecutore diversa, e dove sta il confine tra loro.

## La forma

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Un ramo trasporta lo stato del protocollo. Nessun merge, nessun rebase,
nessun secondo ramo locale da tenere allineato: chiunque esecutore abbia un
checkpoint verificato lo committa e lo pusha, e l'altra parte lo prende con
un fast-forward.

`master` è la storia pre-trasporto e il ramo default pubblicato. Non è
forzato dal trasporto.

## Cosa viaggia e cosa no

Un checkpoint in questo repository trasporta lo stato del protocollo SAIPEN, il
launcher root, l'installer, la documentazione e questi script di trasporto. Tutta
quella è l'intero layer del workspace.

Trasporta **nessun byte di prodotto**. `zcode/` è un repository Git separato,
elencato in `.saipen/source-nested-repos.json` e gitignored a questa root
(`/zcode/`). Il lavoro di prodotto richiede un proprio clone di `vacterro/zaicode` sul ramo
`zaicode`: quel clone è un secondo oggetto indipendente, con storia propria.

La conseguenza si fraintende facile: un `git status` pulito a questa root non dice
nulla sul lavoro di prodotto non committato, e un fast-forward di `saipen-live` non dice
nulla sul codice di prodotto. Controlla `git -C zcode status` esplicitamente.

## Metà locale

Due script, entrambi di proprietà del repo, così una macchina nuova li prende dal repository
invece che dalla memoria:

| File | Ruolo |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | valida, riconcilia il branch, installa e avvia il watcher, scrive la voce di avvio automatico, dimostra locale == remoto |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | il ciclo: fetch, confronto, fast-forward o push, log, pausa; poi il passaggio prodotto e l'auto-aggiornamento |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | round-trip da un esecutore indipendente più prova di ripristino a freddo |
| `tools/saipen-cloud/Test-ProductSync.ps1` | passaggio prodotto e auto-aggiornamento su repository Git usa-e-getta (nessuna rete, nessun remoto reale) |


Installazione e riparazione:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

È idempotente. Lo stato locale della macchina vive in `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (una copia), `ZAICODE_cloud-sync.log` (ruotato a
2 MB verso `.log.1`), `ZAICODE_cloud-sync.lock` (istanza singola),
`ZAICODE_cloud-sync.pid` e una voce nella cartella Startup
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Il programma di installazione rifiuta un albero sporco e non lo ripulisce mai. Se ogni percorso sporco è stato canonico SAIPEN sotto `.saipen/`, lo dice e stampa i comandi esatti di checkpoint; è uno stato del protocollo senza checkpoint, non un guasto di trasporto, e l'installer non lo committerà alle spalle del protocollo.

## Comportamento del watcher

| Situazione | Azione |
|-----------|------|
| pulito, locale è antenato del remoto | `git merge --ff-only` |
| pulito, remoto è antenato del locale | `git push` |
| sporco | pausa; nemmeno un fetch |
| su un altro branch | pausa |
| entrambi avanzati, senza antenato comune | pausa, registra entrambi gli id di commit, non fondere nulla |
| fetch o rete falliti | registra degrado, riprova al prossimo tick |
| merge/rebase/cherry-pick in corso | pausa |

Mai: force push, hard reset, stash, clean, checkout di un branch estraneo,
commit, o arresto per nome del processo. L'installer ferma un watcher solo tramite il
pid registrato nel proprio pid file.

Un albero sporco non costa nulla, perché il watcher controlla lo sporco prima di fare il fetch.
Un checkout inattivo quindi non effettua alcuna chiamata di rete.

### Passaggio prodotto (T-90)

`zcode/` è un repository autonomo, quindi la tabella sopra non sposta mai codice
di prodotto. Dopo di esso, lo stesso tick gestisce il checkout del prodotto (`-ProductRepo`,
predefinito `<repo>\zcode`; branch `-ProductBranch`, predefinito `zaicode`). Il
passaggio prodotto viene eseguito indipendentemente dal fatto che l'albero esterno sia sporco. Esegue solo pull.

| Situazione | Azione |
|-----------|------|
| remote avanti, nessun file in arrivo sporco qui | `git merge --ff-only`; il lavoro di prodotto non committato resta com'è |
| remote avanti, un file in arrivo è sporco qui | HELD: registra i file, non fondere nulla |
| locale avanti | registra; **mai pushato** (il prodotto è pubblicato da SAIPEN SHIP) |
| divergenti | pausa, registra entrambi gli id, non fondere nulla |
| altro branch, operazione git in corso, fetch fallito | pausa |
| nessun checkout di `zcode/`, o `-NoProduct` | saltato |

git rifiuta da solo un fast-forward che sovrascriverebbe una modifica locale, quindi
il controllo HELD è una guardia preventiva più chiara, non l'unica. Un
fast-forward di prodotto non ricostruisce nulla: per testare, esegui `pnpm bundle:zaicode` (o
l'anteprima dev).

### Auto-aggiornamento (T-90)

Il watcher gira come copia sotto `%APPDATA%\SAIPEN`, quindi un watcher più recente nel
repository non è mai stato eseguito senza reinstallazione. In loop mode ora confronta
il proprio file con la copia committata del repository a ogni passaggio. Installa
quel copia sopra sé stesso e riavvia esattamente una volta, con gli stessi argomenti,
solo se valgono tutte queste condizioni:

- i due file differiscono;
- la copia del repository non ha modifiche non committate;
- la copia del repository viene analizzata senza errori.

Una copia che non viene analizzata viene rifiutata e registrata, e il watcher in
esecuzione prosegue.

I watcher installati prima di T-90 non hanno né il passaggio di prodotto né l'auto-aggiornamento.
Riesegui `Install-SaipenLiveSync.ps1` una volta su una macchina di questo tipo; dopo, il
watcher si aggiorna da solo.

## Metà cloud

`CLAUDE.md` alla root è la regola d'ingresso e
`.claude/skills/saipen/SKILL.md` è la procedura di esecuzione. La skill scarica
il kernel SAIPEN da `github.com/vacterro/saipen` e lo esegue attraverso la
superficie di engine dichiarata `tools/saipen.py`. Il kernel è fissato per commit
(`3088eff`), mai per tag. Il tag `v8.0.1` è un kernel più vecchio con lo
stesso `VERSION`; il suo `validate` muta lo stato, e il suo validatore rifiuta questa board.

`STATE.saipen_home` registra il percorso del kernel dell'executor che ha
checkpointato per ultimo. In cloud, il primo `saipen continue` sul kernel `3088eff` lo
converge verso il kernel in esecuzione come un unico `DEC` journalizzato (E-1410). Sulla
macchina dell'operatore il puntatore arriva morto allo stesso modo. Un kernel con
convergenza automatica lo ripara con `continue`; altrimenti esegui
`saipen rebind-home --auto`.

**Il viaggio di ritorno è osservato.** E-1562 (cloud) ha convergento il puntatore su `/home/user/zaicode/.claude/saipen-protocol`; E-1571 (macchina operatore) l'ha riportato direttamente a `V:/.../_SAIPEN`, automaticamente, senza alcun `rebind-home` manuale. Entrambe le direzioni sono la stessa convergenza automatica, quindi aspettati un `saipen_home` `DEC` per ogni cambio di località e trattalo come rumore previsto, non come difetto. Resta rumore finché P1-2 (`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) non sposta il puntatore fuori dallo stato versionato; non implementare P1-2 come effetto collaterale dell'averlo notato. Non modificare mai il puntatore a mano.

`STATE.saipen_home` può puntare a un **checkout di sviluppo** del kernel più avanti del pin, non a un clone `3088eff` pulito — sulla macchina operatore è il ramo `accepted-debt-rebind` con lavoro non committato. Un kernel che non è al commit pinnato non è automaticamente sbagliato, ma non è nemmeno una sorgente clean-room, quindi la regola sotto sul contratto di voce vale per esso a piena forza. Non committare, non usare stash, non resettare, non fare checkout né clean di nulla in un checkout di questo tipo; il ripristino mirato di un singolo file di `saipen/STYLE.md` è l'unica eccezione consentita, e solo quando richiesto dall'operatore.

### STYLE.md non è un'impostazione locale

`saipen/STYLE.md` deve essere **identico byte per byte al file del kernel pinnato** su ogni macchina, in ogni copia, senza eccezioni e senza modifiche locali. Su una macchina operatore esiste più di una copia:

- il checkout del kernel in `STATE.saipen_home` (un clone Git, sulla macchina operatore un checkout di sviluppo);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, popolata dall'attività pianificata `saipen-inject` (`bootstrap/schedule-run.ps1`). **Non è un repository Git**, quindi `git checkout` non può mai ripararla — l'unica via è una risincronizzazione tramite l'injector, oppure una scrittura diretta del contenuto pubblicato.

Il token `style_contract` in `.saipen/STATE.md` è un hash del testo di quel file (`tools/validate.py`, `style_contract_token`: CRLF normalizzati, riga `style_contract:` esclusa). Modifica `reply_language` in una copia e il token si sposta; l'altra copia e il cloud, che recupera il kernel pubblicato, mantengono il token pubblicato, e ogni scrittura CLI dal lato non corrispondente viene rifiutata con `style_contract ... does not match the installed STYLE.md marker`.
Questo è tutto il guasto: il lato locale scrive uno stato che il cloud non può scrivere.

**Cambiare la lingua delle risposte è un commit del kernel più un repin**, mai una modifica locale. Cambiala nel repository del kernel, pubblicala, ripinnа il commit in SKILL.md e aggiorna `STATE.style_contract` tramite `saipen recover`. Una modifica locale a `STYLE.md` desincronizza ogni macchina diversa da quella che la sta effettuando.

Una trappola da segnalare: il `bin/saipen` pubblicato è uno shim legato alla macchina che hardcodifica i percorsi assoluti di interprete e checkout di un solo operatore. Funziona su esattamente una macchina. Il cloud deve usare `python3 tools/saipen.py`.

Scorciatoie: `cc` continua il Work corrente; `cc all <text>` ingerisce l'intero messaggio come sorgente/appends e continua ogni Work eleggibile. Nessuna delle due chiede conferma di routine.

## Classificazione delle capacità

**AVAILABLE_IN_CLOUD** — stato del protocollo e layer del workspace. Lettura e scrittura di `.saipen/`, il launcher (`tools/launcher/ZaicodeLauncher.cs`), l'installer sotto `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` e gli script di trasporto. Lettura Git, commit, push e fetch su `saipen-live`. Qualsiasi gate che sia un'asserzione su file, una revisione di diff o un controllo testuale.


**LOCAL_WINDOWS_ONLY** — i gate che richiedono questa macchina.

| Gate | Perché |
|------|-----|
| `tools\launcher\build.cmd` | compila `ZaicodeLauncher.cs` con .NET Framework `csc`; nessun Windows SDK su un'immagine cloud |
| E2E Electron pacchettizzato (`zcode` desktop, Solo → coda → dispatch) | richiede una sessione desktop e un profilo provider inizializzato |
| il 9router in esecuzione | un servizio Windows su questa macchina |
| click-through desktop interattivo | una persona e uno schermo |
| i casi di runtime del watcher | il watcher gira solo sulla macchina che contiene il checkout |

Questi sono registrati come confini di accettazione solo locali. Non sono mai riportati come superati perché il diff sembrava corretto.

**SAFE_TO_DEFER** — il layer di prodotto. Una sessione cloud può clonare il branch `zaicode` di `vacterro/zaicode` e lavorare lì. Il lavoro sul layer workspace non richiede interventi sul prodotto, ma richiede il clone:
`.saipen/source-nested-repos.json` dichiara `zcode/`, e senza di esso il validatore fallisce con `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. I gate di `pnpm` richiedono pnpm 10.33.2 pinnato e un workspace preparato. `pnpm bootstrap` su un'immagine cloud nuova è il modo documentato per iniziare, e `package.json` del prodotto lo dichiara già.

Il cloud può verificare solo i byte di prodotto presenti su `origin/zaicode`. Un delta di prodotto che esiste solo nel checkout `zcode/` dell'operatore è invisibile qui, quindi ogni gate di prodotto per esso è NOT RUN nel cloud, qualunque sia il gate. T-84 è il primo caso (E-1411): la correzione era solo locale mentre `origin/zaicode` conteneva ancora il codice pre-correzione.

**UNSAFE_TO_EMULATE** — qualsiasi cosa che faccia sembrare verde un gate solo locale.
Non stubbare la build del launcher, non simulare un'esecuzione dell'app pacchettizzata, non riprodurre un risultato registrato di `pnpm verify:pre-push` come se fosse appena stato eseguito, non convertire «il codice sembra corretto» in una riga PASS in `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — conformità che dipende da dove si trova il checkout.
Su kernel `3088eff` il validatore cloud segnala FAIL di `closure-evidence` (T-47, T-62, T-76, T-78 al momento della scrittura) che la macchina dell'operatore non segnala.

Il kernel sposta qualsiasi evento LOG oltre 1024 byte in un sidecar `.saipen/recovery/log-detail/`. In lettura ripristina il sidecar solo quando il percorso assoluto del checkout coincide con quello da cui è stato scritto. Un verdetto VERIFY lungo scritto su Windows è quindi illeggibile nel cloud, e vale anche il contrario.

Il difetto è nel kernel ed è registrato come P1-1 in `docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Finché non viene applicato:

- cita il verdetto del cloud e classificalo come questo confine, ticket per ticket
  (`SKILL.md` § 6 contiene il controllo);
- non riscrivere mai i sidecar, non riverificare solo per ottenere il verde, non patchare la copia
  del kernel;
- mantieni gli eventi LOG sotto 1024 byte su entrambi i lati.

Anche il vincolo del percorso macchina blocca il lavoro. Il debito di pre-BUILD viene acquisito la prima volta che un ticket entra in BUILD e ricontrollato a ogni ingresso successivo. Un ticket entrato la prima volta in BUILD sulla macchina dell'operatore non può quindi entrare in BUILD nel cloud: la transizione viene rifiutata con `DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 è il caso registrato: DEBT-000079 acquisito a E-1377, transizione rifiutata a E-1446. Lascia questi ticket alla macchina che ha acquisito il baseline.

## Divergenza

Se locale e remoto smettono di condividere un antenato, il watcher si ferma. Non fa merge, rebase né force. Entrambi i commit id finiscono nel log, la correzione è `git log --left-right --cherry-pick <branch>...origin/<branch>` a mano, e il risultato viene messo in checkpoint come qualsiasi altra modifica.

## L'azione esatta lato cloud

### Script di setup dell'ambiente (una volta, nelle impostazioni dell'ambiente cloud)

Menu dell'ambiente cloud nella barra del titolo della sessione -> Edit -> Setup script. Viene eseguito prima di ogni nuova sessione, così ogni sessione parte con la toolchain del prodotto già pronta:

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

### Il prompt per ogni nuova sessione

Avvia la sessione sul repository `vacterro/zaicode`, branch `saipen-live`, e
  assicurati che l'agent sulla macchina dell'operatore non stia scrivendo nello stesso momento.
  Sostituisci l'ultima riga con `cc all <new list>` per passare il lavoro nuovo.

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

Sulla macchina dell'operatore il watcher fa fast-forward di `zcode` da
`origin/zaicode`; `REBUILD.cmd` (o `REBUILD_fast.lnk`) lo builda, e
il successivo avvio di ZAICODE sostituisce la nuova build.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
