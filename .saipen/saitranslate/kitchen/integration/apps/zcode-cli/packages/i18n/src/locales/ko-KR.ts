import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "ko-KR",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `지원하지 않는 --locale 값: ${value}. 지원 로케일: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

사용법:
  zcode [command] [options]

command를 지정하지 않으면 zcode가 전체 화면 TUI를 엽니다.

명령:
  app-server ZCode Protocol stdio 앱 서버 실행
  commands   사용자 정의 슬래시 명령 나열 (\`commands list\`)
  doctor     런타임 및 패키징 가정 검사
  login [zai|bigmodel]  브라우저 인증으로 로그인
  logout     공유 Z.AI 로그인 자격 증명 제거
  plugins    플러그인 및 마켓플레이스 관리 (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; 별칭: plugin)
  skills     로컬 스킬 나열 (\`skills list\`)
  tui        터미널 UI 열기
  version    CLI 버전 출력

옵션:
  -h, --help       도움말 표시
  -v, --version    버전 표시
  -p, --prompt <text>  TUI를 열지 않고 단일 프롬프트 실행
  --memory-bench   --prompt과 함께 자동 Memory 추출을 활성화하고 종료 전 대기 (Memory 활성화 필요)
  --browser-use <mode> Browser Use 백엔드 활성화 (지원: headless)
  --surface <surface>  headless 프롬프트/app-server용 표시 표면: terminal 또는 desktop
  --browser-executable <path> headless Browser Use용 Chrome/Chromium 실행 파일
  --attach <path>  로컬 파일을 --prompt에 첨부; 여러 파일은 반복 지정
  --cwd <path>     지정한 디렉터리에서 이 명령 실행
  --disallowed-tools, --disallowedTools <tools...>
    이번 프롬프트/TUI 실행에서만 전체 도구 제거; 저장된 설정은 변경되지 않음.
    쉼표 또는 공백으로 구분한 도구 이름, 예: "Bash Edit".
    "Bash(git *)"는 Bash 전체를 제거함; 명령 패턴은 일치하지 않음.
  --force-mcs      Anthropic 제공업체에 대해 대화 중간 시스템 프록젝션 강제
  --locale <locale>  UI 로케일: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR 또는 auto
  --mode <mode>    프롬프트 권한 모드: build, edit, plan 또는 yolo (--prompt의 기본값은 yolo)
  --resume <sessionId>  sessionId로 저장된 세션 재개 (sess_...)
  --target <text>  headless 모드에서 세션 목표 실행 또는 설정
  --target-replace --target이 설정한 기존 세션 목표를 교체
  -c, --continue        현재 디렉터리의 최신 세션 재개
  --json           지원되는 경우 기계 판독용 JSON 출력
  --no-browser     브라우저를 열지 않고 OAuth URL 출력
  --no-color       ANSI 색상 비활성화
  --verbose        추가 진단 상세 정보 출력

슬래시 명령:
  /help [command]       슬래시 명령 도움말 표시
  /login                Z.AI 또는 BigModel 브라우저 로그인 선택
  /logout               공유 Z.AI 로그인 자격 증명 제거
  /compact [instructions]  현재 대화 압축
  /expert [status|resume|stop|<task>]  전문가 워크플로 실행 또는 관리
  /dwf [list|cancel|resume]  동적 워크플로 실행 나열, 취소 또는 재개
  /fork [latest|checkpointId]  워크스페이스 체크포인트에서 새 세션 분기
  /mcp [list|status|connect|disconnect]  MCP 서버 표시 또는 관리
  /mode [mode]          권한 모드 표시 또는 전환: build, edit, plan 또는 yolo
  /model [id]           현재 세션 모델 표시 또는 전환
  /new                  TUI에서 새 세션 시작
  /resume [sessionId]   sessionId로 세션 재개; 생략하면 cwd의 최신 세션
  /rewind [latest|checkpointId]  최신 체크포인트 표시 또는 워크스페이스 파일 복원
  /skill [name] [task]  스킬 나열 또는 다음 프롬프트가 하나를 로드하도록 강제
  /goal [action]        현재 세션 목표 표시 또는 설정
`,
  },
  tui: {
    copy: {
      copied: "선택한 텍스트를 클립보드에 복사했습니다.",
      failed: "선택한 텍스트를 복사할 수 없습니다.",
      unavailable: "이 터미널에서는 텍스트 클립보드 복사를 사용할 수 없습니다.",
    },
    effort: {
      disabled: "비활성화됨",
      enabled: "활성화됨",
    },
    input: {
      activeStatusHint: "중단하려면 esc",
      busyPlaceholder: "입력을 대기하려면 입력하세요",
      placeholder: "프롬프트 입력",
      queuedMore: (count) => `대기 중 ${count}개 더`,
      queuedSubmitHint: "다음 도구 호출 후 제출됨.",
      queuedTitle: (count) => ` 대기열 (${count}) `,
      title: "입력",
      noHistorySource: "입력 기록 소스가 설정되지 않았습니다.",
      noPreviousInput: "이 프로젝트에 이전 입력이 없습니다.",
      restoredPreviousInput: "이전 입력을 복원했습니다.",
      restoredPreviousInputWithAttachments: (count) =>
        `첨부 파일 ${count}개와 함께 이전 입력을 복원했습니다.`,
      restorePreviousInputFailed: "이전 입력을 복원할 수 없습니다.",
      typePrompt: "질문을 입력하고 Enter를 누르세요.",
    },
    loginRequired: {
      help: "모델을 보려면 /model을, Coding Plan 계정을 연결하려면 /login을(를) 사용하세요.",
      message: "사용 가능한 모델이 없습니다. 제공업체를 구성하거나 /login으로 로그인하세요.",
      status: "사용 가능한 모델이 없습니다. 제공업체를 구성하거나 /login으로 로그인하세요.",
      title: "모델 설정 필요",
    },
    loginSetup: {
      emptyMessage: "사용 가능한 로그인 옵션이 없습니다.",
      help: "위/아래 화살표로 선택하고 Enter로 확정하세요.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "BigModel Coding Plan API 키 입력",
          inputSecondary: "키를 여기에 붙여넣으세요. 입력하는 동안 숨겨집니다.",
          primary: "BigModel Coding Plan API 키",
          secondary: "Coding Plan API 키를 직접 붙여넣으세요.",
        },
        bigmodelOauth: {
          pendingPrimary: "BigModel 인증 대기 중",
          pendingSecondary:
            "브라우저에서 로그인을 완료하세요. 인증은 자동으로 감지됩니다.",
          primary: "BigModel Coding Plan",
          secondary: "브라우저 로그인을 엽니다; 인증은 자동으로 감지됩니다.",
        },
        zaiApiKey: {
          inputPrimary: "Z.AI Coding Plan API 키 입력",
          inputSecondary: "키를 여기에 붙여넣으세요. 입력하는 동안 숨겨집니다.",
          primary: "Z.AI Coding Plan API 키",
          secondary: "Coding Plan API 키를 직접 붙여넣으세요.",
        },
        zaiOauth: {
          pendingPrimary: "Z.AI 인증 대기 중",
          pendingSecondary:
            "브라우저에서 로그인을 완료하세요. 인증이 끝나면 계속 진행하겠습니다.",
          primary: "Z.AI Coding Plan",
          secondary: "브라우저 로그인 열고 Coding Plan API 키 생성하세요.",
        },
      },
      pending: {
        cancelStatus: "로그인 취소됨. 설정 방식 선택하세요.",
        help: "Esc 취소, 설정 선택 화면으로 돌아감.",
        status: "브라우저 인증 대기 중...",
      },
      input: {
        cancelStatus: "API 키 입력 취소됨. 설정 방식 선택하세요.",
        clearStatus: "API 키 입력 지워짐.",
        emptyStatus: "API 키 필수.",
        help: "Enter 키 저장. Esc 설정 선택으로 복귀.",
        placeholder: "API 키 붙여넣기",
        status: "API 키 입력 후 Enter 누르세요.",
        submitStatus: "API 키 저장 중...",
      },
      prompt: "로그인 또는 API 키 설정 방식 선택.",
      response: "Coding Plan 제공자 설정 방식 선택.",
      title: "Coding Plan 설정",
    },
    model: {
      requestFailed: (message) => `모델 요청 실패: ${message}`,
      responseReceived: "모델 응답 수신됨.",
      responseReceivedWithTokens: (tokens) => `모델 응답 수신됨. ${tokens} 토큰.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `${delay} 후 모델 요청 ${attempt}/${Math.max(1, maxAttempts - 1)} 재시도: ${reason}`,
      streamStalled: "모델 스트림 정지.",
    },
    sidebar: {
      subagents: {
        title: "서브에이전트",
        empty: "서브에이전트 없음.",
        emptyOutput: "출력 없음.",
        back: "← 메인 대화",
        readonly: "읽기 전용 · Esc 복귀",
        loading: "서브에이전트 출력 불러오는 중...",
        unavailable: "서브에이전트 출력 없음.",
        retry: "재시도",
        more: "더 불러오기",
        pendingMain: "메인 대화 입력 대기 중 — 복귀해 응답하세요",
        ended: (count) => `종료됨 (${count})`,
        status: {
          running: "실행 중",
          waiting: "대기 중",
          blocked: "차단됨",
          success: "완료됨",
          failed: "실패",
          cancelled: "취소됨",
          lost: "유실",
        },
      },
      api: {
        empty: "API 호출 없음.",
        model: "모델",
        more: (count) => `+${count}개 더`,
        requests: "요청",
        server: "서버",
      },
      cache: {
        hit: "적중",
        lastHit: "마지막 적중",
        lastMiss: "마지막 실패",
        readWrite: ({ read, write }) => `${read} 읽기 / ${write} 쓰기`,
        total: "합계",
      },
      context: {
        cache: "캐시",
        cacheReadWrite: "캐시 읽기/쓰기",
        inputOutput: "I/O",
        reason: "사유",
        tokens: "토큰",
        used: "사용",
        window: "창",
      },
      modifiedFiles: {
        empty: "아직 파일 변경 없음.",
        more: (count) => `+${count}개 더`,
      },
      mcp: {
        empty: "구성된 MCP 서버 없음.",
        loadFailed: "MCP 상태를 확인할 수 없음.",
        loading: "MCP 상태 불러오는 중...",
        more: (count) => `+${count}개 더`,
        servers: "서버",
        status: {
          connected: "연결됨",
          connecting: "연결 중",
          disabled: "비활성화됨",
          disconnected: "연결 끊김",
          failed: "실패",
          untrusted: "신뢰 안 됨",
        },
        summary: ({ connected, total }) => `${connected}/${total} 연결됨`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "완료",
        error: "오류",
        errorWithStatus: (statusCode) => `오류 ${statusCode}`,
        pending: "대기 중",
      },
      status: {
        last: "마지막",
      },
      run: {
        draft: "초안",
        draftChars: (count) => `${count}자`,
        draftEmpty: "비어 있음",
        messages: "메시지",
        mode: "모드",
        model: "모델",
        provider: "제공자",
        thought: "사고",
        trace: "추적",
        turn: "턴",
        workspace: "작업 공간",
      },
      sections: {
        apis: "API",
        context: "컨텍스트",
        mcp: "MCP",
        modifiedFiles: "수정된 파일",
        run: "실행",
        status: "상태",
        todos: "할 일",
      },
      shellSubtitle: "OpenTUI 셸",
      title: "사이드바",
      todos: {
        empty: "할 일이 없습니다.",
        more: (count) => `+${count}개 더`,
        progress: "진행률",
      },
    },
    status: {
      compactFailed: "컨텍스트 압축 실패.",
      compacted: "대화 압축 완료.",
      compacting: "컨텍스트 압축 중...",
      interruptedStreamDiscarded: "중단된 모델 스트림이 버려졌습니다.",
      modelCalling: "모델 호출 중...",
      permissionRequested: (toolName) => `${toolName}에 대한 권한을 요청했습니다.`,
      permissionResolved: (toolName) => `${toolName} 권한이 해결되었습니다.`,
      ready: "준비됨.",
      recoveringStream: "중단된 모델 스트림 복구 중...",
      retryingStream: "모델 스트림 재시도 중...",
      sessionResumed: "세션이 재개되었습니다.",
      targetChanged: (action) => `대상: ${action}.`,
      thinking: "생각 중...",
      toolCompleted: (toolName) => `도구 ${toolName} 완료.`,
      toolFailed: (toolName) => `도구 ${toolName} 실패.`,
      toolPending: (toolName) => `도구 ${toolName} 대기 중.`,
      toolRunning: (toolName) => `도구 ${toolName} 실행 중.`,
      turnFailed: "턴 실패.",
    },
    terminal: {
      requiresInteractive: "TUI에는 대화형 터미널이 필요합니다.",
      starting: "ZCode 시작 중... 종료하려면 Ctrl+C",
    },
    transcript: {
      compact: {
        completed: "컨텍스트 압축됨",
        failed: "컨텍스트 압축 실패",
        interrupted: "컨텍스트 압축 중단됨",
        retry: (command) => `${command} 재시도하려면 Ctrl-R`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `컨텍스트 압축 재시도 (${attempt}/${maxAttempts})`
            : "컨텍스트 압축 재시도",
        skipped: "컨텍스트가 최신 상태입니다. 압축 필요 없음",
        started: "컨텍스트 압축 중",
      },
      roles: {
        agent: "에이전트",
        system: "시스템",
        user: "사용자",
      },
      thought: {
        complete: "사고",
        thinking: "생각 중...",
      },
      title: "트랜스크립트",
      workflow: {
        actors: " actors:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `사용량: ${spentTokens} 토큰`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `워크플로 ${label} - ${status} (${nodesSettled}/${nodesTotal} 단계)`,
        error: (message) => `오류: ${message}`,
        expandHint: "+로 펼치기",
        collapseHint: "-로 접기",
        log: "로그:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} 단계 완료`,
        result: (preview) => `결과: ${preview}`,
        status: {
          completed: "완료됨",
          errored: "오류 발생",
          pending: "대기 중",
          running: "실행 중",
          stopped: "중지됨",
        },
        stopReason: {
          user: "사용자가 중단",
          model: "에이전트가 중단",
          provider: "모델 오류",
          interrupted: "프로세스 종료됨",
          superseded: "수정된 실행으로 대체됨",
        },
        truncated: "(잘림 - 전체 기록은 실행 저널에 있음)",
        interruptedNotice: ({ label, runId }) =>
          `워크플로 ${label}이(가) 중단되었으며 재개 가능: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter 선택, Esc 취소",
      disabled: (reason) => ` [비활성화: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `필터: ${filter || "-"} | ${help ?? "Enter 선택, Esc 취소"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "일치하는 워크스페이스 경로 없음.",
      loading: "워크스페이스 경로 불러오는 중...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "파일",
    },
    slash: {
      title: "명령",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
