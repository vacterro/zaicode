# Ставим ZAICODE

ZAICODE — три проекта, работающих как одно: приложение ZAICODE, SAIPEN (протокол, который держит работу агентов в узде) и SAIMAIL (почта, которой агенты пользуются, чтобы говорить друг с другом). Ставить руками — значит три клона, тулчейн Node.js, окружение Python и сборка. Установщик делает всё это сам: запустил, подождал — ярлык ZAICODE на рабочем столе.

## Один клик

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  скачал, открыл двойным щелчком, жмёшь **INSTALL**. Окно (золото на тёмном,
  баннер SAIPEN) показывает каждый шаг по ходу дела, сколько времени прошло и
  по требованию — лог; в конце **START ZAICODE**, а если шаг не прошёл —
  **TRY AGAIN** / **Autotroubleshoot** / **Open log**. Если указать уже
  готовую папку ZAICODE, кнопка будет **UPDATE**: тот же прогон и обновит, и
  починит. В exe лежат скрипты установки, рядом ничего не нужно; собирает его
  `install\setup\build.cmd` (компилятор .NET Framework, он есть в любых Windows 10/11).
- `install\Setup-ZAICODE.cmd` (двойной щелчок): та же установка, но в консоли.
- С нуля, через PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Параметры установки: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (папка из пресета),
`/auto` (стартует сразу), `/quiet` (без окна: консольный установщик, код выхода
= результат). Первый запуск собирает приложение на этой машине, это долго;
дальше только обновление и починка.

## Бесплатные модели, настраивать нечего

В приложении уже свой 9router. На машине без него ZAICODE запускает его приватно (изолированный режим, порт 20138), наполняет **SAIFREN** из бесплатных уровней без ключа и ставит `SAIRoute / SAIFREN` моделью новых задач — так что первая задача в New task сразу получает ответ: без ключа, без аккаунта, без настроек. Входы в Claude Code, Codex и Antigravity необязательны; логин, который на машине не настраивали, светится как «необязательно, войдите когда угодно», а не как «требует вас». Проверка: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>` запускает собранное приложение на пустом профиле (свои HOME, APPDATA и LOCALAPPDATA) и проходит только когда роутер изолирован, SAIFREN отвечает на пробу первого токена, а задача в New task получает ответ.

## Обновления: четыре части, один ZAICODE

Воркспейс (лаунчер, установщик), приложение, SAIPEN и SAIMAIL — четыре клона. Каждый обновляется сам: **Settings -> ZAICODE -> Updates** показывает их с версией и коммитом, обновляет по одному или все сразу, а переключатель «сам» есть у каждой части (в установленном ZAICODE включён, в дев-чекауте выключен). ZAICODE заглядывает через пару минут после старта, потом раз в шесть часов. После обновления каждая часть получает своё: приложение — зависимости (когда `pnpm-lock.yaml` сдвинулся) и новую сборку (готовится, пока ZAICODE работает, подставляется при следующем запуске), SAIPEN — свой лаунчер, SAIMAIL — свою установку `.venv`, воркспейс — новый корневой лаунчер. Клон на другой ветке, с локальными коммитами или правками, которые обновление затёрло бы, отмечается и остаётся ровно как есть.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Что делает установщик

Установщик — это проверки Autotroubleshoot с режимом «repair» на пустой
папке, в таком порядке. Каждый шаг идемпотентен, так что повторный запуск обновляет
установку и чинит сломанное.

| Проверка | Починка |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | берёт копию с машины, если подходит; иначе приватную копию в `.tools\` (MinGit из Git for Windows, Node.js 24.14.0 с nodejs.org, Python из его пакета NuGet). Прав админа не надо. |
| pnpm | закреплённый pnpm 10.33.2 в `.tools\pnpm10` |
| Воркспейс ZAICODE | клон `vacterro/zaicode`, ветка `master` (исходники лаунчера, установщик, доки; память разработчика `.saipen/` не входит; ветка `workspace` до 2026-09-27) |
| Исходники приложения ZAICODE | клон ветки `zaicode` в `zcode\` |
| SAIPEN | клон `vacterro/saipen` в `saipen\`; его `bin\saipen.cmd` написан под этот клон и этот Python |
| SAIMAIL | клон `vacterro/saimail` в `saimail\`, установка в `.venv\` |
| saimail-local | командный клиент SAIMAIL, им пользуются панели SAIMAIL в ZAICODE (есть с SAIMAIL `0.0.2a3`; проверка `saimail-cli` отдаёт OK) |
| Пакет 9router | `9router` из npm в `.tools\router`, в комплекте, чтобы SAIFREN работал вообще без настроек (WARN, если npm до него не достаёт) |
| Зависимости приложения | `pnpm install --frozen-lockfile` (и снова при смене `pnpm-lock.yaml`) |
| Сборка приложения | `pnpm bundle:zaicode`; пока ZAICODE работает, новая сборка готовится и подменяется при следующем запуске |
| Подмена готовой сборки | чистит `win-unpacked.previous`, оставшийся после сбоя подмены по длинным путям, и подставляет ждущую сборку, пока ZAICODE закрыт |
| Корневой лаунчер | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Ярлыки | Рабочий стол и меню «Пуск»: `ZAICODE` -> `ZAICODE.exe` |
| Входы Claude / Codex | только отчёт: каждый логин `~\.claude*` / `~\.codex*` — свой движок в ZAICODE (A1, A2, C1, ...); для логина нужен вы, в браузере |

Корневой лаунчер указывает ZAICODE на установленный SAIPEN (`saipen\`) и ставит
`.tools\` и `.venv\Scripts` первыми в PATH приложения, так что приложение, его агенты
и воркеры берут установленные копии.

## Несколько подписок

Каждый вход Claude Code или Codex живёт в своём home: `~\.claude`,
`~\.claude-account2`, ... и `~\.codex`, `~\.codex-account2`, ... ZAICODE находит
их все. Заготовить больше при установке:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Установщик создаёт эти home'ы и печатает точную команду входа для каждого
(`$env:CODEX_HOME = '...'; codex login`). То же самое есть в ZAICODE: Настройки ->
Движки и лимиты -> добавить ещё вход.

## Автопочинка

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Статус по каждой проверке: OK, FIXED (было сломано, починили), WARN (работает, но кое-что
опциональное отсутствует), INFO (нужен ты: вход), FAIL. Логи в
`install\logs\`; сводка последней установки — `install\install-report.json`.
В приложении Роутер -> Автопочинка чинит текущий роутер и пулы.

## Параметры

| Параметр | По умолчанию | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | куда всё ставится |
| `-ShortcutDir` | Desktop | куда кладётся ярлык ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | пропустить эти ярлыки |
| `-PortableTools` | | свои Git / Node.js / Python, даже если на машине они уже есть |
| `-Launch` | | запустить ZAICODE после установки |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | репозитории GitHub | другой источник (форк, локальный путь к клону) |

## Проверка

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
берёт свежую установку, подсовывает поломки (ярлык и лаунчер удалены, лаунчер SAIPEN
указывает на отсутствующий Python, venv SAIMAIL удалён, node_modules
от другого lockfile, остался build-каталог глубже MAX_PATH),
требует, чтобы доктор нашёл и починил каждую, потом запускает цель ярлыка
с изолированным профилем и гасит ровно то дерево процессов, которое сам же и запустил.

`install\tests\Test-ZaicodeUpdate.ps1` собирает четыре одноразовых репозитория на
диске и устанавливает их клоны, потом доказывает: проверка ничего не меняет,
одна часть обновляется сама вместе со своим хвостом (лаунчер SAIPEN,
корневой лаунчер), пересекающиеся локальные правки и локальные коммиты остаются,
а неизвестное имя части отклоняется. Без сети.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
