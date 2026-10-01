# ZAICODE SAIPEN 클라우드 전송

이 체크아웃과 Claude Code Cloud 세션이 하나의 SAIPEN 워크스페이스를
서로 다른 실행자 위치에서 구동하는 방식, 그리고 둘 사이의 경계.

## 구조

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

하나의 브랜치가 프로토콜 상태를 담습니다. 병합 단계도, 리베이스 단계도,
맞춰kept는 두 번째 로컬 브랜치도 없습니다. 검증된 체크포인트를 가진 실행자가
이를 커밋·푸시하고, 반대쪽은 fast-forward로 받습니다.

`master`은(는) 전송 이전 이력과 게시된 기본 브랜치입니다. 전송에 의해
force-update되지 않습니다.

## 이동하는 것과 이동하지 않는 것

이 저장소의 체크포인트는 SAIPEN 프로토콜 상태, 루트 런처, 인스톨러,
문서와 이 전송 스크립트를 담습니다. 이것이 전부 워크스페이스 레이어입니다.

**제품 바이트는 전혀 담지 않습니다.** `zcode/`은(는) 별도의 Git 저장소로,
`.saipen/source-nested-repos.json`에 등록되어 있고 이 루트에서는 gitignore 대상
(`/zcode/`)입니다. 제품 작업에는 브랜치 `zaicode`의 `vacterro/zaicode` 자체
클론이 필요하며, 그 클론은 자체 이력을 가진 두 번째 독립 객체입니다.

결과는 잘못 파악하기 쉽습니다. 이 루트의 깨끗한 `git status`은(는) 커밋되지 않은
제품 작업에 대해 아무것도 말해주지 않고, `saipen-live`의 fast-forward는
제품 코드에 대해 아무것도 말해주지 않습니다. `git -C zcode status`를 명시적으로
확인하세요.

## 로컬 절반

두 개의 스크립트. 둘 다 저장소 소유이므로 새 머신이 기억이 아니라
저장소에서 받게 됩니다:

| 파일 | 역할 |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | 검증, 브랜치 조정, 워처 설치·시작, 자동 시작 항목 기록, 로컬 == 원격 증명 |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | 루프: fetch, 비교, fast-forward 또는 push, 로그, 일시정지; 이후 제품 패스와 자체 업데이트 |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | 독립 실행자로부터의 왕복 검증 및 콜드 복구 증명 |
| `tools/saipen-cloud/Test-ProductSync.ps1` | 버릴 수 있는 Git 저장소 대상 제품 패스·자체 업데이트(네트워크 없음, 실제 원격 없음) |

설치 및 복구:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

멱등적. 머신 로컬 상태는 `%APPDATA%\SAIPEN`에 저장됨:
`ZaicodeSaipenLiveWatcher.ps1`(사본), `ZAICODE_cloud-sync.log`(2 MB에서
`.log.1`로 순환), `ZAICODE_cloud-sync.lock`(단일 인스턴스),
`ZAICODE_cloud-sync.pid`, 그리고 시작 폴더 항목
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

설치러는 더티 트리를 거부하며 절대 정리하지 않음. 모든 더티 경로가
`.saipen/` 아래의 표준 SAIPEN 상태라면 이를 알리고 정확한
체크포인트 명령을 출력함. 이는 체크포인트 없는 프로토콜 상태이며
전송 오류가 아님. 설치러는 프로토콜을 몰래 커밋하지 않음.

## 워처 동작

| 상황 | 조치 |
|-----------|------|
| 깨끗함, 로컬이 원격의 조상 | `git merge --ff-only` |
| 깨끗함, 원격이 로컬의 조상 | `git push` |
| 더티 | 일시정지. fetch조차 하지 않음 |
| 다른 브랜치에 있음 | 일시정지 |
| 양쪽 모두 진행됨, 공통 조상 없음 | 일시정지, 두 커밋 id 로그, 병합하지 않음 |
| fetch 또는 네트워크 실패 | degraded 로그, 다음 틱에서 재시도 |
| merge/rebase/cherry-pick 진행 중 | 일시정지 |

금지: force push, hard reset, stash, clean, 외부 브랜치 checkout,
commit, 프로세스 이름으로 중지. 설치러는 자체 pid 파일에 기록한
pid로만 워처를 정지시킴.

더티 트리는 비용이 없음. 워처가 fetch 전에 더티 여부를 확인하기 때문.
따라서 유휴 상태의 checkout은 네트워크 호출을 전혀 하지 않음.

### 제품 패스 (T-90)

`zcode/`은 자체 저장소이므로 위 표는 제품
코드를 절대 이동시키지 않음. 이후 동일한 틱에서 제품 checkout(`-ProductRepo`,
기본값 `<repo>\zcode`; 브랜치 `-ProductBranch`, 기본값 `zaicode`)을 처리함.
제품 패스는 외부 트리가 더티 여부와 무관하게 실행되며, pull만 수행함.

| 상황 | 처리 |
|-----------|------|
| remote이 앞섰고, 들어오는 파일 중 여기서 더티인 것이 없음 | `git merge --ff-only`; 커밋 안 된 제품 작업은 그대로 둠 |
| remote이 앞섰고, 들어오는 파일 중 여기서 더티인 것이 있음 | HELD: 파일 로깅, 병합 안 함 |
| local이 앞섬 | 로깅; **절대 push 안 함** (제품은 SAIPEN SHIP이 배포함) |
| diverged | 중단, 두 id 로깅, 병합 안 함 |
| 다른 브랜치, 진행 중인 git 작업, fetch 실패 | 중단 |
| `zcode/` 체크아웃 없음, 또는 `-NoProduct` | 건너뜀 |

git이 로컬 변경을 덮어쓰는 fast-forward를 스스로 거부하므로, HELD 검사는 더 앞선 더 명확한 가드일 뿐 유일한 가드가 아니다. 제품 fast-forward는 아무것도 다시 빌드하지 않는다. 테스트하려면 `pnpm bundle:zaicode`(또는 dev preview)을 실행한다.

### 자체 업데이트 (T-90)

워처는 `%APPDATA%\SAIPEN` 아래의 사본으로 실행되므로, 저장소에 더 새로운 워처가 있어도 재설치 없이 실행된 적이 없다. 이제 루프 모드에서는 매 패스마다 자신의 파일을 저장소의 커밋된 사본과 비교한다. 다음 조건이 모두 성립할 때만, 동일한 인자로 그 사본을 자기 자신 위에 설치하고 정확히 한 번 재시작한다:

- 두 파일이 서로 다름;
- 저장소 쪽 사본에 미커밋 편집이 없음;
- 저장소 쪽 사본이 오류 없이 파싱됨.

파싱되지 않는 사본은 거부하고 로깅한다. 실행 중인 워처는 그대로 계속 동작한다.

T-90 이전에 설치된 워처는 제품 패스와 자체 업데이트가 모두 없다. 그런 머신에서는 `Install-SaipenLiveSync.ps1`을 한 번 다시 실행하면 된다. 그 이후엔 워처가 자기 자신을 업데이트한다.

## 클라우드 절반

루트의 `CLAUDE.md`은 진입 규칙이고 `.claude/skills/saipen/SKILL.md`은 실행 절차다. 이 스킬은 `github.com/vacterro/saipen`에서 SAIPEN 커널을 가져와 선언된 엔진 표면 `tools/saipen.py`을 통해 실행한다. 커널은 태그가 아니라 커밋(`3088eff`)으로 고정된다. 태그 `v8.0.1`는 동일한 `VERSION`을 가진 구형 커널이다. 그 `validate`은 상태를 변경하며, 해당 검증기는 이 보드를 거부한다.

`STATE.saipen_home`은 마지막으로 체크포인트한 실행자의 커널 경로를 기록한다. 클라우드에서는 커널 `3088eff`에 대한 첫 `saipen continue`이 저널된 `DEC` 하나로 이를 실행 중인 커널에 수렴시킨다 (E-1410). 운영자 머신에서도 같은 방식으로 포인터가 죽은 상태로 도착한다. 자동 수렴이 가능한 커널은 `continue`에서 이를 복구한다. 그렇지 않으면 `saipen rebind-home --auto`을 실행한다.

**왕복이 관찰됨.** E-1562(클라우드)가 포인터를 `/home/user/zaicode/.claude/saipen-protocol`(으)로 수렴시켰고, E-1571(작업자 머신)이 수동 `rebind-home` 없이 자동�� 곧바로 `V:/.../_SAIPEN`(으)로 되돌림. 양방향 모두 같은 자동 수렴이므로, 위치 전환마다 `saipen_home` `DEC` 한 건은 예상하며 결함이 아니라 기대 노이즈로 취급. P1-2(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`)가 포인터를 버전 관리 상태 밖으로 옮기기 전까지는 노이즈에 머묾. 발견했다고 P1-2를 부수 효과로 구현하지 말 것. 포인터를 손으로 직접 수정 금지.

`STATE.saipen_home`는 핀 고정 커널의 깨끗한 `3088eff` 클론이 아니라 핀보다 앞선 커널 **개발 체크아웃**을 가리킬 수 있음 — 작업자 머신에서는 커밋 안 된 작업이 있는 `accepted-debt-rebind` 브랜치임. 핀 커밋이 아닌 커널이 자동으로 틀린 것은 아니지만, 클린룸 소스도 아님. 아래 음성 계약 규칙이 여기에 온전히 적용됨. 이런 체크아웃에서 아무것도 커밋·stash·reset·체크아웃·클린하지 말 것. `saipen/STYLE.md`의 단일 파일 대상 복원만이 유일한 예외이며, 작업자가 요청했을 때만.

### STYLE.md는 로컬 설정이 아님

`saipen/STYLE.md`는 모든 머신의 모든 사본에서 예외 없이, 로컬 편집 없이 핀 고정 커널의 파일과 **바이트 단위로 동일**해야 함. 작업자 머신에는 사본이 둘 이상 있음:

- `STATE.saipen_home`의 커널 체크아웃(Git 클론. 작업자 머신에서는 개발 체크아웃);
- `saipen-inject` 예약 작업(`bootstrap/schedule-run.ps1`)으로 채워지는 `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`. **Git 저장소가 아님**이므로 `git checkout`로는 절대 복구 불가 — 인젝터를 통한 재동기화 또는 게시된 내용의 직접 쓰기가 유일한 경로.

`.saipen/STATE.md` 안의 `style_contract` 토큰은 그 파일 텍스트의 해시임(`tools/validate.py`, `style_contract_token`: CRLF 정규화, `style_contract:` 줄 제외). 사본 하나에서 `reply_language`를 편집하면 토큰이 바뀌고, 다른 사본과 게시 커널을 가져오는 클라우드는 게시된 토큰을 유지함. 어긋난 쪽의 모든 CLI 쓰기가 `style_contract ... does not match the installed STYLE.md marker`(으)로 거부됨. 실패의 전부임: 로컬 쪽이 클라우드가 쓸 수 없는 상태를 씀.

**응답 언어 변경은 커널 커밋 + 재핀이며, 로컬 편집이 아님.** 커널 저장소에서 변경하고, 게시하고, SKILL.md에서 커밋을 재핀하고, `saipen recover`을 통해 `STATE.style_contract` 갱신. `STYLE.md`에 대한 로컬 편집은 그 편집을 하는 머신을 제외한 모든 머신을 비동기화함.

명시할 만한 함정 하나: 게시된 `bin/saipen`는 특정 작업자의 절대 인터프리터 경로와 체크아웃 경로를 하드코딩한 머신 종속 심임. 정확히 한 머신에서만 동작함. 클라우드는 `python3 tools/saipen.py`을 사용해야 함.

단축: `cc`는 현재 Work를 이어감; `cc all <text>`은 메시지 전체를 소스/appends(으)로 받아들여 대상 Work를 모두 이어감. 둘 다 일상적 확인을 묻지 않음.

## 기능 분류

**AVAILABLE_IN_CLOUD** — 프로토콜 상태와 워크스페이스 계층. `.saipen/` 읽기/쓰기, 런처(`tools/launcher/ZaicodeLauncher.cs`), `install/` 하위 인스톨러, `docs/`, `CLAUDE.md`, `.claude/skills/`, 전송 스크립트. `saipen-live` 대상 Git 읽기, 커밋, 푸시, fetch. 파일 단언, diff 리뷰, 텍스트 검사인 게이트 전부.

**LOCAL_WINDOWS_ONLY** — 이 머신이 필요한 게이트.

| 게이트 | 이유 |
|------|-----|
| `tools\launcher\build.cmd` | `ZaicodeLauncher.cs`을 .NET Framework `csc`(으)로 컴파일. 클라우드 이미지엔 Windows SDK 없음 |
| 패키징된 Electron E2E (`zcode` 데스크톱, Solo → queue → dispatch) | 데스크톱 세션과 시드된 provider 프로필 필요 |
| 라이브 9router | 이 머신의 Windows 서비스 |
| 인터랙티브 데스크톱 클릭 스루 | 사람과 화면 필요 |
| 워처 자체 런타임 케이스 | 워처는 체크아웃을 가진 머신에서만 실행됨 |

이것들은 로컬 전용 인수 경계로 기록됨. diff가 멀쩡해 보여 통과로 보고되지 않음.

**SAFE_TO_DEFER** — 제품 계층. 클라우드 세션은 `vacterro/zaicode` 브랜치 `zaicode`을 클론해 그곳에서 작업할 수 있다. 워크스페이스 계층 작업은 제품 작업을 요하지 않지만 클론은 필요하다: `.saipen/source-nested-repos.json`는 `zcode/`을 선언하며, 없으면 밸리데이터가 `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`로 실패한다. `pnpm` 게이트는 고정된 pnpm 10.33.2와 준비된 워크스페이스를 요구한다. 새 클라우드 이미지에서 `pnpm bootstrap`는 문서화된 진입 방법이며, 제품의 `package.json`가 이미 이를 선언한다.

클라우드는 `origin/zaicode`에 있는 제품 바이트만 검증 가능. 오퍼레이터의 `zcode/` 체크아웃에만 존재하는 제품 델타는 여기선 보이지 않으므로, 게이트 종류와 무관하게 해당 제품 게이트는 클라우드에서 NOT RUN. T-84가 첫 사례(E-1411): 수정은 로컬 전용이었고 `origin/zaicode`는 여전히 수정 전 코드를 담고 있었음.

**UNSAFE_TO_EMULATE** — 로컬 전용 게이트를 초록으로 보이게 만드는 모든 것. 런처 빌드를 스텁 처리하거나, 패키징 앱 실행을 위조하거나, 기록된 `pnpm verify:pre-push` 결과를 방금 실행된 것처럼 재생하거나, "코드가
correct해 보인다"를 `.saipen/LOG.md`의 PASS 줄로 바꾸지 말 것.

**KNOWN_CLOUD_DIVERGENCE** — 체크아웃 위치에 따라 달라지는 적합성. 커널 `3088eff`에서 클라우드 밸리데이터는 오퍼레이터 머신에서는 발생하지 않는 `closure-evidence` FAIL(T-47, T-62, T-76, T-78, 작성 시점 기준)을 보고함.

커널은 1024바이트를 넘는 모든 LOG 이벤트를 `.saipen/recovery/log-detail/` 사이드카로 이동시킴. 읽을 때 체크아웃의 절대 경로가 기록된 경로와 같을 때만 사이드카 복원. 따라서 Windows에서 기록된 긴 VERIFY 판정은 클라우드에서 읽을 수 없으며, 반대 방향도 마찬가지.

결함은 커널에 있고 `docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`에 P1-1로 등록됨. 반영될 때까지:

- 클라우드 판정을 그대로 인용하고, 티켓별로 이 경계로 분류
  (`SKILL.md` § 6에 검사 항목);
- 사이드카를 다시 쓰지 말고, 통과시키려고 재검증하지도 말고, 커널
  사본을 패치하지도 말 것;
- 양쪽 모두 LOG 이벤트를 1024바이트 미만으로 유지할 것.

동일한 machine-path 바인딩이 작업도 막는다. BUILD 이전 부채 기준선은 티켓이 처음 BUILD에 진입할 때 캡처되고, 이후 진입할 때마다 다시 검사된다. 따라서 운영자 머신에서 처음 BUILD에 진입한 티켓은 클라우드에서 BUILD에 진입할 수 없다. 전환이 `DEBT_SNAPSHOT_FOREIGN_PROJECT`로 거부된다. 기록된 사례가 T-84다. DEBT-000079는 E-1377에서 캡처되었고 전환은 E-1446에서 거부되었다. 이런 티켓은 기준선을 캡처한 머신에 맡겨라.

## 불일치

로컬과 원격이 더 이상 조상을 공유하지 않으면, 워처는 멈춘다. 병합하거나 리베이스하거나 강제하지 않는다. 두 커밋 ID가 로그에 들어가며, 수정은 `git log --left-right --cherry-pick <branch>...origin/<branch>`로 손수 처리되고, 그 결과는 다른 변경과 마찬가지로 체크포인트된다.

## 클라우드 측에서 할 정확한 작업

### 환경 설정 스크립트 (클라우드 환경 설정에서 한 번만)

세션 타이틀 바의 클라우드 환경 메뉴 -> 편집 -> 설정 스크립트. 모든 새 세션 전에 실행되므로, 각 세션이 제품 툴체인 준비 완료 상태로 시작한다:

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

### 모든 새 세션에 쓸 프롬프트

저장소 `vacterro/zaicode`, 브랜치 `saipen-live`에서 세션을 시작하고, 운영자 머신의 에이전트가 동시에 쓰지 않는지 확인하라.
새 작업을 넘길 때는 마지막 줄을 `cc all <new list>`로 바꿔라.

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

운영자 머신에서 워처가 `origin/zaicode`에서 `zcode`을 fast-forward하고, `REBUILD.cmd`(또는 `REBUILD_fast.lnk`)가 이를 빌드하며, ZAICODE를 다음에 시작할 때 새 빌드가 적용된다.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
