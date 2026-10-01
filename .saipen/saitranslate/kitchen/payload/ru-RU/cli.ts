import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "ru-RU",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Неподдерживаемое значение --locale: ${value}. Поддерживаемые локали: en-US, zh-CN, auto.`,
    },
    help: (version) => `zcode ${version}

Использование:
  zcode [command] [options]

Без команды zcode открывает полноэкранный TUI.

Команды:
  app-server Запустить сервер приложений ZCode Protocol по stdio
  commands   Список пользовательских слэш-команд (\`commands list\`)
  doctor     Проверить среду выполнения и допущения сборки
  login [zai|bigmodel]  Войти через браузер
  logout     Удалить общие учётные данные Z.AI
  plugins    Управление плагинами и маркетплейсами (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; псевдоним: plugin)
  skills     Список локальных навыков (\`skills list\`)
  tui        Открыть терминальный интерфейс
  version    Показать версию CLI

Опции:
  -h, --help       Показать справку
  -v, --version    Показать версию
  -p, --prompt <text>  Выполнить один запрос без открытия TUI
  --memory-bench   С --prompt включает автоматическое извлечение Memory и ожидание перед выходом (требуется включённая Memory)
  --browser-use <mode> Включить бэкенд Browser Use (поддерживается: headless)
  --surface <surface>  Поверхность вывода для headless-запросов/app-server: terminal или desktop
  --browser-executable <path> Исполняемый файл Chrome/Chromium для headless Browser Use
  --attach <path>  Прикрепить локальный файл к --prompt; повторите для нескольких файлов
  --cwd <path>     Выполнить команду из указанной директории
  --disallowed-tools, --disallowedTools <tools...>
    Полностью убрать инструменты только для текущего запроса/сеанса TUI; сохранённые настройки не меняются.
    Имена инструментов через запятую или пробел, например "Bash Edit".
    "Bash(git *)" убирает весь Bash; шаблоны команд не сопоставляются.
  --force-mcs      Принудительное системное проецирование в середине диалога для провайдеров Anthropic
  --locale <locale>  Локаль интерфейса: en-US, zh-CN или auto
  --mode <mode>    Режим разрешений для запросов: build, edit, plan или yolo (по умолчанию yolo для --prompt)
  --resume <sessionId>  Возобновить сохранённый сеанс по sessionId (sess_...)
  --target <text>  Выполнить или задать цель сеанса в headless-режиме
  --target-replace Заменить любую существующую цель сеанса, заданную --target
  -c, --continue        Возобновить последний сеанс для текущей директории
  --json           Выводить машиночитаемый JSON там, где поддерживается
  --no-browser     Вывести OAuth URL без открытия браузера
  --no-color       Отключить цвета ANSI
  --verbose        Выводить дополнительные диагностические данные

Слэш-команды:
  /help [command]       Показать справку по слэш-командам
  /login                Выбрать вход через Z.AI или BigModel в браузере
  /logout               Удалить общие учётные данные Z.AI
  /compact [instructions]  Сжать текущий диалог
  /expert [status|resume|stop|<task>]  Запустить экспертный процесс или управлять им
  /dwf [list|cancel|resume]  Показать, отменить или возобновить динамические запуски процессов
  /fork [latest|checkpointId]  Создать новый сеанс из контрольной точки рабочей области
  /mcp [list|status|connect|disconnect]  Показать серверы MCP или управлять ими
  /mode [mode]          Показать или сменить режим разрешений: build, edit, plan или yolo
  /model [id]           Показать или сменить модель текущего сеанса
  /new                  Начать новый сеанс в TUI
  /resume [sessionId]   Возобновить сеанс по sessionId; без него — последний в cwd
  /rewind [latest|checkpointId]  Показать последнюю контрольную точку или восстановить файлы рабочей области
  /skill [name] [task]  Показать навыки или принудительно загрузить навык для следующего запроса
  /goal [action]        Показать или задать цель текущего сеанса
`,
  },
  tui: {
    copy: {
      copied: "Выделенный текст скопирован в буфер обмена.",
      failed: "Не удалось скопировать выделенный текст.",
      unavailable: "Копирование текста в буфер обмена недоступно в этом терминале.",
    },
    effort: {
      disabled: "отключено",
      enabled: "включено",
    },
    input: {
      activeStatusHint: "esc для прерывания",
      busyPlaceholder: "Введите текст для добавления в очередь",
      placeholder: "Введите запрос",
      queuedMore: (count) => `+ ещё ${count} в очереди`,
      queuedSubmitHint: "Отправлено после следующего вызова инструмента.",
      queuedTitle: (count) => ` Очередь (${count}) `,
      title: "Ввод",
      noHistorySource: "Источник истории ввода не настроен.",
      noPreviousInput: "Нет предыдущего ввода для этого проекта.",
      restoredPreviousInput: "Предыдущий ввод восстановлен.",
      restoredPreviousInputWithAttachments: (count) =>
        `Предыдущий ввод восстановлен с ${count} вложением(ями).`,
      restorePreviousInputFailed: "Не удалось восстановить предыдущий ввод.",
      typePrompt: "Введите вопрос и нажмите Enter.",
    },
    loginRequired: {
      help: "Используйте /model, чтобы посмотреть модели, или /login, чтобы подключить аккаунт Coding Plan.",
      message: "Нет доступных моделей. Настройте провайдера или войдите через /login.",
      status: "Нет доступных моделей. Настройте провайдера или войдите через /login.",
      title: "требуется настройка модели",
    },
    loginSetup: {
      emptyMessage: "Варианты входа недоступны.",
      help: "Используйте Up/Down для выбора, Enter для подтверждения.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Введите BigModel Coding Plan API Key",
          inputSecondary: "Вставьте ключ сюда. Он скрыт при вводе.",
          primary: "API-ключ BigModel Coding Plan",
          secondary: "Вставьте ключ Coding Plan API вручную.",
        },
        bigmodelOauth: {
          pendingPrimary: "Ожидание авторизации BigModel",
          pendingSecondary:
            "Завершите вход в браузере. Авторизация определяется автоматически.",
          primary: "Тариф BigModel Coding Plan",
          secondary: "Открыть вход в браузере; авторизация определяется автоматически.",
        },
        zaiApiKey: {
          inputPrimary: "Введите Z.AI Coding Plan API Key",
          inputSecondary: "Вставьте ключ сюда. Он скрыт при вводе.",
          primary: "API-ключ Z.AI Coding Plan",
          secondary: "Вставьте ключ Coding Plan API вручную.",
        },
        zaiOauth: {
          pendingPrimary: "Ожидание авторизации Z.AI",
          pendingSecondary:
            "Завершите вход в браузере. Продолжу после завершения авторизации.",
          primary: "Z.AI Coding Plan",
          secondary: "Откройте вход в браузере и создайте API-ключ Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Вход отменён. Выберите способ настройки.",
        help: "Esc отменяет и возвращает к вариантам настройки.",
        status: "Ожидание авторизации в браузере...",
      },
      input: {
        cancelStatus: "Ввод API-ключа отменён. Выберите способ настройки.",
        clearStatus: "Поле API-ключа очищено.",
        emptyStatus: "Требуется API-ключ.",
        help: "Enter сохраняет ключ. Esc возвращает к вариантам настройки.",
        placeholder: "Вставьте API-ключ",
        status: "Введите API-ключ, затем нажмите Enter.",
        submitStatus: "Сохранение API-ключа...",
      },
      prompt: "Выберите способ настройки: вход или API-ключ.",
      response: "Выберите, как настроить провайдера Coding Plan.",
      title: "Настроить Coding Plan",
    },
    model: {
      requestFailed: (message) => `Запрос к модели не удался: ${message}`,
      responseReceived: "Ответ модели получен.",
      responseReceivedWithTokens: (tokens) => `Ответ модели получен. ${tokens} токенов.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Повтор запроса к модели ${attempt}/${Math.max(1, maxAttempts - 1)} через ${delay}: ${reason}`,
      streamStalled: "Поток модели прерван.",
    },
    sidebar: {
      subagents: {
        title: "Субагенты",
        empty: "Субагентов пока нет.",
        emptyOutput: "Вывода пока нет.",
        back: "← Основной диалог",
        readonly: "Только чтение · Esc для возврата",
        loading: "Загрузка вывода субагента...",
        unavailable: "Вывод субагента недоступен.",
        retry: "Повторить",
        more: "Загрузить ещё",
        pendingMain: "Основной диалог требует вашего ответа — вернитесь, чтобы ответить",
        ended: (count) => `Завершено (${count})`,
        status: {
          running: "работает",
          waiting: "ожидает",
          blocked: "заблокирован",
          success: "завершено",
          failed: "ошибка",
          cancelled: "отменено",
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
        cacheReadWrite: "Кэш чт/з",
        inputOutput: "I/O",
        reason: "Причина",
        tokens: "Токены",
        used: "Использовано",
        window: "Окно",
      },
      modifiedFiles: {
        empty: "Изменений файлов пока нет.",
        more: (count) => `+${count} ещё`,
      },
      mcp: {
        empty: "Серверы MCP не настроены.",
        loadFailed: "Статус MCP недоступен.",
        loading: "Загрузка статуса MCP...",
        more: (count) => `+${count} ещё`,
        servers: "Серверы",
        status: {
          connected: "подключён",
          connecting: "подключение",
          disabled: "отключён",
          disconnected: "не подключён",
          failed: "ошибка",
          untrusted: "недоверенный",
        },
        summary: ({ connected, total }) => `${connected}/${total} подключено`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "завершено",
        error: "ошибка",
        errorWithStatus: (statusCode) => `ошибка ${statusCode}`,
        pending: "в ожидании",
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
        thought: "Размышление",
        trace: "Трассировка",
        turn: "Ход",
        workspace: "Рабочая область",
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
        more: (count) => `+${count} ещё`,
        progress: "Прогресс",
      },
    },
    status: {
      compactFailed: "Не удалось сжать контекст.",
      compacted: "Диалог уплотнён.",
      compacting: "Сжатие контекста...",
      interruptedStreamDiscarded: "Прерванный поток модели отброшен.",
      modelCalling: "Запрос к модели...",
      permissionRequested: (toolName) => `Запрошено разрешение на ${toolName}.`,
      permissionResolved: (toolName) => `Разрешение на ${toolName} получено.`,
      ready: "Готово.",
      recoveringStream: "Восстановление прерванного потока модели...",
      retryingStream: "Повтор потока модели...",
      sessionResumed: "Сеанс возобновлён.",
      targetChanged: (action) => `Цель: ${action}.`,
      thinking: "Размышление...",
      toolCompleted: (toolName) => `Инструмент ${toolName} завершён.`,
      toolFailed: (toolName) => `Инструмент ${toolName} завершился с ошибкой.`,
      toolPending: (toolName) => `Инструмент ${toolName} в ожидании.`,
      toolRunning: (toolName) => `Инструмент ${toolName} выполняется.`,
      turnFailed: "Ход не удался.",
    },
    terminal: {
      requiresInteractive: "TUI требует интерактивный терминал.",
      starting: "Запуск ZCode... Ctrl+C для выхода",
    },
    transcript: {
      compact: {
        completed: "Контекст сжат",
        failed: "Не удалось сжать контекст",
        interrupted: "Сжатие контекста прервано",
        retry: (command) => `Ctrl-R — повторить ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Повтор сжатия контекста (${attempt}/${maxAttempts})`
            : "Повтор сжатия контекста",
        skipped: "Контекст актуален; сжатие не требуется",
        started: "Сжатие контекста",
      },
      roles: {
        agent: "Агент",
        system: "Система",
        user: "Пользователь",
      },
      thought: {
        complete: "Мысль",
        thinking: "Размышление...",
      },
      title: "Транскрипт",
      workflow: {
        actors: "участники:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `расход: ${spentTokens} токенов`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Процесс ${label} — ${status} (${nodesSettled}/${nodesTotal} шагов)`,
        error: (message) => `ошибка: ${message}`,
        expandHint: "+ развернуть",
        collapseHint: "- свернуть",
        log: "лог:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} шагов завершено`,
        result: (preview) => `результат: ${preview}`,
        status: {
          completed: "завершено",
          errored: "ошибка",
          pending: "в очереди",
          running: "выполняется",
          stopped: "остановлено",
        },
        stopReason: {
          user: "вами",
          model: "агентом",
          provider: "ошибка модели",
          interrupted: "процесс завершён",
          superseded: "заменён исправленным запуском",
        },
        truncated: "(сокращено — полная история в журнале запуска)",
        interruptedNotice: ({ label, runId }) =>
          `Процесс ${label} прерван, можно продолжить: /dwf resume ${runId}`,
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
      empty: "Нет подходящих путей рабочей области.",
      loading: "Загрузка путей рабочей области...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Файлы",
    },
    slash: {
      title: "Команды",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
