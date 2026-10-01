import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "nb-NO",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Verdien for --locale er ikke støttet: ${value}. Støttede språk: en-US, zh-CN, auto.`,
    },
    help: (version) => `zcode ${version}

Bruk:
  zcode [command] [options]

Uten kommando åpner zcode fullskjerm-TUI.

Kommandoer:
  app-server Kjør ZCode Protocol stdio-app-serveren
  commands   List opp egne skråstrekkommandoer (\`commands list\`)
  doctor     Inspiser kjørings- og pakkeantakelser
  login [zai|bigmodel]  Logg inn via nettleserautorisering
  logout     Fjern delte Z.AI-innloggingsdetaljer
  plugins    Administrer plugins og markedsplasser (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     List opp lokale skills (\`skills list\`)
  tui        Åpne terminalgrensesnittet
  version    Skriv ut CLI-versjonen

Alternativer:
  -h, --help       Vis hjelp
  -v, --version    Vis versjon
  -p, --prompt <text>  Kjør én ledetekst uten å åpne TUI
  --memory-bench   Med --prompt, aktiver automatisk Memory-uttrekk og vent før avslutt (krever Memory aktivert)
  --browser-use <mode> Aktiver Browser Use-backend (støttet: headless)
  --surface <surface>  Presentasjonsflate for headless-ledetekster/app-server: terminal eller desktop
  --browser-executable <path> Chrome/Chromium-kjørbar fil for headless Browser Use
  --attach <path>  Legg ved en lokal fil til --prompt; gjenta for flere filer
  --cwd <path>     Kjør denne kommandoen fra den angitte katalogen
  --disallowed-tools, --disallowedTools <tools...>
    Fjern hele verktøy for bare denne ledeteksten/TUI-kjøringen; lagrede innstillinger endres ikke.
    Kommaseparerte eller mellomromsseparerte verktøynavn, f.eks. "Bash Edit".
    "Bash(git *)" fjerner alt av Bash; kommandomønster samsvarer ikke.
  --force-mcs      Tving midt-i-samtalen systemprojeksjon for Anthropic-leverandører
  --locale <locale>  UI-språk: en-US, zh-CN eller auto
  --mode <mode>    Tillatelsesmodus for ledetekster: build, edit, plan eller yolo (standard: yolo for --prompt)
  --resume <sessionId>  Gjenoppta en lagret sesjon etter sessionId (sess_...)
  --target <text>  Kjør eller sett sesjonsmålet i headless-modus
  --target-replace Erstatt eventuelt eksisterende sesjonsmål satt av --target
  -c, --continue        Gjenoppta siste sesjon for gjeldende katalog
  --json           Skriv maskinlesbar JSON der det støttes
  --no-browser     Skriv ut OAuth-URL-en uten å åpne nettleser
  --no-color       Deaktiver ANSI-farger
  --verbose        Skriv ut ekstra diagnostikkdetaljer

Skråstrekkommandoer:
  /help [command]       Vis hjelp for skråstrekkommandoer
  /login                Velg Z.AI- eller BigModel-nettleserinnlogging
  /logout               Fjern delte Z.AI-innloggingsdetaljer
  /compact [instructions]  Komprimer gjeldende samtale
  /expert [status|resume|stop|<task>]  Kjør eller administrer ekspertarbeidsflyten
  /dwf [list|cancel|resume]  List opp, avbryt eller gjenoppta dynamiske arbeidsflytkjøringer
  /fork [latest|checkpointId]  Fork en ny sesjon fra et sjekkpunkt i arbeidsområdet
  /mcp [list|status|connect|disconnect]  Vis eller administrer MCP-servere
  /mode [mode]          Vis eller bytt tillatelsesmodus: build, edit, plan eller yolo
  /model [id]           Vis eller bytt gjeldende sesjonsmodell
  /new                  Start en ny sesjon i TUI
  /resume [sessionId]   Gjenoppta en sesjon etter sessionId; utelate for siste i cwd
  /rewind [latest|checkpointId]  Vis siste sjekkpunkt eller gjenopprett filer i arbeidsområdet
  /skill [name] [task]  List opp skills, eller tving neste ledetekst til å laste én
  /goal [action]        Vis eller sett gjeldende sesjonsmål
`,
  },
  tui: {
    copy: {
      copied: "Kopierte valgt tekst til utklippsstabelen.",
      failed: "Kunne ikke kopiere valgt tekst.",
      unavailable: "Tekstkopiering til utklippsstabelen er ikke tilgjengelig i denne terminalen.",
    },
    effort: {
      disabled: "deaktivert",
      enabled: "aktivert",
    },
    input: {
      activeStatusHint: "esc for å avbryte",
      busyPlaceholder: "Skriv for å legge i kø",
      placeholder: "Skriv en ledetekst",
      queuedMore: (count) => `+ ${count} flere i kø`,
      queuedSubmitHint: "Sendt inn etter neste verktøykall.",
      queuedTitle: (count) => ` Kø (${count}) `,
      title: "Inndata",
      noHistorySource: "Ingen kilde for inndatahistorikk er konfigurert.",
      noPreviousInput: "Ingen tidligere inndata for dette prosjektet.",
      restoredPreviousInput: "Gjenopprettet tidligere inndata.",
      restoredPreviousInputWithAttachments: (count) =>
        `Gjenopprettet tidligere inndata med ${count} vedlegg.`,
      restorePreviousInputFailed: "Kunne ikke gjenopprette tidligere inndata.",
      typePrompt: "Skriv et spørsmål og trykk Enter.",
    },
    loginRequired: {
      help: "Bruk /model for å se modeller, eller /login for å koble til en Coding Plan-konto.",
      message: "Ingen modeller tilgjengelig. Konfigurer en leverandør, eller logg inn med /login.",
      status: "Ingen modeller tilgjengelig. Konfigurer en leverandør, eller logg inn med /login.",
      title: "modelloppsett kreves",
    },
    loginSetup: {
      emptyMessage: "Ingen innloggingsalternativer er tilgjengelige.",
      help: "Bruk Opp/Ned for å velge, Enter for å bekrefte.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Skriv inn BigModel Coding Plan API-nøkkel",
          inputSecondary: "Lim inn nøkkelen her. Den er skjult mens du skriver.",
          primary: "BigModel Coding Plan API-nøkkel",
          secondary: "Lim inn en Coding Plan API-nøkkel manuelt.",
        },
        bigmodelOauth: {
          pendingPrimary: "Venter på BigModel-autorisering",
          pendingSecondary:
            "Fullfør innloggingen i nettleseren. Autoriseringen registreres automatisk.",
          primary: "BigModel Coding Plan",
          secondary: "Åpne nettleserinnlogging; autoriseringen registreres automatisk.",
        },
        zaiApiKey: {
          inputPrimary: "Skriv inn Z.AI Coding Plan API-nøkkel",
          inputSecondary: "Lim inn nøkkelen her. Den er skjult mens du skriver.",
          primary: "Z.AI Coding Plan API-nøkkel",
          secondary: "Lim inn en Coding Plan API-nøkkel manuelt.",
        },
        zaiOauth: {
          pendingPrimary: "Venter på Z.AI-autorisering",
          pendingSecondary:
            "Fullfør innloggingen i nettleseren. Jeg fortsetter når autoriseringen er fullført.",
          primary: "Z.AI Coding Plan",
          secondary: "Åpne nettleserinnlogging og opprett en Coding Plan API-nøkkel.",
        },
      },
      pending: {
        cancelStatus: "Innlogging avbrutt. Velg en oppsettsmetode.",
        help: "Esc avbryter og returnerer til oppsettsvalgene.",
        status: "Venter på nettleserautorisering...",
      },
      input: {
        cancelStatus: "Inndata av API-nøkkel avbrutt. Velg en oppsettsmetode.",
        clearStatus: "API-nøkkelinput tømt.",
        emptyStatus: "API-nøkkel er påkrevd.",
        help: "Enter lagrer nøkkelen. Esc returnerer til oppsettsvalgene.",
        placeholder: "Lim inn API-nøkkel",
        status: "Skriv inn API-nøkkelen, og trykk deretter Enter.",
        submitStatus: "Lagrer API-nøkkel...",
      },
      prompt: "Velg en innloggingsmetode eller API-nøkkelmetode for oppsett.",
      response: "Velg hvordan du vil sette opp en Coding Plan-leverandør.",
      title: "Sett opp Coding Plan",
    },
    model: {
      requestFailed: (message) => `Modellanmodning mislyktes: ${message}`,
      responseReceived: "Modellsvar mottatt.",
      responseReceivedWithTokens: (tokens) => `Modellsvar mottatt. ${tokens} tokens.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Nytt forsøk på modellanmodning ${attempt}/${Math.max(1, maxAttempts - 1)} om ${delay}: ${reason}`,
      streamStalled: "Modellstrømmen stanset.",
    },
    sidebar: {
      subagents: {
        title: "Subagenter",
        empty: "Ingen subagenter ennå.",
        emptyOutput: "Ingen utdata ennå.",
        back: "← Hovedkonversasjon",
        readonly: "Kun lesing · Esc for å gå tilbake",
        loading: "Laster subagentutdata...",
        unavailable: "Subagentutdata utilgjengelig.",
        retry: "Prøv igjen",
        more: "Last inn mer",
        pendingMain: "Hovedkonversasjonen trenger innspilling fra deg – gå tilbake for å svare",
        ended: (count) => `Avsluttet (${count})`,
        status: {
          running: "kjører",
          waiting: "venter",
          blocked: "blokkert",
          success: "fullført",
          failed: "mislyktes",
          cancelled: "avbrutt",
          lost: "tapt",
        },
      },
      api: {
        empty: "Ingen API-kall ennå.",
        model: "Modell",
        more: (count) => `+${count} til`,
        requests: "Forespørsler",
        server: "Tjener",
      },
      cache: {
        hit: "treff",
        lastHit: "siste treff",
        lastMiss: "siste bomt",
        readWrite: ({ read, write }) => `${read} les / ${write} skriv`,
        total: "totalt",
      },
      context: {
        cache: "Buffer",
        cacheReadWrite: "Buffer R/S",
        inputOutput: "I/O",
        reason: "Årsak",
        tokens: "Tokener",
        used: "Brukt",
        window: "Vindu",
      },
      modifiedFiles: {
        empty: "Ingen filendringer ennå.",
        more: (count) => `+${count} til`,
      },
      mcp: {
        empty: "Ingen MCP-servere konfigurert.",
        loadFailed: "MCP-status utilgjengelig.",
        loading: "Laster MCP-status...",
        more: (count) => `+${count} til`,
        servers: "Servere",
        status: {
          connected: "tilkoblet",
          connecting: "kobler til",
          disabled: "deaktivert",
          disconnected: "frakoblet",
          failed: "feilet",
          untrusted: "utrustet",
        },
        summary: ({ connected, total }) => `${connected}/${total} tilkoblet`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "fullført",
        error: "feil",
        errorWithStatus: (statusCode) => `feil ${statusCode}`,
        pending: "venter",
      },
      status: {
        last: "Siste",
      },
      run: {
        draft: "Utkast",
        draftChars: (count) => `${count} tegn`,
        draftEmpty: "tom",
        messages: "Meldinger",
        mode: "Modus",
        model: "Modell",
        provider: "Leverandør",
        thought: "Tanke",
        trace: "Spor",
        turn: "Tur",
        workspace: "Arbeidsområde",
      },
      sections: {
        apis: "API-er",
        context: "Kontekst",
        mcp: "MCP",
        modifiedFiles: "Endrede filer",
        run: "Kjør",
        status: "Tilstand",
        todos: "Oppgaveliste",
      },
      shellSubtitle: "OpenTUI-skall",
      title: "Sidefelt",
      todos: {
        empty: "Ingen oppgaver ennå.",
        more: (count) => `+${count} til`,
        progress: "Framdrift",
      },
    },
    status: {
      compactFailed: "Kontekstkomprimering mislyktes.",
      compacted: "Samtale komprimert.",
      compacting: "Komprimerer kontekst...",
      interruptedStreamDiscarded: "Avbrutt modellstrøm forkastet.",
      modelCalling: "Kaller modell...",
      permissionRequested: (toolName) => `Tillatelse bedt om for ${toolName}.`,
      permissionResolved: (toolName) => `Tillatelse innvilget for ${toolName}.`,
      ready: "Klar.",
      recoveringStream: "Gjenoppretter avbrutt modellstrøm...",
      retryingStream: "Prøer modellstrøm igjen...",
      sessionResumed: "Økt gjenopptatt.",
      targetChanged: (action) => `Mål ${action}.`,
      thinking: "Tenker...",
      toolCompleted: (toolName) => `Verktøy ${toolName} fullført.`,
      toolFailed: (toolName) => `Verktøy ${toolName} mislyktes.`,
      toolPending: (toolName) => `Verktøy ${toolName} venter.`,
      toolRunning: (toolName) => `Verktøy ${toolName} kjører.`,
      turnFailed: "Tur mislyktes.",
    },
    terminal: {
      requiresInteractive: "TUI krever et interaktivt terminalvindu.",
      starting: "Starter ZCode... Ctrl+C for å avslutte",
    },
    transcript: {
      compact: {
        completed: "Kontekst komprimert",
        failed: "Kontekstkomprimering mislyktes",
        interrupted: "Kontekstkomprimering avbrutt",
        retry: (command) => `Ctrl-R for å prøve ${command} igjen`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Prøver komprimering av kontekst på nytt (${attempt}/${maxAttempts})`
            : "Prøver å komprimere kontekst på nytt",
        skipped: "Konteksten er oppdatert; ingen komprimering nødvendig",
        started: "Komprimerer kontekst",
      },
      roles: {
        agent: "Assistent",
        system: "Systemrolle",
        user: "Bruker",
      },
      thought: {
        complete: "Tanke",
        thinking: "Tenker...",
      },
      title: "Transkripsjon",
      workflow: {
        actors: "aktører:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `bruk: ${spentTokens} tokens`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Arbeidsflyt ${label} - ${status} (${nodesSettled}/${nodesTotal} trinn)`,
        error: (message) => `feil: ${message}`,
        expandHint: "+ for å utvide",
        collapseHint: "- for å skjule",
        log: "logg:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} trinn fullført`,
        result: (preview) => `resultat: ${preview}`,
        status: {
          completed: "fullført",
          errored: "feilet",
          pending: "venter",
          running: "kjører",
          stopped: "stoppet",
        },
        stopReason: {
          user: "av deg",
          model: "av agenten",
          provider: "modellfeil",
          interrupted: "prosessen avsluttet",
          superseded: "erstattet av en korrigert kjøring",
        },
        truncated: "(forkortet - full historikk i kjøringsjournalen)",
        interruptedNotice: ({ label, runId }) =>
          `Arbeidsflyt ${label} ble avbrutt og kan gjenopptas: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter velger, Esc avbryter",
      disabled: (reason) => ` [deaktivert: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filtrer: ${filter || "-"} | ${help ?? "Enter velger, Esc avbryter"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Ingen samsvarende arbeidsområdebaner.",
      loading: "Laster arbeidsområdebaner...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Filer",
    },
    slash: {
      title: "Kommandoer",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
