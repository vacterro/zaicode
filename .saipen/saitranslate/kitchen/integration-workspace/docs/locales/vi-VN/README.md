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

ZAICODE là bàn làm việc cho người vận hành, chạy nhiều AI coding agent cùng lúc trên
nhiều dự án mà không phải trông chừng. Đây là bản build đã sửa đổi của
[ZCode](https://github.com/zai-org/ZCode) (app desktop, giao diện web và agent
CLI) với một lớp sản phẩm bên trên: mọi dự án đều được điều khiển qua
giao thức [SAIPEN](https://github.com/vacterro/saipen), công việc khởi tạo, tiếp tục
và lên lịch ngay trong một cửa sổ, còn các CLI theo gói bạn đang trả tiền
(Claude Code, Codex, Antigravity) chạy như worker cận kề các agent trong app.

**0.0.1** là bản snapshot đầu tiên có gắn tag: bản build cá nhân, ưu tiên Windows, dùng hằng ngày.

## Cài đặt một cú nhấp

1. Tải **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Nhấp đúp và bấm **INSTALL**.

Xong. Trình cài đặt bổ sung những gì máy còn thiếu (Git, Node.js, Python, dạng bản sao
riêng: không cần quyền admin), tải ZAICODE, SAIPEN và SAIMAIL từ GitHub,
build app ngay trên máy và tạo shortcut ZAICODE trên desktop. Lần chạy đầu
mất 15-30 phút; cửa sổ hiện từng bước.

Các model miễn phí dùng được ngay: ZAICODE tự chạy router và lấp đầy kho **SAIFREN**
từ các tầng miễn phí không cần key, nên task gõ trong New task sẽ có câu trả lời mà
không cần key, tài khoản hay cài đặt nào. Gói Claude Code, Codex và Antigravity
là tùy chọn, đăng nhập bất cứ lúc nào cũng được.

**Một tổng thể, bốn phần.** Workspace (launcher, installer), app, SAIPEN và
SAIMAIL là bốn repository riêng. Mỗi phần tự cập nhật: *Settings -> ZAICODE -> Updates* hiện mọi phần, cập nhật tay hoặc tự động
(kiểm tra vài phút sau khi khởi động và mỗi sáu giờ). Bản build app mới được chuẩn bị trong
lúc ZAICODE chạy và sẽ dùng ở lần khởi động kế tiếp; các chỉnh sửa của bạn trong
bản clone không bao giờ bị ghi đè. Từ terminal: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Tự khắc phục sự cố: `install\Doctor.cmd`. Chi tiết: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Tham quan giao diện

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

## Những gì bổ sung cho ZCode

- **Dự án có một phiên MAIN.** Mỗi dự án có một phiên MAIN (START,
  `/goal cc all`) và các phiên phụ (subSaipens: WIKI, TEST, AUDIT, …). Chế độ
  xem mặc định của thanh bên hiển thị dòng dự án dưới dạng MAIN của nó; ▶ tiếp tục
  MAIN thay vì mở phiên khác. CONTINUE ALL, DONE và CLEAR ALL DONE quét
  mọi dự án; phiên bị cắt giữa lượt hiện INTERRUPTED, không bao giờ DONE.
- **An toàn khi sập.** Phiên bị tiến trình chết cắt ngang và mục tiêu vẫn còn
  hiệu lực sẽ tự tiếp tục sau khi khởi động lại; worker đang chạy sẽ chạy lại. Agent
  bên trong ZAICODE không thể giết ZAICODE theo tên tiến trình.
- **Worker.** CLI đăng ký chạy trong terminal gắn vào bất kỳ cạnh nào của
  cửa sổ (hoặc trong cửa sổ snapping riêng). Câu hỏi "Trust this folder?"
  lần chạy đầu đã được trả lời; worker chạm giới hạn sử dụng sẽ được báo cáo và,
  theo thiết lập, đóng lại hoặc khởi động lại sau khi reset.
- **Hạn mức và reset.** Đồng hồ đo quota theo tài khoản và pool, hẹn giờ trên
  thanh tiêu đề cho reset gần nhất, kèm danh sách đầy đủ các reset sắp tới khi
  di chuột.
- **SCHEDULER.** Prompt tự khởi chạy: vào một giờ, hằng ngày, mỗi N
  phút hoặc khi cửa sổ quota được nạp lại; trong một dự án hoặc cả một mục
  thanh bên, dự án tệ nhất (bị chặn nhiều nhất / mở nhiều ticket SAIPEN nhất) đi trước.
  Điều kiện có thể dừng các công việc tạm (phiên free-pool, worker yếu hơn) trước,
  chỉ chạy trên dự án rảnh, hoặc chỉ tiếp tục phiên đã đánh dấu. Prompt không có
  giới hạn độ dài thực tế.
- **Định tuyến.** 9router tích hợp sẵn (MIT) cho pool zero-setup: SAIFREN
  (tầng miễn phí không cần key) và SAIOPP (gói đăng ký của bạn).
- **SAIHOME, hẹn giờ, âm thanh, điểm nhấn.** Trang chủ dành cho người vận hành với thống kê,
  hẹn giờ và báo thức kiểu FastPrompter, âm thanh theo từng hành động và giao diện
  Win95 dark golden, sắc nét từng pixel.

## Xây dựng

Yêu cầu: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) là nguồn chuẩn).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Ứng dụng đóng gói luôn khởi động ở chế độ ZAICODE. Khi một ZAICODE cũ hơn đang chạy,
bundler đưa bản build mới vào pha chuẩn bị tại `packages/desktop/dist-next`; launcher ở thư mục gốc
(nhánh `master`, `tools/launcher`) sẽ hoán đổi nó vào ở lần khởi động kế tiếp.
Biến thể Verdana bitmap sắc nét dùng cho UI không nằm trong kho lưu trữ này;
thiếu nó, giao diện sẽ dùng Verdana của hệ thống.

Kiểm tra: `pnpm typecheck`, `pnpm lint`, và các test ZAICODE, ví dụ
`node --import tsx --test test/zaicode*.test.ts` từ `packages/ui`.

## Bố cục kho lưu trữ

| Nhánh      | Nội dung                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | workspace chuẩn: launcher, installer (`install/`), tài liệu sản phẩm (`UI.md`, `docs/`), trạng thái SAIPEN và CHANGELOG |
| `zaicode`   | mã nguồn ứng dụng chuẩn: lịch sử ZCode upstream cộng lớp sản phẩm ZAICODE dùng cho build và cập nhật |

Các ref legacy hoặc do tự động hóa tạo có thể vẫn xuất hiện tạm thời, nhưng chúng không phải
nhánh sản phẩm chuẩn. Công việc workspace mới thuộc về `master`; công việc
mã nguồn ứng dụng thuộc về `zaicode`.

Mã ứng dụng do ZAICODE sở hữu nằm chủ yếu ở `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` và
`packages/desktop/src/main/zaicode*.ts` trên nhánh `zaicode`. Tài liệu
workspace và tooling launcher/update nằm ở `master`.

## Upstream và giấy phép

ZAICODE bắt nguồn từ ZCode của Z.ai và được phân phối theo cùng
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); các thông báo gốc được giữ trong
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) và [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Các tệp đã được tác giả ZAICODE sửa đổi. ZAICODE là một dự án độc lập,
không liên kết hay được Z.ai bảo trợ. README gốc của ZCode được giữ ở
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) và [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Mạng lưới dự án

Kho lưu trữ này là một phần của hệ sinh thái **SAIPEN / vacterro** rộng lớn hơn.

[**Trung tâm tác giả**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**Cộng đồng SAIPEN**](https://discord.gg/SEYaYkuVgN)

Để báo lỗi có thể tái hiện và yêu cầu tính năng lâu dài, hãy dùng [GitHub Issues của kho lưu trữ này](https://github.com/vacterro/zaicode/issues). Dùng Discord để thảo luận nhanh, chia sẻ ảnh chụp màn hình và phản hồi xuyên dự án.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
