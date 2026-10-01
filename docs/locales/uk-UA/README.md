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

ZAICODE — робочий стіл оператора: багато AI-агентів кодування одночасно над
багатьма проєктами, без постійного нагляду. Це модифікована збірка
[ZCode](https://github.com/zai-org/ZCode) (десктопний застосунок, браузерний інтерфейс і агентний
CLI) з продуктовим шаром поверх: кожен проєкт веде
протокол [SAIPEN](https://github.com/vacterro/saipen), роботу запускають, продовжують
і планують з одного вікна, а підписні CLI, за які ви вже платите
(Claude Code, Codex, Antigravity), працюють як прикріплені воркери поруч із вбудованими
агентами.

**0.0.1** — перший тегований знімок: особиста збірка насамперед для Windows,
якою користуються щодня.

## Встановлення в один клік

1. Завантажте **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Двічі клацніть і натисніть **INSTALL**.

Це все. Інсталятор доставляє те, чого бракує машині (Git, Node.js, Python — як приватні
копії: без прав адміністратора), завантажує ZAICODE, SAIPEN і SAIMAIL з GitHub,
збирає застосунок на машині та ставить ярлик ZAICODE на робочому столі. Перший
запуск триває 15-30 хвилин; вікно показує кожен крок.

Безкоштовні моделі працюють одразу: ZAICODE запускає власний роутер і заповнює пул **SAIFREN**
безкоштовними тарифами без ключів, тож завдання, введене в New task, отримує відповідь без
ключа, без акаунта і без жодного налаштування. Підписки Claude Code, Codex і Antigravity
необов'язкові — увійти можна будь-коли.

**Один продукт — чотири частини.** Робоче середовище (лаунчер, інсталятор), застосунок, SAIPEN і
SAIMAIL — це чотири репозиторії. Кожен оновлюється окремо: *Settings -> ZAICODE ->
Updates* показує всі частини й оновлює їх вручну або автоматично (перевірка за кілька хвилин
після запуску та кожні шість годин). Нову збірку застосунку готують, поки ZAICODE працює,
і вона стартує з наступного запуску; ваші правки в клоні ніколи не перезаписують.
З терміналу: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Автовиправлення проблем: `install\Doctor.cmd`. Подробиці: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Огляд інтерфейсу

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

## Що це додає до ZCode

- **Проєкти з MAIN-сесією.** Кожен проєкт має одну MAIN-сесію (START,
  `/goal cc all`) та допоміжні сесії (subSaipens: WIKI, TEST, AUDIT, …).
  Типовий вигляд бічної панелі показує рядок проєкту як його MAIN; ▶ продовжує MAIN
  замість відкриття нової сесії. CONTINUE ALL, DONE і CLEAR ALL DONE
  обробляють кожен проєкт; сесія, обірвана посеред повороту, показує INTERRUPTED, а не DONE.
- **Захист від збоїв.** Сесії, обірвані мертвим процесом, і цілі, які ще активні,
  продовжуються самі після перезапуску; запущені воркери стартують знову. Агенти
  всередині ZAICODE не можуть убити ZAICODE за назвою процесу.
- **Воркери.** Підписні CLI працюють у терміналах, прикріплених до будь-якого краю
  вікна (або у власних вікнах із прив'язкою). Питання «Довіряти цій теці?» при
  першому запуску отримують відповідь; воркер, який уперся в ліміт використання,
  повідомляється і, за налаштуванням, закривається або перезапускається після скидання.
- **Ліміти та скидання.** Лічильники квоти для кожного акаунта й пулу, таймер у
  панелі заголовка до найближчого скидання з повним списком майбутніх скидань при наведенні.
- **SCHEDULER.** Промпти, що запускаються самі: у певний час, щодня, кожні N
  хвилин або коли поповнюється вікно квоти; в одному проєкті або в цілій секції
  бічної панелі, спершу найгірші проєкти (найбільше заблоковані / відкритих тікетів SAIPEN).
  Умови можуть зупиняти тимчасову роботу (сесії безкоштовного пулу, слабші воркери) першими,
  виконуватися лише на проєктах у простої або продовжувати лише позначені сесії. Промпти
  практично не мають обмеження довжини.
- **Маршрутизація.** Вбудований 9router (MIT) дає пули без налаштування: SAIFREN
  (безкоштовні рівні без ключа) та SAIOPP (ваші підписки).
- **SAIHOME, таймери, звуки, підсвічування.** Домашня сторінка оператора зі статистикою,
  таймерами та будильниками у стилі FastPrompter, звуками для кожної дії та інтерфейсом
  у стилі Win95 — темне золоте, піксельно чітке.

## Збірка

Вимоги: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) — джерело істини).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Зпакований застосунок завжди запускається в режимі ZAICODE. Поки працює старіший ZAICODE,
  бандлер розміщує нову збірку в `packages/desktop/dist-next`; кореневий
  лаунчер (гілка `master`, `tools/launcher`) підміняє її під час наступного запуску.
  Чіткий бітмап-варіант Verdana, який використовує UI, не входить до цього репозиторію;
  без нього інтерфейс переходить на системний Verdana.

Перевірки: `pnpm typecheck`, `pnpm lint` та тести ZAICODE, наприклад
`node --import tsx --test test/zaicode*.test.ts` з `packages/ui`.

## Структура репозиторію

| Гілка      | Вміст                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | канонічний workspace: лаунчер, інсталятор (`install/`), документація продукту (`UI.md`, `docs/`), стан SAIPEN і CHANGELOG |
| `zaicode`   | канонічний код застосунку: апстрим-історія ZCode плюс продуктовий шар ZAICODE, що використовується для збірок і оновлень |

Посилання, створені старією версією або автоматизацією, можуть часово залишатися, але вони не
є канонічними гілками продукту. Нова робота над workspace належить `master`; робота
над кодом застосунку — `zaicode`.

Код застосунку, що належить ZAICODE, переважно живе в `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` та
`packages/desktop/src/main/zaicode*.ts` на гілці `zaicode`. Документація workspace
та інструменти лаунчера/update живуть на `master`.

## Апстрим і ліцензія

ZAICODE походить від ZCode від Z.ai і поширюється за тією самим
[ліцензією Apache 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); оригінальні повідомлення збережено в
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) та [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Файли змінено автором ZAICODE. ZAICODE — незалежний проєкт,
не афілійований і не схвалений Z.ai. Оригінальний README ZCode збережено як
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) та [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Мережа проєктів

Цей репозиторій є частиною ширшої екосистеми проєктів **SAIPEN / vacterro**.

[**Хаб автора**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**Спільнота SAIPEN**](https://discord.gg/SEYaYkuVgN)

Для відтворюваних багів і довготривалих запитів на функції використовуйте [GitHub Issues цього репозиторію](https://github.com/vacterro/zaicode/issues). Discord — для швидких обговорень, скриншотів і міжпроєктного зворотного зв'язку.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
