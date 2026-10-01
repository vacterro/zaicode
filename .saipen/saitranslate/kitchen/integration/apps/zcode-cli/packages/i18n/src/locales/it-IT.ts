import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "it-IT",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Valore --locale non supportato: ${value}. Località supportate: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Uso:
  zcode [command] [options]

Senza comando, zcode apre la TUI a schermo intero.

Comandi:
  app-server Esegue il server app stdio del ZCode Protocol
  commands   Elenca i comandi slash personalizzati (\`commands list\`)
  doctor     Verifica runtime e ipotesi di packaging
  login [zai|bigmodel]  Accesso tramite autorizzazione del browser
  logout     Rimuove le credenziali di accesso Z.AI condivise
  plugins    Gestisci plugin e marketplace (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Elenca le skill locali (\`skills list\`)
  tui        Apre l'interfaccia terminale
  version    Stampa la versione della CLI

Opzioni:
  -h, --help       Mostra la guida
  -v, --version    Mostra la versione
  -p, --prompt <testo>  Esegue un singolo prompt senza aprire la TUI
  --memory-bench   Con --prompt, abilita l'estrazione automatica della Memory e attende prima di uscire (richiede Memory attiva)
  --browser-use <modalità> Abilita il backend Browser Use (supportato: headless)
  --surface <superficie>  Superficie di presentazione per prompt headless/app-server: terminal o desktop
  --browser-executable <percorso> Eseguibile Chrome/Chromium per Browser Use headless
  --attach <percorso>  Allega un file locale a --prompt; ripeti per più file
  --cwd <percorso>     Esegue questo comando dalla directory indicata
  --disallowed-tools, --disallowedTools <strumenti...>
    Rimuove interamente gli strumenti solo per questo prompt/sessione TUI; le impostazioni salvate non cambiano.
    Nomi di strumenti separati da virgola o spazio, ad es. "Bash Edit".
    "Bash(git *)" rimuove tutto Bash; i pattern dei comandi non vengono abbinati.
  --force-mcs      Forza la proiezione di sistema a metà conversazione per i provider Anthropic
  --locale <locale>  Località della UI: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR o auto
  --mode <modalità>    Modalità di permesso per i prompt: build, edit, plan o yolo (predefinito: yolo per --prompt)
  --resume <sessionId>  Riprende una sessione persistente tramite sessionId (sess_...)
  --target <testo>  Esegue o imposta l'obiettivo della sessione in modalità headless
  --target-replace Sostituisce qualsiasi obiettivo di sessione impostato da --target
  -c, --continue        Riprende l'ultima sessione per la directory corrente
  --json           Stampa JSON leggibile dalla macchina dove supportato
  --no-browser     Stampa l'URL OAuth senza aprire il browser
  --no-color       Disattiva i colori ANSI
  --verbose        Stampa dettagli diagnostici aggiuntivi

Comandi slash:
  /help [comando]       Mostra la guida dei comandi slash
  /login                Scegli l'accesso via browser Z.AI o BigModel
  /logout               Rimuove le credenziali di accesso Z.AI condivise
  /compact [istruzioni]  Compatta la conversazione corrente
  /expert [status|resume|stop|<attività>]  Esegue o gestisce il flusso esperto
  /dwf [list|cancel|resume]  Elenca, annulla o riprendi le esecuzioni del flusso dinamico
  /fork [latest|checkpointId]  Crea una nuova sessione da un checkpoint del workspace
  /mcp [list|status|connect|disconnect]  Mostra o gestisce i server MCP
  /mode [modalità]          Mostra o cambia la modalità di permesso: build, edit, plan o yolo
  /model [id]           Mostra o cambia il modello della sessione corrente
  /new                  Avvia una nuova sessione nella TUI
  /resume [sessionId]   Riprende una sessione tramite sessionId; omettilo per l'ultima nella cwd
  /rewind [latest|checkpointId]  Mostra l'ultimo checkpoint o ripristina i file del workspace
  /skill [nome] [attività]  Elenca le skill, o forza il prossimo prompt a caricarne una
  /goal [azione]        Mostra o imposta l'obiettivo della sessione corrente
`,
  },
  tui: {
    copy: {
      copied: "Testo selezionato copiato negli appunti.",
      failed: "Impossibile copiare il testo selezionato.",
      unavailable: "La copia negli appunti del testo non è disponibile in questo terminale.",
    },
    effort: {
      disabled: "disabilitato",
      enabled: "abilitato",
    },
    input: {
      activeStatusHint: "esc per interrompere",
      busyPlaceholder: "Digita per mettere in coda l'input",
      placeholder: "Scrivi un prompt",
      queuedMore: (count) => `+ ${count} altri in coda`,
      queuedSubmitHint: "Inviato dopo la prossima chiamata agli strumenti.",
      queuedTitle: (count) => ` Coda (${count}) `,
      title: "Immissione",
      noHistorySource: "Nessuna sorgente configurata per la cronologia dell'input.",
      noPreviousInput: "Nessun input precedente per questo progetto.",
      restoredPreviousInput: "Input precedente ripristinato.",
      restoredPreviousInputWithAttachments: (count) =>
        `Input precedente ripristinato con ${count} allegato/i.`,
      restorePreviousInputFailed: "Impossibile ripristinare l'input precedente.",
      typePrompt: "Scrivi una domanda e premi Enter.",
    },
    loginRequired: {
      help: "Usa /model per vedere i modelli, oppure /login per collegare un account Coding Plan.",
      message: "Nessun modello disponibile. Configura un provider o accedi con /login.",
      status: "Nessun modello disponibile. Configura un provider o accedi con /login.",
      title: "configurazione del modello richiesta",
    },
    loginSetup: {
      emptyMessage: "Nessuna opzione di accesso disponibile.",
      help: "Usa Su/Giù per scegliere, Enter per selezionare.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Inserisci la API Key di BigModel Coding Plan",
          inputSecondary: "Incolla qui la chiave. È nascosta durante la digitazione.",
          primary: "API Key di BigModel Coding Plan",
          secondary: "Incolla manualmente una API key di Coding Plan.",
        },
        bigmodelOauth: {
          pendingPrimary: "In attesa dell'autorizzazione BigModel",
          pendingSecondary:
            "Completa l'accesso nel browser. L'autorizzazione viene rilevata automaticamente.",
          primary: "Piano BigModel Coding Plan",
          secondary: "Apri l'accesso via browser; l'autorizzazione viene rilevata automaticamente.",
        },
        zaiApiKey: {
          inputPrimary: "Inserisci la API Key di Z.AI Coding Plan",
          inputSecondary: "Incolla qui la chiave. È nascosta durante la digitazione.",
          primary: "API Key di Z.AI Coding Plan",
          secondary: "Incolla manualmente una API key di Coding Plan.",
        },
        zaiOauth: {
          pendingPrimary: "In attesa dell'autorizzazione Z.AI",
          pendingSecondary:
            "Completa l'accesso nel browser. Continuerò al termine dell'autorizzazione.",
          primary: "Z.AI Coding Plan",
          secondary: "Apri l'accesso via browser e crea una chiave API del Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Accesso annullato. Scegli un metodo di configurazione.",
        help: "Esc annulla e torna alle scelte di configurazione.",
        status: "In attesa dell'autorizzazione del browser...",
      },
      input: {
        cancelStatus: "Inserimento della chiave API annullato. Scegli un metodo di configurazione.",
        clearStatus: "Campo chiave API svuotato.",
        emptyStatus: "La chiave API è obbligatoria.",
        help: "Enter salva la chiave. Esc torna alle scelte di configurazione.",
        placeholder: "Incolla la chiave API",
        status: "Inserisci la chiave API, poi premi Enter.",
        submitStatus: "Salvataggio della chiave API...",
      },
      prompt: "Scegli un metodo di configurazione: accesso o chiave API.",
      response: "Scegli come configurare un provider Coding Plan.",
      title: "Configura Coding Plan",
    },
    model: {
      requestFailed: (message) => `Richiesta al modello non riuscita: ${message}`,
      responseReceived: "Risposta del modello ricevuta.",
      responseReceivedWithTokens: (tokens) => `Risposta del modello ricevuta. ${tokens} token.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Nuovo tentativo di richiesta al modello ${attempt}/${Math.max(1, maxAttempts - 1)} tra ${delay}: ${reason}`,
      streamStalled: "Stream del modello interrotto.",
    },
    sidebar: {
      subagents: {
        title: "Subagent",
        empty: "Nessun subagent.",
        emptyOutput: "Nessun output.",
        back: "← Conversazione principale",
        readonly: "Sola lettura · Esc per tornare",
        loading: "Caricamento dell'output del subagent...",
        unavailable: "Output del subagent non disponibile.",
        retry: "Riprova",
        more: "Carica altro",
        pendingMain: "La conversazione principale richiede il tuo input — torna indietro per rispondere",
        ended: (count) => `Terminata (${count})`,
        status: {
          running: "in esecuzione",
          waiting: "in attesa",
          blocked: "bloccata",
          success: "completata",
          failed: "non riuscita",
          cancelled: "annullata",
          lost: "persa",
        },
      },
      api: {
        empty: "Nessuna chiamata API.",
        model: "Modello",
        more: (count) => `+${count} altri`,
        requests: "Richieste",
        server: "Nodo server",
      },
      cache: {
        hit: "accesso",
        lastHit: "ultimo hit",
        lastMiss: "ultimo miss",
        readWrite: ({ read, write }) => `${read} lett. / ${write} scr.`,
        total: "totale",
      },
      context: {
        cache: "Memoria cache",
        cacheReadWrite: "Cache lettura/scrittura",
        inputOutput: "I/O",
        reason: "Motivo",
        tokens: "Token",
        used: "Usato",
        window: "Finestra",
      },
      modifiedFiles: {
        empty: "Nessuna modifica ai file.",
        more: (count) => `+${count} altri`,
      },
      mcp: {
        empty: "Nessun server MCP configurato.",
        loadFailed: "Stato MCP non disponibile.",
        loading: "Caricamento stato MCP...",
        more: (count) => `+${count} altri`,
        servers: "Server",
        status: {
          connected: "connesso",
          connecting: "connessione",
          disabled: "disabilitato",
          disconnected: "disconnesso",
          failed: "fallito",
          untrusted: "non attendibile",
        },
        summary: ({ connected, total }) => `${connected}/${total} connessi`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "completato",
        error: "errore",
        errorWithStatus: (statusCode) => `errore ${statusCode}`,
        pending: "in attesa",
      },
      status: {
        last: "Ultimo",
      },
      run: {
        draft: "Bozza",
        draftChars: (count) => `${count} caratteri`,
        draftEmpty: "vuoto",
        messages: "Messaggi",
        mode: "Modalità",
        model: "Modello",
        provider: "Fornitore",
        thought: "Pensiero",
        trace: "Traccia",
        turn: "Turno",
        workspace: "Spazio di lavoro",
      },
      sections: {
        apis: "API",
        context: "Contesto",
        mcp: "MCP",
        modifiedFiles: "File modificati",
        run: "Esegui",
        status: "Stato",
        todos: "Attività",
      },
      shellSubtitle: "Shell OpenTUI",
      title: "Barra laterale",
      todos: {
        empty: "Nessuna attività.",
        more: (count) => `+${count} altri`,
        progress: "Avanzamento",
      },
    },
    status: {
      compactFailed: "Compressione del contesto fallita.",
      compacted: "Conversazione compattata.",
      compacting: "Compressione del contesto in corso...",
      interruptedStreamDiscarded: "Stream del modello interrotto scartato.",
      modelCalling: "Chiamata al modello...",
      permissionRequested: (toolName) => `Autorizzazione richiesta per ${toolName}.`,
      permissionResolved: (toolName) => `Autorizzazione concessa per ${toolName}.`,
      ready: "Pronto.",
      recoveringStream: "Ripristino dello stream del modello interrotto...",
      retryingStream: "Nuovo tentativo dello stream del modello...",
      sessionResumed: "Sessione ripresa.",
      targetChanged: (action) => `Obiettivo ${action}.`,
      thinking: "Sto pensando...",
      toolCompleted: (toolName) => `Strumento ${toolName} completato.`,
      toolFailed: (toolName) => `Strumento ${toolName} fallito.`,
      toolPending: (toolName) => `Strumento ${toolName} in attesa.`,
      toolRunning: (toolName) => `Strumento ${toolName} in esecuzione.`,
      turnFailed: "Turno fallito.",
    },
    terminal: {
      requiresInteractive: "La TUI richiede un terminale interattivo.",
      starting: "Avvio di ZCode... Ctrl+C per uscire",
    },
    transcript: {
      compact: {
        completed: "Contesto compresso",
        failed: "Compressione del contesto fallita",
        interrupted: "Compressione del contesto interrotta",
        retry: (command) => `Ctrl-R per riprovare ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Nuovo tentativo di compressione del contesto (${attempt}/${maxAttempts})`
            : "Nuovo tentativo di compressione del contesto",
        skipped: "Il contesto è aggiornato; compressione non necessaria",
        started: "Compressione del contesto in corso",
      },
      roles: {
        agent: "Agente",
        system: "Sistema",
        user: "Utente",
      },
      thought: {
        complete: "Pensiero",
        thinking: "Sto pensando...",
      },
      title: "Trascrizione",
      workflow: {
        actors: "attori:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `uso: ${spentTokens} token`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Workflow ${label} - ${status} (${nodesSettled}/${nodesTotal} passaggi)`,
        error: (message) => `errore: ${message}`,
        expandHint: "+ per espandere",
        collapseHint: "- per comprimere",
        log: "registro:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} passaggi conclusi`,
        result: (preview) => `risultato: ${preview}`,
        status: {
          completed: "completato",
          errored: "in errore",
          pending: "in attesa",
          running: "in esecuzione",
          stopped: "interrotto",
        },
        stopReason: {
          user: "da te",
          model: "dall'agente",
          provider: "errore del modello",
          interrupted: "processo terminato",
          superseded: "sostituito da un'esecuzione corretta",
        },
        truncated: "(troncato - cronologia completa nel journal dell'esecuzione)",
        interruptedNotice: ({ label, runId }) =>
          `Il workflow ${label} è stato interrotto e può essere ripreso: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Invio seleziona, Esc annulla",
      disabled: (reason) => ` [disabilitato: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filtro: ${filter || "-"} | ${help ?? "Invio seleziona, Esc annulla"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Nessun percorso del workspace corrispondente.",
      loading: "Caricamento dei percorsi del workspace...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "File",
    },
    slash: {
      title: "Comandi",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
