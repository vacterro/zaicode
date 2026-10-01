import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "vi-VN",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Giá trị --locale không được hỗ trợ: ${value}. Ngôn ngữ hỗ trợ: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Cách dùng:
  zcode [command] [options]

Không có lệnh, zcode mở TUI toàn màn hình.

Lệnh:
  app-server Chạy app server stdio theo ZCode Protocol
  commands   Liệt kê các lệnh slash tùy chỉnh (\`commands list\`)
  doctor     Kiểm tra các giả định về runtime và đóng gói
  login [zai|bigmodel]  Đăng nhập qua ủy quyền trình duyệt
  logout     Xóa thông tin đăng nhập Z.AI dùng chung
  plugins    Quản lý plugin và marketplace (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; bí danh: plugin)
  skills     Liệt kê skill cục bộ (\`skills list\`)
  tui        Mở giao diện terminal
  version    In phiên bản CLI

Tùy chọn:
  -h, --help       Hiển thị trợ giúp
  -v, --version    Hiển thị phiên bản
  -p, --prompt <text>  Chạy một prompt mà không mở TUI
  --memory-bench   Kèm --prompt, bật trích xuất Memory tự động và chờ trước khi thoát (cần bật Memory)
  --browser-use <mode> Bật backend Browser Use (hỗ trợ: headless)
  --surface <surface>  Bề mặt hiển thị cho prompt/app-server headless: terminal hoặc desktop
  --browser-executable <path> Tệp thực thi Chrome/Chromium cho Browser Use headless
  --attach <path>  Đính kèm tệp cục bộ vào --prompt; lặp lại cho nhiều tệp
  --cwd <path>     Chạy lệnh này từ thư mục đã cho
  --disallowed-tools, --disallowedTools <tools...>
    Xóa toàn bộ tool cho lần chạy prompt/TUI này; cài đặt đã lưu không thay đổi.
    Tên tool phân tách bằng dấu phẩy hoặc khoảng trắng, ví dụ "Bash Edit".
    "Bash(git *)" xóa toàn bộ Bash; không khớp theo mẫu lệnh.
  --force-mcs      Buộc chiếu system giữa cuộc hội thoại cho nhà cung cấp Anthropic
  --locale <locale>  Ngôn ngữ giao diện: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR hoặc auto
  --mode <mode>    Chế độ quyền cho prompt: build, edit, plan hoặc yolo (mặc định: yolo cho --prompt)
  --resume <sessionId>  Tiếp tục phiên đã lưu theo sessionId (sess_...)
  --target <text>  Chạy hoặc đặt mục tiêu phiên ở chế độ headless
  --target-replace Thay thế mục tiêu phiên hiện có do --target đặt
  -c, --continue        Tiếp tục phiên mới nhất cho thư mục hiện tại
  --json           In JSON máy đọc được ở nơi hỗ trợ
  --no-browser     In URL OAuth mà không mở trình duyệt
  --no-color       Tắt màu ANSI
  --verbose        In chi tiết chẩn đoán bổ sung

Lệnh slash:
  /help [command]       Hiển thị trợ giúp lệnh slash
  /login                Chọn đăng nhập qua trình duyệt Z.AI hoặc BigModel
  /logout               Xóa thông tin đăng nhập Z.AI dùng chung
  /compact [instructions]  Nén cuộc hội thoại hiện tại
  /expert [status|resume|stop|<task>]  Chạy hoặc quản lý quy trình expert
  /dwf [list|cancel|resume]  Liệt kê, hủy hoặc tiếp tục các lần chạy workflow động
  /fork [latest|checkpointId]  Tạo phiên mới từ checkpoint của workspace
  /mcp [list|status|connect|disconnect]  Hiển thị hoặc quản lý máy chủ MCP
  /mode [mode]          Hiển thị hoặc chuyển chế độ quyền: build, edit, plan hoặc yolo
  /model [id]           Hiển thị hoặc chuyển model của phiên hiện tại
  /new                  Bắt đầu phiên mới trong TUI
  /resume [sessionId]   Tiếp tục phiên theo sessionId; bỏ trống để lấy phiên mới nhất trong cwd
  /rewind [latest|checkpointId]  Hiển thị checkpoint mới nhất hoặc khôi phục tệp workspace
  /skill [name] [task]  Liệt kê skill, hoặc buộc prompt kế tiếp nạp một skill
  /goal [action]        Hiển thị hoặc đặt mục tiêu phiên hiện tại
`,
  },
  tui: {
    copy: {
      copied: "Đã sao chép văn bản đã chọn vào clipboard.",
      failed: "Không thể sao chép văn bản đã chọn.",
      unavailable: "Sao chép văn bản vào clipboard không khả dụng trong terminal này.",
    },
    effort: {
      disabled: "tắt",
      enabled: "bật",
    },
    input: {
      activeStatusHint: "esc để ngắt",
      busyPlaceholder: "Nhập để xếp hàng đầu vào",
      placeholder: "Nhập prompt",
      queuedMore: (count) => `+ ${count} nữa đang chờ`,
      queuedSubmitHint: "Đã gửi sau lệnh gọi công cụ kế tiếp.",
      queuedTitle: (count) => ` Hàng đợi (${count}) `,
      title: "Đầu vào",
      noHistorySource: "Chưa cấu hình nguồn lịch sử đầu vào.",
      noPreviousInput: "Không có đầu vào trước cho dự án này.",
      restoredPreviousInput: "Đã khôi phục đầu vào trước.",
      restoredPreviousInputWithAttachments: (count) =>
        `Đã khôi phục đầu vào trước kèm ${count} tệp đính kèm.`,
      restorePreviousInputFailed: "Không thể khôi phục đầu vào trước.",
      typePrompt: "Nhập câu hỏi và nhấn Enter.",
    },
    loginRequired: {
      help: "Dùng /model để xem model, hoặc /login để kết nối tài khoản Coding Plan.",
      message: "Không có model khả dụng. Hãy cấu hình nhà cung cấp hoặc đăng nhập bằng /login.",
      status: "Không có model khả dụng. Hãy cấu hình nhà cung cấp hoặc đăng nhập bằng /login.",
      title: "cần thiết lập model",
    },
    loginSetup: {
      emptyMessage: "Không có tùy chọn đăng nhập nào khả dụng.",
      help: "Dùng Up/Down để chọn, Enter để xác nhận.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Nhập BigModel Coding Plan API Key",
          inputSecondary: "Dán khóa vào đây. Nó được ẩn khi nhập.",
          primary: "Khóa API Coding Plan BigModel",
          secondary: "Dán khóa API Coding Plan thủ công.",
        },
        bigmodelOauth: {
          pendingPrimary: "Đang chờ ủy quyền BigModel",
          pendingSecondary:
            "Hoàn tất đăng nhập trong trình duyệt. Ủy quyền được phát hiện tự động.",
          primary: "Gói Coding Plan BigModel",
          secondary: "Mở đăng nhập qua trình duyệt; ủy quyền được phát hiện tự động.",
        },
        zaiApiKey: {
          inputPrimary: "Nhập Z.AI Coding Plan API Key",
          inputSecondary: "Dán khóa vào đây. Nó được ẩn khi nhập.",
          primary: "Khóa API Coding Plan Z.AI",
          secondary: "Dán khóa API Coding Plan thủ công.",
        },
        zaiOauth: {
          pendingPrimary: "Đang chờ ủy quyền Z.AI",
          pendingSecondary:
            "Hoàn tất đăng nhập trong trình duyệt. Tôi sẽ tiếp tục khi ủy quyền hoàn tất.",
          primary: "Z.AI Coding Plan",
          secondary: "Mở trình duyệt để đăng nhập và tạo khóa API Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Đã hủy đăng nhập. Chọn cách thiết lập.",
        help: "Esc hủy và quay lại các lựa chọn thiết lập.",
        status: "Đang chờ cấp quyền qua trình duyệt...",
      },
      input: {
        cancelStatus: "Đã hủy nhập khóa API. Chọn cách thiết lập.",
        clearStatus: "Đã xóa khóa API đã nhập.",
        emptyStatus: "Khóa API là bắt buộc.",
        help: "Enter lưu khóa. Esc quay lại các lựa chọn thiết lập.",
        placeholder: "Dán khóa API",
        status: "Nhập khóa API, rồi nhấn Enter.",
        submitStatus: "Đang lưu khóa API...",
      },
      prompt: "Chọn cách đăng nhập hoặc dùng khóa API để thiết lập.",
      response: "Chọn cách thiết lập nhà cung cấp Coding Plan.",
      title: "Thiết lập Coding Plan",
    },
    model: {
      requestFailed: (message) => `Yêu cầu mô hình thất bại: ${message}`,
      responseReceived: "Đã nhận phản hồi của mô hình.",
      responseReceivedWithTokens: (tokens) => `Đã nhận phản hồi của mô hình. ${tokens} token.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Đang thử lại yêu cầu mô hình ${attempt}/${Math.max(1, maxAttempts - 1)} sau ${delay}: ${reason}`,
      streamStalled: "Luồng mô hình bị gián đoạn.",
    },
    sidebar: {
      subagents: {
        title: "Subagent",
        empty: "Chưa có subagent nào.",
        emptyOutput: "Chưa có kết quả nào.",
        back: "← Cuộc trò chuyện chính",
        readonly: "Chỉ đọc · Esc để quay lại",
        loading: "Đang tải kết quả của subagent...",
        unavailable: "Không có kết quả của subagent.",
        retry: "Thử lại",
        more: "Tải thêm",
        pendingMain: "Cuộc trò chuyện chính cần bạn nhập — quay lại để trả lời",
        ended: (count) => `Đã kết thúc (${count})`,
        status: {
          running: "đang chạy",
          waiting: "đang chờ",
          blocked: "bị chặn",
          success: "hoàn tất",
          failed: "thất bại",
          cancelled: "đã hủy",
          lost: "mất",
        },
      },
      api: {
        empty: "Chưa có lệnh API nào.",
        model: "Mô hình",
        more: (count) => `+${count} nữa`,
        requests: "Yêu cầu",
        server: "Máy chủ",
      },
      cache: {
        hit: "lượt trúng",
        lastHit: "trúng gần nhất",
        lastMiss: "trượt gần nhất",
        readWrite: ({ read, write }) => `${read} đọc / ${write} ghi`,
        total: "tổng",
      },
      context: {
        cache: "Bộ nhớ đệm",
        cacheReadWrite: "Bộ nhớ đệm đọc/ghi",
        inputOutput: "I/O",
        reason: "Lý do",
        tokens: "Token",
        used: "Đã dùng",
        window: "Cửa sổ",
      },
      modifiedFiles: {
        empty: "Chưa có thay đổi tệp nào.",
        more: (count) => `+${count} nữa`,
      },
      mcp: {
        empty: "Chưa cấu hình máy chủ MCP nào.",
        loadFailed: "Không lấy được trạng thái MCP.",
        loading: "Đang tải trạng thái MCP...",
        more: (count) => `+${count} nữa`,
        servers: "Máy chủ",
        status: {
          connected: "đã kết nối",
          connecting: "đang kết nối",
          disabled: "đã tắt",
          disconnected: "mất kết nối",
          failed: "thất bại",
          untrusted: "không tin cậy",
        },
        summary: ({ connected, total }) => `${connected}/${total} đã kết nối`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "hoàn tất",
        error: "lỗi",
        errorWithStatus: (statusCode) => `lỗi ${statusCode}`,
        pending: "đang chờ",
      },
      status: {
        last: "Cuối",
      },
      run: {
        draft: "Nháp",
        draftChars: (count) => `${count} ký tự`,
        draftEmpty: "rỗng",
        messages: "Tin nhắn",
        mode: "Chế độ",
        model: "Mô hình",
        provider: "Nhà cung cấp",
        thought: "Suy nghĩ",
        trace: "Lượt theo dõi",
        turn: "Lượt",
        workspace: "Không gian làm việc",
      },
      sections: {
        apis: "API",
        context: "Ngữ cảnh",
        mcp: "MCP",
        modifiedFiles: "Tệp đã sửa",
        run: "Chạy",
        status: "Trạng thái",
        todos: "Việc cần làm",
      },
      shellSubtitle: "Vỏ OpenTUI",
      title: "Thanh bên",
      todos: {
        empty: "Chưa có việc cần làm.",
        more: (count) => `+${count} nữa`,
        progress: "Tiến độ",
      },
    },
    status: {
      compactFailed: "Nén ngữ cảnh thất bại.",
      compacted: "Đã nén cuộc trò chuyện.",
      compacting: "Đang nén ngữ cảnh...",
      interruptedStreamDiscarded: "Đã loại bỏ luồng mô hình bị gián đoạn.",
      modelCalling: "Đang gọi mô hình...",
      permissionRequested: (toolName) => `Đã yêu cầu quyền cho ${toolName}.`,
      permissionResolved: (toolName) => `Đã xử lý quyền cho ${toolName}.`,
      ready: "Sẵn sàng.",
      recoveringStream: "Đang khôi phục luồng mô hình bị gián đoạn...",
      retryingStream: "Đang thử lại luồng mô hình...",
      sessionResumed: "Đã tiếp tục phiên.",
      targetChanged: (action) => `Mục tiêu ${action}.`,
      thinking: "Đang suy nghĩ...",
      toolCompleted: (toolName) => `Công cụ ${toolName} đã hoàn tất.`,
      toolFailed: (toolName) => `Công cụ ${toolName} thất bại.`,
      toolPending: (toolName) => `Công cụ ${toolName} đang chờ.`,
      toolRunning: (toolName) => `Công cụ ${toolName} đang chạy.`,
      turnFailed: "Lượt xử lý thất bại.",
    },
    terminal: {
      requiresInteractive: "TUI cần terminal có tương tác.",
      starting: "Đang khởi động ZCode... Nhấn Ctrl+C để thoát",
    },
    transcript: {
      compact: {
        completed: "Đã nén ngữ cảnh",
        failed: "Nén ngữ cảnh thất bại",
        interrupted: "Nén ngữ cảnh bị gián đoạn",
        retry: (command) => `Nhấn Ctrl-R để thử lại ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Đang thử nén lại ngữ cảnh (${attempt}/${maxAttempts})`
            : "Đang thử nén lại ngữ cảnh",
        skipped: "Ngữ cảnh đã mới nhất; không cần nén",
        started: "Đang nén ngữ cảnh",
      },
      roles: {
        agent: "Tác nhân",
        system: "Hệ thống",
        user: "Người dùng",
      },
      thought: {
        complete: "Suy nghĩ",
        thinking: "Đang suy nghĩ...",
      },
      title: "Bản ghi",
      workflow: {
        actors: "tác nhân:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `dùng: ${spentTokens} token`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Quy trình ${label} - ${status} (${nodesSettled}/${nodesTotal} bước)`,
        error: (message) => `lỗi: ${message}`,
        expandHint: "+ để mở rộng",
        collapseHint: "- để thu gọn",
        log: "nhật ký:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} bước đã xong`,
        result: (preview) => `kết quả: ${preview}`,
        status: {
          completed: "hoàn tất",
          errored: "lỗi",
          pending: "đang chờ",
          running: "đang chạy",
          stopped: "đã dừng",
        },
        stopReason: {
          user: "bởi bạn",
          model: "bởi agent",
          provider: "lỗi mô hình",
          interrupted: "tiến trình đã thoát",
          superseded: "bị thay thế bởi một lần chạy đã sửa",
        },
        truncated: "(đã cắt bớt - lịch sử đầy đủ trong sổ nhật ký lần chạy)",
        interruptedNotice: ({ label, runId }) =>
          `Quy trình ${label} đã bị gián đoạn và có thể tiếp tục: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter chọn, Esc hủy",
      disabled: (reason) => ` [vô hiệu: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `bộ lọc: ${filter || "-"} | ${help ?? "Enter chọn, Esc hủy"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Không có đường dẫn workspace phù hợp.",
      loading: "Đang tải đường dẫn workspace...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Tệp",
    },
    slash: {
      title: "Lệnh",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
