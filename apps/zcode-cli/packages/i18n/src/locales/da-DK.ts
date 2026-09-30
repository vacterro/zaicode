import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "da-DK",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Værdi for --locale understøttes ikke: ${value}. Understøttede sprog: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Brug:
  zcode [kommando] [valg]

Uden kommando åbner zcode den fuldskærms TUI.

Kommandoer:
  app-server Kør ZCode Protocol stdio-app-serveren
  commands   List egne skråstregkommandoer (\`commands list\`)
  doctor     Undersøg runtime- og pakkeringsantagelser
  login [zai|bigmodel]  Log ind via browserautorisering
  logout     Fjern de delte Z.AI-loginoplysninger
  plugins    Administrér plugins og markedspladser (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     List lokale skills (\`skills list\`)
  tui        Åbn terminal-UI
  version    Udskriv CLI-versionen

Valg:
  -h, --help       Vis hjælp
  -v, --version    Vis version
  -p, --prompt <text>  Kør en enkelt prompt uden at åbne TUI'en
  --memory-bench   Med --prompt: aktivér automatisk Memory-udtrækning og vent før afslutning (kræver Memory aktiveret)
  --browser-use <mode> Aktivér Browser Use-backend (understøttet: headless)
  --surface <surface>  Præsentationsflade til headless-prompts/app-server: terminal eller desktop
  --browser-executable <path> Chrome/Chromium-program til headless Browser Use
  --attach <path>  Vedhæft en lokal fil til --prompt; gentag for flere filer
  --cwd <path>     Kør denne kommando fra det angivne katalog
  --disallowed-tools, --disallowedTools <tools...>
    Fjern hele værktøjer kun for denne prompt/TUI-kørsel; gemte indstillinger ændres ikke.
    Værktøjnavne adskilt af komma eller mellemrum, f.eks. "Bash Edit".
    "Bash(git *)" fjerner alt af Bash; kommandomønstre matches ikke.
  --force-mcs      Tving systemprojektion midt i samtalen for Anthropic-udbydere
  --locale <locale>  UI-sprog: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR eller auto
  --mode <mode>    Tilladelsestilstand for prompts: build, edit, plan eller yolo (standard: yolo for --prompt)
  --resume <sessionId>  Fortsæt en gemt session via sessionId (sess_...)
  --target <text>  Kør eller angiv sessionens mål i headless-tilstand
  --target-replace Erstat et eksisterende sessionmål angivet af --target
  -c, --continue        Fortsæt den seneste session for det aktuelle katalog
  --json           Udskriv maskinlæsbart JSON hvor understøttet
  --no-browser     Udskriv OAuth-URL'en uden at åbne en browser
  --no-color       Deaktivér ANSI-farver
  --verbose        Udskriv ekstra diagnosticeringsdetaljer

Skråstregkommandoer:
  /help [command]       Vis hjælp til skråstregkommandoer
  /login                Vælg Z.AI- eller BigModel-browserlogin
  /logout               Fjern de delte Z.AI-loginoplysninger
  /compact [instructions]  Komprimér den aktuelle samtale
  /expert [status|resume|stop|<task>]  Kør eller administrér ekspertworkflowet
  /dwf [list|cancel|resume]  List, annullér eller fortsæt dynamiske workflow-kørsler
  /fork [latest|checkpointId]  Forgren en ny session fra et workspace-checkpoint
  /mcp [list|status|connect|disconnect]  Vis eller administrér MCP-servere
  /mode [mode]          Vis eller skift tilladelsestilstand: build, edit, plan eller yolo
  /model [id]           Vis eller skift den aktuelle sessions model
  /new                  Start en ny session i TUI'en
  /resume [sessionId]   Fortsæt en session via sessionId; udelad den for seneste i cwd
  /rewind [latest|checkpointId]  Vis seneste checkpoint eller gendan workspace-filer
  /skill [name] [task]  List skills, eller tving den næste prompt til at indlæse en
  /goal [action]        Vis eller angiv den aktuelle sessions mål
`,
  },
  tui: {
    copy: {
      copied: "Kopierede den valgte tekst til udklipsholder.",
      failed: "Kunne ikke kopiere den valgte tekst.",
      unavailable: "Kopiering af tekst til udklipsholder er ikke tilgængelig i denne terminal.",
    },
    effort: {
      disabled: "deaktiveret",
      enabled: "aktiveret",
    },
    input: {
      activeStatusHint: "esc for at afbryde",
      busyPlaceholder: "Skriv for at sætte input i kø",
      placeholder: "Skriv en prompt",
      queuedMore: (count) => `+ ${count} mere i kø`,
      queuedSubmitHint: "Indsendt efter det næste værktøjskald.",
      queuedTitle: (count) => ` Kø (${count}) `,
      title: "Indtastning",
      noHistorySource: "Der er ikke konfigureret nogen kilde til inputhistorik.",
      noPreviousInput: "Ingen tidligere input for dette projekt.",
      restoredPreviousInput: "Gendannede tidligere input.",
      restoredPreviousInputWithAttachments: (count) =>
        `Gendannede tidligere input med ${count} vedhæftning(er).`,
      restorePreviousInputFailed: "Kunne ikke gendanne tidligere input.",
      typePrompt: "Skriv et spørgsmål, og tryk på Enter.",
    },
    loginRequired: {
      help: "Brug /model for at se modeller, eller /login for at oprette forbindelse til en Coding Plan-konto.",
      message: "Ingen tilgængelige modeller. Konfigurer en udbyder, eller log ind med /login.",
      status: "Ingen tilgængelige modeller. Konfigurer en udbyder, eller log ind med /login.",
      title: "modelsetup påkrævet",
    },
    loginSetup: {
      emptyMessage: "Der er ingen tilgængelige loginmuligheder.",
      help: "Brug Op/Ned til at vælge, Enter til at vælge.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Indtast BigModel Coding Plan API Key",
          inputSecondary: "Indsæt nøglen her. Den er skjult under indtastning.",
          primary: "BigModel Coding Plan API-nøgle",
          secondary: "Indsæt en Coding Plan API-nøgle manuelt.",
        },
        bigmodelOauth: {
          pendingPrimary: "Venter på BigModel-autorisering",
          pendingSecondary:
            "Fuldfør login i din browser. Autorisering registreres automatisk.",
          primary: "BigModel Coding Plan",
          secondary: "Åbn browserlogin; autorisering registreres automatisk.",
        },
        zaiApiKey: {
          inputPrimary: "Indtast Z.AI Coding Plan API Key",
          inputSecondary: "Indsæt nøglen her. Den er skjult under indtastning.",
          primary: "Z.AI Coding Plan API-nøgle",
          secondary: "Indsæt en Coding Plan API-nøgle manuelt.",
        },
        zaiOauth: {
          pendingPrimary: "Venter på Z.AI-autorisering",
          pendingSecondary:
            "Fuldfør login i din browser. Jeg fortsætter, når autoriseringen er færdig.",
          primary: "Z.AI Coding Plan",
          secondary: "Åbn browserlogin, opret en Coding Plan API-nøgle.",
        },
      },
      pending: {
        cancelStatus: "Login annulleret. Vælg en opsætningsmetode.",
        help: "Esc annullerer og vender tilbage til opsætningsvalgene.",
        status: "Venter på browserautorisering...",
      },
      input: {
        cancelStatus: "Indtastning af API-nøgle annulleret. Vælg en opsætningsmetode.",
        clearStatus: "API-nøgleinput ryddet.",
        emptyStatus: "API-nøgle er påkrævet.",
        help: "Enter gemmer nøglen. Esc vender tilbage til opsætningsvalgene.",
        placeholder: "Indsæt API-nøgle",
        status: "Indtast API-nøglen, tryk derefter på Enter.",
        submitStatus: "Gemmer API-nøgle...",
      },
      prompt: "Vælg en opsætningsmetode med login eller API-nøgle.",
      response: "Vælg, hvordan du opsætter en Coding Plan-udbyder.",
      title: "Opsæt Coding Plan",
    },
    model: {
      requestFailed: (message) => `Modelanmodning mislykkedes: ${message}`,
      responseReceived: "Modelsvar modtaget.",
      responseReceivedWithTokens: (tokens) => `Modelsvar modtaget. ${tokens} tokens.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Genforsøger modelanmodning ${attempt}/${Math.max(1, maxAttempts - 1)} om ${delay}: ${reason}`,
      streamStalled: "Modelstreamen er gået i stå.",
    },
    sidebar: {
      subagents: {
        title: "Subagenter",
        empty: "Ingen subagenter endnu.",
        emptyOutput: "Ingen output endnu.",
        back: "← Hovedsamtale",
        readonly: "Kun læsning · Esc for at vende tilbage",
        loading: "Indlæser subagentoutput...",
        unavailable: "Subagentoutput ikke tilgængelig.",
        retry: "Prøv igen",
        more: "Indlæs mere",
        pendingMain: "Hovedsamtalen kræver dit input — vend tilbage for at svare",
        ended: (count) => `Afsluttet (${count})`,
        status: {
          running: "kører",
          waiting: "venter",
          blocked: "blokeret",
          success: "fuldført",
          failed: "mislykkedes",
          cancelled: "annulleret",
          lost: "tabt",
        },
      },
      api: {
        empty: "Ingen API-kald endnu.",
        model: "AI-model",
        more: (count) => `+${count} mere`,
        requests: "Anmodninger",
        server: "Tjener",
      },
      cache: {
        hit: "Ram",
        lastHit: "sidste hit",
        lastMiss: "sidste miss",
        readWrite: ({ read, write }) => `${read} læst / ${write} skrevet`,
        total: "i alt",
      },
      context: {
        cache: "Cachelager",
        cacheReadWrite: "Cache L/S",
        inputOutput: "I/O",
        reason: "Årsag",
        tokens: "Tokener",
        used: "Brugt",
        window: "Vindue",
      },
      modifiedFiles: {
        empty: "Ingen filændringer endnu.",
        more: (count) => `+${count} mere`,
      },
      mcp: {
        empty: "Ingen MCP-servere konfigureret.",
        loadFailed: "MCP-status ikke tilgængelig.",
        loading: "Indlæser MCP-status...",
        more: (count) => `+${count} mere`,
        servers: "Servere",
        status: {
          connected: "forbundet",
          connecting: "opretter forbindelse",
          disabled: "deaktiveret",
          disconnected: "afbrudt",
          failed: "mislykkedes",
          untrusted: "utroværdigt",
        },
        summary: ({ connected, total }) => `${connected}/${total} forbundet`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "fuldført",
        error: "fejl",
        errorWithStatus: (statusCode) => `fejl ${statusCode}`,
        pending: "afventer",
      },
      status: {
        last: "Sidste",
      },
      run: {
        draft: "Kladde",
        draftChars: (count) => `${count} tegn`,
        draftEmpty: "tom",
        messages: "Beskeder",
        mode: "Tilstand",
        model: "Modeltype",
        provider: "Leverandør",
        thought: "Tanke",
        trace: "Spor",
        turn: "Tur",
        workspace: "Arbejdsområde",
      },
      sections: {
        apis: "APIs",
        context: "Kontekst",
        mcp: "MCP",
        modifiedFiles: "Ændrede filer",
        run: "Kør",
        status: "Tilstand",
        todos: "Opgaver",
      },
      shellSubtitle: "OpenTUI-shell",
      title: "Sidepanel",
      todos: {
        empty: "Ingen todos endnu.",
        more: (count) => `+${count} mere`,
        progress: "Fremskridt",
      },
    },
    status: {
      compactFailed: "Kontekstkomprimering mislykkedes.",
      compacted: "Samtale komprimeret.",
      compacting: "Komprimerer kontekst...",
      interruptedStreamDiscarded: "Afbrudt modelstrøm kasseret.",
      modelCalling: "Kalder model...",
      permissionRequested: (toolName) => `Tilladelse anmodet til ${toolName}.`,
      permissionResolved: (toolName) => `Tilladelse løst for ${toolName}.`,
      ready: "Klar.",
      recoveringStream: "Gendanner afbrudt modelstrøm...",
      retryingStream: "Genforsøger modelstrøm...",
      sessionResumed: "Session genoptaget.",
      targetChanged: (action) => `Mål ${action}.`,
      thinking: "Tænker...",
      toolCompleted: (toolName) => `Værktøj ${toolName} fuldført.`,
      toolFailed: (toolName) => `Værktøj ${toolName} mislykkedes.`,
      toolPending: (toolName) => `Værktøj ${toolName} afventer.`,
      toolRunning: (toolName) => `Værktøj ${toolName} kører.`,
      turnFailed: "Tur mislykkedes.",
    },
    terminal: {
      requiresInteractive: "TUI kræver en interaktiv terminal.",
      starting: "Starter ZCode... Ctrl+C for at afslutte",
    },
    transcript: {
      compact: {
        completed: "Kontekst komprimeret",
        failed: "Kontekstkomprimering mislykkedes",
        interrupted: "Kontekstkomprimering afbrudt",
        retry: (command) => `Ctrl-R for at genforsøge ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Genforsøger kontekstkomprimering (${attempt}/${maxAttempts})`
            : "Genforsøger kontekstkomprimering",
        skipped: "Konteksten er opdateret; komprimering ikke nødvendig",
        started: "Komprimerer kontekst",
      },
      roles: {
        agent: "AI-agent",
        system: "Systemet",
        user: "Bruger",
      },
      thought: {
        complete: "Tanke",
        thinking: "Tænker...",
      },
      title: "Transkript",
      workflow: {
        actors: "aktører:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `forbrug: ${spentTokens} tokens`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Arbejdsgang ${label} - ${status} (${nodesSettled}/${nodesTotal} trin)`,
        error: (message) => `fejl: ${message}`,
        expandHint: "+ for at udvide",
        collapseHint: "- for at folde sammen",
        log: "logføring:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} trin afsluttet`,
        result: (preview) => `resultat: ${preview}`,
        status: {
          completed: "fuldført",
          errored: "fejlede",
          pending: "afventer",
          running: "kører",
          stopped: "stoppet",
        },
        stopReason: {
          user: "af dig",
          model: "af agenten",
          provider: "modelfejl",
          interrupted: "process afsluttet",
          superseded: "erstattet af en rettet kørsel",
        },
        truncated: "(afkortet - fuld historik i kørselstidsskriftet)",
        interruptedNotice: ({ label, runId }) =>
          `Arbejdsgang ${label} blev afbrudt og kan genoptages: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter vælger, Esc annullerer",
      disabled: (reason) => ` [deaktiveret: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filtrer: ${filter || "-"} | ${help ?? "Enter vælger, Esc annullerer"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Ingen matchende arbejdsrumsstier.",
      loading: "Indlæser arbejdsrumsstier...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Filer",
    },
    slash: {
      title: "Kommandoer",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
