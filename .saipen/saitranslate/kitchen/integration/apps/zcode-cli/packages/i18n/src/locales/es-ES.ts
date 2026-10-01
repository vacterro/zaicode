import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "es-ES",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Valor --locale no admitido: ${value}. Idiomas admitidos: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Uso:
  zcode [comando] [opciones]

Sin comando, zcode abre la TUI a pantalla completa.

Comandos:
  app-server Ejecuta el servidor de aplicaciones stdio de ZCode Protocol
  commands   Lista los comandos de barra personalizados (\`commands list\`)
  doctor     Inspecciona las suposiciones de ejecución y empaquetado
  login [zai|bigmodel]  Inicia sesión mediante autorización en el navegador
  logout     Elimina las credenciales de inicio de sesión compartidas de Z.AI
  plugins    Gestiona plugins y mercados (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Lista las skills locales (\`skills list\`)
  tui        Abre la interfaz de terminal
  version    Muestra la versión de la CLI

Opciones:
  -h, --help       Muestra la ayuda
  -v, --version    Muestra la versión
  -p, --prompt <texto>  Ejecuta un solo prompt sin abrir la TUI
  --memory-bench   Con --prompt, activa la extracción automática de Memory y espera antes de salir (requiere Memory activado)
  --browser-use <modo> Activa el backend de Browser Use (admitido: headless)
  --surface <superficie>  Superficie de presentación para prompts headless/app-server: terminal o desktop
  --browser-executable <ruta> Ejecutable de Chrome/Chromium para Browser Use headless
  --attach <ruta>  Adjunta un archivo local a --prompt; repetir para varios archivos
  --cwd <ruta>     Ejecuta este comando desde el directorio indicado
  --disallowed-tools, --disallowedTools <herramientas...>
    Elimina herramientas enteras solo para este prompt o ejecución de TUI; los ajustes guardados no cambian.
    Nombres de herramientas separados por comas o espacios, p. ej. "Bash Edit".
    "Bash(git *)" elimina todo Bash; no se comparan patrones de comandos.
  --force-mcs      Fuerza la proyección del sistema a mitad de conversación para proveedores de Anthropic
  --locale <idioma>  Idioma de la interfaz: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR o auto
  --mode <modo>    Modo de permisos para prompts: build, edit, plan o yolo (por defecto: yolo para --prompt)
  --resume <sessionId>  Reanuda una sesión guardada por sessionId (sess_...)
  --target <texto>  Ejecuta o define el objetivo de la sesión en modo headless
  --target-replace Sustituye cualquier objetivo de sesión existente definido por --target
  -c, --continue        Reanuda la última sesión del directorio actual
  --json           Muestra JSON legible por máquina donde se admita
  --no-browser     Muestra la URL de OAuth sin abrir el navegador
  --no-color       Desactiva los colores ANSI
  --verbose        Muestra detalles de diagnóstico adicionales

Comandos de barra:
  /help [comando]       Muestra la ayuda de los comandos de barra
  /login                Elige el inicio de sesión en el navegador de Z.AI o BigModel
  /logout               Elimina las credenciales de inicio de sesión compartidas de Z.AI
  /compact [instrucciones]  Compacta la conversación actual
  /expert [status|resume|stop|<tarea>]  Ejecuta o gestiona el flujo de trabajo experto
  /dwf [list|cancel|resume]  Lista, cancela o reanuda ejecuciones de flujos de trabajo dinámicos
  /fork [latest|checkpointId]  Crea una sesión nueva a partir de un checkpoint del espacio de trabajo
  /mcp [list|status|connect|disconnect]  Muestra o gestiona servidores MCP
  /mode [modo]          Muestra o cambia el modo de permisos: build, edit, plan o yolo
  /model [id]           Muestra o cambia el modelo de la sesión actual
  /new                  Inicia una sesión nueva en la TUI
  /resume [sessionId]   Reanuda una sesión por sessionId; omítelo para la última del directorio actual
  /rewind [latest|checkpointId]  Muestra el último checkpoint o restaura los archivos del espacio de trabajo
  /skill [nombre] [tarea]  Lista las skills o fuerza a que el siguiente prompt cargue una
  /goal [acción]        Muestra o define el objetivo de la sesión actual
`,
  },
  tui: {
    copy: {
      copied: "Texto seleccionado copiado al portapapeles.",
      failed: "No se pudo copiar el texto seleccionado.",
      unavailable: "La copia de texto al portapapeles no está disponible en este terminal.",
    },
    effort: {
      disabled: "desactivado",
      enabled: "activado",
    },
    input: {
      activeStatusHint: "esc para interrumpir",
      busyPlaceholder: "Escribe para poner la entrada en cola",
      placeholder: "Escribe un prompt",
      queuedMore: (count) => `+ ${count} más en cola`,
      queuedSubmitHint: "Enviado tras la siguiente llamada a herramienta.",
      queuedTitle: (count) => ` Cola (${count}) `,
      title: "Entrada",
      noHistorySource: "No hay ninguna fuente de historial de entrada configurada.",
      noPreviousInput: "No hay entradas anteriores para este proyecto.",
      restoredPreviousInput: "Entrada anterior restaurada.",
      restoredPreviousInputWithAttachments: (count) =>
        `Entrada anterior restaurada con ${count} adjunto(s).`,
      restorePreviousInputFailed: "No se pudo restaurar la entrada anterior.",
      typePrompt: "Escribe una pregunta y pulsa Enter.",
    },
    loginRequired: {
      help: "Usa /model para ver los modelos o /login para conectar una cuenta de Coding Plan.",
      message: "No hay modelos disponibles. Configura un proveedor o inicia sesión con /login.",
      status: "No hay modelos disponibles. Configura un proveedor o inicia sesión con /login.",
      title: "se requiere configuración del modelo",
    },
    loginSetup: {
      emptyMessage: "No hay opciones de inicio de sesión disponibles.",
      help: "Usa Up/Down para elegir y Enter para seleccionar.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Introduce la clave de API de BigModel Coding Plan",
          inputSecondary: "Pega la clave aquí. Está oculta mientras escribes.",
          primary: "Clave de API de BigModel Coding Plan",
          secondary: "Pega manualmente una clave de API de Coding Plan.",
        },
        bigmodelOauth: {
          pendingPrimary: "Esperando la autorización de BigModel",
          pendingSecondary:
            "Completa el inicio de sesión en tu navegador. La autorización se detecta automáticamente.",
          primary: "Plan de BigModel: Coding Plan",
          secondary: "Abre el inicio de sesión en el navegador; la autorización se detecta automáticamente.",
        },
        zaiApiKey: {
          inputPrimary: "Introduce la clave de API de Z.AI Coding Plan",
          inputSecondary: "Pega la clave aquí. Está oculta mientras escribes.",
          primary: "Clave de API de Z.AI Coding Plan",
          secondary: "Pega manualmente una clave de API de Coding Plan.",
        },
        zaiOauth: {
          pendingPrimary: "Esperando la autorización de Z.AI",
          pendingSecondary:
            "Completa el inicio de sesión en tu navegador. Continuaré cuando termine la autorización.",
          primary: "Z.AI Coding Plan",
          secondary: "Inicia sesión en el navegador y crea una clave API de Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Inicio de sesión cancelado. Elige un método de configuración.",
        help: "Esc cancela y vuelve a las opciones de configuración.",
        status: "Esperando la autorización del navegador...",
      },
      input: {
        cancelStatus: "Introducción de la clave API cancelada. Elige un método de configuración.",
        clearStatus: "Clave API borrada.",
        emptyStatus: "La clave API es obligatoria.",
        help: "Enter guarda la clave. Esc vuelve a las opciones de configuración.",
        placeholder: "Pegar la clave API",
        status: "Introduce la clave API y pulsa Enter.",
        submitStatus: "Guardando la clave API...",
      },
      prompt: "Elige un método de inicio de sesión o configuración con clave API.",
      response: "Elige cómo configurar un proveedor de Coding Plan.",
      title: "Configurar Coding Plan",
    },
    model: {
      requestFailed: (message) => `La solicitud al modelo falló: ${message}`,
      responseReceived: "Respuesta del modelo recibida.",
      responseReceivedWithTokens: (tokens) => `Respuesta del modelo recibida. ${tokens} tokens.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Reintentando la solicitud al modelo ${attempt}/${Math.max(1, maxAttempts - 1)} en ${delay}: ${reason}`,
      streamStalled: "La transmisión del modelo se ha detenido.",
    },
    sidebar: {
      subagents: {
        title: "Subagentes",
        empty: "Aún no hay subagentes.",
        emptyOutput: "Aún no hay salida.",
        back: "← Conversación principal",
        readonly: "Solo lectura · Esc para volver",
        loading: "Cargando la salida del subagente...",
        unavailable: "Salida del subagente no disponible.",
        retry: "Reintentar",
        more: "Cargar más",
        pendingMain: "La conversación principal necesita tu intervención; vuelve para responder.",
        ended: (count) => `Finalizado (${count})`,
        status: {
          running: "en ejecución",
          waiting: "en espera",
          blocked: "bloqueado",
          success: "completado",
          failed: "fallido",
          cancelled: "cancelado",
          lost: "perdido",
        },
      },
      api: {
        empty: "Aún no hay llamadas API.",
        model: "Modelo",
        more: (count) => `+${count} más`,
        requests: "Solicitudes",
        server: "Servidor",
      },
      cache: {
        hit: "acierto",
        lastHit: "último acierto",
        lastMiss: "último fallo",
        readWrite: ({ read, write }) => `${read} lectura / ${write} escritura`,
        total: "total acumulado",
      },
      context: {
        cache: "Caché",
        cacheReadWrite: "Caché L/E",
        inputOutput: "I/O",
        reason: "Motivo",
        tokens: "Fichas",
        used: "Usado",
        window: "Ventana",
      },
      modifiedFiles: {
        empty: "Aún no hay cambios de archivo.",
        more: (count) => `+${count} más`,
      },
      mcp: {
        empty: "No hay servidores MCP configurados.",
        loadFailed: "Estado de MCP no disponible.",
        loading: "Cargando estado de MCP...",
        more: (count) => `+${count} más`,
        servers: "Servidores",
        status: {
          connected: "conectado",
          connecting: "conectando",
          disabled: "desactivado",
          disconnected: "desconectado",
          failed: "fallido",
          untrusted: "sin verificar",
        },
        summary: ({ connected, total }) => `${connected}/${total} conectados`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "completado",
        error: "fallo",
        errorWithStatus: (statusCode) => `fallo ${statusCode}`,
        pending: "pendiente",
      },
      status: {
        last: "Último",
      },
      run: {
        draft: "Borrador",
        draftChars: (count) => `${count} caracteres`,
        draftEmpty: "vacío",
        messages: "Mensajes",
        mode: "Modo",
        model: "Modelo",
        provider: "Proveedor",
        thought: "Pensamiento",
        trace: "Traza",
        turn: "Turno",
        workspace: "Espacio de trabajo",
      },
      sections: {
        apis: "APIs",
        context: "Contexto",
        mcp: "MCP",
        modifiedFiles: "Archivos modificados",
        run: "Ejecutar",
        status: "Estado",
        todos: "Tareas",
      },
      shellSubtitle: "shell OpenTUI",
      title: "Barra lateral",
      todos: {
        empty: "Aún no hay tareas.",
        more: (count) => `+${count} más`,
        progress: "Progreso",
      },
    },
    status: {
      compactFailed: "Error al comprimir el contexto.",
      compacted: "Conversación compactada.",
      compacting: "Comprimiendo contexto...",
      interruptedStreamDiscarded: "Flujo del modelo interrumpido descartado.",
      modelCalling: "Llamando al modelo...",
      permissionRequested: (toolName) => `Permiso solicitado para ${toolName}.`,
      permissionResolved: (toolName) => `Permiso resuelto para ${toolName}.`,
      ready: "Listo.",
      recoveringStream: "Recuperando flujo del modelo interrumpido...",
      retryingStream: "Reintentando flujo del modelo...",
      sessionResumed: "Sesión reanudada.",
      targetChanged: (action) => `Objetivo ${action}.`,
      thinking: "Pensando...",
      toolCompleted: (toolName) => `Herramienta ${toolName} completada.`,
      toolFailed: (toolName) => `Herramienta ${toolName} falló.`,
      toolPending: (toolName) => `Herramienta ${toolName} pendiente.`,
      toolRunning: (toolName) => `Herramienta ${toolName} en ejecución.`,
      turnFailed: "Turno fallido.",
    },
    terminal: {
      requiresInteractive: "TUI requiere un terminal interactivo.",
      starting: "Iniciando ZCode... Ctrl+C para salir",
    },
    transcript: {
      compact: {
        completed: "Contexto comprimido",
        failed: "Error al comprimir el contexto",
        interrupted: "Compresión del contexto interrumpida",
        retry: (command) => `Ctrl-R para reintentar ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Reintentando la compresión del contexto (${attempt}/${maxAttempts})`
            : "Reintentando la compresión del contexto",
        skipped: "Contexto actualizado; no hace falta comprimir",
        started: "Comprimiendo contexto",
      },
      roles: {
        agent: "Agente",
        system: "Sistema",
        user: "Usuario",
      },
      thought: {
        complete: "Pensamiento",
        thinking: "Pensando...",
      },
      title: "Transcripción",
      workflow: {
        actors: "actores:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `uso: ${spentTokens} tokens`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Flujo de trabajo ${label} - ${status} (${nodesSettled}/${nodesTotal} pasos)`,
        error: (message) => `fallo: ${message}`,
        expandHint: "+ para expandir",
        collapseHint: "- para plegar",
        log: "registro:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} pasos resueltos`,
        result: (preview) => `resultado: ${preview}`,
        status: {
          completed: "completado",
          errored: "con error",
          pending: "pendiente",
          running: "en ejecución",
          stopped: "detenido",
        },
        stopReason: {
          user: "por ti",
          model: "por el agente",
          provider: "error del modelo",
          interrupted: "proceso finalizado",
          superseded: "sustituido por una ejecución corregida",
        },
        truncated: "(truncado: historial completo en el registro de ejecución)",
        interruptedNotice: ({ label, runId }) =>
          `El flujo de trabajo ${label} se interrumpió y se puede reanudar: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter selecciona, Esc cancela",
      disabled: (reason) => ` [desactivado: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filtro: ${filter || "-"} | ${help ?? "Enter selecciona, Esc cancela"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "No hay rutas coincidentes del espacio de trabajo.",
      loading: "Cargando rutas del espacio de trabajo...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Archivos",
    },
    slash: {
      title: "Comandos",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
