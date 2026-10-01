import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "hu-HU",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Nem támogatott --locale érték: ${value}. Támogatott nyelvek: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Használat:
  zcode [command] [options]

Parancs nélkül a zcode megnyitja a teljes képernyős TUI-t.

Parancsok:
  app-server A ZCode Protocol stdio alkalmazásszerver futtatása
  commands   Slash parancsok listázása (\`commands list\`)
  doctor     A futáskörnyezet és a csomagolási feltételezések vizsgálata
  login [zai|bigmodel]  Bejelentkezés böngészős engedélyezéssel
  logout     A közös Z.AI bejelentkezési adatok eltávolítása
  plugins    Bővítmények és piacterek kezelése (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Helyi készségek listázása (\`skills list\`)
  tui        A terminál felület megnyitása
  version    A CLI verziójának kiírása

Opciók:
  -h, --help       Súgó megjelenítése
  -v, --version    Verzió megjelenítése
  -p, --prompt <text>  Egyetlen prompt futtatása a TUI megnyitása nélkül
  --memory-bench   A --prompt kapcsolóval automatikus Memory kinyerés engedélyezése, kilépés előtt várakozás (a Memory engedélyezése szükséges)
  --browser-use <mode> Browser Use háttérrendszer engedélyezése (támogatott: headless)
  --surface <surface>  A headless promptok/app-server megjelenítési felülete: terminal vagy desktop
  --browser-executable <path> Chrome/Chromium futtatható fájl a headless Browser Use számára
  --attach <path> Helyi fájl csatolása a --prompt elemhez; több fájlhoz ismételje
  --cwd <path>     A parancs futtatása a megadott könyvtárból
  --disallowed-tools, --disallowedTools <tools...>
    Teljes eszközök eltávolítása csak erre a promptra/TUI futtatásra; a mentett beállítások változatlanok.
    Vesszővel vagy szóközzel elválasztott eszköznevek, pl. "Bash Edit".
    A "Bash(git *)" az összes Bash elemet eltávolítja; a parancsminták nem illeszkednek.
  --force-mcs      Kényszerített beszélgetésközi rendszerprojekció az Anthropic szolgáltatók számára
  --locale <locale>  UI nyelv: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR vagy auto
  --mode <mode>    Engedélyezési mód a promptokhoz: build, edit, plan vagy yolo (alapértelmezett: yolo a --prompt esetén)
  --resume <sessionId>  Mentett munkamenet folytatása sessionId alapján (sess_...)
  --target <text>  A munkamenet céljának futtatása vagy beállítása headless módban
  --target-replace A --target által beállított meglévő munkamenetcél felülírása
  -c, --continue        A legutóbbi munkamenet folytatása az aktuális könyvtárban
  --json           Géppel feldolgozható JSON kiírása, ahol támogatott
  --no-browser     Az OAuth URL kiírása böngésző megnyitása nélkül
  --no-color       ANSI színek letiltása
  --verbose        További diagnosztikai részletek kiírása

Slash parancsok:
  /help [command]       Slash parancs súgó megjelenítése
  /login                Z.AI vagy BigModel böngészős bejelentkezés választása
  /logout               A közös Z.AI bejelentkezési adatok eltávolítása
  /compact [instructions]  Az aktuális beszélgetés tömörítése
  /expert [status|resume|stop|<task>]  A szakértői munkafolyamat futtatása vagy kezelése
  /dwf [list|cancel|resume]  Dinamikus munkafolyamat futások listázása, megszakítása vagy folytatása
  /fork [latest|checkpointId]  Új munkamenet elágaztatása munkatér checkpointból
  /mcp [list|status|connect|disconnect]  MCP szerverek megjelenítése vagy kezelése
  /mode [mode]          Engedélyezési mód megjelenítése vagy váltása: build, edit, plan vagy yolo
  /model [id]           Az aktuális munkamenet modelljének megjelenítése vagy váltása
  /new                  Új munkamenet indítása a TUI-ban
  /resume [sessionId]   Munkamenet folytatása sessionId alapján; üresen a legutóbbi az aktuális könyvtárban
  /rewind [latest|checkpointId]  A legutóbbi checkpoint megjelenítése vagy a munkatérfájlok visszaállítása
  /skill [name] [task]  Készségek listázása vagy a következő prompt betöltésének kényszerítése
  /goal [action]        Az aktuális munkamenet céljának megjelenítése vagy beállítása
`,
  },
  tui: {
    copy: {
      copied: "A kiválasztott szöveg a vágólapra másolva.",
      failed: "Nem sikerült a kiválasztott szöveget másolni.",
      unavailable: "A szöveges vágólapra másolás nem érhető el ebben a terminálban.",
    },
    effort: {
      disabled: "letiltva",
      enabled: "engedélyezve",
    },
    input: {
      activeStatusHint: "esc a megszakításhoz",
      busyPlaceholder: "Írja be a sorba helyezendő inputot",
      placeholder: "Írjon be egy promptot",
      queuedMore: (count) => `+ ${count} további a sorban`,
      queuedSubmitHint: "A következő eszközhívás után elküldve.",
      queuedTitle: (count) => ` Sor (${count}) `,
      title: "Bevitel",
      noHistorySource: "Nincs beállítva beviteli előzményforrás.",
      noPreviousInput: "Nincs korábbi bevitel ehhez a projekthez.",
      restoredPreviousInput: "Korábbi bevitel visszaállítva.",
      restoredPreviousInputWithAttachments: (count) =>
        `Korábbi bevitel visszaállítva, ${count} melléklettel.`,
      restorePreviousInputFailed: "Nem sikerült a korábbi bevitelt visszaállítani.",
      typePrompt: "Írjon be egy kérdést, majd nyomjon Entert.",
    },
    loginRequired: {
      help: "A modellek megtekintéséhez használja a /model parancsot, a /login parancsal pedig Coding Plan fiókot csatlakoztathat.",
      message: "Nincs elérhető modell. Állítson be egy szolgáltatót, vagy jelentkezzen be a /login segítségével.",
      status: "Nincs elérhető modell. Állítson be egy szolgáltatót, vagy jelentkezzen be a /login segítségével.",
      title: "modell beállítása szükséges",
    },
    loginSetup: {
      emptyMessage: "Nincs elérhető bejelentkezési lehetőség.",
      help: "A választáshoz használja a fel/le nyilakat, a kiválasztáshoz az Entert.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Adja meg a BigModel Coding Plan API kulcsát",
          inputSecondary: "Illessze be a kulcsot ide. Gépelés közben rejtett marad.",
          primary: "BigModel Coding Plan API kulcs",
          secondary: "Illesszen be egy Coding Plan API kulcsot kézzel.",
        },
        bigmodelOauth: {
          pendingPrimary: "Várakozás a BigModel engedélyezésére",
          pendingSecondary:
            "Fejezze be a bejelentkezést a böngészőjében. Az engedélyezés automatikusan észlelhető.",
          primary: "BigModel Coding Plan",
          secondary: "Böngészős bejelentkezés megnyitása; az engedélyezés automatikusan észlelhető.",
        },
        zaiApiKey: {
          inputPrimary: "Adja meg a Z.AI Coding Plan API kulcsát",
          inputSecondary: "Illessze be a kulcsot ide. Gépelés közben rejtett marad.",
          primary: "Z.AI Coding Plan API kulcs",
          secondary: "Illesszen be egy Coding Plan API kulcsot kézzel.",
        },
        zaiOauth: {
          pendingPrimary: "Várakozás a Z.AI engedélyezésére",
          pendingSecondary:
            "Fejezze be a bejelentkezést a böngészőjében. Az engedélyezés befejezésekor folytatom.",
          primary: "Z.AI Coding Plan",
          secondary: "Nyisd meg a böngészős bejelentkezést, és hozz létre egy Coding Plan API-kulcsot.",
        },
      },
      pending: {
        cancelStatus: "Bejelentkezés megszakítva. Válassz telepítési módot.",
        help: "Az Esc megszakítja, és visszatér a telepítési lehetőségekhez.",
        status: "Várakozás a böngésző engedélyezésére...",
      },
      input: {
        cancelStatus: "API-kulcs bevitel megszakítva. Válassz telepítési módot.",
        clearStatus: "API-kulcs bevitel törölve.",
        emptyStatus: "Az API-kulcs kötelező.",
        help: "Az Enter menti a kulcsot. Az Esc visszatér a telepítési lehetőségekhez.",
        placeholder: "API-kulcs beillesztése",
        status: "Add meg az API-kulcsot, majd nyomj Entert.",
        submitStatus: "API-kulcs mentése...",
      },
      prompt: "Válassz bejelentkezési vagy API-kulcsos telepítési módot.",
      response: "Válaszd ki, hogyan állítsd be a Coding Plan szolgáltatót.",
      title: "Coding Plan beállítása",
    },
    model: {
      requestFailed: (message) => `Modellkérés sikertelen: ${message}`,
      responseReceived: "Modellválasz érkezett.",
      responseReceivedWithTokens: (tokens) => `Modellválasz érkezett. ${tokens} token.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Modellkérés újrapróbálása ${attempt}/${Math.max(1, maxAttempts - 1)} ennyi múlva: ${delay}: ${reason}`,
      streamStalled: "A modell folyamata megszakadt.",
    },
    sidebar: {
      subagents: {
        title: "Alügynökök",
        empty: "Még nincs alügynök.",
        emptyOutput: "Még nincs kimenet.",
        back: "← Fő beszélgetés",
        readonly: "Csak olvasható · Esc a visszatéréshez",
        loading: "Alügynök kimenetének betöltése...",
        unavailable: "Az alügynök kimenete nem elérhető.",
        retry: "Újrapróbálás",
        more: "Több betöltése",
        pendingMain: "A fő beszélgetésnek szüksége van a válaszodra — térj vissza a válaszadáshoz",
        ended: (count) => `Végzett (${count})`,
        status: {
          running: "fut",
          waiting: "várakozik",
          blocked: "blokkolva",
          success: "befejezve",
          failed: "sikertelen",
          cancelled: "megszakítva",
          lost: "elveszett",
        },
      },
      api: {
        empty: "Még nincs API-hívás.",
        model: "Modell",
        more: (count) => `+${count} tovább`,
        requests: "Kérések",
        server: "Szerver",
      },
      cache: {
        hit: "találat",
        lastHit: "utolsó találat",
        lastMiss: "utolsó hiba",
        readWrite: ({ read, write }) => `${read} olvasás / ${write} írás`,
        total: "összesen",
      },
      context: {
        cache: "Gyorsítótár",
        cacheReadWrite: "Gyorsítótár olvasás/írás",
        inputOutput: "I/O",
        reason: "Indoklás",
        tokens: "Tokenek",
        used: "Használt",
        window: "Ablak",
      },
      modifiedFiles: {
        empty: "Még nincs fájlmódosítás.",
        more: (count) => `+${count} tovább`,
      },
      mcp: {
        empty: "Nincs beállítva MCP-kiszolgáló.",
        loadFailed: "Az MCP-állapot nem érhető el.",
        loading: "MCP-állapot betöltése...",
        more: (count) => `+${count} tovább`,
        servers: "Kiszolgálók",
        status: {
          connected: "csatlakozva",
          connecting: "csatlakozás",
          disabled: "letiltva",
          disconnected: "szakadt",
          failed: "sikertelen",
          untrusted: "nem megbízható",
        },
        summary: ({ connected, total }) => `${connected}/${total} csatlakozva`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "kész",
        error: "hiba",
        errorWithStatus: (statusCode) => `${statusCode} hiba`,
        pending: "függőben",
      },
      status: {
        last: "Utolsó",
      },
      run: {
        draft: "Piszkozat",
        draftChars: (count) => `${count} karakter`,
        draftEmpty: "üres",
        messages: "Üzenetek",
        mode: "Mód",
        model: "Modell",
        provider: "Szolgáltató",
        thought: "Gondolkodás",
        trace: "Nyom",
        turn: "Forduló",
        workspace: "Munkaterület",
      },
      sections: {
        apis: "API-k",
        context: "Kontextus",
        mcp: "MCP",
        modifiedFiles: "Módosított fájlok",
        run: "Futtatás",
        status: "Állapot",
        todos: "Teendők",
      },
      shellSubtitle: "OpenTUI héj",
      title: "Oldalsáv",
      todos: {
        empty: "Még nincs teendő.",
        more: (count) => `+${count} további`,
        progress: "Haladás",
      },
    },
    status: {
      compactFailed: "Kontextustömörítés sikertelen.",
      compacted: "Beszélgetés tömörítve.",
      compacting: "Kontextus tömörítése...",
      interruptedStreamDiscarded: "Megszakított modellfolyam eldobva.",
      modelCalling: "Modell hívása...",
      permissionRequested: (toolName) => `Engedélykérés: ${toolName}.`,
      permissionResolved: (toolName) => `Engedély lezárva: ${toolName}.`,
      ready: "Kész.",
      recoveringStream: "Megszakított modellfolyam visszaállítása...",
      retryingStream: "Modellfolyam újrapróbálása...",
      sessionResumed: "Munkamenet folytatva.",
      targetChanged: (action) => `Cél: ${action}.`,
      thinking: "Gondolkodás...",
      toolCompleted: (toolName) => `Eszköz ${toolName} befejezve.`,
      toolFailed: (toolName) => `Eszköz ${toolName} sikertelen.`,
      toolPending: (toolName) => `Eszköz ${toolName} függőben.`,
      toolRunning: (toolName) => `Eszköz ${toolName} fut.`,
      turnFailed: "Forduló sikertelen.",
    },
    terminal: {
      requiresInteractive: "A TUI interaktív terminált igényel.",
      starting: "ZCode indítása... Ctrl+C a kilépéshez",
    },
    transcript: {
      compact: {
        completed: "Kontextus tömörítve",
        failed: "Kontextustömörítés sikertelen",
        interrupted: "Kontextustömörítés megszakítva",
        retry: (command) => `Ctrl-R: ${command} újrapróbálása`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Kontextustömörítés újrapróbálkozása (${attempt}/${maxAttempts})`
            : "Kontextustömörítés újrapróbálkozása",
        skipped: "A kontextus naprakész; nem kell tömöríteni",
        started: "Kontextus tömörítése",
      },
      roles: {
        agent: "Ügynök",
        system: "Rendszer",
        user: "Felhasználó",
      },
      thought: {
        complete: "Gondolat",
        thinking: "Gondolkodik...",
      },
      title: "Napló",
      workflow: {
        actors: "szereplők:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `használat: ${spentTokens} token`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Munkafolyamat ${label} - ${status} (${nodesSettled}/${nodesTotal} lépés)`,
        error: (message) => `hiba: ${message}`,
        expandHint: "+ a kibontáshoz",
        collapseHint: "- az összecsukáshoz",
        log: "napló:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} lépés lezárva`,
        result: (preview) => `eredmény: ${preview}`,
        status: {
          completed: "befejezett",
          errored: "hibával zárult",
          pending: "függőben",
          running: "fut",
          stopped: "leállítva",
        },
        stopReason: {
          user: "általad",
          model: "az ügynök által",
          provider: "modellhiba",
          interrupted: "a folyamat kilépett",
          superseded: "felülírva egy módosított futással",
        },
        truncated: "(levágva – a teljes előzmény a futási naplóban)",
        interruptedNotice: ({ label, runId }) =>
          `A(z) ${label} munkafolyamat megszakadt, és folytatható: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter kiválaszt, Esc megszakít",
      disabled: (reason) => ` [letiltva: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `szűrő: ${filter || "-"} | ${help ?? "Enter kiválaszt, Esc megszakít"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Nincs egyező munkaterület-útvonal.",
      loading: "Munkaterület-útvonalak betöltése...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Fájlok",
    },
    slash: {
      title: "Parancsok",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
