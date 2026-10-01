# Встановлення ZAICODE

ZAICODE — це три проєкти, що працюють як одне: застосунок ZAICODE, SAIPEN
(протокол, який тримає роботу агентів під контролем) та SAIMAIL (пошта, якою
агенти спілкуються між собою). Встановлення вручну означає три клони,
інструменти Node.js, середовище Python і збірку. Установник робить усе це:
запустіть, зачекайте — і ярлик ZAICODE на робочому столі.

## Одне клацання

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  завантажте, двічі клацніть, натисніть **INSTALL**. Вікно (золоте на темному,
  з банером SAIPEN) показує кожен крок під час виконання, час, що минув, і журнал
  за потреби; наприкінці — **START ZAICODE** або **TRY AGAIN** / **Autotroubleshoot**
  / **Open log**, якщо якийсь крок не завершився. Якщо вказати на наявну теку ZAICODE,
  кнопка матиме напис **UPDATE**: той самий запуск оновлює та відновлює.
  exe містить скрипти встановлення і не потребує нічого поруч; його збирає
  `install\setup\build.cmd` (компілятор .NET Framework, який є в кожній Windows 10/11).
- `install\Setup-ZAICODE.cmd` (подвійне клацання): те саме встановлення у консолі.
- З нуля, у PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Параметри налаштування: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (тека-пресет),
`/auto` (запускається одразу), `/quiet` (без вікна: консольний інсталятор, код виходу
= результат). Перший запуск збирає застосунок на цій машині, це триває;
надалі лише оновлення та відновлення.

## Безкоштовні моделі, нічого налаштовувати

Застосунок містить власний 9router. На машині без нього ZAICODE запускає його
приватно (ізольований режим, порт 20138), бере **SAIFREN** з безкоштовних безключових
рівнів і робить `SAIRoute / SAIFREN` моделлю нових завдань, тож перше завдання,
введене в New task, одержує відповідь: без ключа, без акаунта, без налаштувань. Входи в
Claude Code, Codex та Antigravity необовʼязкові; вхід, не налаштований на машині,
показується як «необовʼязково, увійдіть будь-коли», а не як пункт «потрібно вас».
Перевірка: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
запускає запакований застосунок на порожньому профілі (власні HOME, APPDATA і
LOCALAPPDATA) і проходить лише тоді, коли роутер ізольований, SAIFREN відповідає на
пробу першого токена, а завдання в New task отримує відповідь.

## Оновлення: чотири частини, один ZAICODE

Робочий простір (лаунчер, інсталятор), застосунок, SAIPEN і SAIMAIL — це чотири клони.
Кожен оновлюється окремо: **Settings -> ZAICODE -> Updates** перелічує їх із версією та
комітом, оновлює по одному або всі разом і має перемикач «самостійно» для кожної
частини (увімкнено за замовчуванням у встановленому ZAICODE, вимкнено в робочій
копії розробника). ZAICODE перевіряє через кілька хвилин після запуску, потім кожні шість
годин. Після оновлення кожна частина отримує своє: застосунок — залежності (коли
`pnpm-lock.yaml` перемістився) і нову збірку (готується, поки ZAICODE працює, запускається
на наступному старті), SAIPEN — свій лаунчер, SAIMAIL — встановлення `.venv`,
робочий простір — новий кореневий лаунчер. Клон на іншій гілці, з локальними
комітами чи з правками, які оновлення перезаписало б, позначається й залишається
без змін.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Що це робить

Інсталятор — це перевірки Autotroubleshoot, запущені з «repair» на порожній теці, у
такому порядку. Кожен крок ідемпотентний, тож повторний запуск оновлює встановлення й
усуває зламане.

| Перевірка | Відновлення |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | використовує копію машини, якщо вона підходить; інакше приватну копію в `.tools\` (MinGit з Git for Windows, Node.js 24.14.0 з nodejs.org, Python з його пакета NuGet). Без прав адміністратора. |
| pnpm | зафіксований pnpm 10.33.2 у `.tools\pnpm10` |
| Робочий простір ZAICODE | клон гілки `vacterro/zaicode` `master` (джерело лаунчера, інсталятор, документація; памʼять розробника `.saipen/` не включається; гілка `workspace` до 2026-09-27) |
| Джерело застосунку ZAICODE | клон гілки `zaicode` у `zcode\` |
| SAIPEN | клон `vacterro/saipen` у `saipen\`; його `bin\saipen.cmd` пишеться для цього клону та цього Python |
| SAIMAIL | клон `vacterro/saimail` у `saimail\`, встановлюється в `.venv\` |
| saimail-local | командний клієнт SAIMAIL, який використовують панелі SAIMAIL у ZAICODE (постачається з SAIMAIL `0.0.2a3`; перевірка `saimail-cli` дає OK) |
| Пакет 9router | `9router` з npm у `.tools\router`, вбудовано, тож SAIFREN працює без налаштувань (WARN, якщо npm не має доступу) |
| Залежності застосунку | `pnpm install --frozen-lockfile` (знову, коли змінюється `pnpm-lock.yaml`) |
| Збірка застосунку | `pnpm bundle:zaicode`; поки ZAICODE працює, нова збірка готується й підміняється на наступному старті |
| Підміна готової збірки | очищає `win-unpacked.previous`, залишений після збою заміни через довгий шлях, і підміняє збірку, що чекає, коли ZAICODE закрито |
| Кореневий лаунчер | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Ярлики | `ZAICODE` на Робочому столі та в меню «Пуск» -> `ZAICODE.exe` |
| Входи в Claude / Codex | лише звіт: кожен вхід `~\.claude*` / `~\.codex*` — це окремий рушій у ZAICODE (A1, A2, C1, ...); вхід потребує вас, у браузері |

Кореневий лаунчер спрямовує ZAICODE на встановлений SAIPEN (`saipen\`) і ставить
`.tools\` та `.venv\Scripts` першими в PATH застосунку, тож застосунок, його агенти та
воркери використовують встановлені копії.

## Кілька підписок

Кожен вхід у Claude Code або Codex живе у власному home: `~\.claude`,
`~\.claude-account2`, ... та `~\.codex`, `~\.codex-account2`, ... ZAICODE знаходить
їх усі. Підготувати більше під час встановлення:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Інсталятор створює ці home й друкує точну команду входу для кожного
(`$env:CODEX_HOME = '...'; codex login`). Те саме в ZAICODE: Settings ->
Engines & limits -> додати ще один вхід.

## Автовиправлення

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Стан кожної перевірки: OK, FIXED (було зламано, виправлено), WARN (працює, але бракує
деякої необовʼязкової речі), INFO (потрібна ваша участь: вхід), FAIL. Логи в
`install\logs\`; підсумок останнього встановлення — `install\install-report.json`.
У застосунку Router -> Autotroubleshoot виправляє запущений router і пули.

## Параметри

| Параметр | За замовчуванням | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | куди все йде |
| `-ShortcutDir` | Desktop | куди потрапляє ярлик ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | пропустити ці ярлики |
| `-PortableTools` | | приватні Git / Node.js / Python навіть якщо вони вже є на машині |
| `-Launch` | | запустити ZAICODE після завершення |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | репозиторії GitHub | інше джерело (форк, локальний клон) |

## Доказ

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
перевіряє свіже встановлення, створює збої (ярлик і лаунчер видалено, лаунчер SAIPEN
вказує на відсутній Python, venv SAIMAIL видалено, node_modules записано для іншого
lockfile, залишився тезковий каталог углиб за MAX_PATH), стверджує, що doctor
повідомляє про кожен з них і виправляє, потім запускає ціль ярлика з ізольованим
профілем і зупиняє рівно те дерево процесів, яке сам запустив.

`install\tests\Test-ZaicodeUpdate.ps1` створює на диску чотири одноразові репозиторії та встановлення їхніх
клонів, потім доводить, що перевірка нічого не змінює, що одна частина оновлюється
окремо зі своїм подальшим кроком (лаунчер SAIPEN, кореневий лаунчер), що
перетинні локальні зміни та локальні коміти зберігаються, і що невідома назва
частини відхиляється. Без мережі.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
