# ZAICODE vận chuyển đám mây SAIPEN

Cách checkout này và một phiên Claude Code Cloud cùng chạy một workspace SAIPEN
với executor khác nhau về vị trí, và ranh giới giữa chúng nằm ở đâu.

## Hình dạng

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Một nhánh mang trạng thái giao thức. Không có bước merge, không có bước rebase
và không có nhánh cục bộ thứ hai phải đồng bộ: executor nào có checkpoint
đã xác minh thì commit và push, phía bên kia lấy bằng fast-forward.

`master` là lịch sử trước vận chuyển và nhánh mặc định đã publish. Nó
không bị force-update bởi lớp vận chuyển.

## Cái gì đi kèm, cái gì không

Một checkpoint trong repo này mang trạng thái giao thức SAIPEN, launcher gốc,
installer, tài liệu và các script vận chuyển này. Đó là toàn bộ lớp workspace.

Nó mang **không byte sản phẩm nào**. `zcode/` là một repo Git riêng, được liệt kê
trong `.saipen/source-nested-repos.json` và bị gitignore ở thư mục gốc này
(`/zcode/`). Công việc sản phẩm cần bản clone riêng của `vacterro/zaicode` trên nhánh
`zaicode`, và bản clone đó là một đối tượng thứ hai, độc lập, có lịch sử riêng.

Hệ quả dễ hiểu sai: `git status` sạch ở thư mục gốc này không nói gì về công việc
sản phẩm chưa commit, và fast-forward của `saipen-live` không nói gì về mã sản phẩm.
Hãy kiểm tra `git -C zcode status` một cách tường minh.

## Nửa cục bộ

Hai script, cả hai đều do repo sở hữu để máy mới nhận chúng từ kho chứ không phải từ trí nhớ:

| Tệp | Vai trò |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | kiểm tra, hòa giải nhánh, cài và khởi động watcher, ghi mục tự chạy, chứng minh local == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | vòng lặp: fetch, so sánh, fast-forward hoặc push, ghi log, tạm dừng; rồi lượt sản phẩm và tự cập nhật |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | vòng khứ hồi từ một executor độc lập cộng bằng chứng phục hồi sau khi tắt máy |
| `tools/saipen-cloud/Test-ProductSync.ps1` | lượt sản phẩm và tự cập nhật trên các kho Git tạm (không mạng, không remote thật) |


Cài đặt và sửa chữa:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Thao tác này idempotent. Trạng thái cục bộ của máy nằm ở `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (bản sao), `ZAICODE_cloud-sync.log` (xoay vòng tại
2 MB sang `.log.1`), `ZAICODE_cloud-sync.lock` (một instance duy nhất),
`ZAICODE_cloud-sync.pid`, và một mục trong thư mục Startup
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Trình cài đặt từ chối cây thư mục bẩn và không bao giờ tự dọn. Nếu mọi đường dẫn bẩn đều là
trạng thái SAIPEN chuẩn dưới `.saipen/`, nó nói rõ và in đúng các
lệnh checkpoint; đó là trạng thái giao thức chưa checkpoint, không phải lỗi
vận chuyển, và trình cài đặt sẽ không commit nó sau lưng giao thức.

## Hành vi watcher

| Tình huống | Hành động |
|-----------|------|
| sạch, local là tổ tiên của remote | `git merge --ff-only` |
| sạch, remote là tổ tiên của local | `git push` |
| bẩn | tạm dừng; không cả fetch |
| đang ở nhánh khác | tạm dừng |
| cả hai cùng tiến, không có tổ tiên chung | tạm dừng, ghi log cả hai commit id, không merge gì |
| fetch hoặc mạng lỗi | ghi log degraded, thử lại ở tick sau |
| merge/rebase/cherry-pick đang dở | tạm dừng |

Không bao giờ: force push, hard reset, stash, clean, checkout nhánh lạ,
commit, hay dừng theo tên tiến trình. Trình cài đặt chỉ dừng watcher theo
pid mà nó đã ghi trong pid file của chính nó.

Cây bẩn không tốn gì, vì watcher kiểm tra bẩn trước khi fetch.
Vì vậy một checkout nhàn rỗi hoàn toàn không gọi mạng.

### Lượt sản phẩm (T-90)

`zcode/` là kho riêng của nó, nên bảng trên không bao giờ động vào mã
sản phẩm. Sau đó, cùng tick đó xử lý checkout sản phẩm (`-ProductRepo`,
mặc định `<repo>\zcode`; nhánh `-ProductBranch`, mặc định `zaicode`). Lượt
sản phẩm chạy dù cây ngoài có bẩn hay không. Nó chỉ pull.

| Tình huống | Hành động |
|-----------|------|
| remote đi trước, không file nào đến bị sửa ở đây | `git merge --ff-only`; sản phẩm chưa commit giữ nguyên như cũ |
| remote đi trước, có file đến bị sửa ở đây | HELD: ghi log các file, không merge gì |
| local đi trước | ghi log; **không bao giờ push** (sản phẩm do SAIPEN SHIP phát hành) |
| phân kỳ | dừng, ghi log cả hai id, không merge gì |
| nhánh khác, đang có thao tác git dở dang, fetch thất bại | dừng |
| không có checkout `zcode/`, hoặc `-NoProduct` | skipped |

git tự chối fast-forward ghi đè một thay đổi local, nên
kiểm tra HELD chỉ là chốt chặn sớm và rõ ràng, không phải chốt chặn duy nhất. Fast-forward sản phẩm không rebuild gì cả: để kiểm thử, hãy chạy `pnpm bundle:zaicode` (hoặc bản xem trước dev).

### Tự cập nhật (T-90)

Watcher chạy dưới dạng một bản sao ở `%APPDATA%\SAIPEN`, nên watcher mới hơn bên trong repo
chưa từng chạy mà không cài lại. Ở chế độ loop, nó nay so sánh
file của chính nó với bản đã commit trong repo trên mỗi vòng lặp. Nó cài bản đó
đè lên chính nó và khởi động lại đúng một lần, với cùng các tham số,
chỉ khi tất cả các điều sau đều đúng:

- hai file khác nhau;
- bản trong repo không có chỉnh sửa chưa commit;
- bản trong repo phân tích không lỗi.

Một bản sao không phân tích được sẽ bị từ chối và ghi log, còn watcher
đang chạy thì tiếp tục.

Watcher được cài trước T-90 thiếu cả bước sản phẩm lẫn tự cập nhật.
Hãy chạy lại `Install-SaipenLiveSync.ps1` một lần trên máy như vậy; sau đó,
watcher sẽ tự cập nhật.

## Nửa đám mây

`CLAUDE.md` ở thư mục gốc là quy tắc vào, còn
`.claude/skills/saipen/SKILL.md` là quy trình thực thi. Skill tải
SAIPEN kernel từ `github.com/vacterro/saipen` và chạy nó qua
bề mặt engine đã khai báo là `tools/saipen.py`. Kernel được ghim theo commit
(`3088eff`), không bao giờ theo tag. Tag `v8.0.1` là một kernel cũ hơn có cùng
`VERSION`; `validate` của nó thay đổi trạng thái, và validator của nó từ chối board này.

`STATE.saipen_home` ghi lại đường dẫn kernel của executor đã checkpoint
lần cuối. Trên cloud, lần `saipen continue` đầu tiên trên kernel `3088eff` sẽ hội tụ
nó về kernel đang chạy thành một `DEC` đã ghi sổ (E-1410). Trên máy
của operator, con trỏ cũng đến chết theo đúng cách đó. Kernel có hội tụ tự động
sẽ sửa nó ở `continue`; nếu không thì hãy chạy
`saipen rebind-home --auto`.

**Chiều khứ hồi đã được quan sát.** E-1562 (cloud) đã hội tụ con trỏ về `/home/user/zaicode/.claude/saipen-protocol`; E-1571 (máy operator) hội tụ thẳng trở lại `V:/.../_SAIPEN`, tự động, không cần `rebind-home` thủ công. Cả hai chiều đều là cùng một sự hội tụ tự động, nên hãy mong đợi một `saipen_home` `DEC` cho mỗi lần chuyển locality và coi đó là nhiễu đã biết chứ không phải lỗi. Nó vẫn là nhiễu cho tới khi P1-2 (`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) đưa con trỏ ra khỏi trạng thái có phiên bản; đừng triển khai P1-2 chỉ như hệ quả phụ khi phát hiện điều đó. Không bao giờ tự sửa tay con trỏ.

`STATE.saipen_home` có thể trỏ tới một bản **checkout phát triển** của kernel đang đi trước pin, chứ không phải một bản clone `3088eff` sạch — trên máy operator đó là nhánh `accepted-debt-rebind` kèm công việc chưa commit. Một kernel không nằm ở commit đã pin không tự động là sai, nhưng nó cũng không phải nguồn clean-room, nên quy tắc bên dưới về voice contract áp dụng cho nó với đầy đủ hiệu lực. Không bao giờ commit, stash, reset, check out hay clean bất cứ thứ gì trong một checkout như vậy; khôi phục có chọn lọc đúng một tệp `saipen/STYLE.md` là ngoại lệ duy nhất được phép, và chỉ khi operator yêu cầu.

### STYLE.md không phải thiết lập cục bộ

`saipen/STYLE.md` phải **giống hệt từng byte với tệp của kernel đã pin** trên mọi máy, trong mọi bản sao, không ngoại lệ và không sửa cục bộ. Trên máy operator có nhiều hơn một bản sao:

- bản checkout kernel tại `STATE.saipen_home` (một Git clone; trên máy operator là một bản checkout phát triển);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, được điền bởi tác vụ lên lịch `saipen-inject` (`bootstrap/schedule-run.ps1`). Nó **không phải Git repository**, nên `git checkout` không bao giờ có thể sửa nó — chỉ đồng bộ lại qua injector, hoặc ghi trực tiếp nội dung đã phát hành, mới là con đường khả dụng.

Token `style_contract` trong `.saipen/STATE.md` là hash của văn bản tệp đó (`tools/validate.py`, `style_contract_token`: chuẩn hóa CRLF, loại trừ dòng `style_contract:`). Sửa `reply_language` ở một bản sao thì token dịch chuyển; bản sao còn lại và cloud, vốn lấy kernel đã phát hành, vẫn giữ token đã phát hành, và mọi thao tác ghi qua CLI ở phía bị lệch đều bị từ chối bằng `style_contract ... does not match the installed STYLE.md marker`.
Đó chính là toàn bộ sự cố: phía cục bộ ghi trạng thái mà cloud không thể ghi.

**Đổi ngôn ngữ trả lời là một kernel commit kèm repin**, không bao giờ là sửa cục bộ. Hãy đổi nó trong kernel repository, phát hành, ghim lại commit trong SKILL.md, và cập nhật `STATE.style_contract` qua `saipen recover`. Một sửa cục bộ đối với `STYLE.md` sẽ làm lệch đồng bộ mọi máy không phải máy đang thực hiện.

Một cái bẫy đáng nêu: `bin/saipen` đã phát hành là một shim gắn với máy, hardcode đường dẫn interpreter và checkout tuyệt đối của một operator. Nó chạy trên đúng một máy. Cloud phải dùng `python3 tools/saipen.py`.

Phím tắt: `cc` tiếp tục Work hiện tại; `cc all <text>` tiếp nhận toàn bộ tin nhắn làm source/appends và tiếp tục mọi Work đủ điều kiện. Không cái nào yêu cầu xác nhận thường lệ.

## Phân loại năng lực

**AVAILABLE_IN_CLOUD** — trạng thái protocol và lớp workspace. Đọc và ghi `.saipen/`, trình khởi chạy (`tools/launcher/ZaicodeLauncher.cs`), bộ cài đặt dưới `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/`, và các script transport. Git read, commit, push và fetch trên `saipen-live`. Mọi gate là file assertion, diff review hoặc kiểm tra văn bản.

**LOCAL_WINDOWS_ONLY** — các gate cần máy này.

| Gate | Vì sao |
|------|-----|
| `tools\launcher\build.cmd` | biên dịch `ZaicodeLauncher.cs` với .NET Framework `csc`; cloud image không có Windows SDK |
| Electron E2E đã đóng gói (`zcode` desktop, Solo → queue → dispatch) | cần desktop session và provider profile đã seed |
| 9router đang chạy | một Windows service trên máy này |
| click-through desktop tương tác | cần con người và màn hình |
| các case runtime của watcher | watcher chỉ chạy trên máy giữ checkout |

Được ghi nhận là ranh giới nghiệm thu chỉ-cục-bộ. Không bao giờ báo PASS chỉ vì diff trông đúng.

**SAFE_TO_DEFER** — lớp sản phẩm. Một phiên đám mây có thể clone nhánh `zaicode` của `vacterro/zaicode` và làm việc ở đó. Việc ở lớp workspace không đòi hỏi việc ở lớp sản phẩm, nhưng vẫn cần bản clone:
`.saipen/source-nested-repos.json` khai báo `zcode/`, và thiếu nó thì
validator thất bại với `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. Các `pnpm` gate cần pnpm 10.33.2
được ghim và workspace đã chuẩn bị. `pnpm bootstrap` trên image đám mây mới là
cách vào theo tài liệu, và `package.json` của sản phẩm đã khai báo nó.

Cloud chỉ verify được product byte nằm trên `origin/zaicode`. Một
product delta chỉ tồn tại trong checkout `zcode/` của operator là
vô hình ở đây, nên mọi product gate của nó là NOT RUN trong cloud, bất kể
gate nào. T-84 là trường hợp đầu (E-1411): bản sửa chỉ cục bộ trong khi
`origin/zaicode` vẫn mang code trước khi sửa.

**UNSAFE_TO_EMULATE** — bất cứ thứ gì làm một gate chỉ-cục-bộ trông xanh.
Không stub launcher build, không giả chạy app đã đóng gói, không phát lại kết quả
`pnpm verify:pre-push` đã ghi như vừa chạy, không đổi "code trông đúng" thành dòng PASS trong `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — tuân thủ phụ thuộc vị trí checkout.
Trên kernel `3088eff`, cloud validator báo các FAIL `closure-evidence`
(T-47, T-62, T-76, T-78 tại thời điểm viết) mà máy operator không có.

Kernel chuyển mọi LOG event trên 1024 byte sang
sidecar `.saipen/recovery/log-detail/`. Khi đọc, nó chỉ khôi phục sidecar khi
đường dẫn tuyệt đối của checkout bằng đúng đường dẫn đã ghi. Vì vậy verdict
VERIFY dài ghi trên Windows không đọc được trong cloud, và ngược lại cũng vậy.

Lỗi nằm ở kernel và được ghi nhận là P1-1 trong
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Cho tới khi nó được merge:

- trích dẫn kết luận cloud và phân loại theo ranh giới này, từng ticket một
  (`SKILL.md` § 6 có phép kiểm tra);
- không bao giờ viết lại sidecar, không kiểm tra lại chỉ để xanh, không vá bản
  kernel;
- giữ sự kiện LOG dưới 1024 byte ở cả hai phía.

Ràng buộc machine-path giống nhau cũng chặn công việc. Mốc nợ trước BUILD
được chụp lần đầu khi ticket vào BUILD và kiểm tra lại ở mọi lần vào sau.
Vì vậy ticket lần đầu vào BUILD trên máy operator không thể vào BUILD trên
cloud: chuyển trạng thái bị từ chối với `DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 là ca được ghi nhận:
DEBT-000079 chụp tại E-1377 và chuyển trạng thái bị từ chối tại E-1446. Để
ticket đó lại máy đã chụp mốc nền của nó.

## Phân kỳ

Nếu local và remote ngừng chia sẻ tổ tiên, watcher dừng. Nó không merge, không
rebase, không force. Cả hai commit id vào log, bản vá được `git log --left-right --cherry-pick <branch>...origin/<branch>` thủ công, và
kết quả được checkpoint như mọi thay đổi khác.

## Hành động chính xác phía cloud

### Script thiết lập môi trường (một lần, trong cài đặt của môi trường cloud)

Menu môi trường cloud ở thanh tiêu đề phiên -> Edit -> Setup script. Nó
chạy trước mọi phiên mới, nên mỗi phiên đều bắt đầu với toolchain sản phẩm
đã sẵn sàng:

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

### Prompt cho mọi phiên mới

Bắt đầu phiên trên repository `vacterro/zaicode`, nhánh `saipen-live`, và
đảm bảo agent trên máy operator không đang ghi cùng lúc.
Thay dòng cuối bằng `cc all <new list>` để bàn giao việc mới.

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

Trên máy operator, watcher fast-forward `zcode` từ
`origin/zaicode`; `REBUILD.cmd` (hoặc `REBUILD_fast.lnk`) build nó, và
lần khởi động ZAICODE tiếp theo sẽ thay bản build mới vào.
<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
