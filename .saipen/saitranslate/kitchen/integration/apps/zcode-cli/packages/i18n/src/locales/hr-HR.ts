import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "hr-HR",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Nepodržana vrijednost --locale: ${value}. Podržane lokalizacije: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Upotreba:
  zcode [command] [options]

Bez naredbe zcode otvara TUI preko cijelog ekrana.

Naredbe:
  app-server Pokreni ZCode Protocol stdio app server
  commands   Popis prilagođenih slash naredbi (\`commands list\`)
  doctor     Pregledaj pretpostavke izvršavanja i pakiranja
  login [zai|bigmodel]  Prijava putem autorizacije u pregledniku
  logout     Ukloni zajedničke Z.AI vjerodajnice za prijavu
  plugins    Upravljaj dodacima i trgovinama (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Popis lokalnih vještina (\`skills list\`)
  tui        Otvori terminal UI
  version    Ispiši verziju CLI-ja

Opcije:
  -h, --help       Prikaži pomoć
  -v, --version    Prikaži verziju
  -p, --prompt <text>  Pokreni jedan prompt bez otvaranja TUI-ja
  --memory-bench   Uz --prompt, omogući automatsko izdvajanje Memory-ja i pričekaj prije izlaza (zahtijeva omogućen Memory)
  --browser-use <mode> Omogući Browser Use backend (podržano: headless)
  --surface <surface>  Površina prikaza za headless promptove/app-server: terminal ili desktop
  --browser-executable <path> Chrome/Chromium izvršna datoteka za headless Browser Use
  --attach <path>  Priloži lokalnu datoteku uz --prompt; ponovi za više datoteka
  --cwd <path>     Pokreni ovu naredbu iz zadanog direktorija
  --disallowed-tools, --disallowedTools <tools...>
    Ukloni cijele alate samo za ovaj prompt/TUI; spremljene postavke ostaju nepromijenjene.
    Nazivi alata odvojeni zarezom ili razmakom, npr. "Bash Edit".
    "Bash(git *)" uklanja sav Bash; obrasci naredbi se ne podudaraju.
  --force-mcs      Prisili sistemsku projekciju usred razgovora za Anthropic pružatelje
  --locale <locale>  Lokalizacija UI-ja: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR ili auto
  --mode <mode>    Način dopuštenja za prompte: build, edit, plan ili yolo (zadano: yolo za --prompt)
  --resume <sessionId>  Nastavi spremljenu sesiju prema sessionId (sess_...)
  --target <text>  Pokreni ili postavi cilj sesije u headless načinu
  --target-replace Zamijeni postojeći cilj sesije postavljen s --target
  -c, --continue        Nastavi najnoviju sesiju za trenutni direktorij
  --json           Ispiši JSON čitljiv stroju gdje je podržano
  --no-browser     Ispiši OAuth URL bez otvaranja preglednika
  --no-color       Onemogući ANSI boje
  --verbose        Ispiši dodatne detalje dijagnostike

Slash naredbe:
  /help [command]       Prikaži pomoć za slash naredbe
  /login                Odaberi Z.AI ili BigModel prijavu u pregledniku
  /logout               Ukloni zajedničke Z.AI vjerodajnice za prijavu
  /compact [instructions]  Sažmi trenutni razgovor
  /expert [status|resume|stop|<task>]  Pokreni ili upravljaj stručnim tijekom rada
  /dwf [list|cancel|resume]  Popis, otkaži ili nastavi dinamičke tokove rada
  /fork [latest|checkpointId]  Odvoji novu sesiju iz checkpointa radnog prostora
  /mcp [list|status|connect|disconnect]  Prikaži ili upravljaj MCP poslužiteljima
  /mode [mode]          Prikaži ili promijeni način dopuštenja: build, edit, plan ili yolo
  /model [id]           Prikaži ili promijeni model trenutne sesije
  /new                  Pokreni novu sesiju u TUI-ju
  /resume [sessionId]   Nastavi sesiju prema sessionId; izostavi za najnoviju u cwd
  /rewind [latest|checkpointId]  Prikaži najnoviji checkpoint ili vrati datoteke radnog prostora
  /skill [name] [task]  Popis vještina ili prisili sljedeći prompt da učita jednu
  /goal [action]        Prikaži ili postavi trenutni cilj sesije
`,
  },
  tui: {
    copy: {
      copied: "Odabrani tekst kopiran u mehanički međuspremnik.",
      failed: "Nije moguće kopirati odabrani tekst.",
      unavailable: "Kopiranje teksta u mehanički međuspremnik nije dostupno u ovom terminalu.",
    },
    effort: {
      disabled: "onemogućeno",
      enabled: "omogućeno",
    },
    input: {
      activeStatusHint: "Esc za prekid",
      busyPlaceholder: "Unesi za red čekanja",
      placeholder: "Unesite prompt",
      queuedMore: (count) => `+ još ${count} u redu čeka`,
      queuedSubmitHint: "Poslano nakon sljedećeg poziva alata.",
      queuedTitle: (count) => ` Red (${count}) `,
      title: "Unos",
      noHistorySource: "Nije konfiguriran izvor povijesti unosa.",
      noPreviousInput: "Nema prethodnog unosa za ovaj projekt.",
      restoredPreviousInput: "Vraćen prethodni unos.",
      restoredPreviousInputWithAttachments: (count) =>
        `Vraćen prethodni unos (${count} priloga).`,
      restorePreviousInputFailed: "Nije moguće vratiti prethodni unos.",
      typePrompt: "Upišite pitanje i pritisnite Enter.",
    },
    loginRequired: {
      help: "Koristite /model za pregled modela ili /login za povezivanje Coding Plan računa.",
      message: "Nema dostupnih modela. Konfigurirajte pružatelja ili se prijavite s /login.",
      status: "Nema dostupnih modela. Konfigurirajte pružatelja ili se prijavite s /login.",
      title: "potrebno postavljanje modela",
    },
    loginSetup: {
      emptyMessage: "Nema dostupnih opcija prijave.",
      help: "Gore/dolje za odabir, Enter za potvrdu.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Unesite BigModel Coding Plan API ključ",
          inputSecondary: "Ovdje zalijepite ključ. Skriven je tijekom tipkanja.",
          primary: "BigModel Coding Plan API ključ",
          secondary: "Ručno zalijepite Coding Plan API ključ.",
        },
        bigmodelOauth: {
          pendingPrimary: "Čeka se autorizacija BigModela",
          pendingSecondary:
            "Dovršite prijavu u pregledniku. Autorizacija se otkriva automatski.",
          primary: "BigModel Coding Plan",
          secondary: "Otvori prijavu u pregledniku; autorizacija se otkriva automatski.",
        },
        zaiApiKey: {
          inputPrimary: "Unesite Z.AI Coding Plan API ključ",
          inputSecondary: "Ovdje zalijepite ključ. Skriven je tijekom tipkanja.",
          primary: "Z.AI Coding Plan API ključ",
          secondary: "Ručno zalijepite Coding Plan API ključ.",
        },
        zaiOauth: {
          pendingPrimary: "Čeka se Z.AI autorizacija",
          pendingSecondary:
            "Dovršite prijavu u pregledniku. Nastavit ću nakon završetka autorizacije.",
          primary: "Z.AI Coding Plan",
          secondary: "Otvori prijavu u pregledniku i stvori API ključ za Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Prijava otkazana. Odaberi način postavljanja.",
        help: "Esc otkazuje i vraća na odabir postavljanja.",
        status: "Čeka se autorizacija u pregledniku...",
      },
      input: {
        cancelStatus: "Unos API ključa otkazan. Odaberi način postavljanja.",
        clearStatus: "Unos API ključa očišćen.",
        emptyStatus: "API ključ je obavezan.",
        help: "Enter spremi ključ. Esc vraća na odabir postavljanja.",
        placeholder: "Zalijepi API ključ",
        status: "Unesi API ključ, zatim pritisni Enter.",
        submitStatus: "Spremanje API ključa...",
      },
      prompt: "Odaberi način prijave ili postavljanja putem API ključa.",
      response: "Odaberi kako postaviti Coding Plan davatelja usluge.",
      title: "Postavi Coding Plan",
    },
    model: {
      requestFailed: (message) => `Zahtjev modelu nije uspio: ${message}`,
      responseReceived: "Odgovor modela primljen.",
      responseReceivedWithTokens: (tokens) => `Odgovor modela primljen. ${tokens} tokena.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Ponovni pokušaj zahtjeva modelu ${attempt}/${Math.max(1, maxAttempts - 1)} za ${delay}: ${reason}`,
      streamStalled: "Prijenos modela je zapeo.",
    },
    sidebar: {
      subagents: {
        title: "Podagenti",
        empty: "Još nema podagenata.",
        emptyOutput: "Još nema izlaza.",
        back: "← Glavni razgovor",
        readonly: "Samo čitanje · Esc za povratak",
        loading: "Učitavanje izlaza podagenta...",
        unavailable: "Izlaz podagenta nije dostupan.",
        retry: "Pokušaj ponovno",
        more: "Učitaj više",
        pendingMain: "Glavni razgovor treba tvoj odgovor — vrati se za odgovor",
        ended: (count) => `Završeno (${count})`,
        status: {
          running: "u tijeku",
          waiting: "čeka",
          blocked: "blokirano",
          success: "dovršeno",
          failed: "neuspjelo",
          cancelled: "otkazano",
          lost: "izgubljeno",
        },
      },
      api: {
        empty: "Još nema poziva API-ja.",
        model: "Parametar modela",
        more: (count) => `+${count} još`,
        requests: "Zahtjevi",
        server: "Poslužitelj",
      },
      cache: {
        hit: "pogodak",
        lastHit: "zadnji pogodak",
        lastMiss: "zadnji promašaj",
        readWrite: ({ read, write }) => `${read} čit. / ${write} zap.`,
        total: "ukupno",
      },
      context: {
        cache: "Predmemorija",
        cacheReadWrite: "Predmemorija čit./zap.",
        inputOutput: "I/O",
        reason: "Razlog",
        tokens: "Tokeni",
        used: "Iskorišteno",
        window: "Prozor",
      },
      modifiedFiles: {
        empty: "Još nema izmjena datoteka.",
        more: (count) => `+${count} još`,
      },
      mcp: {
        empty: "Nema konfiguriranih MCP poslužitelja.",
        loadFailed: "MCP status nije dostupan.",
        loading: "Učitavanje MCP statusa...",
        more: (count) => `+${count} još`,
        servers: "Poslužitelji",
        status: {
          connected: "povezano",
          connecting: "povezivanje",
          disabled: "onemogućeno",
          disconnected: "odspojeno",
          failed: "neuspjelo",
          untrusted: "nepouzdano",
        },
        summary: ({ connected, total }) => `${connected}/${total} povezano`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "završeno",
        error: "greška",
        errorWithStatus: (statusCode) => `greška ${statusCode}`,
        pending: "u čekanju",
      },
      status: {
        last: "Zadnje",
      },
      run: {
        draft: "Skica",
        draftChars: (count) => `${count} znakova`,
        draftEmpty: "prazno",
        messages: "Poruke",
        mode: "Način",
        model: "Uzorak",
        provider: "Dobavljač",
        thought: "Razmišljanje",
        trace: "Trag",
        turn: "Potez",
        workspace: "Radni prostor",
      },
      sections: {
        apis: "API-ji",
        context: "Kontekst",
        mcp: "MCP",
        modifiedFiles: "Izmijenjene datoteke",
        run: "Pokreni",
        status: "Stanje",
        todos: "Zadaci",
      },
      shellSubtitle: "OpenTUI ljuska",
      title: "Bočna traka",
      todos: {
        empty: "Još nema zadataka.",
        more: (count) => `+još ${count}`,
        progress: "Napredak",
      },
    },
    status: {
      compactFailed: "Sažimanje konteksta nije uspjelo.",
      compacted: "Razgovor sažet.",
      compacting: "Sažimanje konteksta...",
      interruptedStreamDiscarded: "Prekinuti tok modela odbačen.",
      modelCalling: "Pozivanje modela...",
      permissionRequested: (toolName) => `Zatraženo dopuštenje za ${toolName}.`,
      permissionResolved: (toolName) => `Dopuštenje razriješeno za ${toolName}.`,
      ready: "Spremno.",
      recoveringStream: "Oporavak prekinutog toka modela...",
      retryingStream: "Ponovni pokušaj toka modela...",
      sessionResumed: "Sesija nastavljena.",
      targetChanged: (action) => `Cilj ${action}.`,
      thinking: "Razmišljanje...",
      toolCompleted: (toolName) => `Alat ${toolName} završen.`,
      toolFailed: (toolName) => `Alat ${toolName} nije uspio.`,
      toolPending: (toolName) => `Alat ${toolName} na čekanju.`,
      toolRunning: (toolName) => `Alat ${toolName} u tijeku.`,
      turnFailed: "Potez nije uspio.",
    },
    terminal: {
      requiresInteractive: "TUI zahtijeva interaktivni terminal.",
      starting: "Pokretanje ZCode... Ctrl+C za izlaz",
    },
    transcript: {
      compact: {
        completed: "Kontekst sažet",
        failed: "Sažimanje konteksta nije uspjelo",
        interrupted: "Sažimanje konteksta prekinuto",
        retry: (command) => `Ctrl-R za ponovni pokušaj ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Ponovni pokušaj sažimanja konteksta (${attempt}/${maxAttempts})`
            : "Ponovni pokušaj sažimanja konteksta",
        skipped: "Kontekst je ažuran; sažimanje nije potrebno",
        started: "Sažimanje konteksta",
      },
      roles: {
        agent: "Izvršni agent",
        system: "Sustav",
        user: "Korisnik",
      },
      thought: {
        complete: "Promišljanje",
        thinking: "Promišljanje...",
      },
      title: "Transkript",
      workflow: {
        actors: "akteri:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `upotreba: ${spentTokens} tokena`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Tijek rada ${label} – ${status} (${nodesSettled}/${nodesTotal} koraka)`,
        error: (message) => `greška: ${message}`,
        expandHint: "+ za proširenje",
        collapseHint: "- za sažimanje",
        log: "zapisnik:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} koraka obrađeno`,
        result: (preview) => `rezultat: ${preview}`,
        status: {
          completed: "dovršeno",
          errored: "greška",
          pending: "na čekanju",
          running: "u tijeku",
          stopped: "zaustavljeno",
        },
        stopReason: {
          user: "od vas",
          model: "od agenta",
          provider: "greška modela",
          interrupted: "proces je izašao",
          superseded: "zamijenjeno izmijenjenim pokretanjem",
        },
        truncated: "(skraćeno – cijela povijest u zapisniku pokretanja)",
        interruptedNotice: ({ label, runId }) =>
          `Tijek rada ${label} prekinut; može se nastaviti: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter odabire, Esc otkazuje",
      disabled: (reason) => ` [onemogućeno: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filtar: ${filter || "-"} | ${help ?? "Enter odabire, Esc otkazuje"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Nema odgovarajućih putanja radnog prostora.",
      loading: "Učitavanje putanja radnog prostora...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Datoteke",
    },
    slash: {
      title: "Naredbe",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
