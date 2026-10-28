import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "nl-NL",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Niet-ondersteunde --locale-waarde: ${value}. Ondersteunde locales: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Gebruik:
  zcode [command] [options]

Zonder command opent zcode de volledig scherm-TUI.

Commands:
  app-server ZCode Protocol stdio-appserver uitvoeren
  commands   Eigen slash-commando's weergeven (\`commands list\`)
  doctor     Runtime- en verpakkingsaannames inspecteren
  login [zai|bigmodel]  Inloggen via browserautorisatie
  logout     Gedeelde Z.AI-logininformatie verwijderen
  plugins    Plug-ins en marktplaatsen beheren (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Lokale skills weergeven (\`skills list\`)
  tui        De terminalinterface openen
  version    De CLI-versie afdrukken

Options:
  -h, --help       Help tonen
  -v, --version    Versie tonen
  -p, --prompt <text>  Eén prompt uitvoeren zonder de TUI te openen
  --memory-bench   Met --prompt: automatische Memory-extractie inschakelen en wachten voor afsluiten (vereist dat Memory is ingeschakeld)
  --browser-use <mode> Browser Use-backend inschakelen (ondersteund: headless)
  --surface <surface>  Weergave-oppervlak voor headless prompts/app-server: terminal of desktop
  --browser-executable <path> Chrome/Chromium-bestand voor headless Browser Use
  --attach <path>  Een lokaal bestand aan --prompt koppelen; herhaal voor meerdere bestanden
  --cwd <path>     Deze opdracht uitvoeren vanuit de opgegeven map
  --disallowed-tools, --disallowedTools <tools...>
    Volledige tools alleen voor deze prompt/TUI-run verwijderen; opgeslagen instellingen blijven ongewijzigd.
    Door komma's of spaties gescheiden toolnamen, bijv. "Bash Edit".
    "Bash(git *)" verwijdert het hele Bash-gedeelte; commandopatronen worden niet gekoppeld.
  --force-mcs      Systeemprojectie midden in het gesprek forceren voor Anthropic-providers
  --locale <locale>  UI-locale: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR of auto
  --mode <mode>    Toestemmingsmodus voor prompts: build, edit, plan of yolo (standaard: yolo voor --prompt)
  --resume <sessionId>  Een opgeslagen sessie hervatten op basis van sessionId (sess_...)
  --target <text>  Sessiedoel uitvoeren of instellen in headless-modus
  --target-replace Een bestaand sessiedoel vervangen dat is ingesteld door --target
  -c, --continue        De laatste sessie voor de huidige map hervatten
  --json           Machine-leesbare JSON afdrukken waar ondersteund
  --no-browser     De OAuth-URL afdrukken zonder een browser te openen
  --no-color       ANSI-kleuren uitschakelen
  --verbose        Extra diagnostische details afdrukken

Slash-commando's:
  /help [command]       Help bij slash-commando's tonen
  /login                Z.AI- of BigModel-browserlogin kiezen
  /logout               Gedeelde Z.AI-logininformatie verwijderen
  /compact [instructions]  Het huidige gesprek samenpersen
  /expert [status|resume|stop|<task>]  Expertworkflow uitvoeren of beheren
  /dwf [list|cancel|resume]  Dynamische workflowruns weergeven, annuleren of hervatten
  /fork [latest|checkpointId]  Een nieuwe sessie aftakken vanaf een workspace-checkpoint
  /mcp [list|status|connect|disconnect]  MCP-servers tonen of beheren
  /mode [mode]          Toestemmingsmodus tonen of wisselen: build, edit, plan of yolo
  /model [id]           Sessiemodel tonen of wisselen
  /new                  Een nieuwe sessie starten in de TUI
  /resume [sessionId]   Een sessie hervatten op basis van sessionId; laat weg voor de laatste in de huidige map
  /rewind [latest|checkpointId]  Laatste checkpoint tonen of workspace-bestanden herstellen
  /skill [name] [task]  Skills weergeven of de volgende prompt er een laten laden
  /goal [action]        Sessiedoel tonen of instellen
`,
  },
  tui: {
    copy: {
      copied: "Geselecteerde tekst naar het klembord gekopieerd.",
      failed: "Geselecteerde tekst kon niet worden gekopieerd.",
      unavailable: "Kopiëren van tekst naar het klembord is in deze terminal niet beschikbaar.",
    },
    effort: {
      disabled: "uitgeschakeld",
      enabled: "ingeschakeld",
    },
    input: {
      activeStatusHint: "esc om te onderbreken",
      busyPlaceholder: "Typ om invoer in de wachtrij te zetten",
      placeholder: "Typ een prompt",
      queuedMore: (count) => `+ nog ${count} in de wachtrij`,
      queuedSubmitHint: "Verzonden na de volgende toolaanroep.",
      queuedTitle: (count) => ` Wachtrij (${count}) `,
      title: "Invoer",
      noHistorySource: "Er is geen bron voor invoergeschiedenis geconfigureerd.",
      noPreviousInput: "Geen eerdere invoer voor dit project.",
      restoredPreviousInput: "Vorige invoer hersteld.",
      restoredPreviousInputWithAttachments: (count) =>
        `Vorige invoer hersteld met ${count} bijlage(n).`,
      restorePreviousInputFailed: "Vorige invoer kon niet worden hersteld.",
      typePrompt: "Typ een vraag en druk op Enter.",
    },
    loginRequired: {
      help: "Gebruik /model om modellen te bekijken, of /login om een Coding Plan-account te verbinden.",
      message: "Geen beschikbare modellen. Configureer een provider of log in met /login.",
      status: "Geen beschikbare modellen. Configureer een provider of log in met /login.",
      title: "modelsetup vereist",
    },
    loginSetup: {
      emptyMessage: "Er zijn geen loginopties beschikbaar.",
      help: "Gebruik Omhoog/Omlaag om te kiezen, Enter om te selecteren.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Voer BigModel Coding Plan API Key in",
          inputSecondary: "Plak de sleutel hier. Hij blijft verborgen tijdens het typen.",
          primary: "BigModel Coding Plan API-sleutel",
          secondary: "Plak handmatig een Coding Plan API-sleutel.",
        },
        bigmodelOauth: {
          pendingPrimary: "Wachten op BigModel-autorisatie",
          pendingSecondary:
            "Voltooi het inloggen in je browser. Autorisatie wordt automatisch gedetecteerd.",
          primary: "BigModel Coding Plan-abonnement",
          secondary: "Open browserlogin; autorisatie wordt automatisch gedetecteerd.",
        },
        zaiApiKey: {
          inputPrimary: "Voer Z.AI Coding Plan API Key in",
          inputSecondary: "Plak de sleutel hier. Hij blijft verborgen tijdens het typen.",
          primary: "Z.AI Coding Plan API-sleutel",
          secondary: "Plak handmatig een Coding Plan API-sleutel.",
        },
        zaiOauth: {
          pendingPrimary: "Wachten op Z.AI-autorisatie",
          pendingSecondary:
            "Voltooi het inloggen in je browser. Ik ga verder zodra de autorisatie klaar is.",
          primary: "Z.AI Coding Plan",
          secondary: "Browserlogin openen en Coding Plan API-sleutel aanmaken.",
        },
      },
      pending: {
        cancelStatus: "Login geannuleerd. Kies een installatiemethode.",
        help: "Esc annuleert en keert terug naar installatiekeuzes.",
        status: "Wachten op browserauthorisatie...",
      },
      input: {
        cancelStatus: "Invoer API-sleutel geannuleerd. Kies een installatiemethode.",
        clearStatus: "API-sleutel-invoer gewist.",
        emptyStatus: "API-sleutel is verplicht.",
        help: "Enter slaat de sleutel op. Esc keert terug naar installatiekeuzes.",
        placeholder: "API-sleutel plakken",
        status: "Voer de API-sleutel in, druk dan op Enter.",
        submitStatus: "API-sleutel opslaan...",
      },
      prompt: "Kies een login- of API-sleutelmethode.",
      response: "Kies hoe je een Coding Plan-provider instelt.",
      title: "Coding Plan instellen",
    },
    model: {
      requestFailed: (message) => `Modelverzoek mislukt: ${message}`,
      responseReceived: "Modelantwoord ontvangen.",
      responseReceivedWithTokens: (tokens) => `Modelantwoord ontvangen. ${tokens} tokens.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Modelverzoek opnieuw ${attempt}/${Math.max(1, maxAttempts - 1)} over ${delay}: ${reason}`,
      streamStalled: "Modelstream gestopt.",
    },
    sidebar: {
      subagents: {
        title: "Subagenten",
        empty: "Nog geen subagents.",
        emptyOutput: "Nog geen uitvoer.",
        back: "← Hoofdgesprek",
        readonly: "Alleen lezen · Esc om terug te keren",
        loading: "Subagentuitvoer laden...",
        unavailable: "Subagentuitvoer niet beschikbaar.",
        retry: "Opnieuw proberen",
        more: "Meer laden",
        pendingMain: "Hoofdgesprek heeft je invoer nodig — terug om te antwoorden",
        ended: (count) => `Beëindigd (${count})`,
        status: {
          running: "actief",
          waiting: "wachtend",
          blocked: "geblokkeerd",
          success: "voltooid",
          failed: "mislukt",
          cancelled: "geannuleerd",
          lost: "verloren",
        },
      },
      api: {
        empty: "Nog geen API-aanroepen.",
        model: "Modeltype",
        more: (count) => `+${count} meer`,
        requests: "Verzoeken",
        server: "Host",
      },
      cache: {
        hit: "Treffer",
        lastHit: "laatste hit",
        lastMiss: "laatste miss",
        readWrite: ({ read, write }) => `${read} lezen / ${write} schrijven`,
        total: "totaal",
      },
      context: {
        cache: "Tijdelijk geheugen",
        cacheReadWrite: "Cache L/S",
        inputOutput: "I/O",
        reason: "Reden",
        tokens: "Token",
        used: "Gebruikt",
        window: "Venster",
      },
      modifiedFiles: {
        empty: "Nog geen bestandswijzigingen.",
        more: (count) => `+${count} meer`,
      },
      mcp: {
        empty: "Geen MCP-servers geconfigureerd.",
        loadFailed: "MCP-status niet beschikbaar.",
        loading: "MCP-status laden...",
        more: (count) => `+${count} meer`,
        servers: "Hosts",
        status: {
          connected: "verbonden",
          connecting: "verbinden",
          disabled: "uitgeschakeld",
          disconnected: "niet verbonden",
          failed: "mislukt",
          untrusted: "niet vertrouwd",
        },
        summary: ({ connected, total }) => `${connected}/${total} verbonden`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "compleet",
        error: "fout",
        errorWithStatus: (statusCode) => `fout ${statusCode}`,
        pending: "in afwachting",
      },
      status: {
        last: "Laatste",
      },
      run: {
        draft: "Concept",
        draftChars: (count) => `${count} tekens`,
        draftEmpty: "leeg",
        messages: "Berichten",
        mode: "Modus",
        model: "Modelnaam",
        provider: "Aanbieder",
        thought: "Gedachte",
        trace: "Tracering",
        turn: "Beurt",
        workspace: "Werkruimte",
      },
      sections: {
        apis: "API's",
        context: "Contextueel",
        mcp: "MCP",
        modifiedFiles: "Gewijzigde bestanden",
        run: "Uitvoeren",
        status: "Toestand",
        todos: "Taken",
      },
      shellSubtitle: "OpenTUI-shell",
      title: "Zijbalk",
      todos: {
        empty: "Nog geen taken.",
        more: (count) => `+${count} meer`,
        progress: "Voortgang",
      },
    },
    status: {
      compactFailed: "Contextcompressie mislukt.",
      compacted: "Gesprek ingekort.",
      compacting: "Context comprimeren...",
      interruptedStreamDiscarded: "Onderbroken modelstream verworpen.",
      modelCalling: "Model aanroepen...",
      permissionRequested: (toolName) => `Toestemming gevraagd voor ${toolName}.`,
      permissionResolved: (toolName) => `Toestemming verleend voor ${toolName}.`,
      ready: "Klaar.",
      recoveringStream: "Onderbroken modelstream herstellen...",
      retryingStream: "Modelstream opnieuw proberen...",
      sessionResumed: "Sessie hervat.",
      targetChanged: (action) => `Doel ${action}.`,
      thinking: "Denken...",
      toolCompleted: (toolName) => `Tool ${toolName} voltooid.`,
      toolFailed: (toolName) => `Tool ${toolName} mislukt.`,
      toolPending: (toolName) => `Tool ${toolName} in afwachting.`,
      toolRunning: (toolName) => `Tool ${toolName} actief.`,
      turnFailed: "Beurt mislukt.",
    },
    terminal: {
      requiresInteractive: "TUI vereist een interactieve terminal.",
      starting: "ZCode starten... Ctrl+C om te sluiten",
    },
    transcript: {
      compact: {
        completed: "Context gecomprimeerd",
        failed: "Contextcompressie mislukt",
        interrupted: "Contextcompressie onderbroken",
        retry: (command) => `Ctrl-R om ${command} opnieuw te proberen`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Contextcompressie opnieuw proberen (${attempt}/${maxAttempts})`
            : "Contextcompressie opnieuw proberen",
        skipped: "Context is actueel; compressie niet nodig",
        started: "Context comprimeren",
      },
      roles: {
        agent: "AI-agent",
        system: "Systeem",
        user: "Gebruiker",
      },
      thought: {
        complete: "Gedachte",
        thinking: "Denken...",
      },
      title: "Gesprekslog",
      workflow: {
        actors: "actoren:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `gebruik: ${spentTokens} tokens`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Werkstroom ${label} - ${status} (${nodesSettled}/${nodesTotal} stappen)`,
        error: (message) => `fout: ${message}`,
        expandHint: "+ uitvouwen",
        collapseHint: "- samenvouwen",
        log: "logboek:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} stappen afgerond`,
        result: (preview) => `resultaat: ${preview}`,
        status: {
          completed: "voltooid",
          errored: "mislukt",
          pending: "in afwachting",
          running: "bezig",
          stopped: "gestopt",
        },
        stopReason: {
          user: "door jou",
          model: "door de agent",
          provider: "modelfout",
          interrupted: "proces beëindigd",
          superseded: "vervangen door een herziene run",
        },
        truncated: "(afgekapt - volledige geschiedenis in het runlogboek)",
        interruptedNotice: ({ label, runId }) =>
          `Werkstroom ${label} is onderbroken en kan worden hervat: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter selecteert, Esc annuleert",
      disabled: (reason) => ` [uitgeschakeld: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filteren: ${filter || "-"} | ${help ?? "Enter selecteert, Esc annuleert"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Geen overeenkomende werkruimtepaden.",
      loading: "Werkruimtepaden laden...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Bestanden",
    },
    slash: {
      title: "Opdrachten",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
