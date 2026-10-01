# ZAICODE

**v0.0.2**

<div align="center">
  <img src="https://raw.githubusercontent.com/vacterro/zaicode/zaicode/packages/ui/src/assets/zaicode-working.png" alt="ZAICODE" width="96" height="96" />
</div>
<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.2-c9a227" alt="version 0.0.2" />
  <img src="https://img.shields.io/badge/platform-Windows-3b3527" alt="Windows" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-3b3527" alt="Apache-2.0" />
</p>
<p align="center">
  ZAICODE · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md">ZCode (简体中文)</a> · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.en.md">ZCode (English)</a>
</p>

<img width="1440" height="860" alt="ZAICODE hero — Do your best." src="../../screenshots/01-do-your-best.png" />

ZAICODE — рабочее место оператора: запуск множества ИИ-агентов по коду
одновременно над многими проектами без постоянного присмотра. Это модифицированная сборка
[ZCode](https://github.com/zai-org/ZCode) (десктопное приложение, браузерный интерфейс и
CLI агента) с продуктовым слоем поверх: каждый проект управляется по
протоколу [SAIPEN](https://github.com/vacterro/saipen), работу запускают, продолжают
и планируют из одного окна, а подписочные CLI, за которые вы уже платите
(Claude Code, Codex, Antigravity), работают как закрепленные воркеры рядом со встроенными
агентами.

**0.0.1** — первый отмеченный снапшот: личная сборка под Windows, которую
используют каждый день.

## Установка в один клик

1. Скачайте **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Дважды щелкните по нему и нажмите **INSTALL**.

Все. Установщик ставит то, чего машине не хватает (Git, Node.js, Python — приватными
копиями: без прав администратора), скачивает с GitHub ZAICODE, SAIPEN и SAIMAIL,
собирает приложение на машине и создает ярлык ZAICODE на рабочем столе. Первый
запуск занимает 15–30 минут; окно показывает каждый шаг.

Бесплатные модели работают сразу: ZAICODE запускает собственный роутер и наполняет пул **SAIFREN**
бесплатными безключевыми тарифами, поэтому задача, введенная в New task, получает ответ без
ключа, аккаунта и настроек. Подписки Claude Code, Codex и Antigravity
необязательны — войти можно в любой момент.

**Одно целое, четыре части.** Рабочая среда (лаунчер, установщик), приложение, SAIPEN и
SAIMAIL — это четыре репозитория. Каждый обновляется отдельно: *Settings -> ZAICODE ->
Updates* показывает все части и обновляет их вручную или автоматически (проверка через несколько минут
после старта и каждые шесть часов). Новая сборка приложения готовится, пока ZAICODE работает,
и запускается при следующем старте; ваши правки в клоне никогда не перезаписываются.
Из терминала: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Автопоиск неполадок: `install\Doctor.cmd`. Подробности: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Обзор интерфейса

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>SAIHOME</strong><br />
      The operator dashboard: quotas, health, projects, streaks, activity, and the live clock in one place.<br /><br />
      <img src="../../screenshots/02-saihome-dashboard.png" alt="SAIHOME dashboard" />
    </td>
    <td width="50%" valign="top">
      <strong>Agents &amp; tasks</strong><br />
      Create roles, inspect queues, and see what is idle, running, finished, or waiting for you.<br /><br />
      <img src="../../screenshots/03-agents-and-tasks.png" alt="Agents and tasks" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Scheduler</strong><br />
      Arm quota-aware autonomous runs and recurring prompts across one project or a whole sidebar section.<br /><br />
      <img src="../../screenshots/04-scheduler.png" alt="Scheduler" />
    </td>
    <td width="50%" valign="top">
      <strong>Audits</strong><br />
      Run Quick 3 Waves audits, watch progress live, and jump straight to reports when something stops.<br /><br />
      <img src="../../screenshots/05-audits.png" alt="Audits" />
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <strong>Active session</strong><br />
      The full working view: transcript, branch, prompt composer, state inspector, board, and backlog at the same time.<br /><br />
      <img src="../../screenshots/06-active-session.png" alt="Active session" />
    </td>
  </tr>
</table>

## Что добавлено к ZCode

- **Проекты с MAIN-сессией.** В каждом проекте одна MAIN-сессия (Пуск,
  `/goal cc all`) и вспомогательные сессии (subSaipens: WIKI, TEST, AUDIT, …).
  По умолчанию в боковой панели строка проекта показана как его MAIN; ▶
  продолжает MAIN, а не открывает новую сессию. ПРОДОЛЖИТЬ ВСЁ, ГОТОВО и
  ОЧИСТИТЬ ВСЁ ГОТОВОЕ обрабатывают все проекты; сессия, оборванная посреди
  хода, показывает ПРЕРВАНО, а не ГОТОВО.
- **Безопасность при сбоях.** Сессии, оборванные упавшим процессом, и активные
  цели продолжаются сами после перезапуска; работающие воркеры стартуют
  заново. Агенты внутри ZAICODE не могут убить ZAICODE по имени процесса.
- **Воркеры.** Подписочные CLI работают в терминалах, прикреплённых к любой
  грани окна (или в собственных окнах с привязкой). Вопросы «Доверять этой
  папке?» при первом запуске получают ответ; воркер, достигший лимита
  использования, отмечается и по настройке закрывается или перезапускается
  после сброса.
- **Лимиты и сбросы.** Счётчики квоты по каждому аккаунту и пулу, таймер в
  заголовке окна до ближайшего сброса и полный список предстоящих сбросов при
  наведении.
- **SCHEDULER.** Промпты, запускающиеся сами: в заданное время, ежедневно,
  каждые N минут или когда окно квоты восполняется; в одном проекте или целой
  секции боковой панели, сначала самые проблемные проекты (больше всего
  блокировок / открытых тикетов SAIPEN). Условия могут сначала останавливать
  временную работу (сессии бесплатных пулов, более слабые воркеры), запускаться
  только в проектах без дела или продолжать только отмеченные сессии. Практического
  ограничения длины промптов нет.
- **Маршрутизация.** Встроенный 9router (MIT) даёт пулы без настройки: SAIFREN
  (бесплатные тарифы без ключа) и SAIOPP (ваши подписки).
- **SAIHOME, таймеры, звуки, подсветка.** Домашняя страница оператора со
  статистикой, таймерами и будильниками в стиле FastPrompter, звуками для
  действий и тёмно-золотым, пиксель-чётким интерфейсом в духе Win95.

## Сборка

Требования: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) — источник истины).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Упакованное приложение всегда запускается в режиме ZAICODE. Пока работает более
старый ZAICODE, сборщик размещает новую сборку в `packages/desktop/dist-next`; корневой
лаунчер (ветка `master`, `tools/launcher`) подменяет её при следующем запуске.
Чёткий растровый вариант Verdana, который использует интерфейс, не входит в
этот репозиторий; без него интерфейс откатывается на системный Verdana.

Проверки: `pnpm typecheck`, `pnpm lint` и тесты ZAICODE, например
`node --import tsx --test test/zaicode*.test.ts` из `packages/ui`.

## Структура репозитория

| Ветка      | Содержимое                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | канонический workspace: лаунчер, установщик (`install/`), продуктовая документация (`UI.md`, `docs/`), состояние SAIPEN и CHANGELOG |
| `zaicode`   | канонический исходный код приложения: история апстрима ZCode плюс продуктовый слой ZAICODE для сборок и обновлений |

Устаревшие или созданные автоматизацией ref могут временно сохраняться, но они
не являются каноническими продуктовыми ветками. Новая работа над workspace
принадлежит `master`; работа над исходным кодом приложения — `zaicode`.

Код приложения, принадлежащий ZAICODE, живёт в основном в `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` и
`packages/desktop/src/main/zaicode*.ts` в ветке `zaicode`. Документация
workspace и инструменты лаунчера/update живут в `master`.

## Апстрим и лицензия

ZAICODE создан на базе ZCode от Z.ai и распространяется по той же
[лицензии Apache 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); уведомления исходного проекта сохранены в
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) и [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Файлы изменены автором ZAICODE. ZAICODE — независимый проект,
не связанный с Z.ai и не одобренный им. Оригинальный README ZCode сохранён как
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) и [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Сеть проектов

Этот репозиторий — часть экосистемы более широкого проекта **SAIPEN / vacterro**.

[**Автор**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**Сообщество SAIPEN**](https://discord.gg/SEYaYkuVgN)

Для воспроизводимых багов и долгосрочных запросов на функции используйте [GitHub Issues этого репозитория](https://github.com/vacterro/zaicode/issues). Discord — для быстрых обсуждений, скриншотов и обратной связи между проектами.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
