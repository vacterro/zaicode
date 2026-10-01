import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "fr-FR",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Valeur --locale non prise en charge : ${value}. Langues prises en charge : en-US, zh-CN, auto.`,
    },
    help: (version) => `zcode ${version}

Utilisation :
  zcode [commande] [options]

Sans commande, zcode ouvre la TUI plein écran.

Commandes :
  app-server Exécuter le serveur d'app stdio du protocole ZCode
  commands   Lister les commandes slash personnalisées (\`commands list\`)
  doctor     Inspecter les hypothèses d'exécution et d'empaquetage
  login [zai|bigmodel]  Se connecter via l'autorisation du navigateur
  logout     Supprimer les identifiants Z.AI partagés
  plugins    Gérer les plugins et les places de marché (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\` ; alias : plugin)
  skills     Lister les compétences locales (\`skills list\`)
  tui        Ouvrir l'interface terminal
  version    Afficher la version de la CLI

Options :
  -h, --help       Afficher l'aide
  -v, --version    Afficher la version
  -p, --prompt <text>  Exécuter une invite unique sans ouvrir la TUI
  --memory-bench   Avec --prompt, activer l'extraction automatique de Memory et attendre avant de quitter (nécessite Memory activé)
  --browser-use <mode> Activer le backend Browser Use (pris en charge : headless)
  --surface <surface>  Surface de présentation pour les invites headless/app-server : terminal ou desktop
  --browser-executable <path> Exécutable Chrome/Chromium pour Browser Use headless
  --attach <path>  Joindre un fichier local à --prompt ; répéter pour plusieurs fichiers
  --cwd <path>     Exécuter cette commande depuis le répertoire indiqué
  --disallowed-tools, --disallowedTools <tools...>
    Supprimer des outils entiers pour cette invite/exécution TUI uniquement ; les paramètres enregistrés restent inchangés.
    Noms d'outils séparés par des virgules ou des espaces, par ex. "Bash Edit".
    "Bash(git *)" supprime tout Bash ; les motifs de commande ne sont pas respectés.
  --force-mcs      Forcer la projection système en cours de conversation pour les fournisseurs Anthropic
  --locale <locale>  Langue de l'interface : en-US, zh-CN ou auto
  --mode <mode>    Mode d'autorisation pour les invites : build, edit, plan ou yolo (par défaut : yolo pour --prompt)
  --resume <sessionId>  Reprendre une session persistée par sessionId (sess_...)
  --target <text>  Exécuter ou définir l'objectif de session en mode headless
  --target-replace Remplacer tout objectif de session existant défini par --target
  -c, --continue        Reprendre la dernière session du répertoire courant
  --json           Afficher du JSON lisible par machine là où c'est pris en charge
  --no-browser     Afficher l'URL OAuth sans ouvrir de navigateur
  --no-color       Désactiver les couleurs ANSI
  --verbose        Afficher des détails de diagnostic supplémentaires

Commandes slash :
  /help [commande]       Afficher l'aide des commandes slash
  /login                Choisir la connexion navigateur Z.AI ou BigModel
  /logout               Supprimer les identifiants Z.AI partagés
  /compact [instructions]  Compacter la conversation en cours
  /expert [status|resume|stop|<task>]  Exécuter ou gérer le flux expert
  /dwf [list|cancel|resume]  Lister, annuler ou reprendre les exécutions de flux dynamiques
  /fork [latest|checkpointId]  Forker une nouvelle session depuis un point de contrôle de l'espace de travail
  /mcp [list|status|connect|disconnect]  Afficher ou gérer les serveurs MCP
  /mode [mode]          Afficher ou changer le mode d'autorisation : build, edit, plan ou yolo
  /model [id]           Afficher ou changer le modèle de la session en cours
  /new                  Démarrer une nouvelle session dans la TUI
  /resume [sessionId]   Reprendre une session par sessionId ; omis = dernière dans le cwd
  /rewind [latest|checkpointId]  Afficher le dernier point de contrôle ou restaurer les fichiers de l'espace de travail
  /skill [name] [task]  Lister les compétences, ou forcer le chargement de l'une au prochain prompt
  /goal [action]        Afficher ou définir l'objectif de la session en cours
`,
  },
  tui: {
    copy: {
      copied: "Texte sélectionné copié dans le presse-papiers.",
      failed: "Impossible de copier le texte sélectionné.",
      unavailable: "La copie de texte dans le presse-papiers n'est pas disponible dans ce terminal.",
    },
    effort: {
      disabled: "désactivé",
      enabled: "activé",
    },
    input: {
      activeStatusHint: "esc pour interrompre",
      busyPlaceholder: "Saisissez pour mettre en file d'attente",
      placeholder: "Saisissez une invite",
      queuedMore: (count) => `+ ${count} autres en file d'attente`,
      queuedSubmitHint: "Envoyé après le prochain appel d'outil.",
      queuedTitle: (count) => ` File (${count}) `,
      title: "Saisie",
      noHistorySource: "Aucune source d'historique de saisie n'est configurée.",
      noPreviousInput: "Aucune saisie précédente pour ce projet.",
      restoredPreviousInput: "Saisie précédente restaurée.",
      restoredPreviousInputWithAttachments: (count) =>
        `Saisie précédente restaurée avec ${count} pièce(s) jointe(s).`,
      restorePreviousInputFailed: "Impossible de restaurer la saisie précédente.",
      typePrompt: "Saisissez une question et appuyez sur Enter.",
    },
    loginRequired: {
      help: "Utilisez /model pour voir les modèles, ou /login pour connecter un compte Coding Plan.",
      message: "Aucun modèle disponible. Configurez un fournisseur ou connectez-vous avec /login.",
      status: "Aucun modèle disponible. Configurez un fournisseur ou connectez-vous avec /login.",
      title: "configuration du modèle requise",
    },
    loginSetup: {
      emptyMessage: "Aucune option de connexion disponible.",
      help: "Utilisez Haut/Bas pour choisir, Enter pour valider.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Saisissez la clé API BigModel Coding Plan",
          inputSecondary: "Collez la clé ici. Elle est masquée pendant la saisie.",
          primary: "Clé API BigModel Coding Plan",
          secondary: "Collez manuellement une clé API Coding Plan.",
        },
        bigmodelOauth: {
          pendingPrimary: "En attente de l'autorisation BigModel",
          pendingSecondary:
            "Terminez la connexion dans votre navigateur. L'autorisation est détectée automatiquement.",
          primary: "BigModel Coding Plan",
          secondary: "Ouvrir la connexion navigateur ; l'autorisation est détectée automatiquement.",
        },
        zaiApiKey: {
          inputPrimary: "Saisissez la clé API Z.AI Coding Plan",
          inputSecondary: "Collez la clé ici. Elle est masquée pendant la saisie.",
          primary: "Clé API Z.AI Coding Plan",
          secondary: "Collez manuellement une clé API Coding Plan.",
        },
        zaiOauth: {
          pendingPrimary: "En attente de l'autorisation Z.AI",
          pendingSecondary:
            "Terminez la connexion dans votre navigateur. Je continuerai une fois l'autorisation terminée.",
          primary: "Z.AI Coding Plan",
          secondary: "Ouvrez la connexion navigateur et créez une clé API Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Connexion annulée. Choisissez une méthode de configuration.",
        help: "Échap annule et revient aux choix de configuration.",
        status: "En attente de l'autorisation du navigateur...",
      },
      input: {
        cancelStatus: "Saisie de la clé API annulée. Choisissez une méthode de configuration.",
        clearStatus: "Saisie de la clé API effacée.",
        emptyStatus: "La clé API est obligatoire.",
        help: "Entrée enregistre la clé. Échap revient aux choix de configuration.",
        placeholder: "Coller la clé API",
        status: "Saisissez la clé API, puis appuyez sur Entrée.",
        submitStatus: "Enregistrement de la clé API...",
      },
      prompt: "Choisissez une méthode de connexion ou de clé API.",
      response: "Choisissez comment configurer un fournisseur Coding Plan.",
      title: "Configurer Coding Plan",
    },
    model: {
      requestFailed: (message) => `Requête au modèle échouée : ${message}`,
      responseReceived: "Réponse du modèle reçue.",
      responseReceivedWithTokens: (tokens) => `Réponse du modèle reçue. ${tokens} tokens.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Nouvel essai de la requête ${attempt}/${Math.max(1, maxAttempts - 1)} dans ${delay} : ${reason}`,
      streamStalled: "Flux du modèle bloqué.",
    },
    sidebar: {
      subagents: {
        title: "Sous-agents",
        empty: "Aucun sous-agent.",
        emptyOutput: "Aucune sortie.",
        back: "← Conversation principale",
        readonly: "Lecture seule · Échap pour revenir",
        loading: "Chargement de la sortie du sous-agent...",
        unavailable: "Sortie du sous-agent indisponible.",
        retry: "Réessayer",
        more: "Charger plus",
        pendingMain: "La conversation principale attend votre saisie — revenez pour répondre",
        ended: (count) => `Terminé (${count})`,
        status: {
          running: "en cours",
          waiting: "en attente",
          blocked: "bloqué",
          success: "terminé",
          failed: "échoué",
          cancelled: "annulé",
          lost: "perdu",
        },
      },
      api: {
        empty: "Aucun appel API.",
        model: "Modèle",
        more: (count) => `+${count} de plus`,
        requests: "Requêtes",
        server: "Serveur",
      },
      cache: {
        hit: "succès",
        lastHit: "dernier succès",
        lastMiss: "dernier échec",
        readWrite: ({ read, write }) => `${read} lecture / ${write} écriture`,
        total: "montant",
      },
      context: {
        cache: "mémoire temporaire",
        cacheReadWrite: "Cache L/E",
        inputOutput: "I/O",
        reason: "Raison",
        tokens: "Jetons",
        used: "Utilisés",
        window: "Fenêtre",
      },
      modifiedFiles: {
        empty: "Aucune modification de fichier pour l’instant.",
        more: (count) => `+${count} de plus`,
      },
      mcp: {
        empty: "Aucun serveur MCP configuré.",
        loadFailed: "État MCP indisponible.",
        loading: "Chargement de l’état MCP...",
        more: (count) => `+${count} de plus`,
        servers: "Serveurs",
        status: {
          connected: "connecté",
          connecting: "connexion en cours",
          disabled: "désactivé",
          disconnected: "déconnecté",
          failed: "échec",
          untrusted: "non approuvé",
        },
        summary: ({ connected, total }) => `${connected}/${total} connectés`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "terminé",
        error: "erreur",
        errorWithStatus: (statusCode) => `erreur ${statusCode}`,
        pending: "en attente",
      },
      status: {
        last: "Dernier",
      },
      run: {
        draft: "Brouillon",
        draftChars: (count) => `${count} car.`,
        draftEmpty: "vide",
        messages: "Échanges",
        mode: "Fonctionnement",
        model: "Modèle",
        provider: "Fournisseur",
        thought: "Pensée",
        trace: "Exécution",
        turn: "Tour",
        workspace: "Espace de travail",
      },
      sections: {
        apis: "APIs",
        context: "Contexte",
        mcp: "MCP",
        modifiedFiles: "Fichiers modifiés",
        run: "Exécution",
        status: "Statut",
        todos: "Liste de tâches",
      },
      shellSubtitle: "Shell OpenTUI",
      title: "Barre latérale",
      todos: {
        empty: "Aucun todo pour l'instant.",
        more: (count) => `+${count} de plus`,
        progress: "Progression",
      },
    },
    status: {
      compactFailed: "Échec de la compression du contexte.",
      compacted: "Conversation condensée.",
      compacting: "Compression du contexte...",
      interruptedStreamDiscarded: "Flux du modèle interrompu abandonné.",
      modelCalling: "Appel du modèle...",
      permissionRequested: (toolName) => `Autorisation demandée pour ${toolName}.`,
      permissionResolved: (toolName) => `Autorisation résolue pour ${toolName}.`,
      ready: "Prêt.",
      recoveringStream: "Récupération du flux du modèle interrompu...",
      retryingStream: "Nouvelle tentative du flux du modèle...",
      sessionResumed: "Session reprise.",
      targetChanged: (action) => `Cible ${action}.`,
      thinking: "Réflexion...",
      toolCompleted: (toolName) => `Outil ${toolName} terminé.`,
      toolFailed: (toolName) => `Échec de l'outil ${toolName}.`,
      toolPending: (toolName) => `Outil ${toolName} en attente.`,
      toolRunning: (toolName) => `Outil ${toolName} en cours.`,
      turnFailed: "Échec du tour.",
    },
    terminal: {
      requiresInteractive: "TUI nécessite un terminal interactif.",
      starting: "Démarrage de ZCode... Ctrl+C pour quitter",
    },
    transcript: {
      compact: {
        completed: "Contexte compressé",
        failed: "Échec de la compression du contexte",
        interrupted: "Compression du contexte interrompue",
        retry: (command) => `Ctrl-R pour réessayer ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Nouvelle tentative de compression du contexte (${attempt}/${maxAttempts})`
            : "Nouvelle tentative de compression du contexte",
        skipped: "Contexte à jour ; aucune compression nécessaire",
        started: "Compression du contexte",
      },
      roles: {
        agent: "Agent IA",
        system: "Système",
        user: "Utilisateur",
      },
      thought: {
        complete: "Pensée",
        thinking: "Réflexion...",
      },
      title: "Transcription",
      workflow: {
        actors: "acteurs :",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `usage : ${spentTokens} tokens`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Workflow ${label} - ${status} (${nodesSettled}/${nodesTotal} étapes)`,
        error: (message) => `erreur : ${message}`,
        expandHint: "+ pour développer",
        collapseHint: "- pour réduire",
        log: "log :",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} étapes terminées`,
        result: (preview) => `résultat : ${preview}`,
        status: {
          completed: "terminé",
          errored: "erreur",
          pending: "en attente",
          running: "en cours",
          stopped: "arrêté",
        },
        stopReason: {
          user: "par vous",
          model: "par l'agent",
          provider: "erreur du modèle",
          interrupted: "processus arrêté",
          superseded: "remplacé par une exécution corrigée",
        },
        truncated: "(tronqué - historique complet dans le journal d'exécution)",
        interruptedNotice: ({ label, runId }) =>
          `Le workflow ${label} a été interrompu et peut reprendre : /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Entrée pour sélectionner, Échap pour annuler",
      disabled: (reason) => ` [désactivé : ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filtre : ${filter || "-"} | ${help ?? "Entrée pour sélectionner, Échap pour annuler"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Aucun chemin d'espace de travail correspondant.",
      loading: "Chargement des chemins de l'espace de travail...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Fichiers",
    },
    slash: {
      title: "Commandes",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
