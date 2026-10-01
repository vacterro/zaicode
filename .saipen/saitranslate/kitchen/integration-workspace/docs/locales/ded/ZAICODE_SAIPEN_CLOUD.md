# Облачный транспорт ZAICODE SAIPEN

Как этот checkout и сессия Claude Code Cloud гоняют один воркспейс SAIPEN
с разной локальностью исполнителя и где между ними граница.

## Как устроено

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Одна ветка тащит состояние протокола. Ни мержа, ни ребейза, ни второй локальной
ветки для синхрона: кто из исполнителей нашёл верифицированный чекпоинт —
закоммитил и запушил, другая сторона забирает fast-forward'ом.

`master` — история до транспорта и опубликованная дефолтная ветка. Транспорт
ей не делает force-update.

## Что едет, а что нет

Чекпоинт в этом репозитории тащит состояние протокола SAIPEN, корневой лаунчер,
инсталлятор, доки и эти транспортные скрипты. Вот весь слой воркспейса.

Ни байта продукта он не тащит. `zcode/` — отдельный Git-репозиторий,
прописан в `.saipen/source-nested-repos.json` и в игноре тут, на корне (`/zcode/`).
Работа по продукту требует своего клона `vacterro/zaicode` на ветке `zaicode`,
и этот клон — второй, независимый объект со своей историей.

Ошибка тут лёгкая: чистый `git status` на этом корне ничего не говорит
о незакоммиченной работе по продукту, а fast-forward `saipen-live` ничего
не говорит о коде продукта. Проверяй `git -C zcode status` явно.

## Локальная часть

Два скрипта, оба принадлежат репозиторию — новая машина получит их из репозитория,
а не из головы:

| Файл | Роль |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | валидирует, сводит ветку, ставит и запускает вотчер, пишет запись автозапуска, доказывает local == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | сам цикл: fetch, сравнение, fast-forward или push, лог, пауза; затем проход по продукту и самообновление |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | круговой прогон через независимый исполнитель плюс доказательство холодного восстановления |
| `tools/saipen-cloud/Test-ProductSync.ps1` | проход по продукту и самообновление на одноразовых Git-репозиториях (без сети, без настоящего remote) |

Установка и починка:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Идемпотентно. Машинное состояние лежит в `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (копия), `ZAICODE_cloud-sync.log` (ротация на
2 МБ в `.log.1`), `ZAICODE_cloud-sync.lock` (единственный экземпляр),
`ZAICODE_cloud-sync.pid` и запись в папке Автозагрузка
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Установщик отказывается работать на грязном дереве и никогда его не чистит. Если все
грязные пути — это каноническое состояние SAIPEN внутри `.saipen/`, он так
и говорит и печатает точные команды чекпоинта: это протокольное
состояние без чекпоинта, а не транспортный сбой, и установщик не станет
коммитить его за спиной протокола.

## Поведение вотчера

| Ситуация | Действие |
|-----------|------|
| чисто, local — предок remote | `git merge --ff-only` |
| чисто, remote — предок local | `git push` |
| грязно | пауза, даже без fetch |
| на другой ветке | пауза |
| обе ушли вперёд, общего предка нет | пауза, в лог оба commit id, ничего не мержим |
| fetch или сеть упали | в лог degraded, повтор на следующем тике |
| merge/rebase/cherry-pick в процессе | пауза |

Никогда: force push, hard reset, stash, clean, checkout чужой ветки,
commit и остановка по имени процесса. Установщик останавливает вотчер
только по pid, который сам записал в свой pid-файл.

Грязное дерево ничего не стоит: вотчер проверяет грязь до fetch. Поэтому
простаивающий чекаут вообще не ходит в сеть.

### Проход по продукту (T-90)

`zcode/` — самостоятельный репозиторий, так что таблица выше
никогда не двигает код продукта. После него тот же тик берёт чекаут
продукта (`-ProductRepo`, по умолчанию `<repo>\zcode`; ветка `-ProductBranch`, по
умолчанию `zaicode`). Проход по продукту идёт независимо от того, грязное
ли внешнее дерево. Он только тянет.

| Ситуация | Действие |
|-----------|------|
| удалённый впереди, входящий файл тут не изменён | `git merge --ff-only`; незакоммиченная работа продукта остаётся как есть |
| удалённый впереди, входящий файл тут изменён | HELD: пишем в лог файлы, не мержим ничего |
| локальный впереди | лог; **никогда не пушить** (продукт публикует SAIPEN SHIP) |
| разошлись | стоп, оба id в лог, не мержим ничего |
| другая ветка, git-операция в полёте, fetch упал | стоп |
| нет чекаута `zcode/` или `-NoProduct` | пропущено |

git сам откажется делать fast-forward поверх локального изменения,
так что проверка HELD — более ранняя, читаемая защита, а не единственная. Fast-forward
продукта ничего не пересобирает: для теста гони `pnpm bundle:zaicode` (или
дев-превью).

### Самообновление (T-90)

Вотчер живёт копией под `%APPDATA%\SAIPEN`, поэтому новее вотчер из
репозитория без переустановки не запускался. В режиме цикла он теперь
каждый проход сверяет свой файл с закоммиченной копией в репозитории.
Он ставит эту копию поверх себя и перезапускается ровно один раз, с теми же
аргументами, и только если всё это верно:

- файлы различаются;
- в копии репозитория нет незакоммиченных правок;
- копия репозитория парсится без ошибок.

Копия, которая не парсится, отклоняется и пишется в лог, работающий
вотчер продолжает работу.

Вотчеры, поставленные до T-90, не умеют ни продуктовый проход, ни самообновление.
Прогони `Install-SaipenLiveSync.ps1` один раз на такой машине; дальше
вотчер сам обновится.

## Облачная половина

`CLAUDE.md` в корне — правило входа,
`.claude/skills/saipen/SKILL.md` — процедура выполнения. Скилл тянет
ядро SAIPEN из `github.com/vacterro/saipen` и гонит его через
объявленную поверхность движка `tools/saipen.py`. Ядро закреплено коммитом
(`3088eff`), не тегом. Тег `v8.0.1` — старое ядро с тем же
`VERSION`; его `validate` меняет состояние, а его валидатор эту доску режет.

`STATE.saipen_home` пишет путь к ядру того исполнителя, который
зачекаупил последним. В облаке первый же `saipen continue` на ядре `3088eff` сводит
его к работающему ядру одним залогированным `DEC` (E-1410). На машине
оператора указатель приходит мёртвым так же. Ядро с автосводкой чинит
это на `continue`; иначе гони
`saipen rebind-home --auto`.

**Обратный ход замечен.** E-1562 (cloud) свёл указатель к
`/home/user/zaicode/.claude/saipen-protocol`; E-1571 (операторская машина)
свёл его прямо назад к `V:/.../_SAIPEN`, автоматом, без ручного
`rebind-home`. Обе стороны — тот же автосвод, так что
на каждое переключение local/cloud жди `saipen_home` `DEC` и считай это
обычным шумом, а не багом. Шумом и останется, пока P1-2
(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) не вытащит указатель из versioned
состояния; не делай P1-2 побочкой от того, что заметил. Руками указатель не трогать.

`STATE.saipen_home` может смотреть на **рабочий чекаут ядра**
впереди пинна, а не на чистый клон `3088eff` — на операторской машине это
ветка `accepted-debt-rebind` с несохранённой работой. Ядро не на пиннованном коммите —
ещё не значит «сломано», но и не clean-room источник,
так что правило ниже про контракт голоса тут действует в полную
силу. Ни коммита, ни stash, ни reset, ни checkout, ни clean в таком
чекауте — никогда. Единственное исключение: точечное восстановление одного файла `saipen/STYLE.md`,
и только когда оператор сам попросил.

### STYLE.md — не локальная настройка

`saipen/STYLE.md` должен быть **байт-в-байт как файл
пиннованного ядра** на каждой машине, в каждой копии, без исключений и
без локальных правок. Копий на операторской машине больше одной:

- чекаут ядра в `STATE.saipen_home` (клон Git, на операторской
  машине — рабочий чекаут);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, который наполняет
  задача по расписанию `saipen-inject` (`bootstrap/schedule-run.ps1`). Это **не
  Git-репозиторий**, так что `git checkout` его не починит — только
  пересинкрон через инжектор либо прямая запись опубликованного содержимого.

`style_contract`-токен в `.saipen/STATE.md` — хеш текста этого файла
(`tools/validate.py`, `style_contract_token`: CRLF нормализован,
строка `style_contract:` исключена). Правишь `reply_language` в одной копии —
токен поедет; вторая копия и облако, которые берут опубликованное ядро,
сохранят опубликованный токен, и любая запись CLI на несовпадающей
стороне откажется с `style_contract ... does not match the installed STYLE.md marker`.
Вот и весь фейл: локальная сторона пишет то, что облако записать не может.

**Смена языка ответа — это коммит ядра плюс перепин**, а не локальная
правка. Меняй в репозитории ядра, публикуй, перепини коммит в
SKILL.md, обнови `STATE.style_contract` через `saipen recover`. Локальная
правка `STYLE.md` рассинхронизит каждую машину, кроме той, где её сделали.

Одна ловушка, про которую стоит сказать: опубликованный `bin/saipen` — это машинный шим,
вшивающий абсолютные пути к интерпретатору и чекауту одного оператора. Работает
ровно на одной машине. Облаку нужен `python3 tools/saipen.py`.

Ярлыки: `cc` продолжает текущий Work; `cc all <text>` берёт всё
сообщение как source/appends и продолжает все подходящие Work. Ни один не
спрашивает подтверждения на рутину.

## Классификация возможностей

**AVAILABLE_IN_CLOUD** — состояние протокола и слой воркспейса. Чтение и
запись `.saipen/`, лаунчер (`tools/launcher/ZaicodeLauncher.cs`), установщик в `install/`,
`docs/`, `CLAUDE.md`, `.claude/skills/` и транспортные скрипты. Git: read,
commit, push, fetch в `saipen-live`. Любой гейт — проверка файла, ревью
диффа или текста.

**LOCAL_WINDOWS_ONLY** — гейты, которым нужна именно эта машина.

| Гейт | Почему |
|------|-----|
| `tools\launcher\build.cmd` | компилит `ZaicodeLauncher.cs` под .NET Framework `csc`; на облачном образе нет Windows SDK |
| packaged Electron E2E (`zcode` desktop, Solo → queue → dispatch) | нужна десктопная сессия и засеянный профиль провайдера |
| живой 9router | служба Windows на этой машине |
| клики по десктопу руками | человек и экран |
| рантайм-кейсы самого вотчера | вотчер живёт только на машине с чекаутом |

Это записано как локальные границы приёмки. Такие гейты никогда не
отмечаются пройденными только потому, что дифф выглядит верно.

**SAFE_TO_DEFER** — продуктовый слой. Облачная сессия может склонировать
`vacterro/zaicode`, ветку `zaicode`, и работать там. Работа на уровне воркспейса не
требует продуктовой работы, но требует клон:
`.saipen/source-nested-repos.json` объявляет `zcode/`, а без него
валидатор падает с `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. Гейтам `pnpm` нужен закреплённый pnpm 10.33.2
и подготовленный воркспейс. `pnpm bootstrap` на свежем облачном образе —
задокументированный вход, и `package.json` продукта уже это объявляет.

Облако проверит только те продуктовые байты, что лежат в `origin/zaicode`.
Продуктовый дельта, живущий лишь в чекауте оператора `zcode/`, здесь
невидим — значит все продуктовые гейты по нему в облаке NOT RUN, какой бы
гейт ни был. T-84 — первый случай (E-1411): фикс был локальным, а
`origin/zaicode` тащил код до фикса.

**UNSAFE_TO_EMULATE** — всё, что делает локальный гейт зелёным на
фальшивке. Не стабу сборку лаунчера, не подделывай запуск packaged-приложения,
не переигрывай записанный результат `pnpm verify:pre-push` как будто он только что
выполнен, не превращай «код выглядит правильно» в строку PASS в `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — конформанс, зависящий от места чекаута.
На ядре `3088eff` облачный валидатор рапортует FAILы `closure-evidence`
(T-47, T-62, T-76, T-78 на момент написания), которых на машине оператора нет.

Ядро выносит любое событие LOG длиннее 1024 байт в
побочный файл `.saipen/recovery/log-detail/`. При чтении он восстанавливает сайдкар только
если абсолютный путь чекаута совпадает с тем, из которого писали. Длинный
вердикт VERIFY, записанный на Windows, в облаке потому нечитаем — и наоборот.

Дефект в ядре, заведён как P1-1 в `docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Пока не залит:

- процитировать вердикт облака и отнести его к этой границе, по тикетам
  (`SKILL.md` § 6 содержит проверку);
- никогда не переписывать сайдкары, не перепроверять ради зелёного, не латать копию ядра;
- держать события LOG до 1024 байт с обеих сторон.

Та же привязка к машинному пути работу тоже блокирует. Долговая база до
BUILD снимается при первом входе тикета в BUILD и перепроверяется при
каждом следующем входе. Тикет, впервой вошедший в BUILD на машине
оператора, потому в облаке в BUILD не войдёт: переход отклоняется с
`DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 — случай из реестра: DEBT-000079 снят на E-1377,
переход отклонён на E-1446. Такой тикет оставляй машине, которая сняла
его базу.

## Расхождение

Если локальный и удалённый перестали иметь общего предка, вотчер
останавливается. Ни merge, ни rebase, ни force. Оба id коммитов
пишутся в лог, фикс `git log --left-right --cherry-pick <branch>...origin/<branch>` руками, и
результат чекпоинтится как любое другое изменение.

## Точное действие на стороне облака

### Скрипт настройки окружения (один раз, в настройках облачного окружения)

Меню облачного окружения в тайтбаре сессии -> Edit -> Setup script.
Он запускается перед каждой новой сессией, так что каждая стартует с
готовым продуктовым тулчейном:

```bash
#!/usr/bin/env bash
# ZAICODE cloud toolchain: Node 24 + pnpm 10.33.2 (product gates),
# 9router 0.5.91 (real-router tests), mono mcs (launcher compile check).
set -u
NODE=v24.14.0
if ! command -v node >/dev/null || ! node -v | grep -q '^v24\.'; then
  curl -fsSL "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" | tar -xJ -C /opt
  ln -sf /opt/node-$NODE-linux-x64/bin/node /opt/node-$NODE-linux-x64/bin/npm /opt/node-$NODE-linux-x64/bin/npx /usr/local/bin/
fi
npm install -g pnpm@10.33.2 && ln -sf "$(npm prefix -g)/bin/pnpm" /usr/local/bin/pnpm
mkdir -p /opt/9router && cd /opt/9router && npm pack 9router@0.5.91 >/dev/null && tar -xzf 9router-0.5.91.tgz
(apt-get update -qq && apt-get install -y -qq mono-mcs) || echo "no mono-mcs: the launcher compile check is NOT RUN"
exit 0
```

### Промпт для каждой новой сессии

Начни сессию на репозитории `vacterro/zaicode`, ветке `saipen-live`, и
убедись, что агент на машине оператора сейчас не пишет.
Последнюю строку замени на `cc all <new list>`, чтобы передать новую работу.

```
Read CLAUDE.md and .claude/skills/saipen/SKILL.md, then cold-recover SAIPEN
state from .saipen/ on branch saipen-live (STATE.md, BOARD.md, tail of LOG.md).
Chat memory is not state; docs/ZAICODE_SAIPEN_CLOUD.md is the transport contract.

Setup (skip what already exists):
- saipen = python3 .claude/saipen-protocol/tools/saipen.py --project-root <repo root>
  (fetch the kernel per SKILL.md if it is missing); run `saipen rebind-home --auto`
  when saipen_home points at another machine.
- Product clone: git clone -b zaicode https://github.com/vacterro/zaicode zcode
  (gitignored here), then `pnpm install` inside zcode (Node 24, pnpm 10.33.2).
- Real-router tests: export ZAICODE_ROUTER_PACKAGE=/opt/9router/package if it exists.

Rules:
- Fetch origin/saipen-live and origin/zaicode before every commit and every push.
  If the other side moved, merge; never rebase, reset or force. If .saipen/
  histories diverged: keep ours on saipen-live-cloud-<sha>, write both ids to
  .saipen/LOG.md, stop and ask me.
- Product gates in zcode: pnpm typecheck, pnpm lint (0 errors),
  pnpm run architecture:check -- --changed, pnpm test. A gate that cannot run
  here is NOT RUN with the reason; a failure blamed on the environment must be
  shown to fail the same without the change.
- I authorize publishing verified product commits to origin/zaicode and SAIPEN
  checkpoints to origin/saipen-live.
- Nothing is PASS until I test on Windows and say PASS. A finished ticket waits
  in VERIFY with .saipen/evidence/T-###-*.md: its commits and the exact manual
  test steps.
- One writer at a time: if LOG shows the local agent mid-work, stop and ask.

cc
```

На машине оператора вотчер делает fast-forward `zcode` от
`origin/zaicode`; `REBUILD.cmd` (или `REBUILD_fast.lnk`) собирает, а следующий
старт ZAICODE подменяет сборку новой.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
