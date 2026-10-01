import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "cs-CZ",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Nepodporovaná hodnota --locale: ${value}. Podporovaná lokalizace: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Použití:
  zcode [příkaz] [možnosti]

Bez příkazu otevře zcode celoobrazovkové TUI.

Příkazy:
  app-server Spustí stdio app server protokolu ZCode
  commands   Seznam vlastních slash příkazů (\`commands list\`)
  doctor     Zkontroluje běhové a balíčkové předpoklady
  login [zai|bigmodel]  Přihlášení přes autorizaci v prohlížeči
  logout     Odebere sdílené přihlašovací údaje Z.AI
  plugins    Správa pluginů a marketplaces (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Seznam místních skills (\`skills list\`)
  tui        Otevře terminálové UI
  version    Vypíše verzi CLI

Možnosti:
  -h, --help       Zobrazit nápovědu
  -v, --version    Zobrazit verzi
  -p, --prompt <text>  Spustit jeden prompt bez otevření TUI
  --memory-bench   S --prompt zapne automatickou extrakci Memory a před ukončením vyčká (vyžaduje zapnuté Memory)
  --browser-use <mode> Zapnout backend Browser Use (podporováno: headless)
  --surface <surface>  Prezentace pro headless prompty/app-server: terminal nebo desktop
  --browser-executable <path> Spustitelný soubor Chrome/Chromium pro headless Browser Use
  --attach <path>  Připojit místní soubor k --prompt; opakujte pro více souborů
  --cwd <path>     Spustit tento příkaz z daného adresáře
  --disallowed-tools, --disallowedTools <tools...>
    Pro tento běh promptu/TUI odebrat celé nástroje; uložená nastavení se nemění.
    Názvy nástrojů oddělené čárkou nebo mezerou, např. "Bash Edit".
    "Bash(git *)" odebere celé Bash; vzory příkazů se neshodují.
  --force-mcs      Vynutit projekci systému v průběhu konverzace pro poskytovatele Anthropic
  --locale <locale>  Lokalizace UI: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR nebo auto
  --mode <mode>    Režim oprávnění pro prompty: build, edit, plan nebo yolo (výchozí yolo pro --prompt)
  --resume <sessionId>  Obnovit uloženou relaci podle sessionId (sess_...)
  --target <text>  Spustit nebo nastavit cíl relance v headless režimu
  --target-replace Nahradit jakýkoli existující cíl relance nastavený pomocí --target
  -c, --continue        Obnovit nejnovější relaci pro aktuální adresář
  --json           Vypisovat JSON pro strojové zpracování, kde je podporováno
  --no-browser     Vypíše URL OAuth bez otevření prohlížeče
  --no-color       Vypnout barvy ANSI
  --verbose        Vypisovat extra diagnostické detaily

Slash příkazy:
  /help [command]       Zobrazit nápovědu slash příkazů
  /login                Vybrat přihlášení Z.AI nebo BigModel v prohlížeči
  /logout               Odebrat sdílené přihlašovací údaje Z.AI
  /compact [instructions]  Zkomprimovat aktuální konverzaci
  /expert [status|resume|stop|<task>]  Spustit nebo spravovat expertní workflow
  /dwf [list|cancel|resume]  Seznam, zrušit nebo obnovit dynamické běhy workflow
  /fork [latest|checkpointId]  Vytvořit novou relaci z checkpointu pracovního prostoru
  /mcp [list|status|connect|disconnect]  Zobrazit nebo spravovat MCP servery
  /mode [mode]          Zobrazit nebo přepnout režim oprávnění: build, edit, plan nebo yolo
  /model [id]           Zobrazit nebo přepnout model aktuální relace
  /new                  Spustit novou relaci v TUI
  /resume [sessionId]   Obnovit relaci podle sessionId; vynecháním nejnovější v cwd
  /rewind [latest|checkpointId]  Zobrazit nejnovější checkpoint nebo obnovit soubory pracovního prostoru
  /skill [name] [task]  Seznam skills nebo vynutit načtení některé pro další prompt
  /goal [action]        Zobrazit nebo nastavit cíl aktuální relace
`,
  },
  tui: {
    copy: {
      copied: "Vybraný text zkopírován do schránky.",
      failed: "Vybraný text se nepodařilo zkopírovat.",
      unavailable: "Kopírování textu do schránky není v tomto terminálu dostupné.",
    },
    effort: {
      disabled: "vypnuto",
      enabled: "zapnuto",
    },
    input: {
      activeStatusHint: "esc pro přerušení",
      busyPlaceholder: "Pište pro zařazení vstupu do fronty",
      placeholder: "Zadejte prompt",
      queuedMore: (count) => `+ ${count} dalších ve frontě`,
      queuedSubmitHint: "Odesláno po dalším volání nástroje.",
      queuedTitle: (count) => ` Fronta (${count}) `,
      title: "Vstup",
      noHistorySource: "Není nakonfigurovaný žádný zdroj historie vstupů.",
      noPreviousInput: "Žádný předchozí vstup pro tento projekt.",
      restoredPreviousInput: "Předchozí vstup obnoven.",
      restoredPreviousInputWithAttachments: (count) =>
        `Předchozí vstup obnoven s ${count} příloh(ou).`,
      restorePreviousInputFailed: "Předchozí vstup se nepodařilo obnovit.",
      typePrompt: "Napište otázku a stiskněte Enter.",
    },
    loginRequired: {
      help: "Pomocí /model zobrazíte modely nebo pomocí /login připojíte účet Coding Plan.",
      message: "Žádné dostupné modely. Nastavte poskytovatele nebo se přihlaste pomocí /login.",
      status: "Žádné dostupné modely. Nastavte poskytovatele nebo se přihlaste pomocí /login.",
      title: "je nutné nastavit model",
    },
    loginSetup: {
      emptyMessage: "Nejsou dostupné žádné možnosti přihlášení.",
      help: "Počítejte Up/Down pro výběr, Enter pro potvrzení.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Zadejte BigModel Coding Plan API Key",
          inputSecondary: "Klíč sem vložte. Při psaní je skrytý.",
          primary: "Klíč API BigModel Coding Plan",
          secondary: "Vložte API key pro Coding Plan ručně.",
        },
        bigmodelOauth: {
          pendingPrimary: "Čeká se na autorizaci BigModel",
          pendingSecondary:
            "Dokončete přihlášení v prohlížeči. Autorizace bude zjištěna automaticky.",
          primary: "Plán BigModel Coding Plan",
          secondary: "Otevřít přihlášení v prohlížeči; autorizace bude zjištěna automaticky.",
        },
        zaiApiKey: {
          inputPrimary: "Zadejte Z.AI Coding Plan API Key",
          inputSecondary: "Klíč sem vložte. Při psaní je skrytý.",
          primary: "Klíč API Z.AI Coding Plan",
          secondary: "Vložte API key pro Coding Plan ručně.",
        },
        zaiOauth: {
          pendingPrimary: "Čeká se na autorizaci Z.AI",
          pendingSecondary:
            "Dokončete přihlášení v prohlížeči. Pokračuji po dokončení autorizace.",
          primary: "Z.AI Coding Plan",
          secondary: "Otevřete přihlášení v prohlížeči a vytvořte API klíč k Coding Planu.",
        },
      },
      pending: {
        cancelStatus: "Přihlášení zrušeno. Zvolte způsob nastavení.",
        help: "Esc zruší a vrátí na volby nastavení.",
        status: "Čeká se na autorizaci v prohlížeči...",
      },
      input: {
        cancelStatus: "Zadání API klíče zrušeno. Zvolte způsob nastavení.",
        clearStatus: "Vstup API klíče vymazán.",
        emptyStatus: "API klíč je povinný.",
        help: "Enter uloží klíč. Esc vrátí na volby nastavení.",
        placeholder: "Vložte API klíč",
        status: "Zadejte API klíč a stiskněte Enter.",
        submitStatus: "Ukládá se API klíč...",
      },
      prompt: "Zvolte způsob nastavení: přihlášení nebo API klíč.",
      response: "Zvolte, jak nastavit poskytovatele Coding Plan.",
      title: "Nastavit Coding Plan",
    },
    model: {
      requestFailed: (message) => `Požadavek modelu selhal: ${message}`,
      responseReceived: "Odpověď modelu přijata.",
      responseReceivedWithTokens: (tokens) => `Odpověď modelu přijata. ${tokens} tokenů.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Opakování požadavku modelu ${attempt}/${Math.max(1, maxAttempts - 1)} za ${delay}: ${reason}`,
      streamStalled: "Proud modelu se zastavil.",
    },
    sidebar: {
      subagents: {
        title: "Subagenti",
        empty: "Zatím žádní subagenti.",
        emptyOutput: "Zatím žádný výstup.",
        back: "← Hlavní konverzace",
        readonly: "Jen pro čtení · Esc pro návrat",
        loading: "Načítá se výstup subagenta...",
        unavailable: "Výstup subagenta není dostupný.",
        retry: "Zkusit znovu",
        more: "Načíst další",
        pendingMain: "Hlavní konverzace vyžaduje váš vstup — vraťte se pro odpověď",
        ended: (count) => `Ukončeno (${count})`,
        status: {
          running: "běží",
          waiting: "čeká",
          blocked: "zablokováno",
          success: "dokončeno",
          failed: "selhalo",
          cancelled: "zrušeno",
          lost: "ztraceno",
        },
      },
      api: {
        empty: "Zatím žádné API volání.",
        model: "Model AI",
        more: (count) => `+${count} dalších`,
        requests: "Požadavky",
        server: "Server (služba)",
      },
      cache: {
        hit: "zásah",
        lastHit: "poslední zásah",
        lastMiss: "poslední neúspěch",
        readWrite: ({ read, write }) => `${read} čtení / ${write} zápis`,
        total: "celkem",
      },
      context: {
        cache: "Mezipaměť",
        cacheReadWrite: "Cache R/Z",
        inputOutput: "I/O",
        reason: "Důvod",
        tokens: "Tokeny",
        used: "Použito",
        window: "Okno",
      },
      modifiedFiles: {
        empty: "Zatím žádné změny souborů.",
        more: (count) => `+${count} dalších`,
      },
      mcp: {
        empty: "Žádné MCP servery nejsou nakonfigurovány.",
        loadFailed: "Stav MCP není dostupný.",
        loading: "Načítání stavu MCP...",
        more: (count) => `+${count} dalších`,
        servers: "Servery",
        status: {
          connected: "připojeno",
          connecting: "připojování",
          disabled: "vypnuto",
          disconnected: "odpojeno",
          failed: "selhalo",
          untrusted: "nedůvěryhodné",
        },
        summary: ({ connected, total }) => `${connected}/${total} připojeno`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "hotovo",
        error: "chyba",
        errorWithStatus: (statusCode) => `chyba ${statusCode}`,
        pending: "čeká",
      },
      status: {
        last: "Poslední",
      },
      run: {
        draft: "Koncept",
        draftChars: (count) => `${count} znaků`,
        draftEmpty: "prázdné",
        messages: "Zprávy",
        mode: "Režim",
        model: "Model AI",
        provider: "Poskytovatel",
        thought: "Myšlenka",
        trace: "Stopa",
        turn: "Kolo",
        workspace: "Pracovní prostor",
      },
      sections: {
        apis: "API",
        context: "Kontext",
        mcp: "MCP",
        modifiedFiles: "Upravené soubory",
        run: "Spustit",
        status: "Stav",
        todos: "Úkoly",
      },
      shellSubtitle: "Prostředí OpenTUI",
      title: "Postranní panel",
      todos: {
        empty: "Zatím žádné úkoly.",
        more: (count) => `+${count} dalších`,
        progress: "Postup",
      },
    },
    status: {
      compactFailed: "Komprese kontextu selhala.",
      compacted: "Konverzace zkompaktována.",
      compacting: "Komprimuji kontext...",
      interruptedStreamDiscarded: "Přerušený stream modelu zahozen.",
      modelCalling: "Volám model...",
      permissionRequested: (toolName) => `Vyžádáno oprávnění pro ${toolName}.`,
      permissionResolved: (toolName) => `Oprávnění vyřešeno pro ${toolName}.`,
      ready: "Připraveno.",
      recoveringStream: "Obnovuji přerušený stream modelu...",
      retryingStream: "Znovu zkouším stream modelu...",
      sessionResumed: "Relace obnovena.",
      targetChanged: (action) => `Cíl ${action}.`,
      thinking: "Přemýšlím...",
      toolCompleted: (toolName) => `Nástroj ${toolName} dokončen.`,
      toolFailed: (toolName) => `Nástroj ${toolName} selhal.`,
      toolPending: (toolName) => `Nástroj ${toolName} čeká.`,
      toolRunning: (toolName) => `Nástroj ${toolName} běží.`,
      turnFailed: "Kolo selhalo.",
    },
    terminal: {
      requiresInteractive: "TUI vyžaduje interaktivní terminál.",
      starting: "Spouštím ZCode... Ctrl+C pro ukončení",
    },
    transcript: {
      compact: {
        completed: "Kontext zkomprimován",
        failed: "Komprese kontextu selhala",
        interrupted: "Komprese kontextu přerušena",
        retry: (command) => `Ctrl-R pro znovu zkoušení ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Znovu se pokouší komprimovat kontext (${attempt}/${maxAttempts})`
            : "Znovu se pokouší komprimovat kontext",
        skipped: "Kontext je aktuální; není třeba komprimovat",
        started: "Komprimování kontextu",
      },
      roles: {
        agent: "Zástupce",
        system: "Systém",
        user: "Uživatel",
      },
      thought: {
        complete: "Myšlenka",
        thinking: "Přemýšlení...",
      },
      title: "Přepis",
      workflow: {
        actors: "aktéři:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `využití: ${spentTokens} tokenů`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Pracovní postup ${label} - ${status} (${nodesSettled}/${nodesTotal} kroků)`,
        error: (message) => `chyba: ${message}`,
        expandHint: "+ pro rozbalení",
        collapseHint: "- pro sbalení",
        log: "protokol:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} kroků vyřešeno`,
        result: (preview) => `výsledek: ${preview}`,
        status: {
          completed: "dokončeno",
          errored: "chyba",
          pending: "čeká",
          running: "běží",
          stopped: "zastaveno",
        },
        stopReason: {
          user: "vámi",
          model: "agentem",
          provider: "chyba modelu",
          interrupted: "proces ukončen",
          superseded: "nahrazeno opraveným během",
        },
        truncated: "(zkráceno – úplná historie v deníku běhu)",
        interruptedNotice: ({ label, runId }) =>
          `Pracovní postup ${label} byl přerušen a lze jej obnovit: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter vybere, Esc zruší",
      disabled: (reason) => ` [zakázáno: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filtr: ${filter || "-"} | ${help ?? "Enter vybere, Esc zruší"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Žádné odpovídající cesty pracovního prostoru.",
      loading: "Načítání cest pracovního prostoru...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Soubory",
    },
    slash: {
      title: "Příkazy",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
