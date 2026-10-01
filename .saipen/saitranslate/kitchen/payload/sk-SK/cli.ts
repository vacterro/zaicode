import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "sk-SK",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Nepodporovaná hodnota --locale: ${value}. Podporované lokality: en-US, zh-CN, auto.`,
    },
    help: (version) => `zcode ${version}

Použitie:
  zcode [command] [options]

Bez príkazu zcode otvorí TUI na celú obrazovku.

Príkazy:
  app-server Spustí ZCode Protocol stdio app server
  commands   Vypíše vlastné slash príkazy (\`commands list\`)
  doctor     Skontroluje behové prostredie a predpoklady balenia
  login [zai|bigmodel]  Prihlásenie cez autorizáciu v prehliadači
  logout     Odstráni zdieľané prihlasovacie údaje Z.AI
  plugins    Spravuje pluginy a marketplaces (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Vypíše lokálne zručnosti (\`skills list\`)
  tui        Otvorí terminálové UI
  version    Vypíše verziu CLI

Možnosti:
  -h, --help       Zobrazí pomoc
  -v, --version    Zobrazí verziu
  -p, --prompt <text>  Spustí jediný prompt bez otvorenia TUI
  --memory-bench   S --prompt zapne automatickú extrakciu Memory a počká pred ukončením (vyžaduje zapnuté Memory)
  --browser-use <mode> Zapne backend Browser Use (podporované: headless)
  --surface <surface>  Zobrazovácia plocha pre headless prompty/app-server: terminal alebo desktop
  --browser-executable <path> Spustiteľný súbor Chrome/Chromium pre headless Browser Use
  --attach <path>  Pripojí lokálny súbor k --prompt; opakovať pre viac súborov
  --cwd <path>     Spustí tento príkaz z daného adresára
  --disallowed-tools, --disallowedTools <tools...>
    Odstráni celé nástroje len pre tento prompt/TUI beh; uložené nastavenia zostávajú nezmenené.
    Názvy nástrojov oddelené čiarkou alebo medzerou, napr. "Bash Edit".
    "Bash(git *)" odstráni celý Bash; vzorce príkazov sa nezhodujú.
  --force-mcs      Vynúti projekciu systému uprostred konverzácie pre poskytovateľov Anthropic
  --locale <locale>  Jazyk UI: en-US, zh-CN alebo auto
  --mode <mode>    Režim oprávnení pre prompty: build, edit, plan alebo yolo (predvolene yolo pre --prompt)
  --resume <sessionId>  Obnoví uloženú session podľa sessionId (sess_...)
  --target <text>  Spustí alebo nastaví cieľ session v headless režime
  --target-replace Nahradí existujúci cieľ session nastavený cez --target
  -c, --continue        Obnoví najnovšiu session pre aktuálny adresár
  --json           Vypíše čitateľný JSON tam, kde je to podporované
  --no-browser     Vypíše OAuth URL bez otvorenia prehliadača
  --no-color       Vypne farby ANSI
  --verbose        Vypíše ďalšie diagnostické detaily

Slash príkazy:
  /help [command]       Zobrazí pomoc pre slash príkazy
  /login                Vyberie prihlásenie Z.AI alebo BigModel v prehliadači
  /logout               Odstráni zdieľané prihlasovacie údaje Z.AI
  /compact [instructions]  Zhustí aktuálnu konverzáciu
  /expert [status|resume|stop|<task>]  Spustí alebo spravuje expert workflow
  /dwf [list|cancel|resume]  Vypíše, zruší alebo obnoví behy dynamických workflowov
  /fork [latest|checkpointId]  Vytvorí novú session z checkpointu pracovného priestoru
  /mcp [list|status|connect|disconnect]  Zobrazí alebo spravuje MCP servery
  /mode [mode]          Zobrazí alebo prepne režim oprávnení: build, edit, plan alebo yolo
  /model [id]           Zobrazí alebo prepne model aktuálnej session
  /new                  Spustí novú session v TUI
  /resume [sessionId]   Obnoví session podľa sessionId; bez neho najnovšiu v cwd
  /rewind [latest|checkpointId]  Zobrazí najnovší checkpoint alebo obnoví súbory pracovného priestoru
  /skill [name] [task]  Vypíše zručnosti alebo vynúti načítanie pri nasledujúcom prompte
  /goal [action]        Zobrazí alebo nastaví cieľ aktuálnej session
`,
  },
  tui: {
    copy: {
      copied: "Vybraný text skopírovaný do schránky.",
      failed: "Kopírovanie vybraného textu zlyhalo.",
      unavailable: "Kopírovanie textu do schránky nie je v tomto termináli dostupné.",
    },
    effort: {
      disabled: "vypnuté",
      enabled: "zapnuté",
    },
    input: {
      activeStatusHint: "esc na prerušenie",
      busyPlaceholder: "Píšte na zaradenie vstupu",
      placeholder: "Napíšte prompt",
      queuedMore: (count) => `+ ${count} ďalších zaradených`,
      queuedSubmitHint: "Odoslané po ďalšom volaní nástroja.",
      queuedTitle: (count) => ` Zaradenie (${count}) `,
      title: "Vstup",
      noHistorySource: "Nie je nastavený zdroj histórie vstupov.",
      noPreviousInput: "Žiadny predchádzajúci vstup pre tento projekt.",
      restoredPreviousInput: "Obnovený predchádzajúci vstup.",
      restoredPreviousInputWithAttachments: (count) =>
        `Obnovený predchádzajúci vstup s ${count} prílohami.`,
      restorePreviousInputFailed: "Obnovenie predchádzajúceho vstupu zlyhalo.",
      typePrompt: "Napíšte otázku a stlačte Enter.",
    },
    loginRequired: {
      help: "Použite /model na zobrazenie modelov alebo /login na pripojenie účtu Coding Plan.",
      message: "Nie sú dostupné žiadne modely. Nastavte poskytovateľa alebo sa prihláste cez /login.",
      status: "Nie sú dostupné žiadne modely. Nastavte poskytovateľa alebo sa prihláste cez /login.",
      title: "vyžaduje sa nastavenie modelu",
    },
    loginSetup: {
      emptyMessage: "Nie sú dostupné žiadne možnosti prihlásenia.",
      help: "Použite Up/Down na výber, Enter na potvrdenie.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Zadajte BigModel Coding Plan API kľúč",
          inputSecondary: "Vložte kľúč sem. Pri písaní je skrytý.",
          primary: "BigModel Coding Plan API kľúč",
          secondary: "Vložte kľúč API Coding Plan ručne.",
        },
        bigmodelOauth: {
          pendingPrimary: "Čaká sa na autorizáciu BigModel",
          pendingSecondary:
            "Dokončite prihlásenie v prehliadači. Autorizácia sa zistí automaticky.",
          primary: "BigModel Coding Plan",
          secondary: "Otvoriť prihlásenie v prehliadači; autorizácia sa zistí automaticky.",
        },
        zaiApiKey: {
          inputPrimary: "Zadajte Z.AI Coding Plan API kľúč",
          inputSecondary: "Vložte kľúč sem. Pri písaní je skrytý.",
          primary: "Z.AI Coding Plan API kľúč",
          secondary: "Vložte kľúč API Coding Plan ručne.",
        },
        zaiOauth: {
          pendingPrimary: "Čaká sa na autorizáciu Z.AI",
          pendingSecondary:
            "Dokončite prihlásenie v prehliadači. Pokračujem po dokončení autorizácie.",
          primary: "Z.AI Coding Plan",
          secondary: "Otvorte prihlásenie v prehliadači a vytvorte API kľúč Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Prihlásenie zrušené. Vyberte metódu nastavenia.",
        help: "Esc zruší a vráti na možnosti nastavenia.",
        status: "Čaká sa na autorizáciu v prehliadači...",
      },
      input: {
        cancelStatus: "Zadanie API kľúča zrušené. Vyberte metódu nastavenia.",
        clearStatus: "Vstup API kľúča vymazaný.",
        emptyStatus: "API kľúč je povinný.",
        help: "Enter uloží kľúč. Esc vráti na možnosti nastavenia.",
        placeholder: "Prilepte API kľúč",
        status: "Zadajte API kľúč a stlačte Enter.",
        submitStatus: "Ukladá sa API kľúč...",
      },
      prompt: "Vyberte metódu nastavenia cez prihlásenie alebo API kľúč.",
      response: "Vyberte, ako nastaviť poskytovateľa Coding Plan.",
      title: "Nastaviť Coding Plan",
    },
    model: {
      requestFailed: (message) => `Požiadavka modelu zlyhala: ${message}`,
      responseReceived: "Odpoveď modelu prijatá.",
      responseReceivedWithTokens: (tokens) => `Odpoveď modelu prijatá. ${tokens} tokenov.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Opakovanie požiadavky modelu ${attempt}/${Math.max(1, maxAttempts - 1)} o ${delay}: ${reason}`,
      streamStalled: "Prúd modelu sa zastavil.",
    },
    sidebar: {
      subagents: {
        title: "Subagenti",
        empty: "Zatiaľ žiadne subagenty.",
        emptyOutput: "Zatiaľ žiadny výstup.",
        back: "← Hlavná konverzácia",
        readonly: "Iba na čítanie · Esc na návrat",
        loading: "Načítava sa výstup subagentu...",
        unavailable: "Výstup subagentu nedostupný.",
        retry: "Skúsiť znova",
        more: "Načítať viac",
        pendingMain: "Hlavná konverzácia vyžaduje váš vstup — vráťte sa, aby ste odpovedeli",
        ended: (count) => `Ukončené (${count})`,
        status: {
          running: "beží",
          waiting: "čaká",
          blocked: "zablokované",
          success: "dokončené",
          failed: "zlyhané",
          cancelled: "zrušené",
          lost: "stratené",
        },
      },
      api: {
        empty: "Zatiaľ žiadne volania API.",
        model: "Typ modelu",
        more: (count) => `+${count} ďalších`,
        requests: "Požiadavky",
        server: "Servér",
      },
      cache: {
        hit: "zásah",
        lastHit: "posledný zásah",
        lastMiss: "posledný výpadok",
        readWrite: ({ read, write }) => `${read} čít. / ${write} záp.`,
        total: "spolu",
      },
      context: {
        cache: "Vyrovnávacia pamäť",
        cacheReadWrite: "Pamäť čít./záp.",
        inputOutput: "I/O",
        reason: "Dôvod",
        tokens: "Tokeny",
        used: "Použité",
        window: "Okno",
      },
      modifiedFiles: {
        empty: "Zatiaľ žiadne zmeny súborov.",
        more: (count) => `+${count} ďalších`,
      },
      mcp: {
        empty: "Nie sú nakonfigurované žiadne servery MCP.",
        loadFailed: "Stav MCP nedostupný.",
        loading: "Načítava sa stav MCP...",
        more: (count) => `+${count} ďalších`,
        servers: "Servery",
        status: {
          connected: "pripojené",
          connecting: "pripája sa",
          disabled: "vypnuté",
          disconnected: "odpojené",
          failed: "zlyhané",
          untrusted: "nedôveryhodné",
        },
        summary: ({ connected, total }) => `${connected}/${total} pripojené`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "dokončené",
        error: "chyba",
        errorWithStatus: (statusCode) => `chyba ${statusCode}`,
        pending: "čaká",
      },
      status: {
        last: "Posledná",
      },
      run: {
        draft: "Koncept",
        draftChars: (count) => `${count} znakov`,
        draftEmpty: "prázdne",
        messages: "Správy",
        mode: "Režim",
        model: "Typ modelu",
        provider: "Poskytovateľ",
        thought: "Myšlienky",
        trace: "Trasa",
        turn: "Kolo",
        workspace: "Pracovný priestor",
      },
      sections: {
        apis: "API",
        context: "Kontext",
        mcp: "MCP",
        modifiedFiles: "Upravené súbory",
        run: "Spustiť",
        status: "Stav",
        todos: "Úlohy",
      },
      shellSubtitle: "shell OpenTUI",
      title: "Bočný panel",
      todos: {
        empty: "Zatiaľ žiadne úlohy.",
        more: (count) => `+${count} ďalších`,
        progress: "Progres",
      },
    },
    status: {
      compactFailed: "Kompresia kontextu zlyhala.",
      compacted: "Konverzácia bola skrátená.",
      compacting: "Komprimujem kontext...",
      interruptedStreamDiscarded: "Prerušený stream modelu bol zahodený.",
      modelCalling: "Volám model...",
      permissionRequested: (toolName) => `Požiadalo sa o povolenie pre ${toolName}.`,
      permissionResolved: (toolName) => `Povolenie pre ${toolName} bolo vyriešené.`,
      ready: "Pripravené.",
      recoveringStream: "Obnovujem prerušený stream modelu...",
      retryingStream: "Skúšam znova stream modelu...",
      sessionResumed: "Relácia obnovená.",
      targetChanged: (action) => `Cieľ ${action}.`,
      thinking: "Premýšľam...",
      toolCompleted: (toolName) => `Nástroj ${toolName} dokončený.`,
      toolFailed: (toolName) => `Nástroj ${toolName} zlyhal.`,
      toolPending: (toolName) => `Nástroj ${toolName} čaká.`,
      toolRunning: (toolName) => `Nástroj ${toolName} beží.`,
      turnFailed: "Kolo zlyhalo.",
    },
    terminal: {
      requiresInteractive: "TUI vyžaduje interaktívny terminál.",
      starting: "Spúšťam ZCode... Ctrl+C na ukončenie",
    },
    transcript: {
      compact: {
        completed: "Kontext skomprimovaný",
        failed: "Kompresia kontextu zlyhala",
        interrupted: "Kompresia kontextu prerušená",
        retry: (command) => `Ctrl-R na znovu pokúsenie ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Opakovanie kompresie kontextu (${attempt}/${maxAttempts})`
            : "Opakovanie kompresie kontextu",
        skipped: "Kontext je aktuálny; kompresia nie je potrebná",
        started: "Kompresia kontextu",
      },
      roles: {
        agent: "Asistent",
        system: "Systém",
        user: "Používateľ",
      },
      thought: {
        complete: "Myšlienka",
        thinking: "Premýšľa...",
      },
      title: "Prepis",
      workflow: {
        actors: "aktéri:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `použitie: ${spentTokens} tokenov`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Pracovný postup ${label} - ${status} (${nodesSettled}/${nodesTotal} krokov)`,
        error: (message) => `chyba: ${message}`,
        expandHint: "+ na rozbalenie",
        collapseHint: "- na zbalenie",
        log: "zápis:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} krokov dokončených`,
        result: (preview) => `výsledok: ${preview}`,
        status: {
          completed: "dokončené",
          errored: "s chybou",
          pending: "čaká",
          running: "beží",
          stopped: "zastavené",
        },
        stopReason: {
          user: "vami",
          model: "agentom",
          provider: "chyba modelu",
          interrupted: "proces ukončený",
          superseded: "nahradené opraveným behom",
        },
        truncated: "(skrátené – celá história v denníku behu)",
        interruptedNotice: ({ label, runId }) =>
          `Pracovný postup ${label} bol prerušený a možno ho obnoviť: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter potvrdzuje, Esc zruší",
      disabled: (reason) => ` [vypnuté: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filtr: ${filter || "-"} | ${help ?? "Enter potvrdzuje, Esc zruší"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Žiadne zhodné cesty pracovného priestoru.",
      loading: "Načítavajú sa cesty pracovného priestoru...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Súbory",
    },
    slash: {
      title: "Príkazy",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
