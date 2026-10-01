# Инсталиране на ZAICODE

ZAICODE са три проекта, които работят като един: приложението ZAICODE, SAIPEN (протоколът, който държи работата на агентите под контрол) и SAIMAIL (пощатата, с която агентите си съобщават). Ръчното им инсталиране означава три клонирания, Node.js
среда за разработка, Python среда и build. Инсталаторът върши всичко това:
стартирайте го, изчакайте и на десктопа има пряк път до ZAICODE.

## Едно кликване

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  изтеглете, двоен клик, натиснете **INSTALL**. Прозорецът (златно върху тъмно,
  банерът на SAIPEN) показва всяка стъпка докато тече, изминалото време и
  log при поискване; накрая **START ZAICODE** или **TRY AGAIN** /
  **Autotroubleshoot** / **Open log**, когато дадена стъпка не е завършила.
  Ако сочи към съществуваща папка на ZAICODE, бутонът пише **UPDATE**: същото
  пускане обновява и поправя. exe файлът съдържа скриптовете за инсталация и
  не се нуждае от нищо до себе си; той е изграден от
  `install\setup\build.cmd` (компилаторът на .NET Framework, който всеки Windows 10/11
  има).
- `install\Setup-ZAICODE.cmd` (двоен клик): същата инсталация в конзола.
- От нулата, в PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Опции за настройка: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (избрана папка),
`/auto` (стартира веднага), `/quiet` (без прозорец: конзолният инсталатор, код на изход
= резултат). Първият старт изгражда приложението на тази машина, което отнема време;
следващите стартове само обновяват и поправят.

## Безплатни модели, нищо за настройване

Приложението си идва със собствен 9router. На машина без такъв ZAICODE го стартира
частно (изолиран режим, порт 20138), запълва **SAIFREN** от безплатни нива без ключ и прави `SAIRoute / SAIFREN` модел на новите задачи, така че първата задача, въведена в Нова задача, получава отговор: без ключ, без акаунт, без настройка. Входът с Claude Code, Codex и Antigravity е незадължителен; вход, който никога не е настроен на машината, се показва като „незадължителен, влезте по всяко време“, а не като елемент „нуждае се от вас“.
Доказателство: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
стартира пакетираното приложение с празен профил (собствени HOME, APPDATA и LOCALAPPDATA) и минава само когато маршрутизаторът е изолиран, SAIFREN отговаря на проверката за първи токен и задача в Нова задача получава отговор.

## Обновления: четири части, един ZAICODE

Работното пространство (стартерът, инсталаторът), приложението, SAIPEN и SAIMAIL
са четири клона. Всеки се обновява сам: **Настройки -> ZAICODE -> Обновления**
ги изброява с версията и комита им, обновява по едно или всичките и има
превключвател „самостоятелно" за всяка част (включен по подразбиране при
инсталиран ZAICODE, изключен в разработчишка копия). ZAICODE проверява няколко
минути след старта и после на всеки шест часа. След обновяване всяка част
получава нужното: приложението — зависимостите си (когато `pnpm-lock.yaml` е преместен)
и нова сборка (подготвена, докато ZAICODE работи, стартирана при следващия
старт), SAIPEN — своя стартер, SAIMAIL — своята
`.venv` инсталация, работното пространство — нов основен стартер. Клон в друг
branch, с локални комити или с редакции, които обновяването би презаписало, се
докладва и остава точно както е.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Какво прави

Инсталаторът са проверките на Autotroubleshoot, стартирани с „repair" в празна
папка, в този ред. Всяка стъпка е идемпотентна, така че повторният старт
обновява инсталацията и поправя счупеното.

| Проверка | Поправка |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | ползва копието на машината, ако отговаря на условията; иначе частно копие в `.tools\` (MinGit от Git for Windows, Node.js 24.14.0 от nodejs.org, Python от неговия NuGet пакет). Без права на администратор. |
| pnpm | фиксирания pnpm 10.33.2 в `.tools\pnpm10` |
| Работно пространство на ZAICODE | клон на `vacterro/zaicode` branch `master` (изходен код на стартера, инсталатор, документация; паметта на разработчика `.saipen/` се изключва; branch `workspace` до 2026-09-27) |
| Изходен код на приложението ZAICODE | клон на branch `zaicode` в `zcode\` |
| SAIPEN | клон на `vacterro/saipen` в `saipen\`; неговият `bin\saipen.cmd` е написан за този клон и този Python |
| SAIMAIL | клон на `vacterro/saimail` в `saimail\`, инсталиран в `.venv\` |
| saimail-local | команден клиент на SAIMAIL, който ползват панелите на SAIMAIL в ZAICODE (доставен от SAIMAIL `0.0.2a3`; проверката `saimail-cli` докладва OK) |
| 9router пакет | `9router` от npm в `.tools\router`, пакетиран, така че SAIFREN работи без никаква настройка (WARN, ако npm не може да го достигне) |
| Зависимости на приложението | `pnpm install --frozen-lockfile` (отново при промяна на `pnpm-lock.yaml`) |
| Сборка на приложението | `pnpm bundle:zaicode`; докато ZAICODE работи, новата сборка се подготвя и влиза при следващия старт |
| Смяна на подготвена сборка | изчиства останен `win-unpacked.previous` от неуспешна смяна с дълъг път и вмъква чакащата сборка, докато ZAICODE е затворен |
| Основен стартер | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Препратки | Работен плот и меню „Старт" `ZAICODE` -> `ZAICODE.exe` |
| Входове в Claude / Codex | само се докладват: всеки вход в `~\.claude*` / `~\.codex*` е отделен двигател в ZAICODE (A1, A2, C1, ...); входът изисква действия от вас, в браузъра |

Основният стартер насочва ZAICODE към инсталирания SAIPEN (`saipen\`) и слага
`.tools\` и `.venv\Scripts` в началото на PATH на приложението, така че приложението,
агентите му и работниците му да ползват инсталираните копия.

## Няколко абонамента

Всеки вход за Claude Code или Codex има свой собствен home: `~\.claude`,
`~\.claude-account2`, ... и `~\.codex`, `~\.codex-account2`, ... ZAICODE намира
всички. За да подготвите повече при инсталиране:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Инсталаторът създава homes и отпечатва точната команда за вход за всеки
(`$env:CODEX_HOME = '...'; codex login`). Същото е и в ZAICODE: Настройки ->
Двигатели и лимити -> добави още един вход.

## Автоотстраняване на проблеми

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Състояние за всяка проверка: OK, FIXED (беше счупено, поправено), WARN (работи, но липсва нещо
незадължително), INFO (нуждае се от вас: вход), FAIL. Логовете са в
`install\logs\`; резюмето на последната инсталация е `install\install-report.json`.
В приложението: Рутер -> Autotroubleshoot поправя работещия рутер и пулове.

## Опции

| Параметър | По подразбиране | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | къде отива всичко |
| `-ShortcutDir` | Desktop | къде отива прекият на ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | пропусни тези преки |
| `-PortableTools` | | частен Git / Node.js / Python дори когато машината ги има |
| `-Launch` | | стартирай ZAICODE при завършване |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | GitHub хранилищата | друг източник (fork, локален clone път) |

## Доказателство

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
проверява нова инсталация, създава неизправности (прекът и launcher изтрити, launcher на
SAIPEN сочи към липсващ Python, venv на SAIMAIL изтрит, node_modules записан за
друг lockfile, остатъчна build папка по-дълбока от MAX_PATH),
утвърждава, че doctor докладва и поправя всяка, после стартира целта на прека с
изолиран профил и спира точно дървото процеси, което е стартирал.

`install\tests\Test-ZaicodeUpdate.ps1` създава четири еднократни хранилища на
диск и инсталация на техните клони, после доказва, че проверка не променя нищо,
че една част се обновява сама с последващата си поправка (launcher на SAIPEN, root
launcher), че припокриващи се локални редакции и локални commit-и се запазват и че
непознато име на част се отхвърля. Без мрежа.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
