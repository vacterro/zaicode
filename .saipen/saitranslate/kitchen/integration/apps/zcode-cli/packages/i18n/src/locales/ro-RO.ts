import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "ro-RO",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Valoare --locale nesuportată: ${value}. Localizări suportate: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Utilizare:
  zcode [comandă] [opțiuni]

Fără comandă, zcode deschide TUI pe ecran complet.

Comenzi:
  app-server Rulează serverul de aplicație ZCode Protocol stdio
  commands   Listează comenzi slash personalizate (\`commands list\`)
  doctor     Inspectează presupunerile runtime-ului și ale împachetării
  login [zai|bigmodel]  Autentificare prin browser
  logout     Elimină credențele Z.AI de login partajate
  plugins    Gestionează pluginuri și piețe (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Listează skillurile locale (\`skills list\`)
  tui        Deschide interfața terminalului
  version    Afișează versiunea CLI

Opțiuni:
  -h, --help       Afișează ajutorul
  -v, --version    Afișează versiunea
  -p, --prompt <text>  Rulează un singur prompt fără a deschide TUI
  --memory-bench   Împreună cu --prompt, activează extragerea automată Memory și așteaptă înainte de ieșire (necesită Memory activat)
  --browser-use <mode> Activează backend-ul Browser Use (suportat: headless)
  --surface <surface>  Suprafața de prezentare pentru prompturi headless/app-server: terminal sau desktop
  --browser-executable <path> Executabil Chrome/Chromium pentru Browser Use headless
  --attach <path>  Atașează un fișier local la --prompt; repetă pentru mai multe fișiere
  --cwd <path>     Rulează această comandă din directorul dat
  --disallowed-tools, --disallowedTools <tools...>
    Elimină complet toolurile pentru acest prompt/TUI; setările salvate rămân neschimbate.
    Nume de tooluri separate prin virgulă sau spațiu, ex. "Bash Edit".
    "Bash(git *)" elimină tot Bash; tiparele de comenzi nu se potrivesc.
  --force-mcs      Forțează proiecția de sistem la mijlocul conversației pentru furnizori Anthropic
  --locale <locale>  Localizarea interfeței: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR sau auto
  --mode <mode>    Modul de permisiuni pentru prompturi: build, edit, plan sau yolo (implicit: yolo pentru --prompt)
  --resume <sessionId>  Reia o sesiune persistată după sessionId (sess_...)
  --target <text>  Rulează sau setează obiectivul sesiunii în modul headless
  --target-replace Înlocuiește orice obiectiv de sesiune existent setat de --target
  -c, --continue        Reia ultima sesiune pentru directorul curent
  --json           Afișează JSON lizibil de mașină unde este suportat
  --no-browser     Afișează URL-ul OAuth fără a deschide browserul
  --no-color       Dezactivează culorile ANSI
  --verbose        Afișează detalii suplimentare de diagnosticare

Comenzi slash:
  /help [comandă]       Afișează ajutorul pentru comenzi slash
  /login                Alege login Z.AI sau BigModel prin browser
  /logout               Elimină credențele Z.AI de login partajate
  /compact [instrucțiuni]  Compactează conversația curentă
  /expert [status|resume|stop|<task>]  Rulează sau gestionează fluxul de lucru expert
  /dwf [list|cancel|resume]  Listează, anulează sau reia rulările fluxurilor dinamice
  /fork [latest|checkpointId]  Creează o sesiune nouă dintr-un checkpoint al spațiului de lucru
  /mcp [list|status|connect|disconnect]  Afișează sau gestionează servere MCP
  /mode [mod]          Afișează sau schimbă modul de permisiuni: build, edit, plan sau yolo
  /model [id]           Afișează sau schimbă modelul sesiunii curente
  /new                  Începe o sesiune nouă în TUI
  /resume [sessionId]   Reia o sesiune după sessionId; omite pentru ultima din cwd
  /rewind [latest|checkpointId]  Afișează ultimul checkpoint sau restaurează fișierele spațiului de lucru
  /skill [name] [task]  Listează skilluri sau forțează următorul prompt să încarce unul
  /goal [acțiune]        Afișează sau setează obiectivul sesiunii curente
`,
  },
  tui: {
    copy: {
      copied: "Textul selectat a fost copiat în clipboard.",
      failed: "Nu s-a putut copia textul selectat.",
      unavailable: "Copierea în clipboard nu este disponibilă în acest terminal.",
    },
    effort: {
      disabled: "dezactivat",
      enabled: "activat",
    },
    input: {
      activeStatusHint: "esc pentru a întrerupe",
      busyPlaceholder: "Scrie pentru a introduce în coadă",
      placeholder: "Scrie un prompt",
      queuedMore: (count) => `+ încă ${count} în coadă`,
      queuedSubmitHint: "Se trimite după următoarea apelare de tool.",
      queuedTitle: (count) => ` Coadă (${count}) `,
      title: "Intrare",
      noHistorySource: "Nu este configurată nicio sursă de istoric pentru intrări.",
      noPreviousInput: "Nicio intrare anterioară pentru acest proiect.",
      restoredPreviousInput: "Intrare anterioară restaurată.",
      restoredPreviousInputWithAttachments: (count) =>
        `Intrare anterioară restaurată cu ${count} atașament(e).`,
      restorePreviousInputFailed: "Nu s-a putut restaura intrarea anterioară.",
      typePrompt: "Scrie o întrebare și apasă Enter.",
    },
    loginRequired: {
      help: "Folosește /model pentru a vedea modelele sau /login pentru a conecta un cont Coding Plan.",
      message: "Niciun model disponibil. Configurează un furnizor sau autentifică-te cu /login.",
      status: "Niciun model disponibil. Configurează un furnizor sau autentifică-te cu /login.",
      title: "configurare model necesară",
    },
    loginSetup: {
      emptyMessage: "Nu există opțiuni de autentificare disponibile.",
      help: "Folosește Sus/Jos pentru a alege, Enter pentru a selecta.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Introdu cheia API BigModel Coding Plan",
          inputSecondary: "Lipește cheia aici. Rămâne ascunsă în timpul scrierii.",
          primary: "Cheie API BigModel Coding Plan",
          secondary: "Lipește manual o cheie API Coding Plan.",
        },
        bigmodelOauth: {
          pendingPrimary: "Se așteaptă autorizarea BigModel",
          pendingSecondary:
            "Finalizează autentificarea în browser. Autorizarea este detectată automat.",
          primary: "BigModel Coding Plan",
          secondary: "Deschide login în browser; autorizarea este detectată automat.",
        },
        zaiApiKey: {
          inputPrimary: "Introdu cheia API Z.AI Coding Plan",
          inputSecondary: "Lipește cheia aici. Rămâne ascunsă în timpul scrierii.",
          primary: "Cheie API Z.AI Coding Plan",
          secondary: "Lipește manual o cheie API Coding Plan.",
        },
        zaiOauth: {
          pendingPrimary: "Se așteaptă autorizarea Z.AI",
          pendingSecondary:
            "Finalizează autentificarea în browser. Voi continua când se încheie autorizarea.",
          primary: "Z.AI Coding Plan",
          secondary: "Deschide autentificarea în browser și creează o cheie API Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Autentificare anulată. Alege o metodă de configurare.",
        help: "Esc anulează și revine la opțiunile de configurare.",
        status: "Se așteaptă autorizarea în browser...",
      },
      input: {
        cancelStatus: "Introducerea cheii API a fost anulată. Alege o metodă de configurare.",
        clearStatus: "Câmpul pentru cheia API a fost golit.",
        emptyStatus: "Cheia API este obligatorie.",
        help: "Enter salvează cheia. Esc revine la opțiunile de configurare.",
        placeholder: "Lipește cheia API",
        status: "Introdu cheia API, apoi apasă Enter.",
        submitStatus: "Se salvează cheia API...",
      },
      prompt: "Alege o metodă de configurare prin autentificare sau cu cheie API.",
      response: "Alege modul de configurare a unui furnizor Coding Plan.",
      title: "Configurează Coding Plan",
    },
    model: {
      requestFailed: (message) => `Cererea modelului a eșuat: ${message}`,
      responseReceived: "Răspunsul modelului a fost primit.",
      responseReceivedWithTokens: (tokens) => `Răspunsul modelului a fost primit. ${tokens} tokeni.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Se reîncearcă cererea modelului ${attempt}/${Math.max(1, maxAttempts - 1)} în ${delay}: ${reason}`,
      streamStalled: "Transmiterea răspunsului modelului s-a blocat.",
    },
    sidebar: {
      subagents: {
        title: "Subagenți",
        empty: "Încă niciun subagenți.",
        emptyOutput: "Încă niciun rezultat.",
        back: "← Conversația principală",
        readonly: "Doar citire · Esc pentru revenire",
        loading: "Se încarcă rezultatul subagențului...",
        unavailable: "Rezultatul subagențului nu este disponibil.",
        retry: "Reîncearcă",
        more: "Încarcă mai mult",
        pendingMain: "Conversația principală așteaptă răspunsul tău — revino pentru a răspunde",
        ended: (count) => `Încheiat (${count})`,
        status: {
          running: "în execuție",
          waiting: "în așteptare",
          blocked: "blocat",
          success: "finalizat",
          failed: "eșuat",
          cancelled: "anulat",
          lost: "pierdut",
        },
      },
      api: {
        empty: "Încă niciun apel API.",
        model: "Model utilizat",
        more: (count) => `+${count} mai mult`,
        requests: "Cereri",
        server: "Calculator server",
      },
      cache: {
        hit: "acord",
        lastHit: "ultimul acord",
        lastMiss: "ultima ratare",
        readWrite: ({ read, write }) => `${read} citire / ${write} scriere`,
        total: "Număr total",
      },
      context: {
        cache: "Memorie cache",
        cacheReadWrite: "Cache Citire/Scriere",
        inputOutput: "I/O",
        reason: "Motiv",
        tokens: "Tokeni",
        used: "Folosit",
        window: "Fereastră",
      },
      modifiedFiles: {
        empty: "Nicio modificare de fișier încă.",
        more: (count) => `+${count} mai mult`,
      },
      mcp: {
        empty: "Niciun server MCP configurat.",
        loadFailed: "Starea MCP indisponibilă.",
        loading: "Se încarcă starea MCP...",
        more: (count) => `+${count} mai mult`,
        servers: "Servere",
        status: {
          connected: "conectat",
          connecting: "se conectează",
          disabled: "dezactivat",
          disconnected: "deconectat",
          failed: "eșuat",
          untrusted: "neverificat",
        },
        summary: ({ connected, total }) => `${connected}/${total} conectate`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "complet",
        error: "eroare",
        errorWithStatus: (statusCode) => `eroare ${statusCode}`,
        pending: "în așteptare",
      },
      status: {
        last: "Ultimul",
      },
      run: {
        draft: "Ciornă",
        draftChars: (count) => `${count} caractere`,
        draftEmpty: "gol",
        messages: "Mesaje",
        mode: "Mod",
        model: "Model AI",
        provider: "Furnizor",
        thought: "Gând",
        trace: "Trasă",
        turn: "Rundă",
        workspace: "Spațiu de lucru",
      },
      sections: {
        apis: "API-uri",
        context: "Conținut",
        mcp: "MCP",
        modifiedFiles: "Fișiere modificate",
        run: "Execută",
        status: "Stare",
        todos: "Taskuri",
      },
      shellSubtitle: "Shell OpenTUI",
      title: "Bara laterală",
      todos: {
        empty: "Încă niciun task.",
        more: (count) => `+${count} în plus`,
        progress: "Progres",
      },
    },
    status: {
      compactFailed: "Comprimarea contextului a eșuat.",
      compacted: "Conversație compactată.",
      compacting: "Se comprimă contextul...",
      interruptedStreamDiscarded: "Fluxul modelului întrerupt a fost eliminat.",
      modelCalling: "Se apelează modelul...",
      permissionRequested: (toolName) => `Permisiune cerută pentru ${toolName}.`,
      permissionResolved: (toolName) => `Permisiune rezolvată pentru ${toolName}.`,
      ready: "Gata.",
      recoveringStream: "Se recuperează fluxul modelului întrerupt...",
      retryingStream: "Se reîncearcă fluxul modelului...",
      sessionResumed: "Sesiune reluată.",
      targetChanged: (action) => `Țintă ${action}.`,
      thinking: "Se gândește...",
      toolCompleted: (toolName) => `Instrumentul ${toolName} s-a încheiat.`,
      toolFailed: (toolName) => `Instrumentul ${toolName} a eșuat.`,
      toolPending: (toolName) => `Instrumentul ${toolName} în așteptare.`,
      toolRunning: (toolName) => `Instrumentul ${toolName} în execuție.`,
      turnFailed: "Runda a eșuat.",
    },
    terminal: {
      requiresInteractive: "TUI necesită un terminal interactiv.",
      starting: "Se pornește ZCode... Ctrl+C pentru ieșire",
    },
    transcript: {
      compact: {
        completed: "Context comprimat",
        failed: "Comprimarea contextului a eșuat",
        interrupted: "Comprimarea contextului întreruptă",
        retry: (command) => `Ctrl-R pentru a reîncerca ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Se reîncearcă comprimarea contextului (${attempt}/${maxAttempts})`
            : "Se reîncearcă comprimarea contextului",
        skipped: "Contextul este la zi; nu este necesară comprimarea",
        started: "Comprimarea contextului",
      },
      roles: {
        agent: "Asistent",
        system: "Sistem",
        user: "Utilizator",
      },
      thought: {
        complete: "Gând",
        thinking: "Se gândește...",
      },
      title: "Jurnal",
      workflow: {
        actors: "actori:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `utilizare: ${spentTokens} tokenuri`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Flux ${label} - ${status} (${nodesSettled}/${nodesTotal} pași)`,
        error: (message) => `eroare: ${message}`,
        expandHint: "+ pentru a extinde",
        collapseHint: "- pentru a restrânge",
        log: "jurnal:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} pași finalizați`,
        result: (preview) => `rezultat: ${preview}`,
        status: {
          completed: "finalizat",
          errored: "eroare",
          pending: "în așteptare",
          running: "în execuție",
          stopped: "oprit",
        },
        stopReason: {
          user: "de tine",
          model: "de agent",
          provider: "eroare model",
          interrupted: "proces încheiat",
          superseded: "înlocuit de o rulare revizuită",
        },
        truncated: "(truncat - istoricul complet în jurnalul rulării)",
        interruptedNotice: ({ label, runId }) =>
          `Fluxul ${label} a fost întrerupt și poate fi reluat: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter selectează, Esc anulează",
      disabled: (reason) => ` [dezactivat: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filtru: ${filter || "-"} | ${help ?? "Enter selectează, Esc anulează"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Nicio cale de spațiu de lucru corespunzătoare.",
      loading: "Se încarcă căile spațiului de lucru...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Fișiere",
    },
    slash: {
      title: "Comenzi",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
