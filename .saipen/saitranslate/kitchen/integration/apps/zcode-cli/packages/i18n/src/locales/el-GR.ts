import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "el-GR",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Μη υποστηριζόμενη τιμή --locale: ${value}. Υποστηριζόμενες γλώσσες: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Χρήση:
  zcode [command] [options]

Χωρίς εντολή, το zcode ανοίγει το TUI πλήρους οθόνης.

Εντολές:
  app-server Εκτέλεση του app server ZCode Protocol stdio
  commands   Λίστα προσαρμοσμένων εντολών slash (\`commands list\`)
  doctor     Έλεγχος υποθέσεων χρόνου εκτέλεσης και πακεταρίσματος
  login [zai|bigmodel]  Σύνδεση μέσω εξουσιοδότησης browser
  logout     Αφαίρεση των κοινών διαπιστευτηρίων σύνδεσης Z.AI
  plugins    Διαχείριση plugins και marketplaces (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Λίστα τοπικών skills (\`skills list\`)
  tui        Άνοιγμα του terminal UI
  version    Εμφάνιση της έκδοσης CLI

Επιλογές:
  -h, --help       Εμφάνιση βοήθειας
  -v, --version       Εμφάνιση έκδοσης
  -p, --prompt <text>  Εκτέλεση ενός prompt χωρίς άνοιγμα του TUI
  --memory-bench   Με --prompt, ενεργοποιεί την αυτόματη εξαγωγή Memory και περιμένει πριν την έξοδο (απαιτεί Memory ενεργοποιημένο)
  --browser-use <mode> Ενεργοποίηση backend Browser Use (υποστηρίζεται: headless)
  --surface <surface>  Επιφάνεια παρουσίασης για headless prompts/app-server: terminal ή desktop
  --browser-executable <path> Εκτελέσιμο Chrome/Chromium για headless Browser Use
  --attach <path>  Σύνδεση τοπικού αρχείου στο --prompt· επανάληψη για πολλά αρχεία
  --cwd <path>     Εκτέλεση αυτής της εντολής από τον δοσμένο κατάλογο
  --disallowed-tools, --disallowedTools <tools...>
    Αφαίρεση ολόκληρων εργαλείων μόνο για αυτή την εκτέλεση prompt/TUI· οι αποθηκευμένες ρυθμίσεις δεν αλλάζουν.
    Ονόματα εργαλείων με κόμμα ή κενό, π.χ. "Bash Edit".
    Το "Bash(git *)" αφαιρεί όλο το Bash· τα πρότυπα εντολών δεν ταιριάζουν.
  --force-mcs      Επιβολή προβολής συστήματος μέσης συνομιλίας για παρόχους Anthropic
  --locale <locale>  Γλώσσα UI: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR ή auto
  --mode <mode>    Λειτουργία δικαιωμάτων για prompts: build, edit, plan ή yolo (default: yolo για --prompt)
  --resume <sessionId>  Συνέχεια αποθηκευμένης συνεδρίας με βάση το sessionId (sess_...)
  --target <text>  Εκτέλεση ή ορισμός του στόχου συνεδρίας σε headless λειτουργία
  --target-replace Αντικατάσταση υπάρχοντος στόχου συνεδρίας που ορίστηκε από --target
  -c, --continue        Συνέχεια της τελευταίας συνεδρίας για τον τρέχοντα κατάλογο
  --json           Εμφάνιση JSON αναγνώσιμου από μηχανή όπου υποστηρίζεται
  --no-browser     Εμφάνιση της OAuth URL χωρίς άνοιγμα browser
  --no-color       Απενεργοποίηση χρωμάτων ANSI
  --verbose        Εμφάνιση πρόσθετων διαγνωστικών λεπτομερειών

Εντολές slash:
  /help [command]       Εμφάνιση βοήθειας εντολών slash
  /login                Επιλογή σύνδεσης Z.AI ή BigModel μέσω browser
  /logout               Αφαίρεση των κοινών διαπιστευτηρίων σύνδεσης Z.AI
  /compact [instructions]  Συμπίεση της τρέχουσας συνομιλίας
  /expert [status|resume|stop|<task>]  Εκτέλεση ή διαχείριση της ροής ειδικού
  /dwf [list|cancel|resume]  Λίστα, ακύρωση ή συνέχεια δυναμικών εκτελέσεων ροής
  /fork [latest|checkpointId]  Δημιουργία νέας συνεδρίας από ένα checkpoint του χώρου εργασίας
  /mcp [list|status|connect|disconnect]  Εμφάνιση ή διαχείριση MCP servers
  /mode [mode]          Εμφάνιση ή αλλαγή λειτουργίας δικαιωμάτων: build, edit, plan ή yolo
  /model [id]           Εμφάνιση ή αλλαγή του μοντέλου τρέχουσας συνεδρίας
  /new                  Έναρξη νέας συνεδρίας στο TUI
  /resume [sessionId]   Συνέχεια συνεδρίας με βάση το sessionId· χωρίς αυτόν για τη τελευταία στον τρέχοντα κατάλογο
  /rewind [latest|checkpointId]  Εμφάνιση τελευταίου checkpoint ή επαναφορά αρχείων του χώρου εργασίας
  /skill [name] [task]  Λίστα skills ή επιβολή φόρτωσης μιας στο επόμενο prompt
  /goal [action]        Εμφάνιση ή ορισμός του στόχου τρέχουσας συνεδρίας
`,
  },
  tui: {
    copy: {
      copied: "Το επιλεγμένο κείμενο αντιγράφηκε στο πρόχειρο.",
      failed: "Δεν ήταν δυνατή η αντιγραφή του επιλεγμένου κειμένου.",
      unavailable: "Η αντιγραφή κειμένου στο πρόχειρο δεν είναι διαθέσιμη σε αυτό το τερματικό.",
    },
    effort: {
      disabled: "απενεργοποιημένο",
      enabled: "ενεργοποιημένο",
    },
    input: {
      activeStatusHint: "esc για διακοπή",
      busyPlaceholder: "Γράψτε για να μπει σε ουρά",
      placeholder: "Γράψτε ένα prompt",
      queuedMore: (count) => `+ ${count} ακόμα σε ουρά`,
      queuedSubmitHint: "Υποβλήθηκε μετά την επόμενη κλήση εργαλείου.",
      queuedTitle: (count) => ` Ουρά (${count}) `,
      title: "Είσοδος",
      noHistorySource: "Δεν έχει ρυθμιστεί πηγή ιστορικού εισόδου.",
      noPreviousInput: "Δεν υπάρχει προηγούμενη είσοδος για αυτό το έργο.",
      restoredPreviousInput: "Η προηγούμενη είσοδος αποκαταστάθηκε.",
      restoredPreviousInputWithAttachments: (count) =>
        `Η προηγούμενη είσοδος αποκαταστάθηκε με ${count} συνημμένο(α).`,
      restorePreviousInputFailed: "Δεν ήταν δυνατή η αποκατάσταση της προηγούμενης εισόδου.",
      typePrompt: "Γράψτε μια ερώτηση και πατήστε Enter.",
    },
    loginRequired: {
      help: "Χρησιμοποιήστε /model για να δείτε τα μοντέλα ή /login για να συνδέσετε λογαριασμό Coding Plan.",
      message: "Δεν υπάρχουν διαθέσιμα μοντέλα. Ρυθμίστε έναν πάροχο ή συνδεθείτε με /login.",
      status: "Δεν υπάρχουν διαθέσιμα μοντέλα. Ρυθμίστε έναν πάροχο ή συνδεθείτε με /login.",
      title: "απαιτείται ρύθμιση μοντέλου",
    },
    loginSetup: {
      emptyMessage: "Δεν υπάρχουν διαθέσιμες επιλογές σύνδεσης.",
      help: "Χρησιμοποιήστε Up/Down για επιλογή, Enter για επιβεβαίωση.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Εισαγάγετε το κλειδί API BigModel Coding Plan",
          inputSecondary: "Επικολλήστε το κλειδί εδώ. Παραμένει κρυφό κατά την πληκτρολόγηση.",
          primary: "Κλειδί API BigModel Coding Plan",
          secondary: "Επικολλήστε μη αυτόματα ένα κλειδί API Coding Plan.",
        },
        bigmodelOauth: {
          pendingPrimary: "Αναμονή εξουσιοδότησης BigModel",
          pendingSecondary:
            "Ολοκληρώστε τη σύνδεση στον browser σας. Η εξουσιοδότηση εντοπίζεται αυτόματα.",
          primary: "BigModel Coding Plan",
          secondary: "Ανοίξτε τη σύνδεση στον browser· η εξουσιοδότηση εντοπίζεται αυτόματα.",
        },
        zaiApiKey: {
          inputPrimary: "Εισαγάγετε το κλειδί API Z.AI Coding Plan",
          inputSecondary: "Επικολλήστε το κλειδί εδώ. Παραμένει κρυφό κατά την πληκτρολόγηση.",
          primary: "Κλειδί API Z.AI Coding Plan",
          secondary: "Επικολλήστε μη αυτόματα ένα κλειδί API Coding Plan.",
        },
        zaiOauth: {
          pendingPrimary: "Αναμονή εξουσιοδότησης Z.AI",
          pendingSecondary:
            "Ολοκληρώστε τη σύνδεση στον browser σας. Θα συνεχίσω μόλις ολοκληρωθεί η εξουσιοδότηση.",
          primary: "Z.AI Coding Plan",
          secondary: "Άνοιγμα login στον browser, δημιουργία κλειδιού API για Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Η σύνδεση ακυρώθηκε. Επιλέξτε μέθοδο ρύθμισης.",
        help: "Το Esc ακυρώνει, επιστρέφει στις επιλογές ρύθμισης.",
        status: "Αναμονή εξουσιοδότησης στον browser...",
      },
      input: {
        cancelStatus: "Η εισαγωγή κλειδιού API ακυρώθηκε. Επιλέξτε μέθοδο ρύθμισης.",
        clearStatus: "Το κλειδί API καθαρίστηκε.",
        emptyStatus: "Το κλειδί API είναι υποχρεωτικό.",
        help: "Το Enter αποθηκεύει το κλειδί. Το Esc επιστρέφει στις επιλογές ρύθμισης.",
        placeholder: "Επικόλληση κλειδιού API",
        status: "Εισαγάγετε το κλειδί API, μετά πατήστε Enter.",
        submitStatus: "Αποθήκευση κλειδιού API...",
      },
      prompt: "Επιλέξτε μέθοδο σύνδεσης ή κλειδιού API.",
      response: "Επιλέξτε πώς να ρυθμίσετε έναν provider Coding Plan.",
      title: "Ρύθμιση Coding Plan",
    },
    model: {
      requestFailed: (message) => `Η αίτηση στο μοντέλο απέτυχε: ${message}`,
      responseReceived: "Λήψη απόκρισης από το μοντέλο.",
      responseReceivedWithTokens: (tokens) => `Λήψη απόκρισης από το μοντέλο. ${tokens} tokens.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Επανάληψη αίτησης στο μοντέλο ${attempt}/${Math.max(1, maxAttempts - 1)} σε ${delay}: ${reason}`,
      streamStalled: "Η ροή του μοντέλου στάθηκε.",
    },
    sidebar: {
      subagents: {
        title: "Υποπράκτορες",
        empty: "Δεν υπάρχουν υποπράκτορες ακόμη.",
        emptyOutput: "Δεν υπάρχει έξοδος ακόμη.",
        back: "← Κύρια συνομιλία",
        readonly: "Μόνο ανάγνωση · Esc για επιστροφή",
        loading: "Φόρτωση εξόδου υποπράκτορα...",
        unavailable: "Η έξοδος του υποπράκτορα δεν είναι διαθέσιμη.",
        retry: "Επανάληψη",
        more: "Φόρτωση περισσότερων",
        pendingMain: "Η κύρια συνομιλία χρειάζεται είσοδό σας — επιστρέψτε για απάντηση",
        ended: (count) => `Τέλος (${count})`,
        status: {
          running: "σε εξέλιξη",
          waiting: "σε αναμονή",
          blocked: "αποκλεισμένο",
          success: "ολοκληρώθηκε",
          failed: "απέτυχε",
          cancelled: "ακυρώθηκε",
          lost: "χάθηκε",
        },
      },
      api: {
        empty: "Δεν υπάρχουν κλήσεις API ακόμη.",
        model: "Μοντέλο",
        more: (count) => `+${count} ακόμα`,
        requests: "Αιτήματα",
        server: "Διακομιστής",
      },
      cache: {
        hit: "εξυπηρέτηση",
        lastHit: "τελευταία εξυπηρέτηση",
        lastMiss: "τελευταία αποτυχία",
        readWrite: ({ read, write }) => `${read} ανάγνωση / ${write} εγγραφή`,
        total: "σύνολο",
      },
      context: {
        cache: "Προσωρινή μνήμη",
        cacheReadWrite: "Προσωρινή μνήμη R/W",
        inputOutput: "I/O",
        reason: "Αιτία",
        tokens: "Διακριτικά",
        used: "Χρησιμοποιήθηκε",
        window: "Παράθυρο",
      },
      modifiedFiles: {
        empty: "Καμία αλλαγή σε αρχεία ακόμη.",
        more: (count) => `+${count} ακόμα`,
      },
      mcp: {
        empty: "Δεν έχουν ρυθμιστεί διακομιστές MCP.",
        loadFailed: "Η κατάσταση MCP δεν είναι διαθέσιμη.",
        loading: "Φόρτωση κατάστασης MCP...",
        more: (count) => `+${count} ακόμα`,
        servers: "Διακομιστές",
        status: {
          connected: "συνδεδεμένοι",
          connecting: "σύνδεση",
          disabled: "απενεργοποιημένοι",
          disconnected: "αποσυνδεδεμένοι",
          failed: "απέτυχε",
          untrusted: "μη αξιόπιστοι",
        },
        summary: ({ connected, total }) => `${connected}/${total} συνδεδεμένοι`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "ολοκληρώθηκε",
        error: "σφάλμα",
        errorWithStatus: (statusCode) => `σφάλμα ${statusCode}`,
        pending: "σε αναμονή",
      },
      status: {
        last: "Τελευταίο",
      },
      run: {
        draft: "Πρόχειρο",
        draftChars: (count) => `${count} χαρ.`,
        draftEmpty: "κενό",
        messages: "Μηνύματα",
        mode: "Λειτουργία",
        model: "Μοντέλο",
        provider: "Πάροχος",
        thought: "Σκέψη",
        trace: "Ίχνος",
        turn: "Στροφή",
        workspace: "Χώρος εργασίας",
      },
      sections: {
        apis: "API",
        context: "Πλαίσιο",
        mcp: "MCP",
        modifiedFiles: "Τροποποιημένα αρχεία",
        run: "Εκτέλεση",
        status: "Κατάσταση",
        todos: "Εργασίες",
      },
      shellSubtitle: "Κέλυφος OpenTUI",
      title: "Πλαϊνή στήλη",
      todos: {
        empty: "Δεν υπάρχουν εργασίες ακόμη.",
        more: (count) => `+${count} περισσότερα`,
        progress: "Πρόοδος",
      },
    },
    status: {
      compactFailed: "Η συμπίεση πλαισίου απέτυχε.",
      compacted: "Η συνομιλία συμπιέστηκε.",
      compacting: "Συμπίεση πλαισίου...",
      interruptedStreamDiscarded: "Η ροή μοντέλου που διακόπηκε απορρίφθηκε.",
      modelCalling: "Κλήση μοντέλου...",
      permissionRequested: (toolName) => `Ζητήθηκε άδεια για ${toolName}.`,
      permissionResolved: (toolName) => `Επιλύθηκε η άδεια για ${toolName}.`,
      ready: "Έτοιμο.",
      recoveringStream: "Ανάκτηση ροής μοντέλου που διακόπηκε...",
      retryingStream: "Επανάληψη ροής μοντέλου...",
      sessionResumed: "Η συνεδρία συνεχίστηκε.",
      targetChanged: (action) => `Στόχος ${action}.`,
      thinking: "Σκέψη...",
      toolCompleted: (toolName) => `Το εργαλείο ${toolName} ολοκληρώθηκε.`,
      toolFailed: (toolName) => `Το εργαλείο ${toolName} απέτυχε.`,
      toolPending: (toolName) => `Το εργαλείο ${toolName} εκκρεμεί.`,
      toolRunning: (toolName) => `Το εργαλείο ${toolName} εκτελείται.`,
      turnFailed: "Η στροφή απέτυχε.",
    },
    terminal: {
      requiresInteractive: "Το TUI απαιτεί διαδραστικό τερματικό.",
      starting: "Εκκίνηση ZCode... Ctrl+C για έξοδο",
    },
    transcript: {
      compact: {
        completed: "Το πλαίσιο συμπιέστηκε",
        failed: "Η συμπίεση πλαισίου απέτυχε",
        interrupted: "Η συμπίεση πλαισίου διακόπηκε",
        retry: (command) => `Ctrl-R για να ξαναδοκιμάσετε ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Επανάληψη συμπίεσης περιεχομένου (${attempt}/${maxAttempts})`
            : "Επανάληψη συμπίεσης περιεχομένου",
        skipped: "Το περιεχόμενο είναι ενημερωμένο· δεν χρειάζεται συμπίεση",
        started: "Συμπίεση περιεχομένου",
      },
      roles: {
        agent: "Πράκτορας",
        system: "Σύστημα",
        user: "Χρήστης",
      },
      thought: {
        complete: "Σκέψη",
        thinking: "Σκέφτεται...",
      },
      title: "Απομαγνητοφώνηση",
      workflow: {
        actors: "ηθοποιοί:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `χρήση: ${spentTokens} tokens`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Ροή εργασίας ${label} - ${status} (${nodesSettled}/${nodesTotal} βήματα)`,
        error: (message) => `σφάλμα: ${message}`,
        expandHint: "+ για ανάπτυξη",
        collapseHint: "- για σύμπτυξη",
        log: "καταγραφή:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} βήματα ολοκληρώθηκαν`,
        result: (preview) => `αποτέλεσμα: ${preview}`,
        status: {
          completed: "ολοκληρώθηκε",
          errored: "με σφάλμα",
          pending: "σε αναμονή",
          running: "σε εξέλιξη",
          stopped: "διακόπηκε",
        },
        stopReason: {
          user: "από εσάς",
          model: "από τον πράκτορα",
          provider: "σφάλμα μοντέλου",
          interrupted: "η διεργασία τερμάτισε",
          superseded: "αντικαταστάθηκε από διορθωμένη εκτέλεση",
        },
        truncated: "(συντετμημένο - πλήρης ιστορικό στο περιοδικό εκτέλεσης)",
        interruptedNotice: ({ label, runId }) =>
          `Η ροή εργασίας ${label} διακόπηκε και μπορεί να συνεχιστεί: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Το Enter επιλέγει, το Esc ακυρώνει",
      disabled: (reason) => ` [απενεργοποιημένο: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `φίλτρο: ${filter || "-"} | ${help ?? "Το Enter επιλέγει, το Esc ακυρώνει"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Καμία αντίστοιχη διαδρομή χώρου εργασίας.",
      loading: "Φόρτωση διαδρομών χώρου εργασίας...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Αρχεία",
    },
    slash: {
      title: "Εντολές",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
