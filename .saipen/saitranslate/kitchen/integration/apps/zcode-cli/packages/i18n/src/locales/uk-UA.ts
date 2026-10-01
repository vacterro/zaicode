import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "uk-UA",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Непідтримуване значення --locale: ${value}. Підтримувані локалі: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Використання:
  zcode [command] [options]

Без команди zcode відкриває повноекранний TUI.

Команди:
  app-server Запустити stdio app server протоколу ZCode
  commands   Список власних slash-команд (\`commands list\`)
  doctor     Перевірити припущення середовища й пакування
  login [zai|bigmodel]  Увійти через браузерну авторизацію
  logout     Видалити спільні облікові дані Z.AI
  plugins    Керувати плагінами та маркетплейсами (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Список локальних навичок (\`skills list\`)
  tui        Відкрити термінальний UI
  version    Вивести версію CLI

Опції:
  -h, --help       Показати довідку
  -v, --version    Показати версію
  -p, --prompt <text>  Виконати один запит без відкриття TUI
  --memory-bench   З --prompt увімкнути автоматичне витягування Memory і зачекати перед виходом (потрібно увімкнено Memory)
  --browser-use <mode> Увімкнути бекенд Browser Use (підтримується: headless)
  --surface <surface>  Поверхня відображення для headless-запитів/app-server: terminal або desktop
  --browser-executable <path> Виконуваний файл Chrome/Chromium для headless Browser Use
  --attach <path>  Прикріпити локальний файл до --prompt; повторюйте для кількох файлів
  --cwd <path>     Виконати цю команду з вказаної директорії
  --disallowed-tools, --disallowedTools <tools...>
    Прибрати інструменти повністю лише для цього запуску запиту/TUI; збережені налаштування не змінюються.
    Назви інструментів через кому або пробіл, напр. "Bash Edit".
    "Bash(git *)" прибирає весь Bash; шаблони команд не збігаються.
  --force-mcs      Примусова системна проєкція посеред розмови для провайдерів Anthropic
  --locale <locale>  Локаль UI: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR або auto
  --mode <mode>    Режим дозволів для запитів: build, edit, plan або yolo (типово: yolo для --prompt)
  --resume <sessionId>  Відновити збережену сесію за sessionId (sess_...)
  --target <text>  Виконати або задати ціль сесії в headless-режимі
  --target-replace Замінити будь-яку наявну ціль сесії, задану --target
  -c, --continue        Відновити останню сесію для поточного каталогу
  --json           Вивести машинозчитний JSON, де підтримується
  --no-browser     Вивести OAuth URL без відкриття браузера
  --no-color       Вимкнути кольори ANSI
  --verbose        Вивести додаткові діагностичні деталі

Slash-команди:
  /help [command]       Показати довідку slash-команд
  /login                Вибрати вхід у браузері Z.AI або BigModel
  /logout               Видалити спільні облікові дані Z.AI
  /compact [instructions]  Стиснути поточну розмову
  /expert [status|resume|stop|<task>]  Виконати експертний workflow або керувати ним
  /dwf [list|cancel|resume]  Список динамічних запусків workflow, скасування або відновлення
  /fork [latest|checkpointId]  Створити нову сесію з workspace checkpoint
  /mcp [list|status|connect|disconnect]  Показати або керувати MCP-серверами
  /mode [mode]          Показати або змінити режим дозволів: build, edit, plan або yolo
  /model [id]           Показати або змінити модель поточної сесії
  /new                  Почати нову сесію в TUI
  /resume [sessionId]   Відновити сесію за sessionId; без нього — останню в cwd
  /rewind [latest|checkpointId]  Показати останній checkpoint або відновити файли workspace
  /skill [name] [task]  Список навичок або примусово завантажити навичку для наступного запиту
  /goal [action]        Показати або задати ціль поточної сесії
`,
  },
  tui: {
    copy: {
      copied: "Вибраний текст скопійовано в буфер обміну.",
      failed: "Не вдалося скопіювати вибраний текст.",
      unavailable: "Копіювання тексту в буфер обміну недоступне в цьому терміналі.",
    },
    effort: {
      disabled: "вимкнено",
      enabled: "увімкнено",
    },
    input: {
      activeStatusHint: "esc для переривання",
      busyPlaceholder: "Введіть текст у чергу",
      placeholder: "Введіть запит",
      queuedMore: (count) => `+ ще ${count} у черзі`,
      queuedSubmitHint: "Надіслано після наступного виклику інструмента.",
      queuedTitle: (count) => ` Черга (${count}) `,
      title: "Введення",
      noHistorySource: "Джерело історії введення не налаштовано.",
      noPreviousInput: "Немає попереднього введення для цього проєкту.",
      restoredPreviousInput: "Попереднє введення відновлено.",
      restoredPreviousInputWithAttachments: (count) =>
        `Попереднє введення відновлено з ${count} вкладенням(ями).`,
      restorePreviousInputFailed: "Не вдалося відновити попереднє введення.",
      typePrompt: "Введіть питання та натисніть Enter.",
    },
    loginRequired: {
      help: "Використайте /model, щоб переглянути моделі, або /login, щоб підключити обліковий запис Coding Plan.",
      message: "Немає доступних моделей. Налаштуйте провайдера або увійдіть через /login.",
      status: "Немає доступних моделей. Налаштуйте провайдера або увійдіть через /login.",
      title: "потрібне налаштування моделі",
    },
    loginSetup: {
      emptyMessage: "Немає доступних способів входу.",
      help: "Використовуйте Up/Down для вибору, Enter для підтвердження.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Введіть ключ API BigModel Coding Plan",
          inputSecondary: "Вставте ключ тут. Під час введення він приховано.",
          primary: "Ключ API BigModel Coding Plan",
          secondary: "Вставте ключ API Coding Plan вручну.",
        },
        bigmodelOauth: {
          pendingPrimary: "Очікування авторизації BigModel",
          pendingSecondary:
            "Завершіть вхід у браузері. Авторизація визначається автоматично.",
          primary: "BigModel Coding Plan",
          secondary: "Відкрити вхід у браузері; авторизація визначається автоматично.",
        },
        zaiApiKey: {
          inputPrimary: "Введіть ключ API Z.AI Coding Plan",
          inputSecondary: "Вставте ключ тут. Під час введення він приховано.",
          primary: "Ключ API Z.AI Coding Plan",
          secondary: "Вставте ключ API Coding Plan вручну.",
        },
        zaiOauth: {
          pendingPrimary: "Очікування авторизації Z.AI",
          pendingSecondary:
            "Завершіть вхід у браузері. Я продовжу, коли авторизація завершиться.",
          primary: "Z.AI Coding Plan",
          secondary: "Відкрийте вхід у браузері та створіть ключ API для Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Вхід скасовано. Виберіть метод налаштування.",
        help: "Esc скасовує та повертає до варіантів налаштування.",
        status: "Очікування авторизації в браузері...",
      },
      input: {
        cancelStatus: "Введення ключа API скасовано. Виберіть метод налаштування.",
        clearStatus: "Поле ключа API очищено.",
        emptyStatus: "Ключ API обов'язковий.",
        help: "Enter зберігає ключ. Esc повертає до варіантів налаштування.",
        placeholder: "Вставити ключ API",
        status: "Введіть ключ API, потім натисніть Enter.",
        submitStatus: "Збереження ключа API...",
      },
      prompt: "Виберіть метод налаштування: вхід або ключ API.",
      response: "Виберіть, як налаштувати провайдера Coding Plan.",
      title: "Налаштувати Coding Plan",
    },
    model: {
      requestFailed: (message) => `Запит до моделі не вдався: ${message}`,
      responseReceived: "Відповідь моделі отримано.",
      responseReceivedWithTokens: (tokens) => `Відповідь моделі отримано. ${tokens} токенів.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Повтор запиту до моделі ${attempt}/${Math.max(1, maxAttempts - 1)} через ${delay}: ${reason}`,
      streamStalled: "Потік моделі зупинено.",
    },
    sidebar: {
      subagents: {
        title: "Підагенти",
        empty: "Підагентів ще немає.",
        emptyOutput: "Виводу ще немає.",
        back: "← Головна розмова",
        readonly: "Лише читання · Esc для повернення",
        loading: "Завантаження виводу підагента...",
        unavailable: "Вивід підагента недоступний.",
        retry: "Повторити",
        more: "Завантажити ще",
        pendingMain: "Головна розмова потребує вашої відповіді — поверніться, щоб відповісти",
        ended: (count) => `Завершено (${count})`,
        status: {
          running: "виконується",
          waiting: "очікує",
          blocked: "заблоковано",
          success: "завершено",
          failed: "помилка",
          cancelled: "скасовано",
          lost: "втрачено",
        },
      },
      api: {
        empty: "Викликів API ще немає.",
        model: "Модель",
        more: (count) => `ще +${count}`,
        requests: "Запити",
        server: "Сервер",
      },
      cache: {
        hit: "попадання",
        lastHit: "останнє попадання",
        lastMiss: "останній промах",
        readWrite: ({ read, write }) => `${read} читання / ${write} запис`,
        total: "Усього",
      },
      context: {
        cache: "Кеш",
        cacheReadWrite: "Кеш читання/запису",
        inputOutput: "I/O",
        reason: "Причина",
        tokens: "Токени",
        used: "Використано",
        window: "Вікно",
      },
      modifiedFiles: {
        empty: "Змін файлів ще немає.",
        more: (count) => `ще +${count}`,
      },
      mcp: {
        empty: "Сервери MCP не налаштовано.",
        loadFailed: "Стан MCP недоступний.",
        loading: "Завантаження стану MCP...",
        more: (count) => `ще +${count}`,
        servers: "Сервери",
        status: {
          connected: "підключено",
          connecting: "підключення",
          disabled: "вимкнено",
          disconnected: "від'єднано",
          failed: "не вдалося",
          untrusted: "недовірений",
        },
        summary: ({ connected, total }) => `${connected}/${total} підключено`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "завершено",
        error: "помилка",
        errorWithStatus: (statusCode) => `помилка ${statusCode}`,
        pending: "очікує",
      },
      status: {
        last: "Останній",
      },
      run: {
        draft: "Чернетка",
        draftChars: (count) => `${count} символів`,
        draftEmpty: "порожньо",
        messages: "Повідомлення",
        mode: "Режим",
        model: "Модель",
        provider: "Провайдер",
        thought: "Міркування",
        trace: "Трасування",
        turn: "Раунд",
        workspace: "Робочий простір",
      },
      sections: {
        apis: "API",
        context: "Контекст",
        mcp: "MCP",
        modifiedFiles: "Змінені файли",
        run: "Запуск",
        status: "Стан",
        todos: "Завдання",
      },
      shellSubtitle: "Оболонка OpenTUI",
      title: "Бічна панель",
      todos: {
        empty: "Завдань ще немає.",
        more: (count) => `ще +${count}`,
        progress: "Поступ",
      },
    },
    status: {
      compactFailed: "Не вдалося стиснути контекст.",
      compacted: "Розмову стиснуто.",
      compacting: "Стиснення контексту...",
      interruptedStreamDiscarded: "Перерваний потік моделі відкинуто.",
      modelCalling: "Виклик моделі...",
      permissionRequested: (toolName) => `Дозвіл запитано для ${toolName}.`,
      permissionResolved: (toolName) => `Дозвіл вирішено для ${toolName}.`,
      ready: "Готово.",
      recoveringStream: "Відновлення перерваного потоку моделі...",
      retryingStream: "Повторне отримання потоку моделі...",
      sessionResumed: "Сеанс відновлено.",
      targetChanged: (action) => `Ціль: ${action}.`,
      thinking: "Міркування...",
      toolCompleted: (toolName) => `Інструмент ${toolName} завершено.`,
      toolFailed: (toolName) => `Інструмент ${toolName} не вдалося виконати.`,
      toolPending: (toolName) => `Інструмент ${toolName} в очікуванні.`,
      toolRunning: (toolName) => `Інструмент ${toolName} виконується.`,
      turnFailed: "Раунд не вдалося.",
    },
    terminal: {
      requiresInteractive: "TUI потребує інтерактивного термінала.",
      starting: "Запуск ZCode... Ctrl+C для виходу",
    },
    transcript: {
      compact: {
        completed: "Контекст стиснуто",
        failed: "Не вдалося стиснути контекст",
        interrupted: "Стиснення контексту перервано",
        retry: (command) => `Ctrl-R для повтору: ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Повторне стиснення контексту (${attempt}/${maxAttempts})`
            : "Повторне стиснення контексту",
        skipped: "Контекст актуальний; стиснення не потрібне",
        started: "Стиснення контексту",
      },
      roles: {
        agent: "Агент",
        system: "Система",
        user: "Користувач",
      },
      thought: {
        complete: "Думка",
        thinking: "Міркування...",
      },
      title: "Транскрипт",
      workflow: {
        actors: "учасники:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `використано токенів: ${spentTokens}`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Робочий процес ${label} — ${status} (${nodesSettled}/${nodesTotal} кроків)`,
        error: (message) => `помилка: ${message}`,
        expandHint: "+ — розгорнути",
        collapseHint: "- — згорнути",
        log: "журнал:",
        nodes: ({ nodesSettled, nodesTotal }) => `завершено кроків: ${nodesSettled}/${nodesTotal}`,
        result: (preview) => `результат: ${preview}`,
        status: {
          completed: "завершено",
          errored: "помилка",
          pending: "очікує",
          running: "виконується",
          stopped: "зупинено",
        },
        stopReason: {
          user: "вами",
          model: "агентом",
          provider: "помилка моделі",
          interrupted: "процес завершено",
          superseded: "замінено виправленим запуском",
        },
        truncated: "(обрізано — повна історія в журналі запуску)",
        interruptedNotice: ({ label, runId }) =>
          `Робочий процес ${label} перервано; можна продовжити: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter — вибір, Esc — скасування",
      disabled: (reason) => ` [вимкнено: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `фільтр: ${filter || "-"} | ${help ?? "Enter — вибір, Esc — скасування"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Немає відповідних шляхів робочого простору.",
      loading: "Завантаження шляхів робочого простору...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Файли",
    },
    slash: {
      title: "Команди",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
