# ZAICODE 설치

ZAICODE는 하나로 작동하는 세 프로젝트입니다: ZAICODE 앱, 에이전트 작업을
정돈해 주는 프로토콜인 SAIPEN, 그리고 에이전트들이 서로 소식을 전하는
메일인 SAIMAIL. 직접 설치하면 클론 세 번, Node.js 툴체인, Python
환경, 빌드가 필요합니다. 설치 프로그램이 이를 모두 처리합니다:
실행하고 기다리면 바탕화면에 ZAICODE 바로 가기가 생깁니다.

## 원클릭

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  다운로드, 더블클릭, **INSTALL** 누르기. 창(어두운 배경에 금색, SAIPEN
  배너)이 실행되는 모든 단계, 지금까지 걸린 시간, 필요할 때 로그를
  표시합니다. 마지막에 **START ZAICODE**, 단계가 끝나지 않았을 때는
  **TRY AGAIN** / **Autotroubleshoot** / **Open log**. 기존 ZAICODE 폴더를
  지정하면 버튼이 **UPDATE**로 표시됩니다: 같은 실행으로 업데이트와
  수리가 함께 됩니다. 이 exe는 설치 스크립트를 품고 있어 곁에
  아무것도 필요 없습니다. `install\setup\build.cmd`로 빌드됩니다(Windows 10/11
  모두에 있는 .NET Framework 컴파일러).
- `install\Setup-ZAICODE.cmd` (더블클릭): 콘솔에서 하는 동일한 설치.
- 아무것도 없는 상태에서 PowerShell로:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

설정 옵션: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE`(프리셋 폴더),
`/auto`(한 번에 시작), `/quiet`(창 없음: 콘솔 설치 프로그램, 종료 코드
= 결과). 첫 실행은 이 컴퓨터에서 앱을 빌드하므로 시간이 걸리고,
이후 실행은 업데이트와 복구만 함.

## 무료 모델, 설정할 것 없음

앱이 자체 9router를 포함함. 컴퓨터에 없으면 ZAICODE가 비공개로 실행함
(격리 모드, 포트 20138), 키 없이 가능한 무료 티어로 **SAIFREN**을 채우고
`SAIRoute / SAIFREN`을(를) 새 작업의 모델로 지정하므로 New task에 처음 입력한 작업에
답이 옴: 키 없음, 계정 없음, 설정 없음. Claude Code, Codex, Antigravity
로그인은 선택 사항이며, 컴퓨터에 설정 안 된 로그인은 "선택 사항, 언제든 로그인"
으로 표시되고 "처리 필요" 항목으로 뜨지 않음.
확인: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
빈 프로필(자체 HOME, APPDATA, LOCALAPPDATA)에서 패키지된 앱을 실행하고,
라우터가 격리되어 있고 SAIFREN이 첫 토큰 탐침에 답하며 New task의 작업에
답이 올 때만 통과함.

## 업데이트: 네 부분, 하나의 ZAICODE

워크스페이스(런처, 설치 프로그램), 앱, SAIPEN, SAIMAIL은 네 개의 클론임.
각각 독립 업데이트: **Settings -> ZAICODE -> Updates**에서 버전과 커밋과 함께
나열되고, 개별 또는 전체 업데이트 가능하며, 부분별로 "자체적으로" 스위치가
있음(설치된 ZAICODE에서는 기본 켜짐, 개발자 체크아웃에서는 꺼짐). ZAICODE는
시작 후 몇 분 뒤, 이후 6시간마다 확인함. 업데이트 후 각 부분에 필요한 것만
적용: 앱은 의존성(`pnpm-lock.yaml` 이동 시)과 새 빌드(ZAICODE 실행 중 준비해 두고
다음 시작 때 적용), SAIPEN은 런처, SAIMAIL은 `.venv` 설치, 워크스페이스는
새 루트 런처. 다른 브랜치에 있거나, 로컬 커밋이 있거나, 업데이트가 덮어쓸
수 있는 수정이 있으면 보고만 하고 그대로 둠.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## 하는 일

설치 프로그램은 빈 폴더에서 "repair"로 실행되는 Autotroubleshoot 검사들임,
이 순서로 진행. 각 단계는 멱등이라 다시 실행하면 설치가 업데이트되고
고장 난 부분이 복구됨.

| 검사 | 복구 |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | 적합하면 컴퓨터 사본을 사용하고, 아니면 `.tools\`에 사사본 사용(Git for Windows의 MinGit, nodejs.org의 Node.js 24.14.0, NuGet 패키지의 Python). 관리자 권한 불필요. |
| pnpm | `.tools\pnpm10`에 고정된 pnpm 10.33.2 |
| ZAICODE 워크스페이스 | `vacterro/zaicode` 브랜치 `master` 클론(런처 소스, 설치 프로그램, 문서; 개발자의 `.saipen/` 메모리는 제외; `workspace` 브랜치는 2026-09-27까지) |
| ZAICODE 앱 소스 | `zaicode` 브랜치를 `zcode\`(으)로 클론 |
| SAIPEN | `vacterro/saipen`(으)를 `saipen\`(으)로 클론; 이 클론과 이 Python용으로 `bin\saipen.cmd` 작성 |
| SAIMAIL | `vacterro/saimail`(으)를 `saimail\`(으)로 클론, `.venv\`에 설치 |
| saimail-local | SAIMAIL의 명령줄 클라이언트, ZAICODE의 SAIMAIL 패널들이 사용(SAIMAIL `0.0.2a3`부터 포함; `saimail-cli` 검사가 OK 보고) |
| 9router 패키지 | npm에서 `9router`을(를) `.tools\router`(으)로 받아 번들 포함, SAIFREN이 설정 없이 동작(npm 접근 실패 시 WARN) |
| 앱 의존성 | `pnpm install --frozen-lockfile` (`pnpm-lock.yaml` 변경 시 다시) |
| 앱 빌드 | `pnpm bundle:zaicode`; ZAICODE 실행 중에는 새 빌드를 준비해 두고 다음 시작 때 교체 |
| 준비된 빌드 교체 | 긴 경로 교체 실패로 남은 `win-unpacked.previous` 정리, ZAICODE가 닫힌 동안 대기 중인 빌드 교체 |
| 루트 런처 | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| 바로 가기 | 바탕 화면과 시작 메뉴 `ZAICODE` -> `ZAICODE.exe` |
| Claude / Codex 로그인 | 보고만: 모든 `~\.claude*` / `~\.codex*` 로그인은 ZAICODE에서 자체 엔진(A1, A2, C1, ...); 로그인은 브라우저에서 사용자 처리 필요 |

루트 런처는 ZAICODE를 설치된 SAIPEN(`saipen\`)에 연결하고
앱의 PATH 맨 앞에 `.tools\`과(와) `.venv\Scripts`를 넣어, 앱과 에이전트와
워커가 설치된 사본을 쓰게 함.

## 여러 구독

모든 Claude Code 또는 Codex 로그인은 각자 전용 홈에 저장됩니다: `~\.claude`,
`~\.claude-account2`, ... 및 `~\.codex`, `~\.codex-account2`, ... ZAICODE는
전부 찾아냅니다. 설치 시 더 많이 준비하려면:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

설치 프로그램이 홈들을 만들고 각 항목의 정확한 로그인 명령을 출력합니다
(`$env:CODEX_HOME = '...'; codex login`). ZAICODE 내에서도 동일: Settings ->
Engines & limits -> 다른 로그인 추가.

## 자동 문제 해결

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

검사 항목별 상태: OK, FIXED (고장났던 것, 복구됨), WARN (동작하지만 선택적
구성 요소 누락), INFO (사용자 조치 필요: 로그인), FAIL. 로그는
`install\logs\`에 있으며, 마지막 설치 요약은 `install\install-report.json`입니다.
앱에서 Router -> Autotroubleshoot은 실행 중인 라우터와 풀을 복구합니다.

## 옵션

| 매개변수 | 기본값 | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | 모든 항목이 설치되는 위치 |
| `-ShortcutDir` | Desktop | ZAICODE 바로가기 위치 |
| `-NoStartMenu`, `-NoShortcut` | | 해당 바로가기 건너뛰기 |
| `-PortableTools` | | 컴퓨터에 있어도 전용 Git / Node.js / Python 설치 |
| `-Launch` | | 완료 후 ZAICODE 시작 |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | GitHub 저장소 | 다른 소스(포크, 로컬 클론 경로) |

## 검증

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
은(는) 새 설치 상태를 검사하고, 고장 요소를 삽입합니다(바로가기와 런처 삭제, SAIPEN
런처가 없는 Python을 가리킴, SAIMAIL의 venv 삭제, 다른 lockfile용으로
기록된 node_modules, MAX_PATH보다 깊은 잔여 빌드 폴더),
doctor가 모든 항목을 보고하고 복구했음을 단언한 뒤, 격리 프로필로
바로가기 대상을 시작하고 자신이 시작한 프로세스 트리만 정확히 종료합니다.

`install\tests\Test-ZaicodeUpdate.ps1`은(는) 디스크에 네 개의 일회용 저장소와 그 클론의 설치를
만든 뒤, 검사 하나가 아무것도 바꾸지 않는지, 한 파트가 후속 조치
(SAIPEN 런처, 루트 런처)만 업데이트되는지, 겹치는 로컬 수정과 로컬
커밋이 보존되는지, 알 수 없는 파트 이름은 거부되는지를 증명합니다. 네트워크 없음.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
