import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "sv-SE",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Okänt --locale-värde: ${value}. Inte stödda språk: en-US, zh-CN, auto.`,
    },
    help: (version) => `zcode ${version}

Användning:
  zcode [command] [options]

Utan kommando öppnar zcode TUI i helskärm.

Kommandon:
  app-server Kör ZCode Protocol stdio-appservern
  commands   Lista anpassade slash-kommandon (\`commands list\`)
  doctor     Inspektera körtids- och paketeringsantaganden
  login [zai|bigmodel]  Logga in via webbläsarauktorisering
  logout     Ta bort de gemensamma Z.AI-inloggningsuppgifterna
  plugins    Hantera plugin-program och marknadsplatser (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Lista lokala skills (\`skills list\`)
  tui        Öppna terminalgränssnittet
  version    Skriv ut CLI-versionen

Alternativ:
  -h, --help       Visa hjälp
  -v, --version    Visa version
  -p, --prompt <text>  Kör en enda prompt utan att öppna TUI
  --memory-bench   Med --prompt, aktivera automatisk Memory-extrahering och vänta innan avslut (kräver att Memory är aktiverat)
  --browser-use <mode> Aktivera Browser Use-backend (stöds: headless)
  --surface <surface>  Presentationsyta för headless-promptar/app-server: terminal eller desktop
  --browser-executable <path> Chrome/Chromium-sökväg för headless Browser Use
  --attach <path>  Bifoga en lokal fil till --prompt; upprepa för flera filer
  --cwd <path>     Kör kommandot från den angivna katalogen
  --disallowed-tools, --disallowedTools <tools...>
    Ta bort hela verktyg endast för denna prompt/TUI-körning; sparade inställningar ändras inte.
    Kommaseparerade eller mellanslagsseparerade verktygsnamn, t.ex. "Bash Edit".
    "Bash(git *)" tar bort allt i Bash; kommandomönster matchas inte.
  --force-mcs      Tvinga systemprojektion mitt i samtalet för Anthropic-leverantörer
  --locale <locale>  UI-språk: en-US, zh-CN eller auto
  --mode <mode>    Behörighetsläge för promptar: build, edit, plan eller yolo (standard: yolo för --prompt)
  --resume <sessionId>  Återuppta en sparad session via sessionId (sess_...)
  --target <text>  Kör eller ange sessionsmålet i headless-läge
  --target-replace Ersätt ett befintligt sessionsmål som satts av --target
  -c, --continue        Återuppta den senaste sessionen för den aktuella katalogen
  --json           Skriv maskinläsbar JSON där det stöds
  --no-browser     Skriv ut OAuth-URL:en utan att öppna webbläsaren
  --no-color       Inaktivera ANSI-färger
  --verbose        Skriv ut extra diagnostikdetaljer

Slash-kommandon:
  /help [command]       Visa hjälp för slash-kommandon
  /login                Välj Z.AI- eller BigModel-inloggning i webbläsaren
  /logout               Ta bort de gemensamma Z.AI-inloggningsuppgifterna
  /compact [instructions]  Kompakta den aktuella konversationen
  /expert [status|resume|stop|<task>]  Kör eller hantera expertarbetsflödet
  /dwf [list|cancel|resume]  Lista, avbryt eller återuppta dynamiska arbetsflödeskörningar
  /fork [latest|checkpointId]  Skapa en ny session från en arbetsutrymmekontrollpunkt
  /mcp [list|status|connect|disconnect]  Visa eller hantera MCP-servrar
  /mode [mode]          Visa eller byt behörighetsläge: build, edit, plan eller yolo
  /model [id]           Visa eller byt modell för den aktuella sessionen
  /new                  Starta en ny session i TUI
  /resume [sessionId]   Återuppta en session via sessionId; utelämna för senaste i cwd
  /rewind [latest|checkpointId]  Visa senaste kontrollpunkt eller återställ arbetsutrymmesfiler
  /skill [name] [task]  Lista skills, eller tvinga nästa prompt att läsa in en
  /goal [action]        Visa eller ange det aktuella sessionsmålet
`,
  },
  tui: {
    copy: {
      copied: "Markerad text kopierades till urklipp.",
      failed: "Kunde inte kopiera markerad text.",
      unavailable: "Kopiering av text till urklipp är inte tillgänglig i den här terminalen.",
    },
    effort: {
      disabled: "avstängd",
      enabled: "aktiverad",
    },
    input: {
      activeStatusHint: "esc för att avbryta",
      busyPlaceholder: "Skriv för att köa inmatning",
      placeholder: "Skriv en prompt",
      queuedMore: (count) => `+ ${count} till i kön`,
      queuedSubmitHint: "Skickas efter nästa verktygsanrop.",
      queuedTitle: (count) => ` Kö (${count}) `,
      title: "Inmatning",
      noHistorySource: "Ingen historikkälla för inmatning är konfigurerad.",
      noPreviousInput: "Ingen tidigare inmatning för det här projektet.",
      restoredPreviousInput: "Tidigare inmatning återställd.",
      restoredPreviousInputWithAttachments: (count) =>
        `Tidigare inmatning återställd med ${count} bilaga/bilagor.`,
      restorePreviousInputFailed: "Kunde inte återställa tidigare inmatning.",
      typePrompt: "Skriv en fråga och tryck Enter.",
    },
    loginRequired: {
      help: "Använd /model för att se modeller, eller /login för att ansluta ett Coding Plan-konto.",
      message: "Inga tillgängliga modeller. Konfigurera en leverantör eller logga in med /login.",
      status: "Inga tillgängliga modeller. Konfigurera en leverantör eller logga in med /login.",
      title: "modellkonfiguration krävs",
    },
    loginSetup: {
      emptyMessage: "Inga inloggningsalternativ tillgängliga.",
      help: "Använd Up/Down för att välja, Enter för att bekräfta.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Ange BigModel Coding Plan API-nyckel",
          inputSecondary: "Klistra in nyckeln här. Den döljs medan du skriver.",
          primary: "BigModel Coding Plan API-nyckel",
          secondary: "Klistra in en Coding Plan API-nyckel manuellt.",
        },
        bigmodelOauth: {
          pendingPrimary: "Väntar på BigModel-auktorisering",
          pendingSecondary:
            "Slutför inloggningen i webbläsaren. Auktoriseringen upptäcks automatiskt.",
          primary: "BigModel Coding Plan",
          secondary: "Öppna inloggning i webbläsaren; auktoriseringen upptäcks automatiskt.",
        },
        zaiApiKey: {
          inputPrimary: "Ange Z.AI Coding Plan API-nyckel",
          inputSecondary: "Klistra in nyckeln här. Den döljs medan du skriver.",
          primary: "Z.AI Coding Plan API-nyckel",
          secondary: "Klistra in en Coding Plan API-nyckel manuellt.",
        },
        zaiOauth: {
          pendingPrimary: "Väntar på Z.AI-auktorisering",
          pendingSecondary:
            "Slutför inloggningen i webbläsaren. Jag fortsätter när auktoriseringen är klar.",
          primary: "Z.AI Coding Plan",
          secondary: "Öppna webbläsarlogin och skapa en Coding Plan API-nyckel.",
        },
      },
      pending: {
        cancelStatus: "Inloggning avbruten. Välj installationsmetod.",
        help: "Esc avbryter och återgår till installationsvalen.",
        status: "Väntar på webbläsarauktorisering...",
      },
      input: {
        cancelStatus: "Inmatning av API-nyckel avbruten. Välj installationsmetod.",
        clearStatus: "API-nyckelinmatningen rensad.",
        emptyStatus: "API-nyckel krävs.",
        help: "Enter sparar nyckeln. Esc återgår till installationsvalen.",
        placeholder: "Klistra in API-nyckel",
        status: "Ange API-nyckeln, tryck sedan Enter.",
        submitStatus: "Sparar API-nyckel...",
      },
      prompt: "Välj inloggning eller API-nyckel som installationsmetod.",
      response: "Välj hur du konfigurerar en Coding Plan-leverantör.",
      title: "Konfigurera Coding Plan",
    },
    model: {
      requestFailed: (message) => `Modellbegäran misslyckades: ${message}`,
      responseReceived: "Modellsvar mottaget.",
      responseReceivedWithTokens: (tokens) => `Modellsvar mottaget. ${tokens} tokens.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Försöker modellbegäran ${attempt}/${Math.max(1, maxAttempts - 1)} igen om ${delay}: ${reason}`,
      streamStalled: "Modellström har stannat.",
    },
    sidebar: {
      subagents: {
        title: "Delagenter",
        empty: "Inga delagenter ännu.",
        emptyOutput: "Ingen utdata ännu.",
        back: "← Huvudkonversation",
        readonly: "Skrivskyddad · Esc för att återgå",
        loading: "Laddar delagentutdata...",
        unavailable: "Delagentutdata otillgänglig.",
        retry: "Försök igen",
        more: "Ladda mer",
        pendingMain: "Huvudkonversationen behöver ditt svar — återgå för att svara",
        ended: (count) => `Avslutad (${count})`,
        status: {
          running: "körs",
          waiting: "väntar",
          blocked: "blockerad",
          success: "slutförd",
          failed: "misslyckad",
          cancelled: "avbruten",
          lost: "förlorad",
        },
      },
      api: {
        empty: "Inga API-anrop ännu.",
        model: "Modell",
        more: (count) => `+${count} till`,
        requests: "Begäran",
        server: "Fjärrserver",
      },
      cache: {
        hit: "träff",
        lastHit: "senaste träff",
        lastMiss: "senaste miss",
        readWrite: ({ read, write }) => `${read} läst / ${write} skriven`,
        total: "totalt",
      },
      context: {
        cache: "Cacheminne",
        cacheReadWrite: "Cache L/S",
        inputOutput: "I/O",
        reason: "Anledning",
        tokens: "Token",
        used: "Använt",
        window: "Fönster",
      },
      modifiedFiles: {
        empty: "Inga filändringar ännu.",
        more: (count) => `+${count} till`,
      },
      mcp: {
        empty: "Inga MCP-servrar konfigurerade.",
        loadFailed: "MCP-status otillgänglig.",
        loading: "Laddar MCP-status...",
        more: (count) => `+${count} till`,
        servers: "Servrar",
        status: {
          connected: "ansluten",
          connecting: "ansluter",
          disabled: "inaktiverad",
          disconnected: "frånkopplad",
          failed: "misslyckades",
          untrusted: "ej betrodd",
        },
        summary: ({ connected, total }) => `${connected}/${total} anslutna`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "klar",
        error: "fel",
        errorWithStatus: (statusCode) => `fel ${statusCode}`,
        pending: "väntande",
      },
      status: {
        last: "Senaste",
      },
      run: {
        draft: "Utkast",
        draftChars: (count) => `${count} tecken`,
        draftEmpty: "tom",
        messages: "Meddelanden",
        mode: "Läge",
        model: "Modell",
        provider: "Leverantör",
        thought: "Tanke",
        trace: "Spår",
        turn: "Tur",
        workspace: "Arbetsyta",
      },
      sections: {
        apis: "API:er",
        context: "Kontext",
        mcp: "MCP",
        modifiedFiles: "Ändrade filer",
        run: "Kör",
        status: "Tillstånd",
        todos: "Att göra",
      },
      shellSubtitle: "OpenTUI-shell",
      title: "Sidopanel",
      todos: {
        empty: "Inga att göra-uppgifter ännu.",
        more: (count) => `+${count} till`,
        progress: "Framsteg",
      },
    },
    status: {
      compactFailed: "Kontextkomprimering misslyckades.",
      compacted: "Konversationen komprimerades.",
      compacting: "Komprimerar kontext...",
      interruptedStreamDiscarded: "Avbruten modellström kastades bort.",
      modelCalling: "Anropar modellen...",
      permissionRequested: (toolName) => `Behörighet begärdes för ${toolName}.`,
      permissionResolved: (toolName) => `Behörighet avgjordes för ${toolName}.`,
      ready: "Klar.",
      recoveringStream: "Återställer avbruten modellström...",
      retryingStream: "Försöker köra modellström igen...",
      sessionResumed: "Sessionen återupptagen.",
      targetChanged: (action) => `Mål ${action}.`,
      thinking: "Tänker...",
      toolCompleted: (toolName) => `Verktyget ${toolName} slutfördes.`,
      toolFailed: (toolName) => `Verktyget ${toolName} misslyckades.`,
      toolPending: (toolName) => `Verktyget ${toolName} väntar.`,
      toolRunning: (toolName) => `Verktyget ${toolName} körs.`,
      turnFailed: "Turen misslyckades.",
    },
    terminal: {
      requiresInteractive: "TUI kräver en interaktiv terminal.",
      starting: "Startar ZCode... Ctrl+C för att avsluta",
    },
    transcript: {
      compact: {
        completed: "Kontext komprimerad",
        failed: "Kontextkomprimering misslyckades",
        interrupted: "Kontextkomprimering avbröts",
        retry: (command) => `Ctrl-R för att köra ${command} igen`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Försöker komprimera kontext igen (${attempt}/${maxAttempts})`
            : "Försöker komprimera kontext igen",
        skipped: "Kontexten är aktuell; ingen komprimering behövs",
        started: "Komprimerar kontext",
      },
      roles: {
        agent: "AI-agent",
        system: "Systeminfo",
        user: "Användare",
      },
      thought: {
        complete: "Tanke",
        thinking: "Tänker...",
      },
      title: "Transkript",
      workflow: {
        actors: "aktörer:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `användning: ${spentTokens} tokens`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Arbetsflöde ${label} - ${status} (${nodesSettled}/${nodesTotal} steg)`,
        error: (message) => `fel: ${message}`,
        expandHint: "+ för att expandera",
        collapseHint: "- för att dölja",
        log: "logg:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} steg klara`,
        result: (preview) => `resultat: ${preview}`,
        status: {
          completed: "klar",
          errored: "fel uppstod",
          pending: "väntande",
          running: "kör",
          stopped: "stoppad",
        },
        stopReason: {
          user: "av dig",
          model: "av agenten",
          provider: "modellfel",
          interrupted: "processen avslutades",
          superseded: "ersatt av en rättad körning",
        },
        truncated: "(förkortat - fullständig historik i körningsjournalen)",
        interruptedNotice: ({ label, runId }) =>
          `Arbetsflödet ${label} avbröts och kan återupptas: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter väljer, Esc avbryter",
      disabled: (reason) => ` [inaktiverad: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filtrera: ${filter || "-"} | ${help ?? "Enter väljer, Esc avbryter"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Inga matchande arbetsytesökvägar.",
      loading: "Läser in arbetsytesökvägar...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Filer",
    },
    slash: {
      title: "Kommandon",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
