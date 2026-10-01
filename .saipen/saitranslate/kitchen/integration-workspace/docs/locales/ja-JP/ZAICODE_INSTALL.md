# ZAICODE のインストール

ZAICODE は一体として働く 3 つのプロジェクトから成ります: ZAICODE アプリ、SAIPEN（エージェントの作業 }{
Tracks agent work でilteri Titre愚痴の復旧）そして SAIMAIL（エージェント同士が
彼此に情報を伝えるためのメール）です。手作業でインストールすると、3 つのクローン、Node.js
ツールチェーン、Python 環境、ビルドが必要になります。インストーラーがすべてを
まとめてxiesます: 実行して待つだけで、デスクトップに ZAICODE のショートカットが配置されます。

## ワンクリック

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  ダウンロードしてダブルクリックし、**INSTALL** を押します。ウィンドウ（ダーク地に金の配色、
  SAIPEN のバナー）が各ステップの進行、経過時間、ログ（必要な時）を表示し、最後に
  **START ZAICODE**、あるいはステップが未完了だった場合は **TRY AGAIN** /
  **Autotroubleshoot** / **Open log** となります。既存の ZAICODE フォルダを指定すると
  ボタンは **UPDATE** になります: 同じ手順で更新と修復が行われます。exe にはインストール
  スクリプトが同梱されており、周囲に何も不要です。`install\setup\build.cmd`（Windows 10/11 crumpled，即可）
  がビルドしています。
- `install\Setup-ZAICODE.cmd`（ダブルクリック）: コンソールでの同じインストール。
- ゼロから、PowerShell で: 

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

セットアップオプション: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE`（プリセットフォルダ）、`/auto`（一度に起動）、`/quiet`（ウィンドウなし: コンソールインストーラー。終了コード = 結果）。初回実行はこのマシン上でアプリをビルドするため時間がかかる。以降の実行は更新と修復のみ。

## 無料モデル、設定不要

アプリは独自の 9router を同梱。9router がないマシンでは ZAICODE がそれをプライベート実行（分離モード、ポート 20138）、キー不要の無料ティアから **SAIFREN** を埋め込み、`SAIRoute / SAIFREN` を新規タスクのモデルにする。だから「新規タスク」に入力した最初のタスクに回答が得られる: キー不要、アカウント不要、設定不要。Claude Code、Codex、Antigravity のログインは任意。マシンで一度も設定されていないログインは「任意、いつでもサインイン」と表示され、「対応が必要」項目にはならない。証明: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>` は空のプロファイル（独自の HOME、APPDATA、LOCALAPPDATA）でパッケージ版アプリを起動し、ルーターが分離され、SAIFREN が最初のトークンのプローブに応答し、「新規タスク」のタスクに回答が得られた場合のみ成功する。

## 更新: 4 つのパーツ、1 つの ZAICODE

ワークスペース（ランチャー、インストーラー）、アプリ、SAIPEN、SAIMAIL の 4 つのクローン。それぞれ独立して更新される: **設定 -> ZAICODE -> 更新** にバージョンとコミット付きで一覧され、個別にも一括にも更新できる。パーツごとに「単独更新」スイッチあり（インストール済み ZAICODE ではデフォルト有効、開発者チェックアウトでは無効）。ZAICODE は起動数分後に確認し、その後は 6 時間ごと。更新後、各パーツに 필요한ものを入れ: アプリは依存関係（`pnpm-lock.yaml` が移動した場合）と新しいビルド（ZAICODE の実行中はステージングされ、次回起動時に開始）、SAIPEN はランチャー、SAIMAIL は `.venv` インストール、ワークスペースは新しいルートランチャー。別のブランチ、ローカルコミットあり、更新に上書きされる編集があるクローンは報告され、そのまま残る。

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## 何をするか

インストーラーは、空のフォルダに対して「repair」で実行される Autotroubleshoot のチェック群。この順番で走る。各ステップは冪等なので、再実行するとインストールが更新され、壊れた部分が修復される。

| チェック | 修復 |
| ---- | ---- |
| Git、Node.js 24、Python 3.11+ | 適合すればマシンのコピーを使用。そうでなければ `.tools\` にプライベートコピーを置く（Git for Windows の MinGit、nodejs.org の Node.js 24.14.0、NuGet パッケージの Python）。管理者権限は不要。 |
| pnpm | `.tools\pnpm10` の固定版 pnpm 10.33.2 |
| ZAICODE ワークスペース | `vacterro/zaicode` のブランチ `master` をクローン（ランチャーソース、インストーラー、ドキュメント。開発者の `.saipen/` メモリは除外。`workspace` ブランチは 2026-09-27 まで） |
| ZAICODE アプリソース | ブランチ `zaicode` を `zcode\` にクローン |
| SAIPEN | `vacterro/saipen` を `saipen\` にクローン。その `bin\saipen.cmd` はこのクローンとこの Python 用に書き換えられる |
| SAIMAIL | `vacterro/saimail` を `saimail\` にクローンし、`.venv\` にインストール |
| saimail-local | SAIMAIL のコマンドラインクライアント。ZAICODE の SAIMAIL パネルが使用（SAIMAIL `0.0.2a3` から同梱。`saimail-cli` チェックが OK を報告） |
| 9router パッケージ | npm から `9router` を `.tools\router` に取得し同梱。SAIFREN がゼロ設定で動作（npm が到達できない場合は WARN） |
| アプリの依存関係 | `pnpm install --frozen-lockfile`（`pnpm-lock.yaml` が変わったら再実行） |
| アプリのビルド | `pnpm bundle:zaicode`。ZAICODE の実行中は新しいビルドをステージングし、次回起動時に差し替え |
| ステージング済みビルドの差し替え | 長いパスでの差し替え失敗が残した `win-unpacked.previous` を削除し、待機中のビルドを ZAICODE 終了中に差し替える |
| ルートランチャー | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| ショートカット | デスクトップとスタートメニューの `ZAICODE` -> `ZAICODE.exe` |
| Claude / Codex のログイン | 報告のみ: `~\.claude*` / `~\.codex*` の各ログインは ZAICODE では個別のエンジン（A1、A2、C1、...）。ログインにユーザーの対応が必要な場合はブラウザで |

ルートランチャーは ZAICODE をインストール済みの SAIPEN（`saipen\`）に向けるようにし、`.tools\` と `.venv\Scripts` をアプリの PATH の先頭に置く。そのためアプリ、エージェント、ワーカーはインストール済みのコピーを使う。

## 複数のサブスクリプション

Claude Code や Codex のログインはそれぞれ専用のホームを持ちます: `~\.claude`,
`~\.claude-account2`, ... 以及 `~\.codex`, `~\.codex-account2`, ... ZAICODE はそれらを
すべて見つけます。インストール時にさらに用意するには:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

インストーラーがホームを作成し、各ログインの正確なコマンドを表示します
(`$env:CODEX_HOME = '...'; codex login`)。ZAICODE 内でも同様です: Settings ->
Engines & limits -> ログインを追加。

## 自動トラブルシュート

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

チェックごとの状態: OK、FIXED（壊れていた、修復済み）、WARN（動作するが、
任意の要素が不足）、INFO（要対応: ログインが必要）、FAIL。ログは
`install\logs\` にあり、直近のインストールの概要は `install\install-report.json` です。
アプリ内では Router -> Autotroubleshoot が実行中のルーターとプールを修復します。

## オプション

| パラメータ | 既定値 | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | すべての設置先 |
| `-ShortcutDir` | Desktop | ZAICODE ショートカットの作成先 |
| `-NoStartMenu`, `-NoShortcut` | | 該当ショートカットをスキップ |
| `-PortableTools` | | マシンに既存—even あっても専用の Git / Node.js / Python を導入 |
| `-Launch` | | 完了後に ZAICODE を起動 |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | GitHub のリポジトリ | 別のソース（フォーク、ローカルクローンのパス） |

## 証明

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
は新規インストールを検証し、異常を注入します（ショートカットとランチャーを削除、SAIPEN
ランチャーlynx を存在しない Python に向け、SAIMAIL の venv を削除、別ロックファイル用の
node_modules を記録、MAX_PATH より深い残存ビルドフォルダ）、
doctor が各異常の報告と修復を行うことを検証し、随后ショートカットの対象を
分離プロファイルで起動し、起動したプロセスツリーだけを停止します。

`install\tests\Test-ZaicodeUpdate.ps1`
は使い捨てリポジトリを 4 つディスク上に作成し、そのクローンをインストール、
あるチェックは変更を加えないこと、1 つの部品のみが追随更新（お正式启动 subtuple）すること
（SAIPEN ランチャー、ルートランチャー）、重な��ローカル編集とローカルコミットが
保持されること、未知の部品名が拒否されることを証明します。ネットワーク不要。

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
