import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "zh-CN",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `不支持的 --locale 值：${value}。支持的区域设置：en-US、zh-CN、auto。`,
    },
    help: (version) => `zcode ${version}

用法：
  zcode [command] [options]

不带命令时，zcode 打开全屏 TUI。

命令：
  app-server 运行 ZCode Protocol stdio 应用服务器
  commands   列出自定义斜杠命令（\`commands list\`）
  doctor     检查运行时与打包假设
  login [zai|bigmodel]  通过浏览器授权登录
  logout     移除共享的 Z.AI 登录凭据
  plugins    管理插件与市场（\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`；别名：plugin）
  skills     列出本地技能（\`skills list\`）
  tui        打开终端界面
  version    打印 CLI 版本

选项：
  -h, --help       显示帮助
  -v, --version    显示版本
  -p, --prompt <text>  不打开 TUI，直接执行单条提示词
  --memory-bench   与 --prompt 搭配时，启用自动 Memory 提取并在退出前等待（需启用 Memory）
  --browser-use <mode> 启用 Browser Use 后端（支持：headless）
  --surface <surface>  headless 提示词/app-server 的展示界面：terminal 或 desktop
  --browser-executable <path> headless Browser Use 使用的 Chrome/Chromium 可执行文件
  --attach <path>  为 --prompt 附加本地文件；可重复以附加多个文件
  --cwd <path>     在指定目录下运行此命令
  --disallowed-tools, --disallowedTools <tools...>
    仅在本次提示词/TUI 运行中移除整个工具；已保存的设置不变。
    用逗号或空格分隔的工具名，例如 "Bash Edit"。
    "Bash(git *)" 会移除整个 Bash；不匹配命令模式。
  --force-mcs      对 Anthropic 提供方强制执行对话中途的系统提示投射
  --locale <locale>  界面区域设置：en-US、zh-CN 或 auto
  --mode <mode>    提示词的权限模式：build、edit、plan 或 yolo（--prompt 默认为 yolo）
  --resume <sessionId>  按 sessionId 恢复已持久化的会话（sess_...）
  --target <text>  在 headless 模式下运行或设置会话目标
  --target-replace 替换 --target 设置的任何现有会话目标
  -c, --continue        恢复当前目录最近的会话
  --json           在支持的场景输出机器可读 JSON
  --no-browser     打印 OAuth URL，不打开浏览器
  --no-color       禁用 ANSI 颜色
  --verbose        打印额外的诊断信息

斜杠命令：
  /help [command]       显示斜杠命令帮助
  /login                选择 Z.AI 或 BigModel 浏览器登录
  /logout               移除共享的 Z.AI 登录凭据
  /compact [instructions]  压缩当前对话
  /expert [status|resume|stop|<task>]  运行或管理专家工作流
  /dwf [list|cancel|resume]  列出、取消或恢复动态工作流运行
  /fork [latest|checkpointId]  从工作区检查点派生新会话
  /mcp [list|status|connect|disconnect]  显示或管理 MCP 服务器
  /mode [mode]          显示或切换权限模式：build、edit、plan 或 yolo
  /model [id]           显示或切换当前会话模型
  /new                  在 TUI 中开启全新会话
  /resume [sessionId]   按 sessionId 恢复会话；省略则使用 cwd 中最近的会话
  /rewind [latest|checkpointId]  显示最新检查点或还原工作区文件
  /skill [name] [task]  列出技能，或强制下一条提示词加载某个技能
  /goal [action]        显示或设置当前会话目标
`,
  },
  tui: {
    copy: {
      copied: "已将所选文本复制到剪贴板。",
      failed: "无法复制所选文本。",
      unavailable: "此终端不支持文本剪贴板复制。",
    },
    effort: {
      disabled: "已禁用",
      enabled: "已启用",
    },
    input: {
      activeStatusHint: "按 esc 中断",
      busyPlaceholder: "输入内容以加入队列",
      placeholder: "输入提示词",
      queuedMore: (count) => `另有 ${count} 条排队中`,
      queuedSubmitHint: "在下次工具调用后提交。",
      queuedTitle: (count) => ` 队列（${count}） `,
      title: "输入",
      noHistorySource: "未配置输入历史来源。",
      noPreviousInput: "此项目没有之前的输入。",
      restoredPreviousInput: "已恢复之前的输入。",
      restoredPreviousInputWithAttachments: (count) =>
        `已恢复之前的输入，附带 ${count} 个附件。`,
      restorePreviousInputFailed: "无法恢复之前的输入。",
      typePrompt: "输入问题并按 Enter。",
    },
    loginRequired: {
      help: "使用 /model 查看模型，或用 /login 连接 Coding Plan 账户。",
      message: "没有可用模型。请配置提供方，或用 /login 登录。",
      status: "没有可用模型。请配置提供方，或用 /login 登录。",
      title: "需要配置模型",
    },
    loginSetup: {
      emptyMessage: "没有可用的登录方式。",
      help: "用 Up/Down 选择，Enter 确认。",
      options: {
        bigmodelApiKey: {
          inputPrimary: "输入 BigModel Coding Plan API Key",
          inputSecondary: "在此粘贴密钥，输入时不会显示。",
          primary: "BigModel Coding Plan API 密钥",
          secondary: "手动粘贴 Coding Plan API 密钥。",
        },
        bigmodelOauth: {
          pendingPrimary: "等待 BigModel 授权",
          pendingSecondary:
            "在浏览器中完成登录，将自动检测到授权。",
          primary: "BigModel Coding Plan 订阅",
          secondary: "打开浏览器登录，将自动检测到授权。",
        },
        zaiApiKey: {
          inputPrimary: "输入 Z.AI Coding Plan API Key",
          inputSecondary: "在此粘贴密钥，输入时不会显示。",
          primary: "Z.AI Coding Plan API 密钥",
          secondary: "手动粘贴 Coding Plan API 密钥。",
        },
        zaiOauth: {
          pendingPrimary: "等待 Z.AI 授权",
          pendingSecondary:
            "在浏览器中完成登录，授权完成后我会继续。",
          primary: "Z.AI Coding Plan",
          secondary: "打开浏览器登录，创建 Coding Plan API 密钥。",
        },
      },
      pending: {
        cancelStatus: "已取消登录。选择一种设置方式。",
        help: "Esc 取消并返回设置选项。",
        status: "等待浏览器授权...",
      },
      input: {
        cancelStatus: "已取消输入 API 密钥。选择一种设置方式。",
        clearStatus: "API 密钥输入已清空。",
        emptyStatus: "API 密钥为必填项。",
        help: "Enter 保存密钥。Esc 返回设置选项。",
        placeholder: "粘贴 API 密钥",
        status: "输入 API 密钥，然后按 Enter。",
        submitStatus: "正在保存 API 密钥...",
      },
      prompt: "选择登录或 API 密钥设置方式。",
      response: "选择 Coding Plan 提供商的设置方式。",
      title: "设置 Coding Plan",
    },
    model: {
      requestFailed: (message) => `模型请求失败：${message}`,
      responseReceived: "已收到模型响应。",
      responseReceivedWithTokens: (tokens) => `已收到模型响应。${tokens} tokens`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `将在 ${delay} 后重试模型请求 ${attempt}/${Math.max(1, maxAttempts - 1)}：${reason}`,
      streamStalled: "模型流已停滞。",
    },
    sidebar: {
      subagents: {
        title: "子智能体",
        empty: "暂无子智能体。",
        emptyOutput: "暂无输出。",
        back: "← 主对话",
        readonly: "只读 · Esc 返回",
        loading: "正在加载子智能体输出...",
        unavailable: "子智能体输出不可用。",
        retry: "重试",
        more: "加载更多",
        pendingMain: "主对话需要你的输入 — 返回以回复",
        ended: (count) => `已结束（${count}）`,
        status: {
          running: "运行中",
          waiting: "等待中",
          blocked: "已阻塞",
          success: "已完成",
          failed: "失败",
          cancelled: "已取消",
          lost: "已丢失",
        },
      },
      api: {
        empty: "暂无 API 调用。",
        model: "模型",
        more: (count) => `+${count} 更多`,
        requests: "请求",
        server: "服务器",
      },
      cache: {
        hit: "命中",
        lastHit: "上次命中",
        lastMiss: "上次未命中",
        readWrite: ({ read, write }) => `${read} 读 / ${write} 写`,
        total: "总计",
      },
      context: {
        cache: "缓存",
        cacheReadWrite: "缓存读/写",
        inputOutput: "I/O",
        reason: "原因",
        tokens: "令牌",
        used: "已用",
        window: "窗口",
      },
      modifiedFiles: {
        empty: "暂无文件改动。",
        more: (count) => `+${count} 更多`,
      },
      mcp: {
        empty: "未配置 MCP 服务器。",
        loadFailed: "MCP 状态不可用。",
        loading: "正在加载 MCP 状态...",
        more: (count) => `+${count} 更多`,
        servers: "服务器",
        status: {
          connected: "已连接",
          connecting: "连接中",
          disabled: "已禁用",
          disconnected: "已断开",
          failed: "失败",
          untrusted: "不受信任",
        },
        summary: ({ connected, total }) => `${connected}/${total} 已连接`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "完成",
        error: "错误",
        errorWithStatus: (statusCode) => `错误 ${statusCode}`,
        pending: "待处理",
      },
      status: {
        last: "最后",
      },
      run: {
        draft: "草稿",
        draftChars: (count) => `${count} 字符`,
        draftEmpty: "空",
        messages: "消息",
        mode: "模式",
        model: "模型",
        provider: "提供方",
        thought: "思考",
        trace: "轨迹",
        turn: "轮次",
        workspace: "工作区",
      },
      sections: {
        apis: "APIs",
        context: "上下文",
        mcp: "MCP",
        modifiedFiles: "已修改文件",
        run: "运行",
        status: "状态",
        todos: "待办",
      },
      shellSubtitle: "OpenTUI 终端",
      title: "侧边栏",
      todos: {
        empty: "暂无待办。",
        more: (count) => `还有 +${count} 项`,
        progress: "进度",
      },
    },
    status: {
      compactFailed: "上下文压缩失败。",
      compacted: "对话已压缩。",
      compacting: "正在压缩上下文...",
      interruptedStreamDiscarded: "已丢弃中断的模型流。",
      modelCalling: "正在调用模型...",
      permissionRequested: (toolName) => `已请求 ${toolName} 的权限。`,
      permissionResolved: (toolName) => `${toolName} 的权限已处理。`,
      ready: "就绪。",
      recoveringStream: "正在恢复中断的模型流...",
      retryingStream: "正在重试模型流...",
      sessionResumed: "会话已恢复。",
      targetChanged: (action) => `目标 ${action}。`,
      thinking: "思考中...",
      toolCompleted: (toolName) => `工具 ${toolName} 已完成。`,
      toolFailed: (toolName) => `工具 ${toolName} 失败。`,
      toolPending: (toolName) => `工具 ${toolName} 等待中。`,
      toolRunning: (toolName) => `工具 ${toolName} 运行中。`,
      turnFailed: "本轮失败。",
    },
    terminal: {
      requiresInteractive: "TUI 需要交互式终端。",
      starting: "正在启动 ZCode... 按 Ctrl+C 退出",
    },
    transcript: {
      compact: {
        completed: "上下文已压缩",
        failed: "上下文压缩失败",
        interrupted: "上下文压缩已中断",
        retry: (command) => `按 Ctrl-R 重试 ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `正在重试上下文压缩（${attempt}/${maxAttempts}）`
            : "正在重试上下文压缩",
        skipped: "上下文已是最新，无需压缩",
        started: "正在压缩上下文",
      },
      roles: {
        agent: "智能体",
        system: "系统",
        user: "用户",
      },
      thought: {
        complete: "思考",
        thinking: "思考中...",
      },
      title: "对话记录",
      workflow: {
        actors: "参与者：",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `用量：${spentTokens} tokens`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `工作流 ${label} - ${status}（${nodesSettled}/${nodesTotal} 步）`,
        error: (message) => `错误：${message}`,
        expandHint: "+ 展开",
        collapseHint: "- 折叠",
        log: "日志：",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} 步已结束`,
        result: (preview) => `结果：${preview}`,
        status: {
          completed: "已完成",
          errored: "出错",
          pending: "待处理",
          running: "运行中",
          stopped: "已停止",
        },
        stopReason: {
          user: "由你停止",
          model: "由智能体停止",
          provider: "模型错误",
          interrupted: "进程已退出",
          superseded: "已被修正后的运行取代",
        },
        truncated: "（已截断 - 完整历史见运行日志）",
        interruptedNotice: ({ label, runId }) =>
          `工作流 ${label} 已中断，可恢复：/dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter 选择，Esc 取消",
      disabled: (reason) => ` [已禁用：${reason}]`,
      filterLine: ({ filter, help }) =>
        `筛选：${filter || "-"} | ${help ?? "Enter 选择，Esc 取消"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "没有匹配的工作区路径。",
      loading: "正在加载工作区路径...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "文件",
    },
    slash: {
      title: "命令",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
