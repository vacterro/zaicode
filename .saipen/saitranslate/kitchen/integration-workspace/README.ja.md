# ZAICODE

[en-US](README.md) · [ru-RU](docs/locales/ru-RU/README.md) · [et-EE](docs/locales/et-EE/README.md) · [uk-UA](docs/locales/uk-UA/README.md) · [ja-JP](docs/locales/ja-JP/README.md) · [ded](docs/locales/ded/README.md) · [zh-CN](docs/locales/zh-CN/README.md) · [de-DE](docs/locales/de-DE/README.md) · [fr-FR](docs/locales/fr-FR/README.md) · [es-ES](docs/locales/es-ES/README.md) · [it-IT](docs/locales/it-IT/README.md) · [pt-BR](docs/locales/pt-BR/README.md) · [nl-NL](docs/locales/nl-NL/README.md) · [pl-PL](docs/locales/pl-PL/README.md) · [sv-SE](docs/locales/sv-SE/README.md) · [da-DK](docs/locales/da-DK/README.md) · [fi-FI](docs/locales/fi-FI/README.md) · [nb-NO](docs/locales/nb-NO/README.md) · [ko-KR](docs/locales/ko-KR/README.md) · [th-TH](docs/locales/th-TH/README.md) · [vi-VN](docs/locales/vi-VN/README.md) · [ar-SA](docs/locales/ar-SA/README.md) · [he-IL](docs/locales/he-IL/README.md) · [tr-TR](docs/locales/tr-TR/README.md) · [hi-IN](docs/locales/hi-IN/README.md) · [id-ID](docs/locales/id-ID/README.md) · [el-GR](docs/locales/el-GR/README.md) · [cs-CZ](docs/locales/cs-CZ/README.md) · [ro-RO](docs/locales/ro-RO/README.md) · [hu-HU](docs/locales/hu-HU/README.md) · [bg-BG](docs/locales/bg-BG/README.md) · [sk-SK](docs/locales/sk-SK/README.md) · [hr-HR](docs/locales/hr-HR/README.md)

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

<img width="1440" height="860" alt="ZAICODE hero — Do your best." src="docs/screenshots/01-do-your-best.png" />

ZAICODE は、複数のプロジェクト上で多数の AI コーディングエージェントを
同時に運用するためのオペレータワークベンチです。張り付きは不要です。
[ZCode](https://github.com/zai-org/ZCode)（デスクトップアプリ、ブラウザ UI、エージェント
CLI）を改造したビルドの上に製品レイヤーを載せたもの。すべてのプロジェクトは
[SAIPEN](https://github.com/vacterro/saipen) プロトコルで駆動され、作業の開始・継続・スケジュール設定は
1 つのウィンドウで行い、すでに課金しているサブスクリプション CLI
（Claude Code、Codex、Antigravity）はアプリ内エージェントの隣にドッキングされた
ワーカーとして動作します。

**0.0.1** は最初のタグ付きスナップショットです。Windows 優先の個人用ビルドで、
毎日使っています。

## ワンクリックでインストール

1. **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)** をダウンロードします。
2. ダブルクリックし、**INSTALL** を押します。

これだけです。セットアップがマシンに無いもの（Git、Node.js、Python。プライベート
コピーとして入れるため管理者権限は不要）を導入し、GitHub から ZAICODE、SAIPEN、
SAIMAIL を取得し、マシン上でアプリをビルドして、デスクトップに ZAICODE の
ショートカットを作成します。初回起動には 15〜30 分かかります。ウィンドウに
各手順が表示されます。

無料モデルはすぐに使えます。ZAICODE は独自のルーターを起動し、キー不要の無料ティア
から **SAIFREN** プールを埋めます。そのため「新規タスク」に入力したタスクには、
キー不要・アカウント不要・設定不要で回答が得られます。Claude Code、Codex、
Antigravity のサブスクリプションは任意で、いつでもサインインできます。

**1 つで完結、4 つのパーツ。** ワークスペース（ランチャー、インストーラー）、アプリ、
SAIPEN、SAIMAIL の 4 つのリポジトリで構成されています。それぞれが
独立して更新されます。*Settings -> ZAICODE -> Updates* ですべてのパーツを
表示し、手動または自動で更新できます（起動数分後と 6 時間ごとに確認）。
新しいアプリビルドは ZAICODE の実行中に準備され、次回起動時に適用されます。
クローンに自分で加えた変更が上書きされることはありません。
ターミナルから: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`。
自動トラブルシューティング: `install\Doctor.cmd`。詳細: [docs/ZAICODE_INSTALL.md](docs/locales/ja-JP/ZAICODE_INSTALL.md)。

## 画面の概要

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>SAIHOME</strong><br />
      The operator dashboard: quotas, health, projects, streaks, activity, and the live clock in one place.<br /><br />
      <img src="docs/screenshots/02-saihome-dashboard.png" alt="SAIHOME dashboard" />
    </td>
    <td width="50%" valign="top">
      <strong>Agents &amp; tasks</strong><br />
      Create roles, inspect queues, and see what is idle, running, finished, or waiting for you.<br /><br />
      <img src="docs/screenshots/03-agents-and-tasks.png" alt="Agents and tasks" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Scheduler</strong><br />
      Arm quota-aware autonomous runs and recurring prompts across one project or a whole sidebar section.<br /><br />
      <img src="docs/screenshots/04-scheduler.png" alt="Scheduler" />
    </td>
    <td width="50%" valign="top">
      <strong>Audits</strong><br />
      Run Quick 3 Waves audits, watch progress live, and jump straight to reports when something stops.<br /><br />
      <img src="docs/screenshots/05-audits.png" alt="Audits" />
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <strong>Active session</strong><br />
      The full working view: transcript, branch, prompt composer, state inspector, board, and backlog at the same time.<br /><br />
      <img src="docs/screenshots/06-active-session.png" alt="Active session" />
    </td>
  </tr>
</table>

## ZCode への追加機能

- **MAIN セッションを持つプロジェクト。**各プロジェクトに MAIN セッションが 1 つ（START、`/goal cc all`）と、ヘルパーセッション（subSaipens: WIKI、TEST、AUDIT、…）があります。サイドバーのデフォルト表示ではプロジェクト行が MAIN を表し、▶ は別セッションを開かず MAIN を続行します。CONTINUE ALL、DONE、CLEAR ALL DONE は全プロジェクトを対象に走査します。ターン途中で切られたセッションは DONE ではなく INTERRUPTED と表示されます。
- **クラッシュ安全性。**プロセスの異常終了で中断したセッションと、進行中のゴールは再起動後に自動で続行され、実行中だったワーカーも再起動します。ZAICODE 内のエージェントはプロセス名では ZAICODE を終了できません。
- **ワーカー。**サブスクリプション CLI は、ウィンドウの任意の端にドッキングしたターミナル（または独立したスナップウィンドウ）で実行されます。初回実行時の「Trust this folder?」には回答済みで、使用量上限に達したワーカーは報告され、設定に応じてリセット後に終了または再起動されます。
- **上限とリセット。**アカウント・プールごとのクォータメーター、タイトルバーに次回リセットまでのタイマー。ホバーで今後の全リセット一覧を表示します。
- **SCHEDULER。**自動起動するプロンプト：指定時刻、毎日、N 分ごと、クォータ枠の回復時。対象は 1 プロジェクトまたはサイドバーセクション全体で、最優先は状況が最も悪いプロジェクト（ブロック／未解決の SAIPEN チケットが多い順）です。条件により、応急措置（フリープールセッション、弱いワーカー）を先に停止、アイドル中のプロジェクトのみで実行、マーク済みセッションのみ継続、を選択できます。プロンプトに実用的な長さ制限はありません。
- **ルーティング。**同梱の 9router（MIT）で設定不要のプールを提供：SAIFREN（キー不要のフリーティア）と SAIOPP（自分のサブスクリプション）。
- **SAIHOME、タイマー、音、ハイライト。**統計付きの運営者ホーム、FastPrompter 式のタイマーとアラーム、アクションごとの効果音、ピクセルシャープな Win95 ダークゴールデン調のインターフェース。

## ビルド

要件: Windows 10/11、Git、Node.js **24.14.0**、pnpm **10.33.2**（[mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) が基準）。

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

パッケージ済みアプリは必ず ZAICODE モードで起動します。旧バージョンの ZAICODE が起動中の間、バンドラーは新しいビルドを `packages/desktop/dist-next` にステージングします。ルートランチャー（ブランチ `master`、`tools/launcher`）が次回起動時に差し替えます。UI が使うくっきりしたビットマップ Verdana 変種はこのリポジトリには含まれません。無い場合、インターフェースはシステムの Verdana にフォールバックします。

チェック: `pnpm typecheck`、`pnpm lint`、および ZAICODE テスト。例えば `packages/ui` から `node --import tsx --test test/zaicode*.test.ts`。

## リポジトリ構成

| ブランチ      | 内容                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | 正統なワークスペース: ランチャー、インストーラー（`install/`）、製品ドキュメント（`UI.md`、`docs/`）、SAIPEN 状態と CHANGELOG |
| `zaicode`   | 正統なアプリソース: 上流の ZCode 履歴と、ビルド・更新に使われる ZAICODE 製品レイヤー |

レガシーや自動化で作成された ref が一時的に残ることがありますが、正統な製品ブランチではありません。新しいワークスペース作業は `master` に、アプリソースの作業は `zaicode` に置くこと。

ZAICODE 所有のアプリコードは、主に `zaicode` ブランチの `packages/ui/src/zaicode/`、`packages/shared/src/zaicode-*.ts`、`packages/services/src/zaicode/`、`packages/desktop/src/main/zaicode*.ts` にあります。ワークスペースのドキュメントとランチャー/update ツールは `master` にあります。

## 上流とライセンス

ZAICODE は Z.ai の ZCode を派生させたもので、同じ
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE) で配布しています。アップストリームの通知は
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) と [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md) に保持しています。
ファイルは ZAICODE の作者が変更しました。ZAICODE は独立したプロジェクトであり、
Z.ai とは提携・承認の関係にありません。元の ZCode の README は
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) と [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md) として保持しています。

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## プロジェクトネットワーク

このリポジトリは、より広い **SAIPEN / vacterro** プロジェクトエコシステムの一部です。

[**著者ハブ**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN コミュニティ**](https://discord.gg/SEYaYkuVgN)

再現可能なバグや永続的な機能リクエストは [このリポジトリの GitHub Issues](https://github.com/vacterro/zaicode/issues) を使ってください。Discord は素早い議論、スクリーンショット、プロジェクト横断のフィードバック向けです。

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
