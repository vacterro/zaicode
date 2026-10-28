import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "de-DE",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Nicht unterstützter --locale-Wert: ${value}. Unterstützte Sprachen: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Verwendung:
  zcode [Befehl] [Optionen]

Ohne Befehl öffnet zcode die vollbildige TUI.

Befehle:
  app-server ZCode-Protocol-Stdio-App-Server ausführen
  commands   Eigene Slash-Befehle auflisten (\`commands list\`)
  doctor     Laufzeit- und Packaging-Annahmen prüfen
  login [zai|bigmodel]  Über Browser-Autorisierung anmelden
  logout     Gemeinsame Z.AI-Anmeldedaten entfernen
  plugins    Plugins und Marktplätze verwalten (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; Alias: plugin)
  skills     Lokale Skills auflisten (\`skills list\`)
  tui        Terminal-UI öffnen
  version    CLI-Version ausgeben

Optionen:
  -h, --help       Hilfe anzeigen
  -v, --version    Version anzeigen
  -p, --prompt <text>  Einen einzelnen Prompt ausführen, ohne die TUI zu öffnen
  --memory-bench   Mit --prompt automatische Memory-Extraktion aktivieren und vor dem Beenden warten (erfordert aktiviertes Memory)
  --browser-use <modus> Browser-Use-Backend aktivieren (unterstützt: headless)
  --surface <surface>  Darstellungsfläche für Headless-Prompts/App-Server: terminal oder desktop
  --browser-executable <pfad> Chrome/Chromium-Programmdatei für Headless Browser Use
  --attach <pfad>  Eine lokale Datei an --prompt anhängen; für mehrere Dateien wiederholen
  --cwd <pfad>     Diesen Befehl im angegebenen Verzeichnis ausführen
  --disallowed-tools, --disallowedTools <tools...>
    Ganze Tools nur für diesen Prompt/TUI-Lauf entfernen; gespeicherte Einstellungen bleiben unverändert.
    Durch Komma oder Leerzeichen getrennte Tool-Namen, z. B. "Bash Edit".
    "Bash(git *)" entfernt alles von Bash; Befehlsmuster werden nicht abgeglichen.
  --force-mcs      System-Projektion mitten im Gespräch für Anthropic-Anbieter erzwingen
  --locale <locale>  UI-Sprache: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR oder auto
  --mode <modus>    Berechtigungsmodus für Prompts: build, edit, plan oder yolo (Standard: yolo für --prompt)
  --resume <sessionId>  Eine gespeicherte Sitzung per sessionId fortsetzen (sess_...)
  --target <text>  Das Sitzungsziel im Headless-Modus ausführen oder setzen
  --target-replace Ein vorhandenes, von --target gesetztes Sitzungsziel ersetzen
  -c, --continue        Die neueste Sitzung für das aktuelle Verzeichnis fortsetzen
  --json           Maschinenlesbares JSON ausgeben, wo unterstützt
  --no-browser     Die OAuth-URL ausgeben, ohne einen Browser zu öffnen
  --no-color       ANSI-Farben deaktivieren
  --verbose        Zusätzliche Diagnosedetails ausgeben

Slash-Befehle:
  /help [Befehl]       Hilfe zu Slash-Befehlen anzeigen
  /login                Z.AI- oder BigModel-Browseranmeldung wählen
  /logout               Gemeinsame Z.AI-Anmeldedaten entfernen
  /compact [Anweisungen]  Die aktuelle Unterhaltung komprimieren
  /expert [status|resume|stop|<task>]  Den Experten-Workflow ausführen oder verwalten
  /dwf [list|cancel|resume]  Dynamische Workflow-Läufe auflisten, abbrechen oder fortsetzen
  /fork [latest|checkpointId]  Eine neue Sitzung aus einem Workspace-Checkpoint ableiten
  /mcp [list|status|connect|disconnect]  MCP-Server anzeigen oder verwalten
  /mode [modus]          Berechtigungsmodus anzeigen oder wechseln: build, edit, plan oder yolo
  /model [id]           Das Modell der aktuellen Sitzung anzeigen oder wechseln
  /new                  Eine neue Sitzung in der TUI starten
  /resume [sessionId]   Eine Sitzung per sessionId fortsetzen; ohne Angabe die neueste im cwd
  /rewind [latest|checkpointId]  Neuesten Checkpoint anzeigen oder Workspace-Dateien wiederherstellen
  /skill [Name] [Aufgabe]  Skills auflisten oder den nächsten Prompt zum Laden eines Skills zwingen
  /goal [Aktion]        Das aktuelle Sitzungsziel anzeigen oder setzen
`,
  },
  tui: {
    copy: {
      copied: "Ausgewählter Text in die Zwischenablage kopiert.",
      failed: "Ausgewählter Text konnte nicht kopiert werden.",
      unavailable: "Kopieren von Text in die Zwischenablage ist in diesem Terminal nicht verfügbar.",
    },
    effort: {
      disabled: "deaktiviert",
      enabled: "aktiviert",
    },
    input: {
      activeStatusHint: "Esc zum Unterbrechen",
      busyPlaceholder: "Zum Einreihen von Eingaben tippen",
      placeholder: "Prompt eingeben",
      queuedMore: (count) => `+ ${count} weitere in der Warteschlange`,
      queuedSubmitHint: "Nach dem nächsten Tool-Aufruf übermittelt.",
      queuedTitle: (count) => ` Warteschlange (${count}) `,
      title: "Eingabe",
      noHistorySource: "Keine Quelle für den Eingabeverlauf konfiguriert.",
      noPreviousInput: "Keine vorherige Eingabe für dieses Projekt.",
      restoredPreviousInput: "Vorherige Eingabe wiederhergestellt.",
      restoredPreviousInputWithAttachments: (count) =>
        `Vorherige Eingabe mit ${count} Anhang/Anhängen wiederhergestellt.`,
      restorePreviousInputFailed: "Vorherige Eingabe konnte nicht wiederhergestellt werden.",
      typePrompt: "Frage eingeben und Enter drücken.",
    },
    loginRequired: {
      help: "Mit /model Modelle anzeigen oder mit /login ein Coding-Plan-Konto verbinden.",
      message: "Keine Modelle verfügbar. Provider konfigurieren oder mit /login anmelden.",
      status: "Keine Modelle verfügbar. Provider konfigurieren oder mit /login anmelden.",
      title: "Modell-Setup erforderlich",
    },
    loginSetup: {
      emptyMessage: "Keine Anmeldeoptionen verfügbar.",
      help: "Mit Auf/Ab auswählen, mit Enter bestätigen.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "BigModel Coding Plan API Key eingeben",
          inputSecondary: "Key hier einfügen. Beim Tippen bleibt er verborgen.",
          primary: "BigModel Coding Plan API-Schlüssel",
          secondary: "Coding-Plan-API-Key manuell einfügen.",
        },
        bigmodelOauth: {
          pendingPrimary: "Warten auf BigModel-Autorisierung",
          pendingSecondary:
            "Anmeldung im Browser abschließen. Die Autorisierung wird automatisch erkannt.",
          primary: "BigModel Coding-Plan",
          secondary: "Browseranmeldung öffnen; die Autorisierung wird automatisch erkannt.",
        },
        zaiApiKey: {
          inputPrimary: "Z.AI Coding Plan API Key eingeben",
          inputSecondary: "Key hier einfügen. Beim Tippen bleibt er verborgen.",
          primary: "Z.AI Coding Plan API-Schlüssel",
          secondary: "Coding-Plan-API-Key manuell einfügen.",
        },
        zaiOauth: {
          pendingPrimary: "Warten auf Z.AI-Autorisierung",
          pendingSecondary:
            "Anmeldung im Browser abschließen. Ich fahre fort, sobald die Autorisierung abgeschlossen ist.",
          primary: "Z.AI Coding Plan",
          secondary: "Browser-Login öffnen und Coding Plan API-Key erstellen.",
        },
      },
      pending: {
        cancelStatus: "Login abgebrochen. Einrichtungsmethode wählen.",
        help: "Esc bricht ab und kehrt zu den Einrichtungsoptionen zurück.",
        status: "Warte auf Browser-Autorisierung...",
      },
      input: {
        cancelStatus: "API-Key-Eingabe abgebrochen. Einrichtungsmethode wählen.",
        clearStatus: "API-Key-Eingabe gelöscht.",
        emptyStatus: "API-Key ist erforderlich.",
        help: "Enter speichert den Key. Esc kehrt zu den Einrichtungsoptionen zurück.",
        placeholder: "API-Key einfügen",
        status: "API-Key eingeben, dann Enter drücken.",
        submitStatus: "API-Key wird gespeichert...",
      },
      prompt: "Login- oder API-Key-Einrichtungsmethode wählen.",
      response: "Wählen, wie ein Coding Plan-Anbieter eingerichtet wird.",
      title: "Coding Plan einrichten",
    },
    model: {
      requestFailed: (message) => `Modellanfrage fehlgeschlagen: ${message}`,
      responseReceived: "Modellantwort erhalten.",
      responseReceivedWithTokens: (tokens) => `Modellantwort erhalten. ${tokens} Tokens.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Modellanfrage ${attempt}/${Math.max(1, maxAttempts - 1)} wird in ${delay} erneut versucht: ${reason}`,
      streamStalled: "Modell-Stream hängt.",
    },
    sidebar: {
      subagents: {
        title: "Subagenten",
        empty: "Noch keine Subagenten.",
        emptyOutput: "Noch keine Ausgabe.",
        back: "← Hauptkonversation",
        readonly: "Nur lesen · Esc zum Zurückkehren",
        loading: "Subagenten-Ausgabe wird geladen...",
        unavailable: "Subagenten-Ausgabe nicht verfügbar.",
        retry: "Erneut versuchen",
        more: "Mehr laden",
        pendingMain: "Hauptkonversation benötigt Ihre Eingabe — zurückkehren, um zu antworten",
        ended: (count) => `Beendet (${count})`,
        status: {
          running: "läuft",
          waiting: "wartet",
          blocked: "blockiert",
          success: "abgeschlossen",
          failed: "fehlgeschlagen",
          cancelled: "abgebrochen",
          lost: "verloren",
        },
      },
      api: {
        empty: "Noch keine API-Aufrufe.",
        model: "Modell",
        more: (count) => `+${count} mehr`,
        requests: "Anfragen",
        server: "Server-Instanz",
      },
      cache: {
        hit: "Treffer",
        lastHit: "letzter Treffer",
        lastMiss: "letzter Fehlschlag",
        readWrite: ({ read, write }) => `${read} Lesen / ${write} Schreiben`,
        total: "gesamt",
      },
      context: {
        cache: "Zwischenspeicher",
        cacheReadWrite: "Cache L/S",
        inputOutput: "I/O",
        reason: "Grund",
        tokens: "Token-Anzahl",
        used: "Verwendet",
        window: "Fenster",
      },
      modifiedFiles: {
        empty: "Noch keine Dateiänderungen.",
        more: (count) => `+${count} mehr`,
      },
      mcp: {
        empty: "Keine MCP-Server konfiguriert.",
        loadFailed: "MCP-Status nicht verfügbar.",
        loading: "Lade MCP-Status...",
        more: (count) => `+${count} mehr`,
        servers: "Server",
        status: {
          connected: "verbunden",
          connecting: "verbinde",
          disabled: "deaktiviert",
          disconnected: "getrennt",
          failed: "fehlgeschlagen",
          untrusted: "nicht vertrauenswürdig",
        },
        summary: ({ connected, total }) => `${connected}/${total} verbunden`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "abgeschlossen",
        error: "Fehler",
        errorWithStatus: (statusCode) => `Fehler ${statusCode}`,
        pending: "ausstehend",
      },
      status: {
        last: "Letzte",
      },
      run: {
        draft: "Entwurf",
        draftChars: (count) => `${count} Zeichen`,
        draftEmpty: "leer",
        messages: "Nachrichten",
        mode: "Modus",
        model: "Modell",
        provider: "Anbieter",
        thought: "Denken",
        trace: "Verlauf",
        turn: "Runde",
        workspace: "Arbeitsbereich",
      },
      sections: {
        apis: "API-Schnittstellen",
        context: "Kontext",
        mcp: "MCP-Server",
        modifiedFiles: "Geänderte Dateien",
        run: "Ausführen",
        status: "Zustand",
        todos: "Aufgaben",
      },
      shellSubtitle: "OpenTUI-Shell",
      title: "Seitenleiste",
      todos: {
        empty: "Noch keine Todos.",
        more: (count) => `+${count} weitere`,
        progress: "Fortschritt",
      },
    },
    status: {
      compactFailed: "Kontextkomprimierung fehlgeschlagen.",
      compacted: "Konversation verdichtet.",
      compacting: "Kontext wird komprimiert...",
      interruptedStreamDiscarded: "Unterbrochener Modell-Stream verworfen.",
      modelCalling: "Modell wird aufgerufen...",
      permissionRequested: (toolName) => `Berechtigung für ${toolName} angefordert.`,
      permissionResolved: (toolName) => `Berechtigung für ${toolName} aufgelöst.`,
      ready: "Bereit.",
      recoveringStream: "Unterbrochener Modell-Stream wird wiederhergestellt...",
      retryingStream: "Modell-Stream wird erneut versucht...",
      sessionResumed: "Sitzung fortgesetzt.",
      targetChanged: (action) => `Ziel ${action}.`,
      thinking: "Denkt nach...",
      toolCompleted: (toolName) => `Tool ${toolName} abgeschlossen.`,
      toolFailed: (toolName) => `Tool ${toolName} fehlgeschlagen.`,
      toolPending: (toolName) => `Tool ${toolName} ausstehend.`,
      toolRunning: (toolName) => `Tool ${toolName} läuft.`,
      turnFailed: "Runde fehlgeschlagen.",
    },
    terminal: {
      requiresInteractive: "TUI erfordert ein interaktives Terminal.",
      starting: "ZCode wird gestartet... Ctrl+C zum Beenden",
    },
    transcript: {
      compact: {
        completed: "Kontext komprimiert",
        failed: "Kontextkomprimierung fehlgeschlagen",
        interrupted: "Kontextkomprimierung unterbrochen",
        retry: (command) => `Ctrl-R zum erneuten Versuch von ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Kontextkomprimierung wird wiederholt (${attempt}/${maxAttempts})`
            : "Kontextkomprimierung wird wiederholt",
        skipped: "Kontext ist aktuell; keine Komprimierung nötig",
        started: "Kontext wird komprimiert",
      },
      roles: {
        agent: "KI-Agent",
        system: "Systeminfo",
        user: "Benutzer",
      },
      thought: {
        complete: "Gedanke",
        thinking: "Denkt...",
      },
      title: "Transkript",
      workflow: {
        actors: "Akteure:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `Verbrauch: ${spentTokens} Tokens`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Workflow ${label} - ${status} (${nodesSettled}/${nodesTotal} Schritte)`,
        error: (message) => `Fehler: ${message}`,
        expandHint: "+ zum Aufklappen",
        collapseHint: "- zum Einklappen",
        log: "Protokoll:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} Schritte abgeschlossen`,
        result: (preview) => `Ergebnis: ${preview}`,
        status: {
          completed: "abgeschlossen",
          errored: "fehlgeschlagen",
          pending: "ausstehend",
          running: "läuft",
          stopped: "gestoppt",
        },
        stopReason: {
          user: "von dir",
          model: "vom Agenten",
          provider: "Modellfehler",
          interrupted: "Prozess beendet",
          superseded: "durch einen geänderten Lauf ersetzt",
        },
        truncated: "(gekürzt – vollständiger Verlauf im Lauf-Journal)",
        interruptedNotice: ({ label, runId }) =>
          `Workflow ${label} wurde unterbrochen und kann fortgesetzt werden: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter wählt aus, Esc bricht ab",
      disabled: (reason) => ` [deaktiviert: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `Filter: ${filter || "-"} | ${help ?? "Enter wählt aus, Esc bricht ab"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Keine passenden Workspace-Pfade.",
      loading: "Workspace-Pfade werden geladen...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Dateien",
    },
    slash: {
      title: "Befehle",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
