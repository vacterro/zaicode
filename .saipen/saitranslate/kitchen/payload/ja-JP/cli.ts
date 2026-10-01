import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "ja-JP",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `サポートされない --locale 値: ${value}。サポートされるロケール: en-US, zh-CN, auto。`,
    },
    help: (version) => `zcode ${version}

使い方:
  zcode [command] [options]

コマンドを指定しない場合、zcode は全画面 TUI を開きます。

コマンド:
  app-server ZCode Protocol の stdio アプリサーバーを実行
  commands   カスタムスラッシュコマンドを一覧 (\`commands list\`)
  doctor     ランタイムとパッケージングの前提を検査
  login [zai|bigmodel]  ブラウザ認可経由でサインイン
  logout     共有の Z.AI ログイン認証情報を削除
  plugins    プラグインとマーケットプレイスを管理 (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; 別名: plugin)
  skills     ローカルスキルを一覧 (\`skills list\`)
  tui        ターミナル UI を開く
  version    CLI バージョンを表示

オプション:
  -h, --help       ヘルプを表示
  -v, --version    バージョンを表示
  -p, --prompt <text>  TUI を開かずに単一のプロンプトを実行
  --memory-bench   --prompt と併用すると、Memory の自動抽出を有効にして終了前に待機 (Memory 有効が必要)
  --browser-use <mode> Browser Use バックエンドを有効化 (対応: headless)
  --surface <surface>  headless プロンプト/アプリサーバーの表示先: terminal または desktop
  --browser-executable <path> headless Browser Use 用 Chrome/Chromium 実行ファイル
  --attach <path>  ローカルファイルを --prompt に添付。複数指定は繰り返し
  --cwd <path>     指定ディレクトリからこのコマンドを実行
  --disallowed-tools, --disallowedTools <tools...>
    このプロンプト/TUI の実行に限りツールを完全に除外します。保存済みの設定は変更されません。
    ツール名はカンマまたはスペース区切り、例: "Bash Edit"。
    "Bash(git *)" は Bash 全体を除外します。コマンドパターンは照合されません。
  --force-mcs      Anthropic プロバイダーで会話途中のシステム投影を強制
  --locale <locale>  UI ロケール: en-US、zh-CN、auto
  --mode <mode>    プロンプトの権限モード: build、edit、plan、yolo (--prompt の既定は yolo)
  --resume <sessionId>  sessionId で保存済みセッションを再開 (sess_...)
  --target <text>  headless モードでセッション目標を実行または設定
  --target-replace --target が設定した既存のセッション目標を置き換え
  -c, --continue        現在のディレクトリの最新セッションを再開
  --json           対応箇所では機械可読 JSON を出力
  --no-browser     ブラウザを開かずに OAuth URL を出力
  --no-color       ANSI 色を無効化
  --verbose        追加の診断詳細を出力

スラッシュコマンド:
  /help [command]       スラッシュコマンドのヘルプを表示
  /login                Z.AI または BigModel のブラウザログインを選択
  /logout               共有の Z.AI ログイン認証情報を削除
  /compact [instructions]  現在の会話を圧縮
  /expert [status|resume|stop|<task>]  エキスパートワークフローの実行または管理
  /dwf [list|cancel|resume]  動的ワークフロー実行の一覧、キャンセル、再開
  /fork [latest|checkpointId]  ワークスペースのチェックポイントから新セッションを分岐
  /mcp [list|status|connect|disconnect]  MCP サーバーの表示または管理
  /mode [mode]          権限モードの表示または切り替え: build、edit、plan、yolo
  /model [id]           現在のセッションモデルの表示または切り替え
  /new                  TUI で新しいセッションを開始
  /resume [sessionId]   sessionId でセッションを再開。省略時は cwd の最新
  /rewind [latest|checkpointId]  最新チェックポイントの表示またはワークスペースファイルの復元
  /skill [name] [task]  スキルを一覧、または次プロンプトで読み込みを強制
  /goal [action]        現在のセッション目標の表示または設定`,
  },
  tui: {
    copy: {
      copied: "選択したテキストをクリップボードにコピーしました。",
      failed: "選択したテキストをコピーできませんでした。",
      unavailable: "このターミナルではテキストのクリップボードコピーを利用できません。",
    },
    effort: {
      disabled: "無効",
      enabled: "有効",
    },
    input: {
      activeStatusHint: "Esc で中断",
      busyPlaceholder: "入力はキューに追加されます",
      placeholder: "プロンプトを入力",
      queuedMore: (count) => `他 ${count} 件がキュー待ち`,
      queuedSubmitHint: "次のツール呼び出しの後に送信されます。",
      queuedTitle: (count) => ` キュー (${count}) `,
      title: "入力",
      noHistorySource: "入力履歴のソースが未設定です。",
      noPreviousInput: "このプロジェクトの以前の入力はありません。",
      restoredPreviousInput: "以前の入力を復元しました。",
      restoredPreviousInputWithAttachments: (count) =>
        `以前の入力を添付 ${count} 件付きで復元しました。`,
      restorePreviousInputFailed: "以前の入力を復元できませんでした。",
      typePrompt: "質問を入力して Enter を押してください。",
    },
    loginRequired: {
      help: "/model でモデルを表示、/login で Coding Plan アカウントを接続できます。",
      message: "利用可能なモデルがありません。プロバイダーを設定するか、/login でサインインしてください。",
      status: "利用可能なモデルがありません。プロバイダーを設定するか、/login でサインインしてください。",
      title: "モデルの設定が必要",
    },
    loginSetup: {
      emptyMessage: "利用できるログイン方法がありません。",
      help: "↑/↓ で選択、Enter で確定。",
      options: {
        bigmodelApiKey: {
          inputPrimary: "BigModel Coding Plan API Key を入力",
          inputSecondary: "ここにキーを貼り付けてください。入力中は非表示になります。",
          primary: "BigModel Coding Plan API キー",
          secondary: "Coding Plan API キーを手動で貼り付けてください。",
        },
        bigmodelOauth: {
          pendingPrimary: "BigModel の認可を待機中",
          pendingSecondary:
            "ブラウザでサインインを完了してください。認可は自動的に検出されます。",
          primary: "BigModel Coding プラン",
          secondary: "ブラウザログインを開きます。認可は自動的に検出されます。",
        },
        zaiApiKey: {
          inputPrimary: "Z.AI Coding Plan API Key を入力",
          inputSecondary: "ここにキーを貼り付けてください。入力中は非表示になります。",
          primary: "Z.AI Coding Plan API キー",
          secondary: "Coding Plan API キーを手動で貼り付けてください。",
        },
        zaiOauth: {
          pendingPrimary: "Z.AI の認可を待機中",
          pendingSecondary:
            "ブラウザでサインインを完了してください。認可完了後に続行します。",
          primary: "Z.AI Coding Plan",
          secondary: "ブラウザでログインし、Coding Plan の API キーを作成します。",
        },
      },
      pending: {
        cancelStatus: "ログインをキャンセルしました。セットアップ方法を選択してください。",
        help: "Esc でキャンセルし、セットアップ選択に戻ります。",
        status: "ブラウザでの認可を待っています...",
      },
      input: {
        cancelStatus: "API キー入力をキャンセルしました。セットアップ方法を選択してください。",
        clearStatus: "API キー入力をクリアしました。",
        emptyStatus: "API キーが必要です。",
        help: "Enter でキーを保存。Esc でセットアップ選択に戻ります。",
        placeholder: "API キーを貼り付け",
        status: "API キーを入力し、Enter を押してください。",
        submitStatus: "API キーを保存しています...",
      },
      prompt: "ログインまたは API キーのセットアップ方法を選択してください。",
      response: "Coding Plan プロバイダーのセットアップ方法を選択してください。",
      title: "Coding Plan をセットアップ",
    },
    model: {
      requestFailed: (message) => `モデルリクエストが失敗しました: ${message}`,
      responseReceived: "モデルの応答を受け取りました。",
      responseReceivedWithTokens: (tokens) => `モデルの応答を受け取りました。${tokens} トークン。`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `モデルリクエストを再試行 ${attempt}/${Math.max(1, maxAttempts - 1)}（${delay} 後）: ${reason}`,
      streamStalled: "モデルのストリームが停止しました。",
    },
    sidebar: {
      subagents: {
        title: "サブエージェント",
        empty: "サブエージェントはまだありません。",
        emptyOutput: "出力はまだありません。",
        back: "← メインの会話",
        readonly: "読み取り専用 · Esc で戻る",
        loading: "サブエージェントの出力を読み込んでいます...",
        unavailable: "サブエージェントの出力を利用できません。",
        retry: "再試行",
        more: "さらに読み込む",
        pendingMain: "メインの会話が入力を待っています — 戻って応答してください",
        ended: (count) => `終了 (${count})`,
        status: {
          running: "実行中",
          waiting: "待機中",
          blocked: "ブロック",
          success: "完了",
          failed: "失敗",
          cancelled: "キャンセル",
          lost: "消失",
        },
      },
      api: {
        empty: "API 呼び出しはまだありません。",
        model: "モデル",
        more: (count) => `他${count}件`,
        requests: "リクエスト",
        server: "サーバー",
      },
      cache: {
        hit: "ヒット",
        lastHit: "最終ヒット",
        lastMiss: "最終ミス",
        readWrite: ({ read, write }) => `読${read} / 書${write}`,
        total: "合計",
      },
      context: {
        cache: "キャッシュ",
        cacheReadWrite: "キャッシュ R/W",
        inputOutput: "I/O",
        reason: "理由",
        tokens: "トークン",
        used: "使用",
        window: "ウィンドウ",
      },
      modifiedFiles: {
        empty: "ファイル変更はまだありません。",
        more: (count) => `他${count}件`,
      },
      mcp: {
        empty: "MCP サーバーが未設定です。",
        loadFailed: "MCP ステータスを取得できません。",
        loading: "MCP ステータスを読み込み中...",
        more: (count) => `他${count}件`,
        servers: "サーバー",
        status: {
          connected: "接続済み",
          connecting: "接続中",
          disabled: "無効",
          disconnected: "切断",
          failed: "失敗",
          untrusted: "未信頼",
        },
        summary: ({ connected, total }) => `${connected}/${total} 接続済み`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "完了",
        error: "エラー",
        errorWithStatus: (statusCode) => `エラー ${statusCode}`,
        pending: "保留",
      },
      status: {
        last: "最終",
      },
      run: {
        draft: "下書き",
        draftChars: (count) => `${count} 文字`,
        draftEmpty: "空",
        messages: "メッセージ",
        mode: "モード",
        model: "モデル",
        provider: "プロバイダー",
        thought: "思考",
        trace: "トレース",
        turn: "ターン",
        workspace: "ワークスペース",
      },
      sections: {
        apis: "APIs",
        context: "コンテキスト",
        mcp: "MCP",
        modifiedFiles: "変更ファイル",
        run: "実行",
        status: "ステータス",
        todos: "ToDo",
      },
      shellSubtitle: "OpenTUI シェル",
      title: "サイドバー",
      todos: {
        empty: "ToDo はまだありません。",
        more: (count) => `他 ${count} 件`,
        progress: "進捗",
      },
    },
    status: {
      compactFailed: "コンテキストの圧縮に失敗しました。",
      compacted: "会話を圧縮しました。",
      compacting: "コンテキストを圧縮中...",
      interruptedStreamDiscarded: "中断されたモデルストリームを破棄しました。",
      modelCalling: "モデルを呼び出し中...",
      permissionRequested: (toolName) => `${toolName} の権限が要求されました。`,
      permissionResolved: (toolName) => `${toolName} の権限が解決されました。`,
      ready: "準備完了。",
      recoveringStream: "中断されたモデルストリームを再開中...",
      retryingStream: "モデルストリームを再試行中...",
      sessionResumed: "セッションを再開しました。",
      targetChanged: (action) => `対象 ${action}。`,
      thinking: "思考中...",
      toolCompleted: (toolName) => `ツール ${toolName} が完了しました。`,
      toolFailed: (toolName) => `ツール ${toolName} が失敗しました。`,
      toolPending: (toolName) => `ツール ${toolName} が待機中。`,
      toolRunning: (toolName) => `ツール ${toolName} が実行中。`,
      turnFailed: "ターンが失敗しました。",
    },
    terminal: {
      requiresInteractive: "TUI には対話型ターミナルが必要です。",
      starting: "ZCode を起動中... 終了は Ctrl+C",
    },
    transcript: {
      compact: {
        completed: "コンテキストを圧縮しました",
        failed: "コンテキストの圧縮に失敗しました",
        interrupted: "コンテキストの圧縮が中断されました",
        retry: (command) => `Ctrl-R で ${command} を再試行`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `コンテキスト圧縮を再試行中 (${attempt}/${maxAttempts})`
            : "コンテキスト圧縮を再試行中",
        skipped: "コンテキストは最新です。圧縮は不要です",
        started: "コンテキストを圧縮中",
      },
      roles: {
        agent: "エージェント",
        system: "システム",
        user: "ユーザー",
      },
      thought: {
        complete: "思考",
        thinking: "思考中...",
      },
      title: "記録",
      workflow: {
        actors: "actor:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `使用量: ${spentTokens} トークン`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `ワークフロー ${label} - ${status} (${nodesSettled}/${nodesTotal} ステップ)`,
        error: (message) => `エラー: ${message}`,
        expandHint: "+ で展開",
        collapseHint: "- で折りたたむ",
        log: "ログ:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} ステップ完了`,
        result: (preview) => `結果: ${preview}`,
        status: {
          completed: "完了",
          errored: "エラー",
          pending: "保留中",
          running: "実行中",
          stopped: "停止",
        },
        stopReason: {
          user: "あなたによる",
          model: "エージェントによる",
          provider: "モデルエラー",
          interrupted: "プロセスが終了しました",
          superseded: "修正済み実行により置き換えられました",
        },
        truncated: "（省略 - 完全な履歴は実行ジャーナルにあります）",
        interruptedNotice: ({ label, runId }) =>
          `ワークフロー ${label} は中断されました。再開できます: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter で選択、Esc でキャンセル",
      disabled: (reason) => ` [無効: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `フィルター: ${filter || "-"} | ${help ?? "Enter で選択、Esc でキャンセル"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "一致するワークスペースのパスがありません。",
      loading: "ワークスペースのパスを読み込み中...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "ファイル",
    },
    slash: {
      title: "コマンド",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
