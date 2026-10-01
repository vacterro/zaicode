# ZAICODE SAIPEN хмарний транспорт

Як цей checkout і сесія Claude Code Cloud запускають один workspace SAIPEN
з різною локальністю виконавців і де межа між ними.

## Форма

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Одна гілка несе стан протоколу. Ні кроку merge, ні кроку rebase,
ні другої локальної гілки для синхронізації: який виконавець має
перевірений checkpoint — той комітить і пушить, а інша сторона
приймає його через fast-forward.

`master` — це історія до транспорту та опублікована гілка за замовчуванням. Вона
не оновлюється примусово транспортом.

## Що їде, а що ні

Checkpoint у цьому репозиторії несе стан протоколу SAIPEN, кореневий
launcher, інсталятор, документацію та ці транспортні скрипти. Це весь
шар workspace.

Він не містить **жодного байта продукту**. `zcode/` — це окремий репозиторій Git,
зазначений у `.saipen/source-nested-repos.json` і доданий до gitignore у цьому корені
(`/zcode/`). Робота над продуктом потребує власного clone `vacterro/zaicode` на гілці
`zaicode`, і цей clone — другий незалежний об'єкт із власною історією.

Наслідок легко зрозуміти неправильно: чистий `git status` у цьому корені нічого
не каже про незакомічену роботу над продуктом, а fast-forward `saipen-live`
нічого не каже про код продукту. Перевіряйте `git -C zcode status` явно.

## Локальна половина

Два скрипти, обидва належать репозиторію, щоб нова машина отримала їх із репозиторію,
а не з пам'яті:

| Файл | Роль |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | перевіряє, синхронізує гілку, встановлює й запускає watcher, записує запис автозапуску, доводить, що local == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | цикл: fetch, порівняння, fast-forward або push, журнал, пауза; потім продуктовий прохід і самооновлення |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | round-trip з незалежного виконавця плюс доказ відновлення після перезапуску |
| `tools/saipen-cloud/Test-ProductSync.ps1` | продуктовий прохід і самооновлення на одноразових Git-репозиторіях (без мережі, без справжнього remote) |

Встановлення та відновлення:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Ідемпотентно. Локальний стан машини живе в `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (копія), `ZAICODE_cloud-sync.log` (ротовано на
2 MB до `.log.1`), `ZAICODE_cloud-sync.lock` (один екземпляр),
`ZAICODE_cloud-sync.pid` та запис у теці Startup
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Інсталятор відмовляє на брудному дереві й ніколи його не чистить. Якщо кожен брудний шлях — це канонічний стан SAIPEN у `.saipen/`, він повідомляє про це й друкує точні
команди для checkpoint; це не збій транспорту, а непротокольний стан, і інсталятор не робитиме commit за спиною в протоколу.

## Поведінка watcher

| Ситуація | Дія |
|-----------|------|
| чисто, local є предком remote | `git merge --ff-only` |
| чисто, remote є предком local | `git push` |
| брудно | пауза; навіть без fetch |
| інша гілка | пауза |
| обидві просунулися, немає спільного предка | пауза, залогуювати обидва commit id, нічого не мержити |
| fetch або мережа не вдалася | залогувати погіршення, повторити на наступному тіку |
| триває merge/rebase/cherry-pick | пауза |

Ніколи: force push, hard reset, stash, clean, checkout чужої гілки,
commit або зупинка за назвою процесу. Інсталятор зупиняє watcher лише за
pid, який сам записав у власний pid-файл.

Брудне дерево нічого не варте, бо watcher перевіряє бруд перед тим, як робити fetch.
Тож простоюючий checkout узагалі не робить жодних мережевих викликів.

### Продуктовий прохід (T-90)

`zcode/` є власним репозиторієм, тож таблиця вище ніколи не переміщує продуктовий
код. Після нього той самий тік обробляє checkout продукту (`-ProductRepo`,
за замовчуванням `<repo>\zcode`; гілка `-ProductBranch`, за замовчуванням `zaicode`).
Продуктовий прохід виконується незалежно від того, чи зовнішнє дерево брудне. Він лише pull.

| Ситуація | Дія |
|-----------|------|
| remote попереду, жоден вхідний файл тут не змінено | `git merge --ff-only`; незакомічені продуктові зміни залишаються як є |
| remote попереду, вхідний файл тут змінено | HELD: залогуювати файли, не мерджити нічого |
| local попереду | залог; **ніколи не пушиться** (продукт публікує SAIPEN SHIP) |
| розійшлися | пауза, залогуювати обидва id, не мерджити нічого |
| інша гілка, триває git-операція, fetch не вдався | пауза |
| немає checkout `zcode/`, або `-NoProduct` | skipped |

git сам відхиляє fast-forward, який перезаписав би локальну зміну, тому
перевірка HELD — раніший, зрозуміліший запобіжник, а не єдиний.
Продуктовий fast-forward нічого не перебудовує: для перевірки запустити `pnpm bundle:zaicode`
(або dev-прев'ю).

### Самооновлення (T-90)

Watcher працює як копія під `%APPDATA%\SAIPEN`, тому новіший watcher у репозиторії
ніколи не запускався без перевстановлення. У цикліному режимі він тепер
кожен прохід порівнює свій файл із коміченою копією в репозиторії. Він
встановлює цю копію поверх себе і перезапускається рівно один раз, з тими
самими аргументами, лише коли виконуються всі ці умови:

- два файли відрізняються;
- копія в репозиторії не має незакомічених змін;
- копія в репозиторії парситься без помилок.

Копію, що не парситься, відхилено й залоговано; запущений watcher
працює далі.

Watchers, встановлені до T-90, не мають ні продуктового проходу, ані
самооновлення. На такій машині один раз перезапустити `Install-SaipenLiveSync.ps1`; далі
watcher оновлює себе сам.

## Хмарна половина

`CLAUDE.md` у корені — це правило входу, а
`.claude/skills/saipen/SKILL.md` — процедура виконання. Skill завантажує
ядро SAIPEN з `github.com/vacterro/saipen` і запускає його через
оголошену поверхню рушія `tools/saipen.py`. Ядро прив'язане комітом
(`3088eff`), ніколи тегом. Тег `v8.0.1` — старіше ядро з тим самим
`VERSION`; його `validate` змінює стан, а його валідатор відхиляє цю дошку.

`STATE.saipen_home` записує шлях ядра того executor, який останнім
зробив checkpoint. У хмарі перший `saipen continue` на ядрі `3088eff` зводить
його до запущеного ядра як один журнальований `DEC` (E-1410). На
машині оператора вказівник приходить мертвим так само. Ядро з авто-
зведенням відновлює його на `continue`; інакше запустити
`saipen rebind-home --auto`.

**Зворотний шлях спостерігається.** E-1562 (cloud) звів покажчик до
`/home/user/zaicode/.claude/saipen-protocol`; E-1571 (машина оператора)
звів його просто назад до `V:/.../_SAIPEN`, автоматично, без ручного
`rebind-home`. Обидва напрями — те саме автоматичне зведення, тож очікуйте
один `saipen_home` `DEC` на кожну зміну локальності і вважайте це очікуваним шумом,
а не дефектом. Це лишається шумом, доки P1-2
(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) не виведе покажчик із версіонованого
стану; не реалізуйте P1-2 як побічний ефект помічання. Ніколи не редагуйте
покажчик вручну.

`STATE.saipen_home` може вказувати на **робочу копію розробки** ядра, опережающу пін, а не на чистий клон `3088eff` — на машині оператора це
гілка `accepted-debt-rebind` з незакоміченими змінами. Ядро не на пін-коміті не є автоматично помилковим, але й не є чистим джерелом,
тому правило нижче про контракт голосу діє на нього повною силою. Ніколи не комітьте, не stash-те, не скидайте, не перемикайте й не чистіть нічого в такій
робочій копії; лише цільове відновлення одного файлу `saipen/STYLE.md` — єдиний
дозволений виняток, і тільки коли оператор цього попросив.

### STYLE.md — не локальне налаштування

`saipen/STYLE.md` має бути **побайтово ідентичним файлу запінованого ядра** на
кожній машині, в кожній копії, без винятків і без локальних правок. На машині
оператора є більше ніж одна копія:

- робоча копія ядра в `STATE.saipen_home` (клон Git; на машині
  оператора — робоча копія розробки);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, заповнювана
  запланованою задачею `saipen-inject` (`bootstrap/schedule-run.ps1`). Це **не
  Git-репозиторій**, тому `git checkout` ніколи не зможе її полагодити — лише повторна синхронізація через інжектор або прямий запис опублікованого вмісту дають шлях.

`style_contract`-токен у `.saipen/STATE.md` — це хеш тексту цього файлу
(`tools/validate.py`, `style_contract_token`: CRLF нормалізовано, рядок
`style_contract:` виключено). Змініть `reply_language` в одній копії — і токен
зміститься; інша копія та хмара, які беруть опубліковане ядро,
зберігають опублікований токен, і кожен CLI-запис з боку, що не збігається,
відхиляється з `style_contract ... does not match the installed STYLE.md marker`.
Це і є весь збій: локальна сторона пише стан, який хмара написати не може.

**Зміна мови відповіді — це коміт ядра плюс перепінінг**, ніколи локальна
правка. Змініть її в репозиторії ядра, опублікуйте, перепініть коміт у
SKILL.md і оновіть `STATE.style_contract` через `saipen recover`. Локальна
правка `STYLE.md` розсинхронізує кожну машину, крім тієї, що її робить.

Одна пастка, варта згадати: опублікований `bin/saipen` — це прив'язаний до машини шеп, який
жорстко задає абсолютні шляхи до інтерпретатора та робочої копії одного оператора. Він працює
рівно на одній машині. Хмара має використовувати `python3 tools/saipen.py`.

Короткі команди: `cc` продовжує поточну Work; `cc all <text>` сприймає весь
повідомлення як джерело/appends і продовжує кожну придатну Work. Жодна не питає
підтвердження для рутинних дій.

## Класифікація можливостей

**AVAILABLE_IN_CLOUD** — стан протоколу та шар workspace. Читання і запис `.saipen/`, лаунчер (`tools/launcher/ZaicodeLauncher.cs`), інсталятор у `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` і транспортні скрипти. Git: читання, commit, push і fetch у `saipen-live`. Будь-який gate, що є перевіркою файлу, оглядом diff або текстовою перевіркою.

**LOCAL_WINDOWS_ONLY** — gate, які потребують цієї машини.

| Gate | Чому |
|------|-----|
| `tools\launcher\build.cmd` | компілює `ZaicodeLauncher.cs` через .NET Framework `csc`; на хмарному образі немає Windows SDK |
| packaged Electron E2E (`zcode` desktop, Solo → queue → dispatch) | потрібен desktop-сеанс і заповнений профіль провайдера |
| живий 9router | Windows-служба на цій машині |
| інтерактивний desktop click-through | людина й екран |
| власні runtime-кейси watcher | watcher запускається лише на машині, де лежить checkout |

Це зафіксовано як локальні межі приймання. Їх ніколи не позначають пройденими лише тому, що diff виглядав правильним.

**SAFE_TO_DEFER** — продуктовий шар. Хмарна сесія може клонувати `vacterro/zaicode` гілку `zaicode` і працювати там. Робота над шаром workspace не потребує роботи над продуктом, але потребує самого клону: `.saipen/source-nested-repos.json` оголошує `zcode/`, і без нього валідатор завершується помилкою через `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. Gate'и `pnpm` потребують зафіксованого pnpm 10.33.2 та підготовленого workspace. `pnpm bootstrap` на свіжому хмарному образі — задокументований спосіб входу, а `package.json` продукту вже оголошує його.

Хмара може перевіряти лише ті байти продукту, що є на `origin/zaicode`. Продуктова дельта, яка існує тільки в checkout оператора `zcode/`, тут невидима — тож кожен продуктовий gate для неї у хмарі має статус NOT RUN, незалежно від виду gate. T-84 — перший випадок (E-1411): його виправлення було лише локальним, поки `origin/zaicode` ще містив код до виправлення.

**UNSAFE_TO_EMULATE** — усе, що зробило б локальний gate зеленим. Не підміняйте збірку лаунчера, не імітуйте запуск зібраного застосунку, не відтворюйте записаний результат `pnpm verify:pre-push` так, наче він щойно виконався, і не перетворюйте «код виглядає правильним» на рядок PASS у `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — відповідність, що залежить від того, де лежить checkout. На kernel `3088eff` хмарний валідатор повідомляє про FAIL у `closure-evidence` (T-47, T-62, T-76, T-78 на момент написання), яких немає на машині оператора.

Kernel переміщує будь-яку подію LOG понад 1024 байти у sidecar `.saipen/recovery/log-detail/`. Під час читання він відновлює sidecar лише тоді, коли абсолютний шлях checkout дорівнює шляху, з якого його записано. Тому довгий вердикт VERIFY, записаний на Windows, не читається у хмарі, і навпаки.

Дефект у kernel, заведений як P1-1 у `docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Доки це не приземлиться:

- цитувати вердикт хмари та класифікувати його як цю межу, тікет за тікетом
  (`SKILL.md` § 6 містить перевірку);
- ніколи не переписувати сайдкари, не перевіряти повторно заради зеленого стану
  і не патчити копію ядра;
- тримати LOG-події меншими за 1024 байти з обох боків.

Прив'язка до тієї самої машинної шляхи також блокує роботу. Базова лінія
боргу до BUILD фіксується вперше, коли тікет входить у BUILD, і
перевіряється щоразу при наступному вході. Отже, тікет, який уперше
увійшов у BUILD на машинці оператора, не може увійти у BUILD у хмарі:
перехід відхиляється з `DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 — це зафіксований
випадок: DEBT-000079 зафіксовано на E-1377, а перехід відхилено на
E-1446. Залиште такий тікет тій машині, яка зафіксувала його базову
лінію.

## Розходження

Якщо локальна та віддалена гілки втратили спільного предка, watcher
зупиняється. Він не мержить, не робить rebase і не застосовує force.
Обидва commit id потрапляють у лог, виправлення вноситься
вручну з `git log --left-right --cherry-pick <branch>...origin/<branch>`, а
результат зберігається як будь-яка інша зміна.

## Точна дія на боці хмари

### Скрипт налаштування середовища (один раз, у налаштуваннях хмарного середовища)

Меню Cloud environment у панелі заголовка сесії -> Edit -> Setup script. Він
виконується перед кожною новою сесією, тож кожна сесія стартує з готовим
продуктовим toolchain:

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

### Промпт для кожної нової сесії

Почніть сесію на репозиторії `vacterro/zaicode`, гілці `saipen-live` і
переконайтеся, що агент на машинці оператора не пише водночас.
Замініть останній рядок на `cc all <new list>`, щоб передати нову роботу.

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

На машинці оператора watcher робить fast-forward `zcode` з
`origin/zaicode`; `REBUILD.cmd` (або `REBUILD_fast.lnk`) збирає його, а
наступний запуск ZAICODE підставляє нову збірку.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
