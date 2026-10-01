# Installare ZAICODE

ZAICODE è tre progetti che funzionano come uno: l'app ZAICODE, SAIPEN (il
protocollo che mantiene il lavoro degli agenti in linea) e SAIMAIL (la posta
usata dagli agenti per comunicare). Installarli a mano significa tre clone, un
toolchain Node.js, un ambiente Python e una build. L'installer fa tutto:
lancialo, attendi, e sul desktop troverai un collegamento a ZAICODE.

## Un clic

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  scarica, fai doppio clic, premi **INSTALLA**. La finestra (oro su scuro, il
  banner SAIPEN) mostra ogni passo mentre viene eseguito, il tempo trascorso e
  il log su richiesta; alla fine **AVVIA ZAICODE**, oppure **RIPROVA** / **Autotroubleshoot**
  / **Apri log** quando un passo non è stato completato. Puntato a una cartella
  ZAICODE esistente il pulsante mostra **AGGIORNA**: la stessa esecuzione aggiorna
  e ripara. L'exe contiene gli script di installazione e non ha bisogno di nulla
  accanto; è compilato da `install\setup\build.cmd` (il compilatore .NET Framework presente
  in ogni Windows 10/11).
- `install\Setup-ZAICODE.cmd` (doppio clic): la stessa installazione in console.
- Da zero, in PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Opzioni di installazione: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (cartella preset),
`/auto` (si avvia subito), `/quiet` (nessuna finestra: il programma di installazione a console, il codice di uscita
= risultato). La prima esecuzione compila l'app su questa macchina, il che richiede tempo;
quelle successive solo aggiornano e riparano.

## Modelli gratuiti, nulla da configurare

L'app include il proprio 9router. Su una macchina senza 9router ZAICODE lo esegue
in privato (modalità isolata, porta 20138), riempi **SAIFREN** con i piani gratuiti
senza chiave e imposta `SAIRoute / SAIFREN` come modello delle nuove attività, così la prima attività
digitata in Nuova attività riceve una risposta: nessuna chiave, nessun account, nessuna impostazione. Claude
Code, Codex e Antigravity sono facoltativi; un login non configurato sulla
macchina compare come "facoltativo, accedi quando vuoi", non come "richiede te".
Prova: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
avvia l'app impacchettata con un profilo vuoto (il proprio HOME, APPDATA e
LOCALAPPDATA) e passa solo se il router è isolato, SAIFREN risponde al suo
test del primo token e un'attività in Nuova attività riceve risposta.

## Aggiornamenti: quattro parti, un ZAICODE

L'area di lavoro (launcher, installer), l'app, SAIPEN e SAIMAIL sono quattro
cloni. Ogniuno si aggiorna da solo: **Impostazioni -> ZAICODE -> Aggiornamenti** li elenca
con versione e commit, li aggiorna uno alla volta o tutti, e ha un interruttore "da solo"
per ogni parte (attivo per impostazione predefinita in un ZAICODE installato, disattivo
in una copia per sviluppatori). ZAICODE controlla qualche minuto dopo l'avvio e poi
every six ore -> ogni sei ore. Dopo un aggiornamento ogni parte ottiene ciò che le serve: l'app le sue
dipendenze (quando `pnpm-lock.yaml` è cambiato) e una nuova build (preparata mentre
ZAICODE è in esecuzione, avviata alla successiva apertura), SAIPEN il suo launcher, SAIMAIL la sua
installazione `.venv`, l'area di lavoro un nuovo launcher radice. Un clone su un altro ramo,
con commit locali o con modifiche che l'aggiornamento sovrascriverebbe viene segnalato e
lasciato esattamente com'è.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Cosa fa

L'installer è l'insieme dei controlli Autotroubleshoot eseguiti con "repair" su una cartella
vuota, in questo ordine. Ogni passo è idempotente, quindi rieseguirlo aggiorna
l'installazione e ripara ciò che si è rotto.

| Controllo | Riparazione |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | usa la copia della macchina quando è adatta; altrimenti una copia privata in `.tools\` (MinGit da Git for Windows, Node.js 24.14.0 da nodejs.org, Python dal suo pacchetto NuGet). Nessun diritto di amministratore. |
| pnpm | il pnpm 10.33.2 fissato in `.tools\pnpm10` |
| Area di lavoro ZAICODE | clone del ramo `vacterro/zaicode` `master` (sorgente del launcher, installer, documentazione; la memoria `.saipen/` dello sviluppatore è esclusa; ramo `workspace` fino al 2026-09-27) |
| Sorgente dell'app ZAICODE | clone del ramo `zaicode` in `zcode\` |
| SAIPEN | clone di `vacterro/saipen` in `saipen\`; il suo `bin\saipen.cmd` è scritto per questo clone e per questo Python |
| SAIMAIL | clone di `vacterro/saimail` in `saimail\`, installato in `.venv\` |
| saimail-local | client della riga di comando di SAIMAIL, usato dai pannelli SAIMAIL di ZAICODE (fornito da SAIMAIL `0.0.2a3`; il controllo `saimail-cli` segnala OK) |
| Pacchetto 9router | `9router` da npm in `.tools\router`, incluso così SAIFREN funziona senza configurazione (WARN se npm non lo raggiunge) |
| Dipendenze dell'app | `pnpm install --frozen-lockfile` (di nuovo quando `pnpm-lock.yaml` cambia) |
| Build dell'app | `pnpm bundle:zaicode`; mentre ZAICODE è in esecuzione la nuova build viene preparata e sostituita alla successiva apertura |
| Sostituzione della build preparata | rimuove un `win-unpacked.previous` lasciato da un errore di sostituzione per percorsi lunghi e sostituisce la build in attesa mentre ZAICODE è chiuso |
| Launcher radice | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Scorciatoie | `ZAICODE` -> `ZAICODE.exe` su Desktop e menu Start |
| Login Claude / Codex | solo segnalati: ogni login `~\.claude*` / `~\.codex*` è un motore a sé in ZAICODE (A1, A2, C1, ...); un login richiede te, nel browser |

Il launcher radice punta ZAICODE al SAIPEN installato (`saipen\`) e mette
`.tools\` e `.venv\Scripts` in cima al PATH dell'app, così l'app, i suoi agenti
e i suoi worker usano le copie installate.

## Più abbonamenti

Ogni login di Claude Code o Codex vive nella sua home: `~\.claude`,
`~\.claude-account2`, ... e `~\.codex`, `~\.codex-account2`, ... ZAICODE li trova
tutti. Per prepararne altri al momento dell'installazione:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

L'installer crea le home e stampa il comando di login esatto per ciascuna
(`$env:CODEX_HOME = '...'; codex login`). Lo stesso vale in ZAICODE: Impostazioni ->
Motori e limiti -> aggiungi un altro login.

## Risoluzione automatica dei problemi

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Stato per controllo: OK, FIXED (era rotto, riparato), WARN (funziona, ma manca qualcosa
facoltativo), INFO (serve te: un login), FAIL. I log sono in
`install\logs\`; il riepilogo dell'ultima installazione è `install\install-report.json`.
Nell'app, Router -> Autotroubleshoot ripara il router e le pool in esecuzione.

## Opzioni

| Parametro | Predefinito | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | dove va tutto |
| `-ShortcutDir` | Desktop | dove va il collegamento ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | salta quei collegamenti |
| `-PortableTools` | | Git / Node.js / Python privati anche se la macchina li ha già |
| `-Launch` | | avvia ZAICODE al termine |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | i repo GitHub | un'altra sorgente (un fork, un percorso di clone locale) |

## Prova

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
verifica un'installazione nuova, inietta guasti (collegamento e launcher cancellati, launcher
SAIPEN puntato a un Python mancante, venv di SAIMAIL cancellato, node_modules
registrati per un altro lockfile, una cartella di build residua più profonda di MAX_PATH),
asserisce che il doctor segnali e ripari ogni guasto, poi avvia il bersaglio del collegamento con un profilo isolato e ferma esattamente l'albero di processi che ha avviato.

`install\tests\Test-ZaicodeUpdate.ps1` costruisce quattro repository usa-e-getta su
disco e un'installazione dei loro cloni, poi dimostra che un controllo non cambia nulla,
che una singola parte si aggiorna da sola con il suo seguito (launcher SAIPEN, launcher
radice), che le modifiche locali sovrapposte e i commit locali vengono conservati, e che un
nome di parte sconosciuto viene rifiutato. Nessuna rete.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
