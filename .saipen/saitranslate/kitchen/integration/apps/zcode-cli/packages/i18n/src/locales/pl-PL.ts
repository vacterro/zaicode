import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "pl-PL",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Nieobsługiwana wartość --locale: ${value}. Obsługiwane lokalizacje: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Użycie:
  zcode [command] [options]

Bez polecenia zcode otwiera pełnoekranowy TUI.

Polecenia:
  app-server Uruchom stdio serwer aplikacji ZCode Protocol
  commands   Lista własnych poleceń ukośnika (\`commands list\`)
  doctor     Sprawdź założenia środowiska uruchomieniowego i pakowania
  login [zai|bigmodel]  Zaloguj się przez autoryzację w przeglądarce
  logout     Usuń wspólne dane logowania Z.AI
  plugins    Zarządzaj wtyczkami i sklepami (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Lista lokalnych umiejętności (\`skills list\`)
  tui        Otwórz interfejs terminala
  version    Wypisz wersję CLI

Opcje:
  -h, --help       Pokaż pomoc
  -v, --version    Pokaż wersję
  -p, --prompt <text>  Wykonaj pojedynczy prompt bez otwierania TUI
  --memory-bench   Z --prompt włącz automatyczne wydobywanie Memory i poczekaj przed wyjściem (wymaga włączonego Memory)
  --browser-use <mode> Włącz backend Browser Use (obsługiwane: headless)
  --surface <surface>  Powierzchnia prezentacji dla promptów headless/app-server: terminal lub desktop
  --browser-executable <path> Wykonywalny plik Chrome/Chromium dla headless Browser Use
  --attach <path>  Dołącz lokalny plik do --prompt; powtórz dla wielu plików
  --cwd <path>     Uruchom to polecenie z podanego katalogu
  --disallowed-tools, --disallowedTools <tools...>
    Usuń całe narzędzia tylko dla tego promptu lub uruchomienia TUI; zapisane ustawienia bez zmian.
    Nazwy narzędzi oddzielone przecinkiem lub spacją, np. "Bash Edit".
    "Bash(git *)" usuwa całe Bash; wzorce poleceń nie są dopasowywane.
  --force-mcs      Wymuś projekcję systemową w trakcie rozmowy dla dostawców Anthropic
  --locale <locale>  Lokalizacja UI: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR lub auto
  --mode <mode>    Tryb uprawnień dla promptów: build, edit, plan lub yolo (domyślnie: yolo dla --prompt)
  --resume <sessionId>  Wznów zapisaną sesję po sessionId (sess_...)
  --target <text>  Uruchom lub ustaw cel sesji w trybie headless
  --target-replace Zastąp istniejący cel sesji ustawiony przez --target
  -c, --continue        Wznów najnowszą sesję dla bieżącego katalogu
  --json           Wypisz JSON w formie maszynowej, gdzie obsługiwane
  --no-browser     Wypisz URL OAuth bez otwierania przeglądarki
  --no-color       Wyłącz kolory ANSI
  --verbose        Wypisz dodatkowe szczegóły diagnostyczne

Polecenia ukośnika:
  /help [command]       Pokaż pomoc poleceń ukośnika
  /login                Wybierz logowanie przez przeglądarkę Z.AI lub BigModel
  /logout               Usuń wspólne dane logowania Z.AI
  /compact [instructions]  Skompaktuj bieżącą rozmowę
  /expert [status|resume|stop|<task>]  Uruchom lub zarządzaj przepływem pracy eksperta
  /dwf [list|cancel|resume]  Lista, anulowanie lub wznawianie dynamicznych przepływów pracy
  /fork [latest|checkpointId]  Rozgałęź nową sesję z punktu kontrolnego przestrzeni roboczej
  /mcp [list|status|connect|disconnect]  Pokaż lub zarządzaj serwerami MCP
  /mode [mode]          Pokaż lub zmień tryb uprawnień: build, edit, plan lub yolo
  /model [id]           Pokaż lub zmień model bieżącej sesji
  /new                  Rozpocznij nową sesję w TUI
  /resume [sessionId]   Wznów sesję po sessionId; pomiń dla najnowszej w cwd
  /rewind [latest|checkpointId]  Pokaż najnowszy punkt kontrolny lub przywróć pliki przestrzeni roboczej
  /skill [name] [task]  Lista umiejętności lub wymuś wczytanie jednej w następnym prompcie
  /goal [action]        Pokaż lub ustaw bieżący cel sesji
`,
  },
  tui: {
    copy: {
      copied: "Zaznaczony tekst skopiowany do schowka.",
      failed: "Nie udało się skopiować zaznaczonego tekstu.",
      unavailable: "Kopiowanie tekstu do schowka jest niedostępne w tym terminalu.",
    },
    effort: {
      disabled: "wyłączone",
      enabled: "włączone",
    },
    input: {
      activeStatusHint: "esc, aby przerwać",
      busyPlaceholder: "Wpisz, aby zakolejkować wejście",
      placeholder: "Wpisz prompt",
      queuedMore: (count) => `+ ${count} więcej w kolejce`,
      queuedSubmitHint: "Przesłano po następnym wywołaniu narzędzia.",
      queuedTitle: (count) => ` Kolejka (${count}) `,
      title: "Wejście",
      noHistorySource: "Nie skonfigurowano źródła historii wejścia.",
      noPreviousInput: "Brak poprzedniego wejścia dla tego projektu.",
      restoredPreviousInput: "Przywrócono poprzednie wejście.",
      restoredPreviousInputWithAttachments: (count) =>
        `Przywrócono poprzednie wejście z ${count} załącznikami.`,
      restorePreviousInputFailed: "Nie udało się przywrócić poprzedniego wejścia.",
      typePrompt: "Wpisz pytanie i naciśnij Enter.",
    },
    loginRequired: {
      help: "Użyj /model, aby zobaczyć modele, lub /login, aby połączyć konto Coding Plan.",
      message: "Brak dostępnych modeli. Skonfiguruj dostawcę lub zaloguj się przez /login.",
      status: "Brak dostępnych modeli. Skonfiguruj dostawcę lub zaloguj się przez /login.",
      title: "wymagana konfiguracja modelu",
    },
    loginSetup: {
      emptyMessage: "Brak dostępnych opcji logowania.",
      help: "Użyj Up/Down, aby wybrać, Enter, aby zatwierdzić.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Wprowadź klucz API BigModel Coding Plan",
          inputSecondary: "Wklej klucz tutaj. Jest ukryty podczas wpisywania.",
          primary: "Klucz API BigModel Coding Plan",
          secondary: "Wklej klucz API Coding Plan ręcznie.",
        },
        bigmodelOauth: {
          pendingPrimary: "Oczekiwanie na autoryzację BigModel",
          pendingSecondary:
            "Dokończ logowanie w przeglądarce. Autoryzacja zostanie wykryta automatycznie.",
          primary: "BigModel Coding Plan",
          secondary: "Otwórz logowanie w przeglądarce; autoryzacja zostanie wykryta automatycznie.",
        },
        zaiApiKey: {
          inputPrimary: "Wprowadź klucz API Z.AI Coding Plan",
          inputSecondary: "Wklej klucz tutaj. Jest ukryty podczas wpisywania.",
          primary: "Klucz API Z.AI Coding Plan",
          secondary: "Wklej klucz API Coding Plan ręcznie.",
        },
        zaiOauth: {
          pendingPrimary: "Oczekiwanie na autoryzację Z.AI",
          pendingSecondary:
            "Dokończ logowanie w przeglądarce. Wrócę, gdy autoryzacja się zakończy.",
          primary: "Z.AI Coding Plan",
          secondary: "Otwórz logowanie w przeglądarce i utwórz klucz API Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Logowanie anulowane. Wybierz metodę konfiguracji.",
        help: "Esc anuluje i wraca do opcji konfiguracji.",
        status: "Oczekiwanie na autoryzację w przeglądarce...",
      },
      input: {
        cancelStatus: "Wprowadzanie klucza API anulowane. Wybierz metodę konfiguracji.",
        clearStatus: "Wpis klucza API wyczyszczony.",
        emptyStatus: "Klucz API jest wymagany.",
        help: "Enter zapisuje klucz. Esc wraca do opcji konfiguracji.",
        placeholder: "Wklej klucz API",
        status: "Wprowadź klucz API, a następnie naciśnij Enter.",
        submitStatus: "Zapisywanie klucza API...",
      },
      prompt: "Wybierz metodę konfiguracji logowania lub klucza API.",
      response: "Wybierz sposób konfiguracji dostawcy Coding Plan.",
      title: "Skonfiguruj Coding Plan",
    },
    model: {
      requestFailed: (message) => `Żądanie do modelu nie powiodło się: ${message}`,
      responseReceived: "Otrzymano odpowiedź modelu.",
      responseReceivedWithTokens: (tokens) => `Otrzymano odpowiedź modelu. ${tokens} tokenów.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Ponawianie żądania do modelu ${attempt}/${Math.max(1, maxAttempts - 1)} za ${delay}: ${reason}`,
      streamStalled: "Strumień modelu się zatrzymał.",
    },
    sidebar: {
      subagents: {
        title: "Podagenci",
        empty: "Nie ma jeszcze podagentów.",
        emptyOutput: "Nie ma jeszcze wyniku.",
        back: "← Główna rozmowa",
        readonly: "Tylko do odczytu · Esc wraca",
        loading: "Wczytywanie wyniku podagenta...",
        unavailable: "Wynik podagenta niedostępny.",
        retry: "Ponów",
        more: "Wczytaj więcej",
        pendingMain: "Główna rozmowa wymaga Twojej odpowiedzi — wróć, aby odpowiedzieć",
        ended: (count) => `Zakończono (${count})`,
        status: {
          running: "w toku",
          waiting: "oczekiwanie",
          blocked: "zablokowany",
          success: "ukończony",
          failed: "niepowodzenie",
          cancelled: "anulowano",
          lost: "utracono",
        },
      },
      api: {
        empty: "Nie ma jeszcze wywołań API.",
        model: "Model AI",
        more: (count) => `+${count} więcej`,
        requests: "Żądania",
        server: "Serwer",
      },
      cache: {
        hit: "trafienie",
        lastHit: "ostatnie trafienie",
        lastMiss: "ostatnie nietrafienie",
        readWrite: ({ read, write }) => `${read} odczytów / ${write} zapisów`,
        total: "Łącznie",
      },
      context: {
        cache: "Pamięć podręczna",
        cacheReadWrite: "Pamięć podręczna O/Z",
        inputOutput: "I/O",
        reason: "Powód",
        tokens: "Tokeny",
        used: "Użyte",
        window: "Okno",
      },
      modifiedFiles: {
        empty: "Nie ma jeszcze zmian w plikach.",
        more: (count) => `+${count} więcej`,
      },
      mcp: {
        empty: "Nie skonfigurowano serwerów MCP.",
        loadFailed: "Status MCP jest niedostępny.",
        loading: "Wczytywanie statusu MCP...",
        more: (count) => `+${count} więcej`,
        servers: "Serwery",
        status: {
          connected: "połączony",
          connecting: "łączenie",
          disabled: "wyłączony",
          disconnected: "rozłączony",
          failed: "niepowodzenie",
          untrusted: "niezaufany",
        },
        summary: ({ connected, total }) => `${connected}/${total} połączonych`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "ukończono",
        error: "błąd",
        errorWithStatus: (statusCode) => `błąd ${statusCode}`,
        pending: "oczekuje",
      },
      status: {
        last: "Ostatni",
      },
      run: {
        draft: "Wersja robocza",
        draftChars: (count) => `${count} znaków`,
        draftEmpty: "pusty",
        messages: "Wiadomości",
        mode: "Tryb",
        model: "Rodzaj modelu",
        provider: "Dostawca",
        thought: "Myśl",
        trace: "Ślad",
        turn: "Tura",
        workspace: "Obszar roboczy",
      },
      sections: {
        apis: "API",
        context: "Kontekst",
        mcp: "MCP",
        modifiedFiles: "Zmodyfikowane pliki",
        run: "Uruchom",
        status: "Stan",
        todos: "Zadania",
      },
      shellSubtitle: "Powłoka OpenTUI",
      title: "Panel boczny",
      todos: {
        empty: "Brak zadań.",
        more: (count) => `+${count} więcej`,
        progress: "Postęp",
      },
    },
    status: {
      compactFailed: "Kompresja kontekstu nie powiodła się.",
      compacted: "Rozmowa skompaktowana.",
      compacting: "Kompresowanie kontekstu...",
      interruptedStreamDiscarded: "Przerwany strumień modelu odrzucony.",
      modelCalling: "Wywoływanie modelu...",
      permissionRequested: (toolName) => `Poproszono o uprawnienie dla ${toolName}.`,
      permissionResolved: (toolName) => `Rozwiązano uprawnienie dla ${toolName}.`,
      ready: "Gotowe.",
      recoveringStream: "Odzyskiwanie przerwanego strumienia modelu...",
      retryingStream: "Ponawianie strumienia modelu...",
      sessionResumed: "Sesja wznowiona.",
      targetChanged: (action) => `Cel: ${action}.`,
      thinking: "Myślenie...",
      toolCompleted: (toolName) => `Narzędzie ${toolName} zakończone.`,
      toolFailed: (toolName) => `Narzędzie ${toolName} nie powiodło się.`,
      toolPending: (toolName) => `Narzędzie ${toolName} oczekuje.`,
      toolRunning: (toolName) => `Narzędzie ${toolName} działa.`,
      turnFailed: "Tura nie powiodła się.",
    },
    terminal: {
      requiresInteractive: "TUI wymaga terminala interaktywnego.",
      starting: "Uruchamianie ZCode... Ctrl+C aby wyjść",
    },
    transcript: {
      compact: {
        completed: "Kontekst skompresowany",
        failed: "Kompresja kontekstu nie powiodła się",
        interrupted: "Kompresja kontekstu przerwana",
        retry: (command) => `Ctrl-R aby ponowić ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Ponawianie kompresji kontekstu (${attempt}/${maxAttempts})`
            : "Ponawianie kompresji kontekstu",
        skipped: "Kontekst jest aktualny; kompresja niepotrzebna",
        started: "Kompresowanie kontekstu",
      },
      roles: {
        agent: "Pomocnik",
        system: "Informacje o systemie",
        user: "Użytkownik",
      },
      thought: {
        complete: "Myśl",
        thinking: "Myślenie...",
      },
      title: "Transkrypcja",
      workflow: {
        actors: "aktorzy:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `użycie: ${spentTokens} tokenów`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Workflow ${label} - ${status} (${nodesSettled}/${nodesTotal} kroków)`,
        error: (message) => `błąd: ${message}`,
        expandHint: "+ rozwiń",
        collapseHint: "- zwiń",
        log: "dziennik:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} kroków zakończonych`,
        result: (preview) => `wynik: ${preview}`,
        status: {
          completed: "zakończone",
          errored: "błąd",
          pending: "oczekujące",
          running: "uruchomione",
          stopped: "zatrzymane",
        },
        stopReason: {
          user: "przez ciebie",
          model: "przez agenta",
          provider: "błąd modelu",
          interrupted: "proces zakończony",
          superseded: "zastąpione poprawionym uruchomieniem",
        },
        truncated: "(ucięte - pełna historia w dzienniku uruchomienia)",
        interruptedNotice: ({ label, runId }) =>
          `Workflow ${label} został przerwany i można go wznowić: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter wybiera, Esc anuluje",
      disabled: (reason) => ` [wyłączone: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filtr: ${filter || "-"} | ${help ?? "Enter wybiera, Esc anuluje"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Brak pasujących ścieżek workspace.",
      loading: "Ładowanie ścieżek workspace...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Pliki",
    },
    slash: {
      title: "Polecenia",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
