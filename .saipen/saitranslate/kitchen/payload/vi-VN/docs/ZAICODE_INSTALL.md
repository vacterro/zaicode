# Cài đặt ZAICODE

ZAICODE gồm ba dự án hoạt động như một: ứng dụng ZAICODE, SAIPEN (giao thức giữ công việc của agent đúng hướng) và SAIMAIL (hệ thống thư mà các agent dùng để trao đổi với nhau). Cài thủ công nghĩa là ba lần clone, một bộ công cụ Node.js, một môi trường Python và một bản build. Trình cài đặt làm hết tất cả: chạy nó, chờ, và một lối tắt ZAICODE sẽ nằm trên desktop.

## Một cú nhấp chuột

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  tải về, nhấp đúp, nhấn **INSTALL**. Cửa sổ (màu vàng trên nền tối, biểu ngữ SAIPEN) hiển thị từng bước khi chạy, thời gian đã trôi qua và log khi cần; kết thúc là **START ZAICODE**, hoặc **TRY AGAIN** / **Autotroubleshoot**
  / **Open log** khi một bước chưa hoàn tất. Khi trỏ vào thư mục ZAICODE
  đã có, nút sẽ ghi **UPDATE**: cùng một lần chạy đó vừa cập nhật vừa sửa chữa. Tệp
  exe mang theo các script cài đặt và không cần gì bên cạnh; nó được build bởi
  `install\setup\build.cmd` (trình biên dịch .NET Framework mà mọi Windows 10/11 đều có).
- `install\Setup-ZAICODE.cmd` (nhấp đúp): cùng bản cài đặt trong cửa sổ console.
- Từ số 0, trong PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Tùy chọn cài đặt: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (thư mục định sẵn),
`/auto` (chạy ngay), `/quiet` (không cửa sổ: trình cài đặt console, mã thoát
= kết quả). Lần chạy đầu build ứng dụng trên máy này, mất một lúc;
lần sau chỉ cập nhật và sửa.

## Model miễn phí, không phải thiết lập gì

Ứng dụng đi kèm 9router của riêng nó. Trên máy chưa có, ZAICODE chạy riêng
(chế độ cô lập, cổng 20138), điền **SAIFREN** từ các tầng miễn phí không cần khóa
và đặt `SAIRoute / SAIFREN` làm model cho tác vụ mới, nên tác vụ đầu tiên gõ ở New task có câu trả lời: không khóa, không tài khoản, không thiết lập. Đăng nhập Claude
Code, Codex và Antigravity là tùy chọn; đăng nhập chưa thiết lập trên máy hiện là "tùy
chọn, đăng nhập bất cứ lúc nào", không phải mục "cần bạn".
Kiểm chứng: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
chạy ứng dụng đóng gói trên hồ sơ trống (HOME, APPDATA và
LOCALAPPDATA riêng) và chỉ đạt khi router cô lập, SAIFREN trả lời bài dò token đầu
và một tác vụ trong New task được trả lời.

## Cập nhật: bốn phần, một ZAICODE

Không gian làm việc (launcher, installer), ứng dụng, SAIPEN và SAIMAIL là bốn
clone. Mỗi thứ tự cập nhật riêng: **Settings -> ZAICODE -> Updates** liệt kê chúng
kèm phiên bản và commit, cập nhật từng cái hoặc tất cả, và có công tắc "tự cập
nhật" cho từng phần (bật mặc định trong ZAICODE đã cài, tắt trong bản checkout của
lập trình viên). ZAICODE kiểm tra vài phút sau khi khởi động rồi mỗi sáu giờ. Sau
mỗi lần cập nhật, mỗi phần nhận đúng thứ nó cần: ứng dụng nhận dependency (khi
`pnpm-lock.yaml` đổi) và bản build mới (được staged khi ZAICODE đang chạy, chạy ở lần khởi
động sau), SAIPEN nhận launcher, SAIMAIL nhận bản cài `.venv` của nó, không gian
làm việc nhận launcher gốc mới. Clone ở nhánh khác, có commit cục bộ, hoặc có chỉnh
sửa mà bản cập nhật sẽ ghi đè sẽ được báo và giữ nguyên y như cũ.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Nó làm gì

Trình cài đặt là các kiểm tra Autotroubleshoot chạy với "repair" trên một thư mục
trống, theo thứ tự sau. Mỗi bước idempotent, nên chạy lại chỉ cập nhật bản cài và sửa
những gì hỏng.

| Kiểm tra | Sửa |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | dùng bản trên máy khi phù hợp; nếu không thì bản riêng trong `.tools\` (MinGit từ Git for Windows, Node.js 24.14.0 từ nodejs.org, Python từ gói NuGet của nó). Không cần quyền quản trị. |
| pnpm | pnpm 10.33.2 ghim phiên bản trong `.tools\pnpm10` |
| Không gian làm việc ZAICODE | clone `vacterro/zaicode` nhánh `master` (mã launcher, installer, tài liệu; loại trừ memory của lập trình viên `.saipen/`; nhánh `workspace` đến 2026-09-27) |
| Mã nguồn ứng dụng ZAICODE | clone nhánh `zaicode` vào `zcode\` |
| SAIPEN | clone `vacterro/saipen` vào `saipen\`; `bin\saipen.cmd` của nó được viết cho clone này và Python này |
| SAIMAIL | clone `vacterro/saimail` vào `saimail\`, cài vào `.venv\` |
| saimail-local | client dòng lệnh của SAIMAIL, dùng cho các panel SAIMAIL của ZAICODE (có từ SAIMAIL `0.0.2a3`; kiểm tra `saimail-cli` báo OK) |
| Gói 9router | `9router` từ npm vào `.tools\router`, đóng gói sẵn để SAIFREN chạy với zero setup (WARN nếu npm không truy cập được) |
| Dependencyứng dụng | `pnpm install --frozen-lockfile` (làm lại khi `pnpm-lock.yaml` đổi) |
| Build ứng dụng | `pnpm bundle:zaicode`; khi ZAICODE đang chạy, bản build mới được staged và hoán đổi ở lần khởi động sau |
| Hoán đổi build staged | xóa `win-unpacked.previous` còn sót do hoán đổi đường dài thất bại và đưa build đang chờ vào khi ZAICODE đã đóng |
| Launcher gốc | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Phím tắt | Desktop và Start menu `ZAICODE` -> `ZAICODE.exe` |
| Đăng nhập Claude / Codex | chỉ báo cáo: mỗi đăng nhập `~\.claude*` / `~\.codex*` là engine riêng trong ZAICODE (A1, A2, C1, ...); đăng nhập cần bạn, trên trình duyệt |

Launcher gốc trỏ ZAICODE tới SAIPEN đã cài (`saipen\`) và đặt
`.tools\` và `.venv\Scripts` lên đầu PATH của ứng dụng, nên ứng dụng, agent và
worker của nó dùng bản đã cài.

## Nhiều gói thuê bao

Mỗi đăng nhập Claude Code hay Codex nằm trong home riêng: `~\.claude`,
`~\.claude-account2`, ... và `~\.codex`, `~\.codex-account2`, ... ZAICODE tìm hết.
Chuẩn bị thêm lúc cài:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Trình cài tạo các home, in đúng lệnh đăng nhập cho từng cái
(`$env:CODEX_HOME = '...'; codex login`). Trong ZAICODE: Settings ->
Engines & limits -> thêm một đăng nhập khác.

## Tự khắc phục sự cố

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Trạng thái mỗi bước: OK, FIXED (đang hỏng, đã sửa), WARN (chạy được, nhưng thiếu
thứ gì tùy chọn), INFO (cần bạn: một đăng nhập), FAIL. Log ở
`install\logs\`; tóm tắt lần cài gần nhất là `install\install-report.json`.
Trong app, Router -> Autotroubleshoot sửa router và các pool đang chạy.

## Tùy chọn

| Tham số | Mặc định | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | nơi đặt mọi thứ |
| `-ShortcutDir` | Desktop | nơi đặt lối tắt ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | bỏ qua các lối tắt đó |
| `-PortableTools` | | Git / Node.js / Python riêng tư kể cả khi máy đã có |
| `-Launch` | | khởi chạy ZAICODE khi xong |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | các repo GitHub | nguồn khác (fork, đường dẫn bản clone cục bộ) |

## Bằng chứng

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
kiểm tra bản cài mới, gieo lỗi (shortcut và launcher bị xóa, launcher
SAIPEN trỏ tới Python không có, venv của SAIMAIL bị xóa, node_modules
ghi cho lockfile khác, thư mục build thừa sâu hơn MAX_PATH),
khẳng định doctor báo và sửa hết, rồi chạy target của shortcut với profile
cô lập và dừng đúng cây tiến trình nó đã tạo.

`install\tests\Test-ZaicodeUpdate.ps1` dựng bốn repo dùng-một-lần trên
đĩa cùng bản cài của các bản clone, rồi chứng minh một bước kiểm không đổi gì,
rằng một phần cập nhật riêng kèm phần theo sau (launcher SAIPEN, launcher
gốc), rằng sửa đổi cục bộ chồng lấn và commit cục bộ được giữ, và rằng tên
phần lạ bị từ chối. Không mạng.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
