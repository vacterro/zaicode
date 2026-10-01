# ZAICODE SAIPEN облачен транспорт

Как този checkout и сесия на Claude Code Cloud изпълняват едно SAIPEN
работно пространство с различен локалитет на изпълнителите и къде е границата
между тях.

## Формата

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Един клон носи състоянието на протокола. Няма стъпка с merge, няма стъпка с
rebase и няма втори локален клон за подравняване: който изпълнител има
проверен чекпойнт, комитва и push-ва него, а другата страна го поема с
fast-forward.

`master` е предтранспортната история и публикуваният клон по подразбиране.
Той не се презаписва принудително от транспорта.

## Какво се пренася и какво не

Чекпойнт в това хранилище носи състоянието на протокола SAIPEN, основния
лаунчер, инсталатора, документацията и тези транспортни скриптове. Това е целият
слой на работното пространство.

Не носи **нито един байт продукт**. `zcode/` е отделно Git хранилище, изброено
в `.saipen/source-nested-repos.json` и игнорирано от git в този корен
(`/zcode/`). Продуктовата работа изисква собствен клонинг на `vacterro/zaicode` на клон
`zaicode`, а този клонинг е втори, независим обект със своя история.

Последствието се разбира трудно: чист `git status` в този корен не казва
нищо за некоммитирана продуктова работа, а `saipen-live` fast-forward не казва
нищо за продуктовия код. Проверявайте `git -C zcode status` изрично.

## Локалната половина

Два скрипта, и двата държани в хранилището, за да ги получава нова машина
от хранилището, а не от паметта:

| Файл | Роля |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | валидира, изравнява клона, инсталира и стартира watcher-а, записва автостарт запис, доказва local == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | цикълът: fetch, сравнение, fast-forward или push, лог, пауза; след това продуктовата проверка и self-update |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | round-trip от независим изпълнител плюс доказателство за възстановяване след студен старт |
| `tools/saipen-cloud/Test-ProductSync.ps1` | продуктова проверка и self-update върху еднодневни Git хранилища (без мрежа, без реален remote) |


Инсталиране и поправяне:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Работи идемпотентно. Машинното състояние живее в `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (копие), `ZAICODE_cloud-sync.log` (ротиран при
2 MB към `.log.1`), `ZAICODE_cloud-sync.lock` (единична инстанция),
`ZAICODE_cloud-sync.pid` и запис в папката Startup
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Инсталаторът отказва мръсно дърво и никога не го почиства. Ако всеки
мръсен път е канонично състояние на SAIPEN под `.saipen/`, той го
казва и отпечатва точните checkpoint команди; това е незаписено състояние
на протокола, не транспортна грешка, и инсталаторът няма да го commit-не
зад гърба на протокола.

## Поведение на watcher-а

| Ситуация | Действие |
|-----------|------|
| чисто, local е предшественик на remote | `git merge --ff-only` |
| чисто, remote е предшественик на local | `git push` |
| мръсно | пауза; дори без fetch |
| друг клон | пауза |
| двете страни напреднали, без общ предшественик | пауза, лог на двата commit id, без merge |
| fetch или мрежата се провалиха | лог degraded, повторение следващия tick |
| merge/rebase/cherry-pick е в ход | пауза |

Никога: force push, hard reset, stash, clean, checkout на чужд клон,
commit или спиране по име на процес. Инсталаторът спира watcher-а само по
pid-то, записано в неговия собствен pid файл.

Мръсно дърво не струва нищо, защото watcher-а проверява мръсото преди fetch.
Така че idle checkout изобщо не прави мрежови извиквания.

### Продуктова проверка (T-90)

`zcode/` е собствено хранилище, така че таблицата по-горе никога не
движи продуктовия код. След нея същият tick обработва продуктовия checkout
(`-ProductRepo`, по подразбиране `<repo>\zcode`; клон `-ProductBranch`, по подразбиране
`zaicode`). Продуктовата проверка работи независимо дали външното дърво
е мръсно. Винаги само pull.

| Ситуация | Действие |
|-----------|------|
| remote напред, тук няма dirty входен файл | `git merge --ff-only`; неcommitted продуктова работа остава както е |
| remote напред, входен файл тук е dirty | HELD: логва файловете, не merge-ва нищо |
| local напред | лог; **никога push** (продуктът се публикува от SAIPEN SHIP) |
| diverged | пауза, логва и двата id, не merge-ва нищо |
| друг клон, git операция в ход, fetch fail-нал | пауза |
| няма `zcode/` checkout, или `-NoProduct` | пропуснато |

git сам отказва fast-forward, който би презаписал local промяна, така че
HELD проверката е по-ранна, по-ясна защита, не единствената. Продуктовият
fast-forward не rebuild-ва нищо: за тест изпълни `pnpm bundle:zaicode` (или
dev preview).

### Самообновяване (T-90)

Watcher-ът работи като копие под `%APPDATA%\SAIPEN`, така че по-нов watcher в
repository-то никога не е пускан без reinstall. В loop режим сега сравнява
собствения си файл с commit-натото копие в repository-то при всеки pass. Инсталира
това копие върху себе си и рестартира точно веднъж, със същите аргументи,
само когато всички от следните са верни:

- двата файла се различават;
- копието в repository-то няма неcommit-ени промени;
- копието в repository-то парсва без грешки.

Копие, което не парсва, се отказва и логва, а работещият watcher
продължава.

Watcher-и, инсталирани преди T-90, нямат нито продуктовия pass, нито самообновяване.
Изпълни `Install-SaipenLiveSync.ps1` веднъж на такава машина; след това
watcher-ът се обновява сам.

## Облачната част

`CLAUDE.md` в root-а е входното правило, а
`.claude/skills/saipen/SKILL.md` е процедурата за изпълнение. Skill-ът fetch-ва
SAIPEN kernel от `github.com/vacterro/saipen` и го пуска през
обявената engine повърхност `tools/saipen.py`. Kernel-ът е pinned по commit
(`3088eff`), никога по tag. Tag `v8.0.1` е по-стар kernel със същия
`VERSION`; неговият `validate` мутира състояние, а validator-ът му отхвърля тази платка.

`STATE.saipen_home` записва kernel пътя на последния checkpoint-нат executor.
В облака първият `saipen continue` върху kernel `3088eff` го
конвергира към работещия kernel като един журнализиран `DEC` (E-1410). На
машината на оператора pointer-ът пристига мъртъв по същия начин. Kernel с
автоматична конвергенция поправя това при `continue`; иначе изпълни
`saipen rebind-home --auto`.

**Обратното връщане се наблюдава.** E-1562 (cloud) съвпадна указателя с
`/home/user/zaicode/.claude/saipen-protocol`; E-1571 (машината на оператора)
го върна директно обратно към `V:/.../_SAIPEN`, автоматично, без ръчен
`rebind-home`. И двете посоки са едно и също автоматично съвпадение — очаквайте
един `saipen_home` `DEC` при всяка смяна на локализация и го третирайте като
очакван шум, не като дефект. Остава шум, докато P1-2
(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) не измести указателя от versioning
състояние; не реализирайте P1-2 като страничен ефект от забелязването му. Никога
не редактирайте указателя ръчно.

`STATE.saipen_home` може да сочи към development checkout на ядрото, който е
напред от пина, а не към чист `3088eff` клон — на машината на оператора това е
`accepted-debt-rebind` клон с некоммитирана работа. Ядро, което не е на
пинован commit, не е автоматично грешно, но и не е clean-room
източник, така че правилото по-долу за гласовия договор се прилага към него с
цялата си сила. Никога не комитвайте, не stash-вайте, не reset-вайте, не checkout-вайте
и не почиствайте нищо в такъв checkout; целевото възстановяване на един
файл `saipen/STYLE.md` е единственото разрешено изключение и само когато
операторът го е поискал.

### STYLE.md не е локална настройка

`saipen/STYLE.md` трябва да е **байт-идентичен с файл-а на пинованото ядро** на
всяка машина, във всяка копия, без изключения и без локални редакции. На
машината на оператора има повече от едно копие:

- checkout-ът на ядрото в `STATE.saipen_home` (Git клонак, на машината
  на оператора — development checkout);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, запълнен от
  `saipen-inject` планирана задача (`bootstrap/schedule-run.ps1`). Тя **не е
  Git хранилище**, следователно `git checkout` никога не може да го поправи — resync през
  инжектора или пряко записване на публикуваното съдържание е единственият път.

`style_contract` токенът в `.saipen/STATE.md` е hash на текста на този файл
(`tools/validate.py`, `style_contract_token`: CRLF нормализиран, без
`style_contract:` реда). Редактирайте `reply_language` в едно копие и
токенът се променя; другото копие и cloud-ът, който дърпа публикуваното ядро,
пазят публикувания токен и всеки CLI запис от несъвпадащата страна
се отхвърля с `style_contract ... does not match the installed STYLE.md marker`.
Това е целият проблем: локалната страна записва състояние, което cloud-ът не може да запише.

**Промяната на езика на отговор е kernel commit плюс repin**, никога локална
редакция. Променете го в kernel хранилището, публикувайте го, ре-пинете commit-а в
SKILL.md и обновете `STATE.style_contract` чрез `saipen recover`. Локална
редакция на `STYLE.md` десинхронизира всяка машина, която не е тази, която я прави.

Една клопка, която си струва да се назовава: публикуваният `bin/saipen` е машинно-обвързан shim, който
втвърдява абсолютните пътища на interpreter-а и checkout-а на един оператор.
Работи на точно една машина. Cloud-ът трябва да използва `python3 tools/saipen.py`.

Съкращения: `cc` продължава текущия Work; `cc all <text>` поглъща цялото
съобщение като source/appends и продължава всеки допустим Work. Нито едно
не иска потвърждение за рутинни операции.

## Класификация на способностите

**AVAILABLE_IN_CLOUD** — състоянието на протокола и слойът на работната
среда. Четене и
запис на `.saipen/`, стартиращия модул (`tools/launcher/ZaicodeLauncher.cs`),
инсталатора под `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` и
скриптовете за транспорт. Git read, commit, push и fetch в `saipen-live`. Всеки
гейт, който е твърдение за файл, преглед на diff или текстова проверка.

**LOCAL_WINDOWS_ONLY** — гейтовете, които изискват тази машина.

| Гейт | Защо |
|------|-----|
| `tools\launcher\build.cmd` | компилира `ZaicodeLauncher.cs` с .NET Framework `csc`; няма Windows SDK в облачен образ |
| пакетираният Electron E2E (`zcode` desktop, Solo → queue → dispatch) | изисква десктоп сесия и настроен профил на доставчик |
| работещият 9router | Windows услуга на тази машина |
| интерактивен клик през десктопа | човек и екран |
| собствените runtime случаи на watcher-а | watcher-ът работи само на машината с checkout-а |

Тези се записват като локални граници на приемане. Никога
не се отчитат като успешни, защото diff-ът е изглеждал правилен.

**SAFE_TO_DEFER** — продуктовият слой. Облачна сесия може да клонира
`vacterro/zaicode` клон `zaicode` и да работи там. Работата по слоя на
средата не изисква продуктова работа, но изисква клона:
`.saipen/source-nested-repos.json` декларира `zcode/`, а без него
валидаторът се проваля с `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. Гейтовете на `pnpm`
изискват фиксирания pnpm 10.33.2 и подготвена работна среда. `pnpm bootstrap` на
свеж облачен образ е документираният начин за влизане, а `package.json` на
продукта вече го декларира.

Облакът може да провери само продуктови байтове, които са в `origin/zaicode`.
Продуктова промяна, съществуваща само в checkout-а на `zcode/` на
оператора, тук е невидима, затова всеки продуктов гейт за нея е NOT RUN в
облака, какъвто и да е гейтът. T-84 е първият случай (E-1411): поправката му
беше само локална, докато `origin/zaicode` все още носеше кода преди поправката.

**UNSAFE_TO_EMULATE** — всичко, което би направило локален гейт да изглежда
успешен. Не замествай стартиращия модул, не симулирай стартиране на
пакетирано приложение, не възпроизвеждай записан
`pnpm verify:pre-push` резултат сякаш току-що е стартирал, и не превръщай „кодът
изглежда правилен“ в PASS ред в `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — съответствие, което зависи от това къде е
checkout-ът. На ядро `3088eff` облачният валидатор отчита
`closure-evidence` FAIL (T-47, T-62, T-76, T-78 към момента на писане), които
машината на оператора не отчита.

Ядрото премества всеки LOG събитие над 1024 байта в
`.saipen/recovery/log-detail/` страничен файл. При четене възстановява страничния файл
само когато абсолютният път на checkout-а съвпада с пътя, от който е
записан. Следователно дълъг VERIFY вердикт, записан на Windows, е
нечетим в облака, и обратното също важи.

Дефектът е в ядрото и е заведен като P1-1 в
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Докато не бъде интегриран:

- цитирай verdict-а от облака и го класифицирай като този boundary, билет по билет
  (`SKILL.md` § 6 съдържа проверката);
- никога не пренаписвай sidecar-и, не ре-верифицирай само за зелено, не пейч ядро
  копия;
- дръж LOG събитията под 1024 байта от двете страни.

Същото свързване с машинния път блокира и работата. Дълговата базова линия преди BUILD
се улавя при първото влизане на билета в BUILD и се проверява отново при всяко
следващо влизане. Билет, записан за първи път в BUILD на операторската машина, следователно
не може да влезе в BUILD в облака: преходът се отказва с
`DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 е записаният случай: DEBT-000079 беше
уловен на E-1377, а преходът отказан на E-1446. Остави такъв билет на машината,
която е уловила базовия му текст.

## Разминаване

Ако локалното и отдалеченото споделят предшественик, watcher-ът спира. Не
слива, не преизгражда, не форсира. Двата commit id отиват в лога, поправката е
`git log --left-right --cherry-pick <branch>...origin/<branch>` на ръка, а
резултатът се checkpoint-ва като всяка друга промяна.

## Точното действие от облачната страна

### Скрипт за настройка на средата (еднократно, в настройките на облачната среда)

Меню на облачната среда в лентата за заглавие на сесията -> Edit -> Setup script. Той
работи преди всяка нова сесия, така че всяка сесия започва с готовия продуктов
toolchain:

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

### Prompt-ът за всяка нова сесия

Започни сесията на repository `vacterro/zaicode`, branch `saipen-live` и
увери се, че агентът на операторската машина не пише по същото време.
Замени последния ред с `cc all <new list>`, за да предадеш новата работа.

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

На операторската машина watcher-ът прави fast-forward на `zcode` от
`origin/zaicode`; `REBUILD.cmd` (или `REBUILD_fast.lnk`) го билдва, а
следващият старт на ZAICODE замества новия билд.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
