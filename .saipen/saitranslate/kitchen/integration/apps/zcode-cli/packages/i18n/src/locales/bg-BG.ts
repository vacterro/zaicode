import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "bg-BG",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Неподдържана стойност на --locale: ${value}. Поддържани локали: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Употреба:
  zcode [command] [options]

Без команда zcode отваря пълноекранния TUI.

Команди:
  app-server Стартира ZCode Protocol stdio app сървъра
  commands   Изброява персонализираните slash команди (\`commands list\`)
  doctor     Проверява допусканията за runtime и пакетиране
  login [zai|bigmodel]  Вход чрез браузърна оторизация
  logout     Премахва споделените Z.AI входни данни
  plugins    Управлява плъгини и marketplace-и (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; псевдоним: plugin)
  skills     Изброява локалните skills (\`skills list\`)
  tui        Отваря терминалния интерфейс
  version    Отпечатава версията на CLI

Опции:
  -h, --help       Показва помощта
  -v, --version    Показва версията
  -p, --prompt <text>  Изпълнява един prompt, без да отваря TUI
  --memory-bench   С --prompt включва автоматично извличане на памет и изчакване преди изход (изисква Memory)
  --browser-use <mode> Активира Browser Use бекенда (поддържа се: headless)
  --surface <surface>  Поверхност на представяне за headless prompt-и/app-server: terminal или desktop
  --browser-executable <path> Изпълним файл Chrome/Chromium за headless Browser Use
  --attach <path>  Прикачва локален файл към --prompt; повторете за няколко файла
  --cwd <path>     Изпълнява тази команда от зададената директория
  --disallowed-tools, --disallowedTools <tools...>
    Премахва цели инструменти само за този prompt/TUI; запазените настройки не се променят.
    Имена на инструменти, разделени със запетая или интервал, напр. "Bash Edit".
    "Bash(git *)" премахва целия Bash; шаблони на команди не се сравняват.
  --force-mcs      Принуждава междинно системно проектиране за Anthropic доставчици
  --locale <locale>  Локал на интерфейса: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR или auto
  --mode <mode>    Режим на разрешения за prompt-и: build, edit, plan или yolo (по подразбиране yolo за --prompt)
  --resume <sessionId>  Възобновява запазена сесия по sessionId (sess_...)
  --target <text>  Изпълнява или задава целта на сесията в headless режим
  --target-replace Заменя съществуваща цел на сесията, зададена от --target
  -c, --continue        Възобновява последната сесия за текущата директория
  --json           Отпечатава машинно четим JSON, където се поддържа
  --no-browser     Отпечатава OAuth URL, без да отваря браузър
  --no-color       Изключва ANSI цветовете
  --verbose        Отпечатава допълнителни диагностични данни

Slash команди:
  /help [command]       Показва помощта за slash команди
  /login                Избира Z.AI или BigModel вход в браузъра
  /logout               Премахва споделените Z.AI входни данни
  /compact [instructions]  Компактира текущия разговор
  /expert [status|resume|stop|<task>]  Изпълнява или управлява експертния workflow
  /dwf [list|cancel|resume]  Изброява, отменя или възобновява динамични изпълнения на workflow
  /fork [latest|checkpointId]  Създава нова сесия от checkpoint на workspace
  /mcp [list|status|connect|disconnect]  Показва или управлява MCP сървъри
  /mode [mode]          Показва или сменя режима на разрешения: build, edit, plan или yolo
  /model [id]           Показва или сменя модела на текущата сесия
  /new                  Стартира нова сесия в TUI
  /resume [sessionId]   Възобновява сесия по sessionId; пропуснете за последната в cwd
  /rewind [latest|checkpointId]  Показва последния checkpoint или възстановява файловете на workspace
  /skill [name] [task]  Изброява skills или принуждава следващия prompt да зареди един
  /goal [action]        Показва или задава целта на текущата сесия
`,
  },
  tui: {
    copy: {
      copied: "Избраният текст е копиран в клипборда.",
      failed: "Избраният текст не можа да бъде копиран.",
      unavailable: "Копирането на текст не е налично в този терминал.",
    },
    effort: {
      disabled: "изключено",
      enabled: "включено",
    },
    input: {
      activeStatusHint: "esc за прекъсване",
      busyPlaceholder: "Въведете текст, за да го добавите в опашката",
      placeholder: "Въведете prompt",
      queuedMore: (count) => `+ още ${count} в опашката`,
      queuedSubmitHint: "Изпратено след следващото извикване на инструмент.",
      queuedTitle: (count) => ` Опашка (${count}) `,
      title: "Вход",
      noHistorySource: "Не е конфигуриран източник на история на въвода.",
      noPreviousInput: "Няма предишен вход за този проект.",
      restoredPreviousInput: "Възстановен предишен вход.",
      restoredPreviousInputWithAttachments: (count) =>
        `Възстановен предишен вход с ${count} прикачени файл(а).`,
      restorePreviousInputFailed: "Неуспешно възстановяване на предишния вход.",
      typePrompt: "Въведете въпрос и натиснете Enter.",
    },
    loginRequired: {
      help: "Използвайте /model, за да видите моделите, или /login, за да свържете Coding Plan акаунт.",
      message: "Няма налични модели. Конфигурирайте доставчик или влезте с /login.",
      status: "Няма налични модели. Конфигурирайте доставчик или влезте с /login.",
      title: "необходима е настройка на модел",
    },
    loginSetup: {
      emptyMessage: "Няма налични опции за вход.",
      help: "Използвайте Up/Down за избор, Enter за потвърждение.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Въведете BigModel Coding Plan API ключ",
          inputSecondary: "Поставете ключа тук. Скрит е по време на въвеждане.",
          primary: "BigModel Coding Plan API ключ",
          secondary: "Поставете ръчно API ключ за Coding Plan.",
        },
        bigmodelOauth: {
          pendingPrimary: "Изчакване на оторизация от BigModel",
          pendingSecondary:
            "Завършете входа в браузъра. Оторизацията се разпознава автоматично.",
          primary: "BigModel Coding Plan",
          secondary: "Отваряне на вход в браузъра; оторизацията се разпознава автоматично.",
        },
        zaiApiKey: {
          inputPrimary: "Въведете Z.AI Coding Plan API ключ",
          inputSecondary: "Поставете ключа тук. Скрит е по време на въвеждане.",
          primary: "Z.AI Coding Plan API ключ",
          secondary: "Поставете ръчно API ключ за Coding Plan.",
        },
        zaiOauth: {
          pendingPrimary: "Изчакване на оторизация от Z.AI",
          pendingSecondary:
            "Завършете входа в браузъра. Ще продължа след завършване на оторизацията.",
          primary: "Z.AI Coding Plan",
          secondary: "Влезте през браузър и създайте API ключ за Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Входът е отменен. Изберете метод за настройка.",
        help: "Esc отменя и връща към избора за настройка.",
        status: "Чакане на оторизация в браузъра...",
      },
      input: {
        cancelStatus: "Въвеждането на API ключа е отменено. Изберете метод за настройка.",
        clearStatus: "API ключът е изчистен.",
        emptyStatus: "API ключът е задължителен.",
        help: "Enter запазва ключа. Esc връща към избора за настройка.",
        placeholder: "Поставяне на API ключ",
        status: "Въведете API ключа и натиснете Enter.",
        submitStatus: "Запазване на API ключа...",
      },
      prompt: "Изберете метод за настройка: вход или API ключ.",
      response: "Изберете как да настроите доставчик на Coding Plan.",
      title: "Настройка на Coding Plan",
    },
    model: {
      requestFailed: (message) => `Заявката към модела е неуспешна: ${message}`,
      responseReceived: "Отговорът на модела е получен.",
      responseReceivedWithTokens: (tokens) => `Отговорът на модела е получен. ${tokens} токена.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Повторен опит за заявката към модела ${attempt}/${Math.max(1, maxAttempts - 1)} след ${delay}: ${reason}`,
      streamStalled: "Потокът от модела е спрял.",
    },
    sidebar: {
      subagents: {
        title: "Подагенти",
        empty: "Още няма подагенти.",
        emptyOutput: "Още няма изход.",
        back: "← Основен разговор",
        readonly: "Само за четене · Esc за връщане",
        loading: "Зареждане на изхода на подагент...",
        unavailable: "Изходът на подагента е недостъпен.",
        retry: "Повтори",
        more: "Зареди още",
        pendingMain: "Основният разговор изисква ваш отговор — върнете се, за да отговорите",
        ended: (count) => `Приключи (${count})`,
        status: {
          running: "работи",
          waiting: "чака",
          blocked: "блокиран",
          success: "завършен",
          failed: "неуспешен",
          cancelled: "отменен",
          lost: "загубен",
        },
      },
      api: {
        empty: "Още няма API извиквания.",
        model: "Модел",
        more: (count) => `+${count} още`,
        requests: "Заявки",
        server: "Сървър",
      },
      cache: {
        hit: "попадания",
        lastHit: "последно попадение",
        lastMiss: "последен пропуск",
        readWrite: ({ read, write }) => `${read} четеж / ${write} запис`,
        total: "общо",
      },
      context: {
        cache: "Кеш",
        cacheReadWrite: "Кеш Ч/З",
        inputOutput: "I/O",
        reason: "Причина",
        tokens: "Токени",
        used: "Използвано",
        window: "Прозорец",
      },
      modifiedFiles: {
        empty: "Още няма промени в файлове.",
        more: (count) => `+${count} още`,
      },
      mcp: {
        empty: "Няма конфигурирани MCP сървъри.",
        loadFailed: "Състоянието на MCP е недостъпно.",
        loading: "Зареждане на състоянието на MCP...",
        more: (count) => `+${count} още`,
        servers: "Сървъри",
        status: {
          connected: "свързан",
          connecting: "свързване",
          disabled: "изключен",
          disconnected: "прекъснат",
          failed: "неуспешно",
          untrusted: "недоверен",
        },
        summary: ({ connected, total }) => `${connected}/${total} свързани`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "завършено",
        error: "грешка",
        errorWithStatus: (statusCode) => `грешка ${statusCode}`,
        pending: "чакащо",
      },
      status: {
        last: "Последни",
      },
      run: {
        draft: "Чернови",
        draftChars: (count) => `${count} знака`,
        draftEmpty: "празно",
        messages: "Съобщения",
        mode: "Режим",
        model: "Модел",
        provider: "Доставчик",
        thought: "Мисъл",
        trace: "Следа",
        turn: "Ход",
        workspace: "Работна област",
      },
      sections: {
        apis: "API",
        context: "Контекст",
        mcp: "MCP",
        modifiedFiles: "Променени файлове",
        run: "Изпълнение",
        status: "Състояние",
        todos: "Задачи",
      },
      shellSubtitle: "OpenTUI обвивка",
      title: "Странична лента",
      todos: {
        empty: "Няма задачи още.",
        more: (count) => `+${count} още`,
        progress: "Напредък",
      },
    },
    status: {
      compactFailed: "Компресирането на контекста е неуспешно.",
      compacted: "Разговорът е компресиран.",
      compacting: "Компресиране на контекста...",
      interruptedStreamDiscarded: "Прекъснатият поток на модела е отхвърлен.",
      modelCalling: "Извикване на модел...",
      permissionRequested: (toolName) => `Поискано е разрешение за ${toolName}.`,
      permissionResolved: (toolName) => `Разрешението за ${toolName} е решено.`,
      ready: "Готово.",
      recoveringStream: "Възстановяване на прекъснатия поток на модела...",
      retryingStream: "Опит за повторение на потока на модела...",
      sessionResumed: "Сесията е възобновена.",
      targetChanged: (action) => `Цел ${action}.`,
      thinking: "Мислене...",
      toolCompleted: (toolName) => `Инструментът ${toolName} е завършил.`,
      toolFailed: (toolName) => `Инструментът ${toolName} е неуспешен.`,
      toolPending: (toolName) => `Инструментът ${toolName} е в изчакване.`,
      toolRunning: (toolName) => `Инструментът ${toolName} се изпълнява.`,
      turnFailed: "Ходът е неуспешен.",
    },
    terminal: {
      requiresInteractive: "TUI изисква интерактивен терминал.",
      starting: "Стартиране на ZCode... Ctrl+C за изход",
    },
    transcript: {
      compact: {
        completed: "Контекстът е компресиран",
        failed: "Компресирането на контекста е неуспешно",
        interrupted: "Компресирането на контекста е прекъснато",
        retry: (command) => `Ctrl-R за повторен опит на ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Повторно опитване за компресиране на контекста (${attempt}/${maxAttempts})`
            : "Повторно опитване за компресиране на контекста",
        skipped: "Контекстът е актуален; компресиране не е необходимо",
        started: "Компресиране на контекста",
      },
      roles: {
        agent: "Агент",
        system: "Система",
        user: "Потребител",
      },
      thought: {
        complete: "Мисъл",
        thinking: "Мислене...",
      },
      title: "Транскрипт",
      workflow: {
        actors: "участници:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `използване: ${spentTokens} токена`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Работен процес ${label} - ${status} (${nodesSettled}/${nodesTotal} стъпки)`,
        error: (message) => `грешка: ${message}`,
        expandHint: "+ за разгъване",
        collapseHint: "- за сгъване",
        log: "лог:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} стъпки приключиха`,
        result: (preview) => `резултат: ${preview}`,
        status: {
          completed: "завършено",
          errored: "с грешка",
          pending: "в очакване",
          running: "изпълнява се",
          stopped: "спряно",
        },
        stopReason: {
          user: "от вас",
          model: "от агента",
          provider: "моделна грешка",
          interrupted: "процесът е излязъл",
          superseded: "заменено от коригиран старт",
        },
        truncated: "(съкратено - пълната история е в дневника на старта)",
        interruptedNotice: ({ label, runId }) =>
          `Работният процес ${label} беше прекъснат и може да бъде продължен: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter избира, Esc отменя",
      disabled: (reason) => ` [деактивирано: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `филтър: ${filter || "-"} | ${help ?? "Enter избира, Esc отменя"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Няма съвпадащи пътища в работната папка.",
      loading: "Зареждане на пътищата в работната папка...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Файлове",
    },
    slash: {
      title: "Команди",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
