# ZAICODE SAIPEN クラウドトランスポート

このチェックアウトと Claude Code Cloud セッションが、executor の配置先が異なる同一个 SAIPEN ワークスペース
をどう共有するか、およびその境界がどこか。

## 全体像

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

プロトコル状態は 1 本のブランチが担う。merge 手順も rebase 手順も、同期保つ 2 本目のローカルブランチも
存在しない: 検証済みチェックポイントを持つ executor がそれを commit して push し、反対側は
fast-forward で受け取る。

`master` はトランスポート前の履歴であり、公開されるデフォルトブランチである。トランスポートによって
force-update されることはない。

## 何が移動し、何が移動しないか

このリポジトリのチェックポイントは SAIPEN プロトコル状態、ルートランチャーインストーラー、
ドキュメント、およびこれらのトランスポートスクリプトを運ぶ。それがワークスペース層的全部である。

**製品バイトは一切含まれない**。`zcode/` は別個の Git リポジトリであり、`.saipen/source-nested-repos.json` に記載され、
このルートで gitignore されている（`/zcode/`）。製品作業には `vacterro/zaicode` の自身用 clone が
ブランチ `zaicode` で必要になる。その clone は独自の履歴を持つ第 2 の独立したオブジェクトである。

結果として-Rom Mistakes.pm やすい: このルートのクリーンな `git status` は未コミットの製品作業について何も
語らず、`saipen-live` の fast-forward も製品コードについて何も語らない。`git -C zcode status` を明示的に確認する。

## ローカル側

スクリプト 2 つ。両方リポジトリ所有なので、新しいマシンでは
記憶ではなくリポジトリから入る：

| ファイル | 役割 |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | 検証し、ブランチを调和し、ウォッチャーをインストール・起動し、自動起動エントリを書き出し、local == remote を証明する |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | ループ: fetch、比較、fast-forward または push、ログ、一時停止。その後、プロダクトパスと自己更新 |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | 独立した実行系からの往復試験と、コールドリカバリの証明 |
| `tools/saipen-cloud/Test-ProductSync.ps1` | 使い捨ての Git リポジトリに対するプロダクトパスと自己更新（ネットワークなし、実リモートなし）|

インストールと修復:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

冪等性がある。マシンローカルの状態は `%APPDATA%\SAIPEN` に置かれる:
`ZaicodeSaipenLiveWatcher.ps1`（コピー）、`ZAICODE_cloud-sync.log`（
2 MB で `.log.1` へローテート）、`ZAICODE_cloud-sync.lock`（単一インスタンス）、
`ZAICODE_cloud-sync.pid`、およびスタートアップフォルダのエントリ
`SAIPEN-ZAICODE-Cloud-Sync.cmd`。

インストーラーは dirty ツリーを拒否し、勝手に clean しない。すべての dirty パスが
`.saipen/` 配下の正規の SAIPEN 状態であれば、その旨を示して正確な
チェックポイントコマンドを表示する。これはチェックポイントされていない
プロトコル状態であり、トランスポート障害ではない。インストーラーが
プロトコルの裏で commit することは決してない。

## ウォッチャーの挙動

| 状況 | 動作 |
|-----------|------|
| clean、local が remote の祖先 | `git merge --ff-only` |
| clean、remote が local の祖先 | `git push` |
| dirty | 一時停止。fetch すら行わない |
| 別のブランチ上 | 一時停止 |
| 両方が進み、共通の祖先がない | 一時停止し、両方の commit id をログに記録し、何も merge しない |
| fetch またはネットワークが失敗 | 低下としてログに記録し、次のティックで再試行 |
| merge/rebase/cherry-pick が進行中 | 一時停止 |

禁止事項: force push、hard reset、stash、clean、他ブランチの checkout、
commit、プロセス名による停止。インストーラーが停止するのは、
自分の pid ファイルに記録した pid のウォッチャーのみ。

dirty ツリーはコストにならない。ウォッチャーは fetch の前に
dirty を確認するから。したがって、アイドル状態の checkout は
ネットワーク通信を一切行わない。

### プロダクトパス (T-90)

`zcode/` は独自のリポジトリなので、上のテーブルがプロダクトコードを
動かすことはない。その後、同じティックでプロダクトの checkout（`-ProductRepo`、
既定は `<repo>\zcode`。ブランチ `-ProductBranch`、既定は `zaicode`）を処理する。
プロダクトパスは外側のツリーが dirty かどうかに関係なく実行される。
常に pull するだけ。

| 状況 | 対応 |
|-----------|------|
| リモートが先行、受け入れるファイルがここでは未コミット | `git merge --ff-only`; 未コミットの製品変更はそのまま残す |
| リモートが先行、受け入れるファイルがここでは dirty | HELD: ファイルを記録、merge しない |
| ローカルが先行 | 記録、**push しない**（製品は SAIPEN SHIP が公開） |
| 分岐 | 一時停止、両方の id を記録、merge しない |
| 他ブランチ、git 操作進行中、fetch 失敗 | 一時停止 |
| `zcode/` のチェックアウトなし、または `-NoProduct` | スキップ |

git 自身が、ローカル変更を上書きする fast-forward を拒否する。
したがって HELD チェックはより早い、より明確なガードであり、唯一のガードではない。製品の
fast-forward は何も再構築しない: テストには `pnpm bundle:zaicode` を実行（または dev プレビュー）。

### セルフ更新 (T-90)

ウォッチャーは `%APPDATA%\SAIPEN` の配下でコピーとして動くため、リポジトリ内の新しいウォッチャーが再インストールなしで実行されることはない。ループモードでは、各パスごとに
自分のファイルとリポジトリのコミット済みコピーを比較する。次の条件をすべて満たす場合のみ、
同じ引数で、そのコピーを自分の上にインストールし、ちょうど一度再起動する:

- 2つのファイルが異なる;
- リポジトリのコピーに未コミットの編集がない;
- リポジトリのコピーがエラーなくパースできる。

パースできないコピーは拒否して記録され、実行中のウォッチャーは
そのまま継続する。

T-90 より前にインストールされたウォッチャーには、製品パスもセルフ更新も無い。
そのようなマシンでは `Install-SaipenLiveSync.ps1` を一度再実行する; その後、
ウォッチャーは自己更新する。

## クラウド側

`CLAUDE.md` found at root はエントリールール、`.claude/skills/saipen/SKILL.md` は実行手順。スキルは `github.com/vacterro/saipen` から
SAIPEN カーネルを取得し、宣言されたエンジン面 `tools/saipen.py` 経由で実行する。カーネルはタグではなく
commit (`3088eff`) で固定。タグ `v8.0.1` は同じ `VERSION` を持つ旧カーネルで、
その `validate` は状態を変更し、バリデータはこのボードを拒否する。

`STATE.saipen_home` は、最後にチェックポイントした実行者のカーネルパスを記録する。クラウドでは、
カーネル `3088eff` に対する最初の `saipen continue` が、記録済みの 1 つの `DEC` として実行中のカーネルに
収束させる（E-1410）。オペレータマシンでも同じ方法で、 포インタは到達時に死んだ状態になる。自動収束
を持つカーネルは `continue` で修復する; なければ
`saipen rebind-home --auto` を実行。

**往復移動が観測される。** E-1562（クラウド）はポインタを`/home/user/zaicode/.claude/saipen-protocol`に収束させ、E-1571（オペレーター機）は
`V:/.../_SAIPEN`へ自動で即座に収束させた。`rebind-home`は手動なし。
両方向とも同じ自動収束なので、ローカリティ切替ごとに
`saipen_home` `DEC`が1回発生すると考え、不備ではなく想定内の
ノイズとして扱う。P1-2
（`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`）がバージョン管理対象の
状態を外れるまでノイズのままである。ポインタを検出_TRANSLATE_  autop 副作用として実装してはならない。
ポインタを手動編集してならない。

`STATE.saipen_home`は固定ピンより進んだカーネルの**開発チェックアウト**を指す
場合があり、クリーンな`3088eff`クローンではない — オペレーター機では未コミットの作業が残った`accepted-debt-rebind`ブランチである。
固定コミットにないカーネルが必ず誤りというわけではないが、クリーンルームのソースでも
ないので、以下のボイス契約に関する規則は完全にその效能で適用される。
そのようなチェックアウトで commit・stash・reset・checkout・clean を絶対に行わないこと。`saipen/STYLE.md`の対象ファイル単一 bullshitの復元のみが
許可された例外であり、オペレーターが要求した場合に限る。

### STYLE.md はローカル設定ではない

`saipen/STYLE.md` は**固定カーネルのファイルとバイト単位で同一**でなければ
ならない。すべてのマシン、すべてのコピーで、例外もローカル編集も一切ない。
オペレーターマシンにはコピーが複数存在する:

- `STATE.saipen_home` のカーネルチェックアウト（Git クローン。オペレーターマシン上では開発用チェックアウト）;
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`。`saipen-inject` スケジュールタスク（`bootstrap/schedule-run.ps1`）によって
  配置される。これは **Git リポジトリではない**ため、`git checkout` では
  一切修復できない — インジェクタ経由の再同期、または公開内容の直接書き込みが
  唯一の手段である。

`.saipen/STATE.md` 内の `style_contract` トークンは、そのファイルのテキストのハッシュ
（`tools/validate.py`、`style_contract_token`: CRLF を正規化、`style_contract:` の行を除外）である。
 片方のコピーで `reply_language` を編集するとトークンが変わり、もう片方のコピーと
公開カーネルを取得するクラウドはトークンを維持したまま、不一致側への
すべての CLI 書き込みが `style_contract ... does not match the installed STYLE.md marker` で拒否される。
これが失敗の全体像である: ローカル側が、クラウドには書けない状態を書いてしまう。

**返信言語の変更はローカル編集ではなく、カーネルのコミットと再固定で実行する。**
カーネルリポジトリで変更し、公開し、SKILL.md でコミットを再固定し、
`saipen recover` 経由で `STATE.style_contract` を更新する。`STYLE.md` をローカル編集すると、
そのマシン以外すべてのマシンと非同期になる。

 명 deserving な罠: 公開される `bin/saipen` はマシン依存のシムであり、
あるオペレーターの絶対パス（インタプリタとチェックアウト）をハードコードしている。
動作するのは特定の一台だけである。クラウドは `python3 tools/saipen.py` を使用しなければならない。

ショートカット: `cc` は現在の Work を継続する。`cc all <text>` はメッセージ
全体をソース/appendsとして取り込み、対象すべての Work を継続する。
どちらも通常の確認を求めない。

## 機能の分類

**AVAILABLE_IN_CLOUD** — プロトコル状態とワークスペース層。`.saipen/` の読み書き、ランチャー (`tools/launcher/ZaicodeLauncher.cs`)、`install/` 配下のインストーラー、`docs/`、`CLAUDE.md`、`.claude/skills/`、トランスポートスクリプト。`saipen-live` での Git の read・commit・push・fetch。ファイル検証・差分レビュー・テキストチェックであるいずれのゲートも。

**LOCAL_WINDOWS_ONLY** — このマシンを必要とするゲート。

| ゲート | 理由 |
|------|-----|
| `tools\launcher\build.cmd` | `ZaicodeLauncher.cs` を .NET Framework `csc` でコンパイルする。クラウドイメージには Windows SDK がない |
| パッケージ版 Electron E2E (`zcode` デスクトップ、Solo → キュー → ディスパッチ) | デスクトップセッションとシード済みプロバイダープロファイルが必要 |
| 稼働中の 9router | このマシン上の Windows サービス |
| 対話型デスクトップのクリック操作 | 人間と画面が必要 |
| ウォッチャー自身のランタイムケース | ウォッチャーはチェックアウトを保持するマシンでしか実行されない |

これらはローカル専用の受け入れ境界として記録される。差分が正しく見えるだけで PASS として報告されることはない。

**SAFE_TO_DEFER** — 製品レイヤー。クラウドセッションは `vacterro/zaicode` ブランチ `zaicode` をクローンしてそこで作業できる。ワークスペースレイヤーの作業に製品側の作業は不要だが、クローンは必須：`.saipen/source-nested-repos.json` が `zcode/` を宣言しておらず、なければバリデータが `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'` で失敗する。`pnpm` のゲートにはピン留めされた pnpm 10.33.2 と準備済みのワークスペースが必要。新規のクラウドイメージでの `pnpm bootstrap` は、文書化された導入手段であり、製品の `package.json` はすでにそれを宣言している。

クラウドが検証できるのは `origin/zaicode` 上にある製品バイトのみ。オペレーターの `zcode/` チェックアウトにのみ存在する製品デルタはここでは不可視なので、その製品ゲートは内容にかかわらずクラウドでは NOT RUN となる。T-84 が最初のケース (E-1411) で、修正はローカル専用のまま `origin/zaicode` は修正前のコードを持っていた。

**UNSAFE_TO_EMULATE** — ローカル専用ゲートを緑に見せかける行為すべて。ランチャーのビルドをスタブ化、パッケージアプリの実行の偽装、記録された `pnpm verify:pre-push` の結果を直前に実行されたかのように再生すること、および「コードは正しく見える」を `.saipen/LOG.md` の PASS 行に変換することは行わない。

**KNOWN_CLOUD_DIVERGENCE** — チェックアウトの場所に依存する適合性。カーネル `3088eff` ではクラウドのバリデータがオペレーターのマシンでは出ない `closure-evidence` の FAIL を報告する (執筆時点で T-47、T-62、T-76、T-78)。

カーネルは 1024 バイトを超える LOG イベントを
`.saipen/recovery/log-detail/` サイドカーへ移す。読み取り時は、チェックアウトの絶対パスが書き出し元のパスと一致する場合にのみサイドカーを復元する。したがって Windows で書かれた長い VERIFY 判定はクラウドでは読めず、逆も同様である。

欠陥はカーネルにあり `docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md` に P1-1 として起票済み。取り込まれるまで:

- そのクラウド判定を引用し、チケットごとにこの境界へ分類する
  （`SKILL.md` § 6 にチェックがある）;
- sidecar を書き換えない。緑を得るためだけの再検証もしない。kernel
  のコピーをパッチしない;
- 両側とも LOG イベントは 1024 バイト未満に保つ。

同じ machine-path 結合は作業もブロックする。BUILD 前の負債ベースラインは、
チケットが初めて BUILD に入った時点で取得され、以降の再進入のたびに
再チェックされる。したがって Cuts 初めて BUILD に入ったのはオペレーター
マシン上のチケットはクラウドでは BUILD に入れない。その遷移は
`DEBT_SNAPSHOT_FOREIGN_PROJECT` で拒否される。記録上の事例が T-84 で、DEBT-000079 は
E-1377 で取得され、E-1446 で遷移が拒否された。当該チケットはベース
ラインを取得したマシンに任せろ。

## 分岐

ローカルとリモートが共通祖先を共有しなくなった場合、watcher は停止する。
merge も rebase も force もしない。両方のコミット ID をログに残し、
修正は `git log --left-right --cherry-pick <branch>...origin/<branch>` で手作業で行い、
結果は他 변경と同様にチェックポイントする。

## クラウド側で実行する正確な操作

### 環境セットアップスクリプト（クラウド環境の設定で一度だけ）

セッションタイトルバーのクラウド環境メニュー -> Edit -> Setup script。
新しいセッションごとに実行されるので、各セッションは製品ツールチェーンが
準備済みの状態から始まる：

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

### 新しいセッションごとのプロンプト

セッションをリポジトリ `vacterro/zaicode`、ブランチ `saipen-live` で開始し、
オペレーター côté machine のエージェントが同時に書き込んでいないことを
確認する。最後の行を `cc all <new list>` に置き換えると新規作業を引き継げる。

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

オペレーター側マシンでは watcher が `zcode` を `origin/zaicode` から
fast-forward し、`REBUILD.cmd`（または `REBUILD_fast.lnk`）がビルドする。
ZAICODE の次の起動時に新しいビルドARTAに差し替わる。

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
