# ZAICODE

<div align="center">
  <img src="https://raw.githubusercontent.com/vacterro/zaicode/zaicode/packages/ui/src/assets/zaicode-working.png" alt="ZAICODE" width="96" height="96" />
</div>
<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.1-c9a227" alt="version 0.0.1" />
  <img src="https://img.shields.io/badge/platform-Windows-3b3527" alt="Windows" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-3b3527" alt="Apache-2.0" />
</p>
<p align="center">
  ZAICODE · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md">ZCode (简体中文)</a> · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.en.md">ZCode (English)</a>
</p>

<img width="1440" height="860" alt="ZAICODE hero — Do your best." src="../../screenshots/01-do-your-best.png" />

ZAICODE는 여러 프로젝트에서 AI 코딩 에이전트를 한꺼번에 실행하고 감시하지 않아도 되게 하는 운영자 워크벤치입니다. [ZCode](https://github.com/zai-org/ZCode)(데스크톱 앱, 브라우저 UI, 에이전트 CLI)의 수정 빌드에 제품 계층을 얹은 형태입니다. 모든 프로젝트는 [SAIPEN](https://github.com/vacterro/saipen) 프로토콜로 구동되고, 작업은 하나의 창에서 시작·계속·예약되며, 이미 결제 중인 구독 CLI(Claude Code, Codex, Antigravity)는 앱 내 에이전트 옆에 도킹된 워커로 실행됩니다.

**0.0.1**은 첫 태그 스냅샷: Windows 우선, 매일 쓰는 개인용 빌드.

## 한 번 클릭으로 설치

1. **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)** 다운로드.
2. 더블클릭 후 **INSTALL**.

그게 전부입니다. 설정 파일은 머신에 없는 것(Git, Node.js, Python — 사설 복사본, 관리자 권한 불필요)을 설치하고, GitHub에서 ZAICODE와 SAIPEN, SAIMAIL을 받아这台에서 앱을 빌드한 뒤 바탕화면에 ZAICODE 바로가기를 만듭니다. 첫 실행은 15~30분 걸리며, 창에 모든 단계가 표시됩니다.

무료 모델은 바로 동작합니다. ZAICODE가 자체 라우터를 실행하고 키 없이 가능한 무료 티어에서 **SAIFREN** 풀을 채우므로, New task에 입력한 작업은 키·계정·설정 없이 답을 받습니다. Claude Code, Codex, Antigravity 구독은 선택 사항이며 언제든 로그인할 수 있습니다.

**하나의 완전한 구성, 네 개 파트.** 워크스페이스(런처, 설치 프로그램), 앱, SAIPEN, SAIMAIL은 네 저장소입니다. 각자 독립적으로 업데이트됩니다: *Settings -> ZAICODE -> Updates*에서 모든 파트를 보고, 수동 또는 자동으로 갱신합니다(시작 몇 분 후, 이후 6시간마다). 새 앱 빌드는 ZAICODE 실행 중에 준비되고 다음 시작 때 적용되며, 클론에 직접 수정한 내용은 덮어쓰이지 않습니다. 터미널에서: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
자동 문제 해결: `install\Doctor.cmd`. 자세한 내용: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## 인터페이스 둘러보기

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

## ZCode에 더해지는 것

- **MAIN 세션이 있는 프로젝트.** 각 프로젝트는 MAIN 세션 하나(START,
  `/goal cc all`)와 헬퍼 세션(subSaipens: WIKI, TEST, AUDIT, …)를 가집니다.
  기본 사이드바 보기는 프로젝트 행을 MAIN으로 표시하고, ▶는 새 세션을
  여는 대신 MAIN을 계속합니다. 전체 계속, 완료, 완료 항목 모두 지우기는
  모든 프로젝트를 훑습니다. 중간에 잘린 세션은 완료가 아닌 INTERRUPTED로
  표시됩니다.
- **크래시 안전성.** 죽은 프로세스가 잘라버린 세션과 진행 중이던 목표는
  재시작 후 자동으로 이어집니다. 실행 중이던 워커도 다시 시작합니다. ZAICODE
  내부의 에이전트는 프로세스 이름으로 ZAICODE를 종료할 수 없습니다.
- **워커.** 구독 CLI는 창 어느 가장자리에도 도킹된 터미널(또는 자체 스내핑
  창)에서 실행됩니다. 최초 실행 시 "이 폴더를 신뢰할까요?" 질문은 미리
  응답해 두고, 사용 한도에 도달한 워커는 보고 후 설정에 따라 종료하거나
  초기화 후 재시작합니다.
- **한도와 초기화.** 계정·풀별 쿼터 계기판, 가장 가까운 초기화를 세는
  제목 표시줄 타이머, 마우스를 올리면 전체 초기화 목록 표시.
- **SCHEDULER.** 스스로 시작하는 프롬프트: 지정 시각, 매일, N분마다, 또는
  쿼터 창이 채워질 때. 프로젝트 하나 또는 사이드바 섹션 전체에 적용되며
  가장 막힌 프로젝트(차단됨 / 열린 SAIPEN 티켓 기준)를 먼저 처리합니다.
  조건으로 임시 방편 작업(무료 풀 세션, 약한 워커)을 먼저 중단하거나, 유휴
  프로젝트에서만 실행하거나, 표시된 세션만 계속할 수 있습니다. 프롬프트
  길이 제한은 사실상 없습니다.
- **라우팅.** 번들된 9router(MIT)가 설정 없는 풀을 제공: SAIFREN
  (무키 무료 티어)과 SAIOPP(내 구독).
- **SAIHOME, 타이머, 사운드, 하이라이트.** 통계가 있는 운영자 홈,
  FastPrompter식 타이머·알람, 동작별 사운드, Win95 다크 골드 픽셀 선명한
  인터페이스.

## 빌드

요구 사항: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml)이 기준).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

패키징된 앱은 항상 ZAICODE 모드로 시작합니다. 구형 ZAICODE가 실행 중이면
  번들러가 새 빌드를 `packages/desktop/dist-next`에 임시 저장하고, 루트
  런처(브랜치 `master`, `tools/launcher`)가 다음 시작 시 교체합니다.
  UI가 쓰는 선명한 비트맵 Verdana 변형은 이 저장소에 포함되지 않으며,
  없으면 시스템 Verdana로 대체됩니다.

점검: `pnpm typecheck`, `pnpm lint`, 그리고 ZAICODE 테스트. 예: `packages/ui`에서
`node --import tsx --test test/zaicode*.test.ts`.

## 저장소 구조

| 브랜치      | 내용                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | 정통 워크스페이스: 런처, 인스톨러(`install/`), 제품 문서(`UI.md`, `docs/`), SAIPEN 상태, CHANGELOG |
| `zaicode`   | 정통 앱 소스: 업스트림 ZCode 이력 + 빌드·업데이트에 쓰이는 ZAICODE 제품 레이어 |

레거시나 자동화로 생긴 ref가 잠시 남을 수 있지만 정통 제품
브랜치가 아닙니다. 새 워크스페이스 작업은 `master`에, 앱 소스
작업은 `zaicode`에 넣습니다.

ZAICODE 소유 앱 코드는 대부분 `zaicode` 브랜치의 `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/`, `packages/desktop/src/main/zaicode*.ts`에 있습니다. 워크스페이스
문서와 런처/update 툴링은 `master`에 있습니다.

## 업스트림 및 라이선스

ZAICODE는 Z.ai의 ZCode에서 파생되었으며 동일한
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE)으로 배포됩니다. 상위 고지 사항은
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md)와 [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md)에 그대로 보존됩니다.
파일은 ZAICODE 작성자가 수정했습니다. ZAICODE는 독립 프로젝트이며
Z.ai와 제휴하거나,Z.ai의 승인을 받지 않았습니다. 원본 ZCode README는
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md)와 [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md)로 보존됩니다.

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## 프로젝트 네트워크

이 저장소는 더 넓은 **SAIPEN / vacterro** 프로젝트 생태계의 일부입니다.

[**작성자 허브**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN 커뮤니티**](https://discord.gg/SEYaYkuVgN)

재현 가능한 버그와 장기적 기능 요청은 [이 저장소의 GitHub Issues](https://github.com/vacterro/zaicode/issues)를 사용하세요. Discord는 빠른 토론, 스크린샷, 프로젝트 간 피드백에 사용합니다.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
