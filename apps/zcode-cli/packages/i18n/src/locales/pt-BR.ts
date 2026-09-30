import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "pt-BR",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Valor de --locale não suportado: ${value}. Localidades suportadas: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Uso:
  zcode [comando] [opções]

Sem comando, zcode abre a TUI em tela cheia.

Comandos:
  app-server Executa o app server stdio do ZCode Protocol
  commands   Lista comandos de barra personalizados (\`commands list\`)
  doctor     Inspeciona premissas de runtime e empacotamento
  login [zai|bigmodel]  Login via autorização do navegador
  logout     Remove as credenciais de login compartilhadas do Z.AI
  plugins    Gerencia plugins e marketplaces (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Lista skills locais (\`skills list\`)
  tui        Abre a interface de terminal
  version    Imprime a versão da CLI

Opções:
  -h, --help       Mostra ajuda
  -v, --version    Mostra versão
  -p, --prompt <texto>  Executa um único prompt sem abrir a TUI
  --memory-bench   Com --prompt, ativa a extração automática de Memory e espera antes de sair (requer Memory ativado)
  --browser-use <modo> Ativa o backend Browser Use (suportado: headless)
  --surface <superfície>  Superfície de apresentação para prompts/app-server headless: terminal ou desktop
  --browser-executable <caminho> Executável Chrome/Chromium para Browser Use headless
  --attach <caminho>     Anexa um arquivo local a --prompt; repita para vários arquivos
  --cwd <caminho>     Executa este comando a partir do diretório informado
  --disallowed-tools, --disallowedTools <ferramentas...>
    Remove ferramentas inteiras apenas nesta execução de prompt/TUI; as configurações salvas não mudam.
    Nomes de ferramentas separados por vírgula ou espaço, ex.: "Bash Edit".
    "Bash(git *)" remove todo o Bash; padrões de comando não são considerados.
  --force-mcs      Força a projeção de sistema no meio da conversa para provedores Anthropic
  --locale <localidade>  Localidade da UI: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR ou auto
  --mode <modo>    Modo de permissão para prompts: build, edit, plan ou yolo (padrão: yolo para --prompt)
  --resume <sessionId>  Retoma uma sessão persistida pelo sessionId (sess_...)
  --target <texto>  Executa ou define a meta da sessão no modo headless
  --target-replace Substitui qualquer meta de sessão existente definida por --target
  -c, --continue        Retoma a sessão mais recente do diretório atual
  --json           Imprime JSON legível por máquina onde houver suporte
  --no-browser     Imprime a URL do OAuth sem abrir o navegador
  --no-color       Desativa as cores ANSI
  --verbose        Imprime detalhes extras de diagnóstico

Comandos de barra:
  /help [comando]       Mostra a ajuda dos comandos de barra
  /login                Escolhe o login via navegador do Z.AI ou BigModel
  /logout               Remove as credenciais de login compartilhadas do Z.AI
  /compact [instruções]  Compacta a conversa atual
  /expert [status|resume|stop|<tarefa>]  Executa ou gerencia o workflow do especialista
  /dwf [list|cancel|resume]  Lista, cancela ou retoma execuções de workflow dinâmico
  /fork [latest|checkpointId]  Cria uma nova sessão a partir de um checkpoint do workspace
  /mcp [list|status|connect|disconnect]  Mostra ou gerencia servidores MCP
  /mode [modo]          Mostra ou muda o modo de permissão: build, edit, plan ou yolo
  /model [id]           Mostra ou muda o modelo da sessão atual
  /new                  Inicia uma nova sessão na TUI
  /resume [sessionId]   Retoma uma sessão pelo sessionId; omita para a mais recente no cwd
  /rewind [latest|checkpointId]  Mostra o último checkpoint ou restaura os arquivos do workspace
  /skill [nome] [tarefa]  Lista skills ou força o próximo prompt a carregar uma
  /goal [ação]        Mostra ou define a meta da sessão atual
`,
  },
  tui: {
    copy: {
      copied: "Texto selecionado copiado para a área de transferência.",
      failed: "Não foi possível copiar o texto selecionado.",
      unavailable: "A cópia de texto para a área de transferência não está disponível neste terminal.",
    },
    effort: {
      disabled: "desativado",
      enabled: "ativado",
    },
    input: {
      activeStatusHint: "esc para interromper",
      busyPlaceholder: "Digite para enfileirar a entrada",
      placeholder: "Digite um prompt",
      queuedMore: (count) => `+ mais ${count} na fila`,
      queuedSubmitHint: "Enviado após a próxima chamada de ferramenta.",
      queuedTitle: (count) => ` Fila (${count}) `,
      title: "Entrada",
      noHistorySource: "Nenhuma fonte de histórico de entrada configurada.",
      noPreviousInput: "Nenhuma entrada anterior para este projeto.",
      restoredPreviousInput: "Entrada anterior restaurada.",
      restoredPreviousInputWithAttachments: (count) =>
        `Entrada anterior restaurada com ${count} anexo(s).`,
      restorePreviousInputFailed: "Não foi possível restaurar a entrada anterior.",
      typePrompt: "Digite uma pergunta e pressione Enter.",
    },
    loginRequired: {
      help: "Use /model para ver modelos, ou /login para conectar uma conta Coding Plan.",
      message: "Nenhum modelo disponível. Configure um provedor ou faça login com /login.",
      status: "Nenhum modelo disponível. Configure um provedor ou faça login com /login.",
      title: "configuração de modelo necessária",
    },
    loginSetup: {
      emptyMessage: "Nenhuma opção de login disponível.",
      help: "Use Up/Down para escolher, Enter para selecionar.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Digite a API Key do BigModel Coding Plan",
          inputSecondary: "Cole a chave aqui. Ela fica oculta enquanto você digita.",
          primary: "API Key do BigModel Coding Plan",
          secondary: "Cole manualmente uma API key do Coding Plan.",
        },
        bigmodelOauth: {
          pendingPrimary: "Aguardando autorização do BigModel",
          pendingSecondary:
            "Conclua o login no seu navegador. A autorização é detectada automaticamente.",
          primary: "BigModel Coding Plan",
          secondary: "Abre o login no navegador; a autorização é detectada automaticamente.",
        },
        zaiApiKey: {
          inputPrimary: "Digite a API Key do Z.AI Coding Plan",
          inputSecondary: "Cole a chave aqui. Ela fica oculta enquanto você digita.",
          primary: "API Key do Z.AI Coding Plan",
          secondary: "Cole manualmente uma API key do Coding Plan.",
        },
        zaiOauth: {
          pendingPrimary: "Aguardando autorização do Z.AI",
          pendingSecondary:
            "Conclua o login no seu navegador. Vou continuar quando a autorização terminar.",
          primary: "Z.AI Coding Plan",
          secondary: "Abra o login no navegador e crie uma chave de API do Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Login cancelado. Escolha um método de configuração.",
        help: "Esc cancela e volta às opções de configuração.",
        status: "Aguardando autorização do navegador...",
      },
      input: {
        cancelStatus: "Inserção da chave de API cancelada. Escolha um método de configuração.",
        clearStatus: "Entrada da chave de API limpa.",
        emptyStatus: "A chave de API é obrigatória.",
        help: "Enter salva a chave. Esc volta às opções de configuração.",
        placeholder: "Colar chave de API",
        status: "Digite a chave de API e pressione Enter.",
        submitStatus: "Salvando chave de API...",
      },
      prompt: "Escolha um método de configuração por login ou chave de API.",
      response: "Escolha como configurar um provedor do Coding Plan.",
      title: "Configurar Coding Plan",
    },
    model: {
      requestFailed: (message) => `Falha na requisição ao modelo: ${message}`,
      responseReceived: "Resposta do modelo recebida.",
      responseReceivedWithTokens: (tokens) => `Resposta do modelo recebida. ${tokens} tokens.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Tentando novamente a requisição ao modelo ${attempt}/${Math.max(1, maxAttempts - 1)} em ${delay}: ${reason}`,
      streamStalled: "Stream do modelo travou.",
    },
    sidebar: {
      subagents: {
        title: "Subagentes",
        empty: "Nenhum subagente ainda.",
        emptyOutput: "Nenhuma saída ainda.",
        back: "← Conversa principal",
        readonly: "Somente leitura · Esc para voltar",
        loading: "Carregando saída do subagente...",
        unavailable: "Saída do subagente indisponível.",
        retry: "Tentar novamente",
        more: "Carregar mais",
        pendingMain: "A conversa principal precisa da sua entrada — volte para responder",
        ended: (count) => `Encerrado (${count})`,
        status: {
          running: "em execução",
          waiting: "aguardando",
          blocked: "bloqueado",
          success: "concluído",
          failed: "falhou",
          cancelled: "cancelado",
          lost: "perdido",
        },
      },
      api: {
        empty: "Nenhuma chamada de API ainda.",
        model: "Modelo",
        more: (count) => `+${count} mais`,
        requests: "Requisições",
        server: "Servidor",
      },
      cache: {
        hit: "acerto",
        lastHit: "último acerto",
        lastMiss: "última falha",
        readWrite: ({ read, write }) => `${read} leitura / ${write} escrita`,
        total: "soma total",
      },
      context: {
        cache: "Cache temporário",
        cacheReadWrite: "Cache L/E",
        inputOutput: "I/O",
        reason: "Motivo",
        tokens: "Créditos",
        used: "Usado",
        window: "Janela",
      },
      modifiedFiles: {
        empty: "Nenhuma alteração de arquivo ainda.",
        more: (count) => `+${count} mais`,
      },
      mcp: {
        empty: "Nenhum servidor MCP configurado.",
        loadFailed: "Status MCP indisponível.",
        loading: "Carregando status MCP...",
        more: (count) => `+${count} mais`,
        servers: "Servidores",
        status: {
          connected: "conectado",
          connecting: "conectando",
          disabled: "desativado",
          disconnected: "desconectado",
          failed: "falhou",
          untrusted: "não confiável",
        },
        summary: ({ connected, total }) => `${connected}/${total} conectados`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "completo",
        error: "erro",
        errorWithStatus: (statusCode) => `erro ${statusCode}`,
        pending: "pendente",
      },
      status: {
        last: "Última",
      },
      run: {
        draft: "Rascunho",
        draftChars: (count) => `${count} caracteres`,
        draftEmpty: "vazio",
        messages: "Mensagens",
        mode: "Modo",
        model: "Modelo",
        provider: "Provedor",
        thought: "Pensamento",
        trace: "Rastreamento",
        turn: "Turno",
        workspace: "Área de trabalho",
      },
      sections: {
        apis: "Integrações de API",
        context: "Contexto",
        mcp: "Servidores MCP",
        modifiedFiles: "Arquivos modificados",
        run: "Executar",
        status: "Situação",
        todos: "Tarefas",
      },
      shellSubtitle: "shell OpenTUI",
      title: "Barra lateral",
      todos: {
        empty: "Nenhuma tarefa ainda.",
        more: (count) => `+${count} mais`,
        progress: "Progresso",
      },
    },
    status: {
      compactFailed: "Falha na compressão do contexto.",
      compacted: "Conversa compactada.",
      compacting: "Comprimindo contexto...",
      interruptedStreamDiscarded: "Fluxo do modelo interrompido descartado.",
      modelCalling: "Chamando o modelo...",
      permissionRequested: (toolName) => `Permissão solicitada para ${toolName}.`,
      permissionResolved: (toolName) => `Permissão resolvida para ${toolName}.`,
      ready: "Pronto.",
      recoveringStream: "Recuperando fluxo do modelo interrompido...",
      retryingStream: "Tentando o fluxo do modelo novamente...",
      sessionResumed: "Sessão retomada.",
      targetChanged: (action) => `Alvo ${action}.`,
      thinking: "Pensando...",
      toolCompleted: (toolName) => `Ferramenta ${toolName} concluída.`,
      toolFailed: (toolName) => `Ferramenta ${toolName} falhou.`,
      toolPending: (toolName) => `Ferramenta ${toolName} pendente.`,
      toolRunning: (toolName) => `Ferramenta ${toolName} em execução.`,
      turnFailed: "Turno falhou.",
    },
    terminal: {
      requiresInteractive: "TUI requer um terminal interativo.",
      starting: "Iniciando ZCode... Ctrl+C para sair",
    },
    transcript: {
      compact: {
        completed: "Contexto comprimido",
        failed: "Falha na compressão do contexto",
        interrupted: "Compressão do contexto interrompida",
        retry: (command) => `Ctrl-R para tentar ${command} novamente`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Tentando compactar o contexto novamente (${attempt}/${maxAttempts})`
            : "Tentando compactar o contexto novamente",
        skipped: "O contexto está atualizado; não é necessário compactar",
        started: "Compactando o contexto",
      },
      roles: {
        agent: "Agente",
        system: "Sistema",
        user: "Usuário",
      },
      thought: {
        complete: "Pensamento",
        thinking: "Pensando...",
      },
      title: "Transcrição",
      workflow: {
        actors: "atores:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `uso: ${spentTokens} tokens`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Fluxo ${label} - ${status} (${nodesSettled}/${nodesTotal} etapas)`,
        error: (message) => `erro: ${message}`,
        expandHint: "+ para expandir",
        collapseHint: "- para recolher",
        log: "registro:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} etapas concluídas`,
        result: (preview) => `resultado: ${preview}`,
        status: {
          completed: "concluído",
          errored: "com erro",
          pending: "pendente",
          running: "em execução",
          stopped: "parado",
        },
        stopReason: {
          user: "por você",
          model: "pelo agente",
          provider: "erro do modelo",
          interrupted: "processo encerrado",
          superseded: "substituído por uma execução corrigida",
        },
        truncated: "(truncado - histórico completo no diário da execução)",
        interruptedNotice: ({ label, runId }) =>
          `O fluxo ${label} foi interrompido e pode ser retomado: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter seleciona, Esc cancela",
      disabled: (reason) => ` [desativado: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filtro: ${filter || "-"} | ${help ?? "Enter seleciona, Esc cancela"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Nenhum caminho do workspace corresponde.",
      loading: "Carregando caminhos do workspace...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Arquivos",
    },
    slash: {
      title: "Comandos",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
