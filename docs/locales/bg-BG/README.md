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

ZAICODE е работна станция за оператори, с която се пускат много AI кодиращи агенти едновременно
по много проекти, без да се грижат за тях. Това е модифициран билд на
[ZCode](https://github.com/zai-org/ZCode) (десктоп приложение, браузърен интерфейс и агентски
CLI) с продуктови слой отгоре: всеки проект се задвижва от
[SAIPEN](https://github.com/vacterro/saipen) протокола, работата се стартира, продължава
и планира от един прозорец, а абонаментните CLI, за които вече плащате
(Claude Code, Codex, Antigravity), работят като доковани работници до вградените агенти.

**0.0.1** е първият версиониран снапшот: личен билд, ориентиран към Windows, който
се ползва всеки ден.

## Инсталиране с едно кликване

1. Изтеглете **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Кликнете двукратно върху него и натиснете **INSTALL**.

Толкова. Инсталаторът добавя това, което машината няма (Git, Node.js, Python — като
частни копия: без администраторски права), изтегля ZAICODE, SAIPEN и SAIMAIL от GitHub,
изгражда приложението на машината и слага пряког на работния плот. Първият
старт отнема 15-30 минути; прозорецът показва всяка стъпка.

Безплатните модели работят веднага: ZAICODE си пуска собствен рутер и пълни **SAIFREN**
пула от безключови безплатни нива, така че задача, написана в New task, получава отговор без
ключ, без акаунт и без настройка. Абонаментите за Claude Code, Codex и Antigravity
са по избор и могат да се впишете по всяко време.

**Цялото, в четири части.** Работното пространство (лаунчерът, инсталаторът), приложението, SAIPEN и
SAIMAIL са четири хранилища. Всяко се обновява самостоятелно: *Settings -> ZAICODE ->
Updates* показва всяка част, обновява я ръчно или автоматично (проверка няколко минути
след старта и на всеки шест часа). Нов билд на приложението се подготвя, докато ZAICODE работи,
и стартира при следващото пускане; вашите собствени промени в клона никога не се презаписват.
От терминал: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Автоматично отстраняване на проблеми: `install\Doctor.cmd`. Подробности: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Обиколка на интерфейса

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

## Какво добавя към ZCode

- **Проекти с MAIN сесия.** Всеки проект има една MAIN сесия (START,
  `/goal cc all`) и помощни сесии (subSaipens: WIKI, TEST, AUDIT, …). Изгледът в
  страничната лента по подразбиране показва реда на проекта като негова MAIN; ▶
  продължава MAIN вместо да отваря нова сесия. CONTINUE ALL, DONE и CLEAR ALL
  DONE обхождат всеки проект; сесия, прекъсната по средата на ход, показва
  INTERRUPTED, никога DONE.
- **Безопасност при срив.** Сесии, прекъснати от мъртъв процес, и цели, още
  активни, продължават сами след рестарт; работещите воркери се пускат наново.
  Агентите в ZAICODE не могат да убият ZAICODE по име на процеса.
- **Воркери.** Абонаментните CLI работят в терминали, закрепени към който и да е
  ръб на прозореца (или в собствени прилепващи се прозорци). Въпросите
  "Trust this folder?" при първия старт се отговарят; воркер, ударил лимита си,
  се докладва и според настройката се затваря или рестартира след ресета.
- **Лимити и ресети.** Кватометри за акаунт и пул, таймер в лентата на
  заглавието до най-близкия ресет с пълния списък на предстоящи ресети при ховър.
- **SCHEDULER.** Prompt-и, които тръгват сами: в определен час, ежедневно, на
  всеки N минути или когато се попълни квотен прозорец; в един проект или цяла
  секция на страничната лента, първо най-проблемните проекти (най-много
  блокирани / отворени SAIPEN билети). Условията могат първо да спират
  временната работа (сесии от безплатния пул, по-слаби воркери), да се изпълняват
  само в неактивни проекти или да продължават само маркирани сесии. Prompt-ите нямат
  практически лимит на дължина.
- **Маршрутизиране.** Вграден 9router (MIT) дава пулове без настройка: SAIFREN
  (безплатни нива без ключ) и SAIOPP (вашите абонаменти).
- **SAIHOME, таймери, звуци, отблясъци.** Операторски дом със статистика,
  таймери и аларми във FastPrompter стил, звуци за всяко действие и Win95 тъмно
  златен, пиксел-остър интерфейс.

## Сборка

Изисквания: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) е източникът на истината).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Пакетираното приложение винаги стартира в режим ZAICODE. Докато работи по-стара
версия на ZAICODE, бандлерът подготвя новата сборка в `packages/desktop/dist-next`; root
launcher (клон `master`, `tools/launcher`) я сменя при следващия старт.
Острото растерово издание на Verdana, което използва интерфейсът, не е част от
това хранилище; без него интерфейсът пада обратно към системния Verdana.

Проверки: `pnpm typecheck`, `pnpm lint` и тестовете на ZAICODE, например
`node --import tsx --test test/zaicode*.test.ts` от `packages/ui`.

## Структура на хранилището

| Клон         | Съдържание                                                              |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | каноничното работно пространство: launcher, инсталатор (`install/`), продуктова документация (`UI.md`, `docs/`), състояние на SAIPEN и CHANGELOG |
| `zaicode`   | каноничният изходен код на приложението: upstream история на ZCode плюс продуктовия слой на ZAICODE, използван за сборки и обновления |

Останали или създадени от автоматизация git рефове може все още да се появяват
временно, но те не са канонични продуктови клони. Новата работа в работното
пространство е за `master`; работата по изходния код на приложението —
за `zaicode`.

Кодът на приложението, собственост на ZAICODE, живее най-вече в `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` и
`packages/desktop/src/main/zaicode*.ts` на клона `zaicode`. Документацията на работното
пространство и launcher/update инструментариумът са на `master`.

## Upstream и лиценз

ZAICODE е производно от ZCode от Z.ai и се разпространява при същите
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); известията от upstream се пазят в
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) и [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Файловете са променяни от автора на ZAICODE. ZAICODE е независим проект,
не свързан и не одобрен от Z.ai. Оригиналният README на ZCode е запазен като
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) и [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Проектна мрежа

Това хранилище е част от по-широката екосистема от проекти **SAIPEN / vacterro**.

[**Хъб на автора**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN Community**](https://discord.gg/SEYaYkuVgN)

За възпроизводими бъгове и трайни заявки за функции използвайте [GitHub Issues на това хранилище](https://github.com/vacterro/zaicode/issues). Използвайте Discord за бързи обсъждания, скрийншоти и обратна връзка между проекти.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
