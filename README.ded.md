# ZAICODE

**v0.0.2**

[en-US](README.md) · [ru-RU](docs/locales/ru-RU/README.md) · [et-EE](docs/locales/et-EE/README.md) · [uk-UA](docs/locales/uk-UA/README.md) · [ja-JP](docs/locales/ja-JP/README.md) · [ded](docs/locales/ded/README.md) · [zh-CN](docs/locales/zh-CN/README.md) · [de-DE](docs/locales/de-DE/README.md) · [fr-FR](docs/locales/fr-FR/README.md) · [es-ES](docs/locales/es-ES/README.md) · [it-IT](docs/locales/it-IT/README.md) · [pt-BR](docs/locales/pt-BR/README.md) · [nl-NL](docs/locales/nl-NL/README.md) · [pl-PL](docs/locales/pl-PL/README.md) · [sv-SE](docs/locales/sv-SE/README.md) · [da-DK](docs/locales/da-DK/README.md) · [fi-FI](docs/locales/fi-FI/README.md) · [nb-NO](docs/locales/nb-NO/README.md) · [ko-KR](docs/locales/ko-KR/README.md) · [th-TH](docs/locales/th-TH/README.md) · [vi-VN](docs/locales/vi-VN/README.md) · [ar-SA](docs/locales/ar-SA/README.md) · [he-IL](docs/locales/he-IL/README.md) · [tr-TR](docs/locales/tr-TR/README.md) · [hi-IN](docs/locales/hi-IN/README.md) · [id-ID](docs/locales/id-ID/README.md) · [el-GR](docs/locales/el-GR/README.md) · [cs-CZ](docs/locales/cs-CZ/README.md) · [ro-RO](docs/locales/ro-RO/README.md) · [hu-HU](docs/locales/hu-HU/README.md) · [bg-BG](docs/locales/bg-BG/README.md) · [sk-SK](docs/locales/sk-SK/README.md) · [hr-HR](docs/locales/hr-HR/README.md)

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

<img width="1440" height="860" alt="ZAICODE hero — Do your best." src="docs/screenshots/01-do-your-best.png" />

ZAICODE — рабочий пульт оператора: гонять много AI-агентов кодинга разом по куче проектов, без няньки. Это модифицированная сборка [ZCode](https://github.com/zai-org/ZCode) (десктоп, браузерный UI и агентный CLI) с продуктовым слоем сверху: каждый проект крутится по протоколу [SAIPEN](https://github.com/vacterro/saipen), работу стартуют, продолжают и планируют из одного окна, а подписочные CLI, за которые ты уже платишь (Claude Code, Codex, Antigravity), пашут пристыкованными воркерами рядом с внутренними агентами.

**0.0.1** — первый тегнутый снапшот: личная сборка в первую очередь под Windows, ежедневно в работе.

## Установка в один клик

1. Скачай **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Двойной клик по нему и жми **INSTALL**.

И всё. Установщик дотянет то, чего машине не хватает (Git, Node.js, Python — приватными копиями: права админа не нужны), заберёт ZAICODE, SAIPEN и SAIMAIL с GitHub, соберёт приложение на месте и кинет ярлык ZAICODE на рабочий стол. Первый запуск — 15-30 минут; окно показывает каждый шаг.

Бесплатные модели работают сразу: ZAICODE поднимает свой роутер и наполняет пул **SAIFREN** бесключевыми бесплатными лимитами, так что задача, вбитая в «Новая задача», получает ответ без ключа, без аккаунта и без настроек. Подписки Claude Code, Codex и Antigravity не обязательны — войти можно когда угодно.

**Одно целое, четыре части.** Рабочее пространство (лаунчер, установщик), приложение, SAIPEN и SAIMAIL — четыре репозитория. Каждый обновляется сам: «Настройки -> ZAICODE -> Обновления» показывает все части, обновляй руками или дай самому (проверка через пару минут после старта и каждые шесть часов). Новая сборка приложения готовится, пока ZAICODE работает, и включается при следующем старте; твои правки в клоне никогда не перетираются.
Из терминала: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Автодиагностика: `install\Doctor.cmd`. Подробности: [docs/ZAICODE_INSTALL.md](docs/locales/ded/ZAICODE_INSTALL.md).

## Обзор интерфейса

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>SAIHOME</strong><br />
      The operator dashboard: quotas, health, projects, streaks, activity, and the live clock in one place.<br /><br />
      <img src="docs/screenshots/02-saihome-dashboard.png" alt="SAIHOME dashboard" />
    </td>
    <td width="50%" valign="top">
      <strong>Agents &amp; tasks</strong><br />
      Create roles, inspect queues, and see what is idle, running, finished, or waiting for you.<br /><br />
      <img src="docs/screenshots/03-agents-and-tasks.png" alt="Agents and tasks" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Scheduler</strong><br />
      Arm quota-aware autonomous runs and recurring prompts across one project or a whole sidebar section.<br /><br />
      <img src="docs/screenshots/04-scheduler.png" alt="Scheduler" />
    </td>
    <td width="50%" valign="top">
      <strong>Audits</strong><br />
      Run Quick 3 Waves audits, watch progress live, and jump straight to reports when something stops.<br /><br />
      <img src="docs/screenshots/05-audits.png" alt="Audits" />
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <strong>Active session</strong><br />
      The full working view: transcript, branch, prompt composer, state inspector, board, and backlog at the same time.<br /><br />
      <img src="docs/screenshots/06-active-session.png" alt="Active session" />
    </td>
  </tr>
</table>

## Что добавлено к ZCode

- **Проекты с MAIN-сессией.** У каждого проекта одна MAIN-сессия (START,
  `/goal cc all`) и сессии-помощники (subSaipens: WIKI, TEST, AUDIT, …).
  По умолчанию строка проекта в сайдбаре — это его MAIN; ▶ продолжает MAIN,
  а не открывает новую сессию. CONTINUE ALL, DONE и CLEAR ALL DONE прочёсывают
  все проекты; сессия, оборванная посреди хода, показывает INTERRUPTED, а не DONE.
- **Устойчивость к падениям.** Сессии, срезанные умершим процессом, и незакрытые
  цели сами продолжаются после рестарта; работающие воркеры стартуют заново. Агенты
  внутри ZAICODE не могут убить ZAICODE по имени процесса.
- **Воркеры.** Подписочные CLI крутятся в терминалах, пристыкованных к любой
  грани окна (или в отдельных snap-окнах). Вопрос «Доверять этой папке?» при
  первом запуске закрыт; воркер, упёршийся в лимит, отмечается и — по настройке —
  закрывается либо перезапускается после сброса.
- **Лимиты и сбросы.** Счётчики квоты по аккаунту и пулу, таймер в заголовке
  до ближайшего сброса, полный список будущих сбросов — по наведению.
- **SCHEDULER.** Промпты, стартующие сами: в заданный час, ежедневно, каждые
  N минут или когда окно квоты восполнится; в одном проекте или целой секции
  сайдбара, сначала худшие проекты (больше всего блокеров / открытых тикетов
  SAIPEN). Условия могут гасить сначала подпорки (сессии бесплатных пулов,
  слабые воркеры), гонять только по простаивающим проектам или продолжать
  только помеченные сессии. Длина промптов практически не ограничена.
- **Роутинг.** Вшитый 9router (MIT) даёт пулы без настройки: SAIFREN
  (бесплатные тарифы без ключа) и SAIOPP (твои подписки).
- **SAIHOME, таймеры, звуки, подсветка.** Дом оператора со статистикой,
  таймерами-будильниками в духе FastPrompter, звуком на каждое действие
  и тёмно-золотым пиксельным интерфейсом Win95.

## Сборка

Требования: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) — эталон).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Собранное приложение всегда стартует в режиме ZAICODE. Пока работает старая ZAICODE, сборщик готовит новую сборку в `packages/desktop/dist-next`; корневой лаунчер (ветка `master`, `tools/launcher`) подменяет её при следующем старте. Чёткий растровый вариант Verdana, который берёт интерфейс, в этот репозиторий не входит; без него интерфейс откатывается на системный Verdana.

Проверки: `pnpm typecheck`, `pnpm lint` и тесты ZAICODE, например `node --import tsx --test test/zaicode*.test.ts` из `packages/ui`.

## Структура репозитория

| Ветка       | Содержимое                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | каноническое рабочее пространство: лаунчер, инсталлятор (`install/`), продуктовая документация (`UI.md`, `docs/`), состояние SAIPEN и CHANGELOG |
| `zaicode`   | канонический исходник приложения: история upstream ZCode плюс продуктовый слой ZAICODE, из которого собираются сборки и обновления |

Легаси-ветки и рефы, созданные автоматизацией, могут ещё временно попадаться, но каноническими продуктовыми ветками они не являются. Новая работа над рабочим пространством — в `master`; над исходниками приложения — в `zaicode`.

Код приложения, принадлежащий ZAICODE, живёт в основном в `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` и
`packages/desktop/src/main/zaicode*.ts` ветки `zaicode`. Документация рабочего пространства и тулы лаунчера/update живут на `master`.

## Upstream и лицензия

ZAICODE — это ZCode от Z.ai под той же
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); исходные уведомления лежат в
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) и [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Файлы правил автор ZAICODE. ZAICODE — самостоятельный проект,
ни с Z.ai не связан, ни им не одобрен. Оригинальный README ZCode сохранён как
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) и [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Сеть проектов

Этот репозиторий — часть общей экосистемы **SAIPEN / vacterro**.

[**Хаб автора**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN Community**](https://discord.gg/SEYaYkuVgN)

Баги с повтором и долгие просьбы о фичах — сюда: [GitHub Issues этого репозитория](https://github.com/vacterro/zaicode/issues). Discord — для быстрого обсуждения, скринов и отзывов между проектами.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
