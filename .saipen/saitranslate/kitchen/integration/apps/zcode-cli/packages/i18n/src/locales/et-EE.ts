import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "et-EE",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Toetamatu --locale väärtus: ${value}. Toetatud locale'id: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Kasutus:
  zcode [command] [options]

Ilma käsudeta avab zcode täisekraaniga TUI.

Käskud:
  app-server Käivita ZCode Protocol stdio rakendusserver
  commands   Loetle kohalikud kaldkriipsukäsud (\`commands list\`)
  doctor     Kontrolli käitustööaja ja pakkimise eeldusi
  login [zai|bigmodel]  Logi sisse brauseri autoriseerimise kaudu
  logout     Eemalda jagatud Z.AI sisselogimisandmed
  plugins    Halda pluginaid ja turupaiku (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Loetle kohalikud oskused (\`skills list\`)
  tui        Ava terminali UI
  version    Prindi CLI versioon

Valikud:
  -h, --help       Näita abi
  -v, --version    Näita versiooni
  -p, --prompt <text>  Käivita üks viip TUI-d avamata
  --memory-bench   Koos --prompt-ga lülita sisse automaatne Memory eraldamine ja oota enne väljumist (nõuab Memory sisse lülitamist)
  --browser-use <mode> Lülita sisse Browser Use taustaprogramm (toetatud: headless)
  --surface <surface>  Esituspind headless viipudele/rakendusserverile: terminal või desktop
  --browser-executable <path> Chrome/Chromium käivitatav fail headless Browser Use jaoks
  --attach <path>  Lisa kohalik fail --prompt-le; mitme faili jaoks korda valikut
  --cwd <path>     Käivita see käsk antud kataloogist
  --disallowed-tools, --disallowedTools <tools...>
    Eemalda terviklikud tööriistad ainult selle viivu/TUI käivituse jaoks; salvestatud seaded ei muutu.
    Tööriistade nimed komaga või tühikuga eraldatult, nt "Bash Edit".
    "Bash(git *)" eemaldab kogu Bash-i; käsumustreid ei sobitata.
  --force-mcs      Sunni Anthropic teenusepakkujate jaoks vestluse keskel süsteemiprojektsioon
  --locale <locale>  UI locale: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR või auto
  --mode <mode>    Viipude lubamismode: build, edit, plan või yolo (vaheväärtus yolo: --prompt)
  --resume <sessionId>  Jätka salvestatud sessioon sessionId järgi (sess_...)
  --target <text>  Käivita või määra sessiooni eesmärk headless režiimis
  --target-replace Asenda olemasolev sessiooni eesmärk, mille määras --target
  -c, --continue        Jätka praeguse kataloogi uusim sessioon
  --json           Prindi masinlugitav JSON, kus toetatud
  --no-browser     Prindi OAuth URL brauserit avamata
  --no-color       Keela ANSI värvid
  --verbose        Prindi lisa diagnostikateave

Kaldkriipsukäsud:
  /help [command]       Näita kaldkriipsukäskude abi
  /login                Vali Z.AI või BigModel brauseri sisselogimine
  /logout               Eemalda jagatud Z.AI sisselogimisandmed
  /compact [instructions]  Tihenda praegune vestlus
  /expert [status|resume|stop|<task>]  Käivita või halda ekspertide töövoogu
  /dwf [list|cancel|resume]  Loetle, tühista või jätka dünaamilisi töövoo käivitusi
  /fork [latest|checkpointId]  Loo tööala kontrollpunktist uus sessioon
  /mcp [list|status|connect|disconnect]  Näita või halda MCP servereid
  /mode [mode]          Näita või vaheta lubamismode: build, edit, plan või yolo
  /model [id]           Näita või vaheta praeguse sessiooni mudel
  /new                  Alusta TUI-s uus sessioon
  /resume [sessionId]   Jätka sessioon sessionId järgi; jäta välja, et kasutada cwd viimast
  /rewind [latest|checkpointId]  Näita viimast kontrollpunkti või taasta tööala failid
  /skill [name] [task]  Loetle oskused või sunni järgmine viip üht laadima
  /goal [action]        Näita või määra praeguse sessiooni eesmärk
`,
  },
  tui: {
    copy: {
      copied: "Valitud tekst kopeeriti lõikelauale.",
      failed: "Valitud teksti kopeerimine ebaõnnestus.",
      unavailable: "Teksti kopeerimine lõikelauale pole selles terminaalis saadaval.",
    },
    effort: {
      disabled: "keelatud",
      enabled: "luba",
    },
    input: {
      activeStatusHint: "esc katkestamiseks",
      busyPlaceholder: "Kirjuta, et panna sisend järjekorda",
      placeholder: "Kirjuta viip",
      queuedMore: (count) => `+ ${count} rohkem järjekorras`,
      queuedSubmitHint: "Saadetud pärast järgmist tööriistukõnet.",
      queuedTitle: (count) => ` Järjekord (${count}) `,
      title: "Sisend",
      noHistorySource: "Sisendi ajaloo allikas pole seadistatud.",
      noPreviousInput: "Selle projekti jaoks pole eelmist sisendit.",
      restoredPreviousInput: "Eelmine sisend taastati.",
      restoredPreviousInputWithAttachments: (count) =>
        `Eelmine sisend taastati koos ${count} manulusega.`,
      restorePreviousInputFailed: "Eelmise sisendi taastamine ebaõnnestus.",
      typePrompt: "Kirjuta küsimus ja vajuta Enter.",
    },
    loginRequired: {
      help: "Kasuta /model mudelite vaatamiseks või /login Coding Plan konto ühendamiseks.",
      message: "Saadaolevaid mudeleid pole. Seadista teenusepakkuja või logi sisse /login-ga.",
      status: "Saadaolevaid mudeleid pole. Seadista teenusepakkuja või logi sisse /login-ga.",
      title: "vajalik mudeli seadistus",
    },
    loginSetup: {
      emptyMessage: "Sisselogimisvalikuid pole saadaval.",
      help: "Vali üles/alla, kinnita Enteriga.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Sisesta BigModel Coding Plan API Key",
          inputSecondary: "Kleebi võti siia. Kirjutamisel on see peidetud.",
          primary: "BigModel Coding Plan API võti",
          secondary: "Kleebi Coding Plan API võti käsitsi.",
        },
        bigmodelOauth: {
          pendingPrimary: "Ootab BigModeli autoriseerimist",
          pendingSecondary:
            "Viista sisselogimine lõpule brauseris. Autoriseerimine tuvastatakse automaatselt.",
          primary: "BigModeli Coding Plan",
          secondary: "Ava brauseri sisselogimine; autoriseerimine tuvastatakse automaatselt.",
        },
        zaiApiKey: {
          inputPrimary: "Sisesta Z.AI Coding Plan API Key",
          inputSecondary: "Kleebi võti siia. Kirjutamisel on see peidetud.",
          primary: "Z.AI Coding Plan API võti",
          secondary: "Kleebi Coding Plan API võti käsitsi.",
        },
        zaiOauth: {
          pendingPrimary: "Ootab Z.AI autoriseerimist",
          pendingSecondary:
            "Viista sisselogimine lõpule brauseris. Jätkan, kui autoriseerimine lõpeb.",
          primary: "Z.AI Coding Plan",
          secondary: "Ava brauseri sisselogimine ja loo Coding Plan API võti.",
        },
      },
      pending: {
        cancelStatus: "Sisselogimine tühistatud. Vali seadistusviis.",
        help: "Esc tühistab ja naaseb seadistusvalikutele.",
        status: "Ootab brauseri autoriseerimist...",
      },
      input: {
        cancelStatus: "API võtme sisestamine tühistatud. Vali seadistusviis.",
        clearStatus: "API võtme sisestus tühjendatud.",
        emptyStatus: "API võti on kohustuslik.",
        help: "Enter salvestab võtme. Esc naaseb seadistusvalikutele.",
        placeholder: "Kleebi API võti",
        status: "Sisesta API võti ja vajuta Enter.",
        submitStatus: "API võtme salvestamine...",
      },
      prompt: "Vali sisselogimise või API võtme seadistusviis.",
      response: "Vali, kuidas seadistada Coding Plan teenusepakkuja.",
      title: "Seadista Coding Plan",
    },
    model: {
      requestFailed: (message) => `Mudeli päring ebaõnnestus: ${message}`,
      responseReceived: "Mudeli vastus saadud.",
      responseReceivedWithTokens: (tokens) => `Mudeli vastus saadud. ${tokens} tokenit.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Kordatakse mudeli päringut ${attempt}/${Math.max(1, maxAttempts - 1)} pärast ${delay}: ${reason}`,
      streamStalled: "Mudeli voog jäi seisma.",
    },
    sidebar: {
      subagents: {
        title: "Alaagendid",
        empty: "Alaagente pole veel.",
        emptyOutput: "Väljundit pole veel.",
        back: "← Põhivestlus",
        readonly: "Ainult lugemiseks · Esc naasmiseks",
        loading: "Alaagendi väljundi laadimine...",
        unavailable: "Alaagendi väljund pole saadaval.",
        retry: "Korda",
        more: "Laadi rohkem",
        pendingMain: "Põhivestlus vajab sinu sisestust — naasta vastamiseks",
        ended: (count) => `Lõppetatud (${count})`,
        status: {
          running: "käib",
          waiting: "ootab",
          blocked: "blokeeritud",
          success: "lõpetatud",
          failed: "ebaõnnestunud",
          cancelled: "tühistatud",
          lost: "kaotsi",
        },
      },
      api: {
        empty: "API kutsusi pole veel.",
        model: "Mudel",
        more: (count) => `+${count} veel`,
        requests: "Päringud",
        server: "Hostmasin",
      },
      cache: {
        hit: "tabamus",
        lastHit: "viimane tabamus",
        lastMiss: "viimane puudujääk",
        readWrite: ({ read, write }) => `${read} lugemine / ${write} kirjutamine`,
        total: "kokku",
      },
      context: {
        cache: "Vahemälu",
        cacheReadWrite: "Vahemälu L/K",
        inputOutput: "I/O",
        reason: "Põhjus",
        tokens: "Tokenid",
        used: "Kasutatud",
        window: "Aken",
      },
      modifiedFiles: {
        empty: "Failimuutusi pole veel.",
        more: (count) => `+${count} veel`,
      },
      mcp: {
        empty: "MCP servere pole seadistatud.",
        loadFailed: "MCP olek pole saadaval.",
        loading: "MCP oleku laadimine...",
        more: (count) => `+${count} veel`,
        servers: "Serverid",
        status: {
          connected: "ühendatud",
          connecting: "ühendamisel",
          disabled: "keelatud",
          disconnected: "ühend katkestatud",
          failed: "ebaõnnestus",
          untrusted: "usaldamatu",
        },
        summary: ({ connected, total }) => `${connected}/${total} ühendatud`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "valmis",
        error: "viga",
        errorWithStatus: (statusCode) => `viga ${statusCode}`,
        pending: "ootel",
      },
      status: {
        last: "Viimane",
      },
      run: {
        draft: "Mustand",
        draftChars: (count) => `${count} märki`,
        draftEmpty: "tühi",
        messages: "Sõnumid",
        mode: "Režiim",
        model: "Mudel",
        provider: "Pakkuja",
        thought: "Mõtlemine",
        trace: "Jälg",
        turn: "Vahetus",
        workspace: "Tööruum",
      },
      sections: {
        apis: "API-d",
        context: "Kontekst",
        mcp: "MCP",
        modifiedFiles: "Muudetud failid",
        run: "Käivitamine",
        status: "Olek",
        todos: "Ülesanded",
      },
      shellSubtitle: "OpenTUI kest",
      title: "Külgriba",
      todos: {
        empty: "Ülesandeid pole veel.",
        more: (count) => `+${count} veel`,
        progress: "Edenemine",
      },
    },
    status: {
      compactFailed: "Konteksti tihendamine ebaõnnestus.",
      compacted: "Konts vestlus tihendati.",
      compacting: "Konteksti tihendamine...",
      interruptedStreamDiscarded: "Katkestatud mudeli voog hüljati.",
      modelCalling: "Mudeli väljakutsumine...",
      permissionRequested: (toolName) => `Küsitakse luba ${toolName} jaoks.`,
      permissionResolved: (toolName) => `Luba otsustatud ${toolName} jaoks.`,
      ready: "Valmis.",
      recoveringStream: "Katkenud mudeli voogu taastatakse...",
      retryingStream: "Mudeli voogu proovitakse uuesti...",
      sessionResumed: "Sessioon jätkus.",
      targetChanged: (action) => `Siht ${action}.`,
      thinking: "Mõtlemine...",
      toolCompleted: (toolName) => `Tööriist ${toolName} lõpetatud.`,
      toolFailed: (toolName) => `Tööriist ${toolName} ebaõnnestus.`,
      toolPending: (toolName) => `Tööriist ${toolName} ootel.`,
      toolRunning: (toolName) => `Tööriist ${toolName} käib.`,
      turnFailed: "Vahetus ebaõnnestus.",
    },
    terminal: {
      requiresInteractive: "TUI vajab interaktiivset terminaali.",
      starting: "ZCode käivitamine... Ctrl+C väljumiseks",
    },
    transcript: {
      compact: {
        completed: "Kontekst tihendatud",
        failed: "Konteksti tihendamine ebaõnnestus",
        interrupted: "Konteksti tihendamine katkestatud",
        retry: (command) => `Ctrl-R proovib ${command} uuesti`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Konteksti tihendamise uuesti proovimine (${attempt}/${maxAttempts})`
            : "Konteksti tihendamise uuesti proovimine",
        skipped: "Kontekst on värskes; tihendamist pole vaja",
        started: "Konteksti tihendamine",
      },
      roles: {
        agent: "AIAgent",
        system: "Süsteem",
        user: "Kasutaja",
      },
      thought: {
        complete: "Mõtisklus",
        thinking: "Mõtisklemine...",
      },
      title: "Transkript",
      workflow: {
        actors: "osalejad:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `kasutus: ${spentTokens} tokenit`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Voog ${label} - ${status} (${nodesSettled}/${nodesTotal} sammu)`,
        error: (message) => `viga: ${message}`,
        expandHint: "+ laiendada",
        collapseHint: "- kokku tõmmata",
        log: "logi:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} sammu lõpetatud`,
        result: (preview) => `tulemus: ${preview}`,
        status: {
          completed: "lõpetatud",
          errored: "viga",
          pending: "ootab",
          running: "käib",
          stopped: "peatatud",
        },
        stopReason: {
          user: "sinu poolt",
          model: "agendi poolt",
          provider: "mudeli viga",
          interrupted: "protsess lõpetatud",
          superseded: "asendatud parandatud käiguga",
        },
        truncated: "(katkendlik - täielik ajalugu käigu ajakirjas)",
        interruptedNotice: ({ label, runId }) =>
          `Voogu ${label} katkestati ja seda saab jätkata: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter valib, Esc tühistab",
      disabled: (reason) => ` [keelatud: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filtre: ${filter || "-"} | ${help ?? "Enter valib, Esc tühistab"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Tööruumi vastavaid radasid pole leitud.",
      loading: "Tööruumi radade laadimine...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Failid",
    },
    slash: {
      title: "Käsklused",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
