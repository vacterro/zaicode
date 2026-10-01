import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "ded",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Неподдерживаемое значение --locale: ${value}. Поддерживаемые локали: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Использование:
  zcode [command] [options]

Без команды zcode открывает полноэкранный TUI.

Команды:
  app-server Запустить app server протокола ZCode по stdio
  commands   Показать свои слеш-команды (\`commands list\`)
  doctor     Проверить, что с рантаймом и сборкой всё ок
  login [zai|bigmodel]  Войти через браузер
  logout     Убрать общие учётные данные Z.AI
  plugins    Управлять плагинами и маркетплейсами (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; алиас: plugin)
  skills     Показать локальные скиллы (\`skills list\`)
  tui        Открыть терминальный UI
  version    Показать версию CLI

Опции:
  -h, --help       Показать справку
  -v, --version    Показать версию
  -p, --prompt <text>  Выполнить один промпт без запуска TUI
  --memory-bench   С --prompt — автоизвлечение из Memory и ждать перед выходом (нужно включить Memory)
  --browser-use <mode> Бэкенд Browser Use (поддерживается: headless)
  --surface <surface>  Поверхность вывода для headless-промптов/app-server: terminal или desktop
  --browser-executable <path> Chrome/Chromium для headless Browser Use
  --attach <path>     Прикрепить локальный файл к --prompt; можно повторять
  --cwd <path>     Выполнить команду из указанной папки
  --disallowed-tools, --disallowedTools <tools...>
    Убрать инструменты целиком только для этого промпта/запуска TUI; сохранённые настройки не трогаем.
    Имена через запятую или пробел, напр. "Bash Edit".
    "Bash(git *)" убирает весь Bash; шаблоны команд не ловятся.
  --force-mcs      Форсировать системную проекцию посреди разговора для провайдеров Anthropic
  --locale <locale>  Локаль UI: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR или auto
  --mode <mode>    Режим прав для промптов: build, edit, plan или yolo (по умолчанию yolo для --prompt)
  --resume <sessionId>  Возобновить сохранённую сессию по sessionId (sess_...)
  --target <text>  Задать или показать цель сессии в headless-режиме
  --target-replace Заменить уже заданную цель сессии от --target
  -c, --continue        Подхватить последнюю сессию текущей папки
  --json           Машиночитаемый JSON, где поддерживается
  --no-browser     Показать OAuth-ссылку, не открывая браузер
  --no-color       Отключить цвета ANSI
  --verbose        Показать допдиагностику

Слеш-команды:
  /help [command]       Справка по слеш-командам
  /login                Выбрать вход в браузер: Z.AI или BigModel
  /logout               Убрать общие учётные данные Z.AI
  /compact [instructions]  Сжать текущий диалог
  /expert [status|resume|stop|<task>]  Запустить или вести экспертный воркфлоу
  /dwf [list|cancel|resume]  Список, отмена или продолжение динамических воркфлоу
  /fork [latest|checkpointId]  Новая сессия из чекпойнта воркспейса
  /mcp [list|status|connect|disconnect]  Показать или вести серверы MCP
  /mode [mode]          Показать или сменить режим прав: build, edit, plan, yolo
  /model [id]           Показать или сменить модель текущей сессии
  /new                  Новая сессия в TUI
  /resume [sessionId]   Возобновить сессию по sessionId; без него — последняя в cwd
  /rewind [latest|checkpointId]  Показать последний чекпойнт или откатить файлы воркспейса
  /skill [name] [task]  Список скиллов или загрузить скилл при следующем промпте
  /goal [action]        Показать или задать цель сессии
`,
  },
  tui: {
    copy: {
      copied: "Выделенный текст скопирован в буфер обмена.",
      failed: "Не удалось скопировать выделенный текст.",
      unavailable: "Копирование текста в буфер обмена в этом терминале недоступно.",
    },
    effort: {
      disabled: "отключено",
      enabled: "включено",
    },
    input: {
      activeStatusHint: "Esc для прерывания",
      busyPlaceholder: "Печатай — встанет в очередь",
      placeholder: "Введи промпт",
      queuedMore: (count) => `+ ${count} ещё в очереди`,
      queuedSubmitHint: "Отправлено после следующего вызова инструмента.",
      queuedTitle: (count) => ` Очередь (${count}) `,
      title: "Ввод",
      noHistorySource: "Источник истории ввода не настроен.",
      noPreviousInput: "Для этого проекта предыдущего ввода нет.",
      restoredPreviousInput: "Предыдущий ввод восстановлен.",
      restoredPreviousInputWithAttachments: (count) =>
        `Предыдущий ввод восстановлен, вложений: ${count}.`,
      restorePreviousInputFailed: "Не удалось восстановить предыдущий ввод.",
      typePrompt: "Введи вопрос и жми Enter.",
    },
    loginRequired: {
      help: "Жми /model — список моделей, или /login — подключить аккаунт Coding Plan.",
      message: "Моделей нет. Настрой провайдера или войди через /login.",
      status: "Моделей нет. Настрой провайдера или войди через /login.",
      title: "нужна настройка модели",
    },
    loginSetup: {
      emptyMessage: "Вариантов входа нет.",
      help: "Выбор — стрелками Up/Down, Enter — подтвердить.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Введи BigModel Coding Plan API Key",
          inputSecondary: "Вставь ключ сюда. При вводе он скрыт.",
          primary: "Ключ BigModel Coding Plan API",
          secondary: "Вставь ключ Coding Plan API руками.",
        },
        bigmodelOauth: {
          pendingPrimary: "Ждём авторизацию BigModel",
          pendingSecondary:
            "Закрой вход в браузере. Авторизация подхватится сама.",
          primary: "BigModel Coding Plan",
          secondary: "Открыть вход в браузере; авторизация подхватится сама.",
        },
        zaiApiKey: {
          inputPrimary: "Введи Z.AI Coding Plan API Key",
          inputSecondary: "Вставь ключ сюда. При вводе он скрыт.",
          primary: "Ключ Z.AI Coding Plan API",
          secondary: "Вставь ключ Coding Plan API руками.",
        },
        zaiOauth: {
          pendingPrimary: "Ждём авторизацию Z.AI",
          pendingSecondary:
            "Закрой вход в браузере. Дальше поедем, когда авторизация закончится.",
          primary: "Z.AI Coding Plan",
          secondary: "Вход через браузер, создай ключ API для Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Вход отменён. Выбери способ настройки.",
        help: "Esc — отмена, назад к выбору настройки.",
        status: "Ждём авторизацию в браузере...",
      },
      input: {
        cancelStatus: "Ввод ключа API отменён. Выбери способ настройки.",
        clearStatus: "Ключ API стёрт.",
        emptyStatus: "Ключ API обязателен.",
        help: "Enter — сохранить ключ. Esc — назад к выбору настройки.",
        placeholder: "Вставь ключ API",
        status: "Введи ключ API, потом жми Enter.",
        submitStatus: "Сохраняю ключ API...",
      },
      prompt: "Выбери способ настройки: вход или ключ API.",
      response: "Выбери, как настроить провайдер Coding Plan.",
      title: "Настроить Coding Plan",
    },
    model: {
      requestFailed: (message) => `Запрос к модели сорвался: ${message}`,
      responseReceived: "Ответ модели получен.",
      responseReceivedWithTokens: (tokens) => `Ответ модели получен. ${tokens} токенов.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Повтор запроса к модели ${attempt}/${Math.max(1, maxAttempts - 1)} через ${delay}: ${reason}`,
      streamStalled: "Поток от модели встал.",
    },
    sidebar: {
      subagents: {
        title: "Субагенты",
        empty: "Пока субагентов нет.",
        emptyOutput: "Пока вывода нет.",
        back: "← Главный диалог",
        readonly: "Только чтение · Esc — назад",
        loading: "Грузю вывод субагента...",
        unavailable: "Вывод субагента недоступен.",
        retry: "Повторить",
        more: "Показать ещё",
        pendingMain: "Главный диалог ждёт твоего ответа — вернись и ответь",
        ended: (count) => `Закончено (${count})`,
        status: {
          running: "работает",
          waiting: "ждёт",
          blocked: "заблокирован",
          success: "завершён",
          failed: "провален",
          cancelled: "отменён",
          lost: "потерян",
        },
      },
      api: {
        empty: "Вызовов API пока нет.",
        model: "Модель",
        more: (count) => `+${count} ещё`,
        requests: "Запросы",
        server: "Сервер",
      },
      cache: {
        hit: "попадание",
        lastHit: "последнее попадание",
        lastMiss: "последний промах",
        readWrite: ({ read, write }) => `${read} чтение / ${write} запись`,
        total: "всего",
      },
      context: {
        cache: "Кэш",
        cacheReadWrite: "Кэш чт./з.",
        inputOutput: "I/O",
        reason: "Причина",
        tokens: "Токены",
        used: "Занято",
        window: "Окно",
      },
      modifiedFiles: {
        empty: "Пока нет изменений файлов.",
        more: (count) => `+${count} ещё`,
      },
      mcp: {
        empty: "Серверы MCP не настроены.",
        loadFailed: "Статус MCP недоступен.",
        loading: "Грузю статус MCP...",
        more: (count) => `+${count} ещё`,
        servers: "Серверы",
        status: {
          connected: "подключён",
          connecting: "подключается",
          disabled: "выключен",
          disconnected: "отключён",
          failed: "ошибка",
          untrusted: "не доверен",
        },
        summary: ({ connected, total }) => `${connected}/${total} подключено`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "готово",
        error: "ошибка",
        errorWithStatus: (statusCode) => `ошибка ${statusCode}`,
        pending: "в очереди",
      },
      status: {
        last: "Последнее",
      },
      run: {
        draft: "Черновик",
        draftChars: (count) => `${count} симв.`,
        draftEmpty: "пусто",
        messages: "Сообщения",
        mode: "Режим",
        model: "Модель",
        provider: "Провайдер",
        thought: "Мысли",
        trace: "Трасса",
        turn: "Ход",
        workspace: "Рабочая папка",
      },
      sections: {
        apis: "API",
        context: "Контекст",
        mcp: "MCP",
        modifiedFiles: "Изменённые файлы",
        run: "Запуск",
        status: "Статус",
        todos: "Задачи",
      },
      shellSubtitle: "Оболочка OpenTUI",
      title: "Боковая панель",
      todos: {
        empty: "Задач пока нет.",
        more: (count) => `ещё +${count}`,
        progress: "Прогресс",
      },
    },
    status: {
      compactFailed: "Сжатие контекста сорвалось.",
      compacted: "Контекст ужат.",
      compacting: "Жму контекст...",
      interruptedStreamDiscarded: "Прерванный поток модели отброшен.",
      modelCalling: "Зову модель...",
      permissionRequested: (toolName) => `Запросили доступ на ${toolName}.`,
      permissionResolved: (toolName) => `Доступ на ${toolName} дан.`,
      ready: "Готово.",
      recoveringStream: "Поднимаю прерванный поток модели...",
      retryingStream: "Повторяю поток модели...",
      sessionResumed: "Сессия продолжена.",
      targetChanged: (action) => `Цель ${action}.`,
      thinking: "Думаю...",
      toolCompleted: (toolName) => `Инструмент ${toolName} отработал.`,
      toolFailed: (toolName) => `Инструмент ${toolName} сдох.`,
      toolPending: (toolName) => `Инструмент ${toolName} в очереди.`,
      toolRunning: (toolName) => `Инструмент ${toolName} работает.`,
      turnFailed: "Ход не удался.",
    },
    terminal: {
      requiresInteractive: "TUI требует интерактивный терминал.",
      starting: "Запускаю ZCode... Ctrl+C — выход",
    },
    transcript: {
      compact: {
        completed: "Контекст сжат",
        failed: "Сжатие контекста сорвалось",
        interrupted: "Сжатие контекста прервано",
        retry: (command) => `Ctrl-R — повторить ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Повтор сжатия контекста (${attempt}/${maxAttempts})`
            : "Повтор сжатия контекста",
        skipped: "Контекст свежий, сжатие не нужно",
        started: "Сжимаю контекст",
      },
      roles: {
        agent: "Агент",
        system: "Система",
        user: "Юзер",
      },
      thought: {
        complete: "Мысль",
        thinking: "Думаю...",
      },
      title: "Транскрипт",
      workflow: {
        actors: "акторы:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `расход: ${spentTokens} токенов`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Воркфлоу ${label} - ${status} (${nodesSettled}/${nodesTotal} шагов)`,
        error: (message) => `ошибка: ${message}`,
        expandHint: "+ развернуть",
        collapseHint: "- свернуть",
        log: "лог:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} шагов завершено`,
        result: (preview) => `итог: ${preview}`,
        status: {
          completed: "готово",
          errored: "с ошибкой",
          pending: "в очереди",
          running: "работает",
          stopped: "остановлено",
        },
        stopReason: {
          user: "тобой",
          model: "агентом",
          provider: "ошибка модели",
          interrupted: "процесс вышел",
          superseded: "заменён исправленным прогоном",
        },
        truncated: "(обрезано - полная история в журнале прогона)",
        interruptedNotice: ({ label, runId }) =>
          `Воркфлоу ${label} прерван, можно продолжить: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter выбирает, Esc отменяет",
      disabled: (reason) => ` [отключено: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `фильтр: ${filter || "-"} | ${help ?? "Enter выбирает, Esc отменяет"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Нет подходящих путей воркспейса.",
      loading: "Грузю пути воркспейса...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Файлы",
    },
    slash: {
      title: "Команды",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
