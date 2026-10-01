# การติดตั้ง ZAICODE

ZAICODE คือสามโครงการที่ทำงานร่วมกัน: แอป ZAICODE, SAIPEN (โปรโตคอลที่คุมให้งานเอเจนต์อยู่ทางราว) และ SAIMAIL (จดหมายที่เอเจนต์ใช้สื่อสารกัน) การติดตั้งด้วยมือแปลว่าต้อง clone สามที่, ติดตั้ง Node.js toolchain, ตั้งค่า Python environment แล้ว build ตัวติดตั้งทำทั้งหมดให้: รันแล้วรอ สั้น ๆ ก็มีทางลัด ZAICODE บนเดสก์ท็อป

## คลิกเดียวจบ

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  ดาวน์โหลด ดับเบิลคลิก กด **INSTALL** หน้าต่าง (สีทองบนพื้นเข้ม พร้อมแบนเนอร์
  SAIPEN) แสดงทุกขั้นตอนขณะทำงาน เวลาที่ใช้ไป และดู log ได้ตามต้องการ
  เมื่อจบ **START ZAICODE** หรือ **TRY AGAIN** / **Autotroubleshoot**
  / **Open log** เมื่อขั้นตอนใดไม่เสร็จ หากชี้ไปที่โฟลเดอร์ ZAICODE
  ที่มีอยู่แล้ว ปุ่มจะขึ้นเป็น **UPDATE**: การรันเดิมอัปเดตและซ่อมทั้งระบบ
  ไฟล์ exe พกสคริปต์ติดตั้งมาด้วย ไม่ต้องมีอะไรข้าง ๆ มัน สร้างโดย
  `install\setup\build.cmd` (คอมไพเลอร์ .NET Framework ที่มีในทุกเครื่อง Windows 10/11)
- `install\Setup-ZAICODE.cmd` (ดับเบิลคลิก): การติดตั้งชุดเดียวกันในคอนโซล
- เริ่มจากศูนย์ ใน PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

ตัวเลือกการติดตั้ง: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (โฟลเดอร์ที่กำหนด),
`/auto` (เริ่มทันที), `/quiet` (ไม่มีหน้าต่าง: ตัวติดตั้งคอนโซล, รหัสจบการทำงาน
= ผลลัพธ์) การรันครั้งแรกจะบิลด์แอปบนเครื่องนี้ ซึ่งใช้เวลาสักพัก;
การรันครั้งต่อไปอัปเดตและซ่อมแซมเท่านั้น

## โมเดลฟรี ไม่ต้องตั้งค่าอะไร

แอปมี 9router ติดมากับตัวเอง ในเครื่องที่ไม่มี ZAICODE จะรันมันแบบส่วนตัว
(โหมดแยก, พอร์ต 20138) เติม **SAIFREN** จากชั้นฟรีที่ไม่ต้องใช้คีย์
และกำหนดให้ `SAIRoute / SAIFREN` เป็นโมเดลของงานใหม่ งานแรกที่พิมพ์ใน New task จึงได้คำตอบ:
ไม่ต้องใช้คีย์ ไม่ต้องมีบัญชี ไม่ต้องตั้งค่า การล็อกอิน Claude
Code, Codex และ Antigravity เป็นเรื่องเสริม; การล็อกอินที่ไม่ได้ตั้งค่า
บนเครื่องจะแสดงว่า "ไม่บังคับ เข้าสู่ระบบได้ทุกเมื่อ" ไม่ใช่รายการ "ต้องให้คุณทำ"
หลักฐาน: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
สตาร์ตแอปที่แพ็กมาแล้วบนโปรไฟล์ว่าง (HOME, APPDATA และ
LOCALAPPDATA ของตัวเอง) และจะผ่านก็ต่อเมื่อ router อยู่ในโหมดแยก, SAIFREN ตอบ
probe โทเคนแรก และงานใน New task ได้รับคำตอบ

## อัปเดต: สี่ส่วน หนึ่ง ZAICODE

เวิร์กสเปซ (launcher, ตัวติดตั้ง), แอป, SAIPEN และ SAIMAIL เป็นสี่คลองแยก
แต่ละส่วนอัปเดตเอง: **Settings -> ZAICODE -> Updates** จะแสดงรายการพร้อม
เวอร์ชันและ commit, อัปเดตทีละส่วนหรือทั้งหมด และมีสวิตช์ "ด้วยตัวเอง" ของแต่ละส่วน
(เปิดโดยค่าเริ่มต้นใน ZAICODE ที่ติดตั้งแล้ว, ปิดในโค้ดของนักพัฒนา) ZAICODE จะดู
ไฟล์เมื่อผ่านไปไม่กี่นาทีหลังเริ่มทำงาน แล้วทุกหกชั่วโมง หลังอัปเดต แต่ละส่วนจะได้สิ่งที่
ต้องใช้: แอปได้ dependency (เมื่อ `pnpm-lock.yaml` เปลี่ยน) และบิลด์ใหม่ (เตรียมไว้ขณะ ZAICODE
ทำงาน เริ่มใช้ในการสตาร์ตครั้งถัดไป), SAIPEN ได้ launcher, SAIMAIL ได้การติดตั้ง
`.venv`, เวิร์กสเปซได้ root launcher ใหม่ คลองที่อยู่บน branch อื่น, มี commit
ในเครื่อง หรือมีการแก้ไขที่อัปเดตจะเขียนทับ จะถูกรายงานและปล่อยไว้ตามเดิม

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## มันทำอะไร

ตัวติดตั้งคือการตรวจ Autotroubleshoot ที่รันด้วย "repair" ในโฟลเดอร์ว่าง
ตามลำดับนี้ แต่ละขั้นตอนเป็น idempotent การรันซ้ำจึงอัปเดตการติดตั้ง
และซ่อมแซมสิ่งที่พัง

| การตรวจ | การซ่อมแซม |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | ใช้ตัวของเครื่องเมื่อรองรับ มิฉะนั้นใช้สำเนาส่วนตัวใน `.tools\` (MinGit จาก Git for Windows, Node.js 24.14.0 จาก nodejs.org, Python จากแพ็กเกจ NuGet ของมัน) ไม่ต้องใช้สิทธิ์ผู้ดูแลระบบ |
| pnpm | pnpm 10.33.2 เวอร์ชันตรึงใน `.tools\pnpm10` |
| เวิร์กสเปซ ZAICODE | โคลน `vacterro/zaicode` branch `master` (ซอร์ส launcher, ตัวติดตั้ง, เอกสาร; ไม่รวม memory ของนักพัฒนาใน `.saipen/`; branch `workspace` จนถึง 2026-09-27) |
| ซอร์สแอป ZAICODE | โคลน branch `zaicode` เข้า `zcode\` |
| SAIPEN | โคลน `vacterro/saipen` เข้า `saipen\`; `bin\saipen.cmd` ของมันถูกเขียนมาสำหรับคลองนี้และ Python นี้ |
| SAIMAIL | โคลน `vacterro/saimail` เข้า `saimail\`, ติดตั้งเข้า `.venv\` |
| saimail-local | ไคลเอนต์บรรทัดคำสั่งของ SAIMAIL ที่แผง SAIMAIL ใน ZAICODE ใช้ (มีตั้งแต่ SAIMAIL `0.0.2a3`; การตรวจ `saimail-cli` รายงาน OK) |
| แพ็กเกจ 9router | `9router` จาก npm เข้า `.tools\router`, รวมมาให้ SAIFREN ใช้งานได้โดยไม่ต้องตั้งค่า (WARN เมื่อ npm ติดต่อไม่ได้) |
| dependency ของแอป | `pnpm install --frozen-lockfile` (ทำซ้ำเมื่อ `pnpm-lock.yaml` เปลี่ยน) |
| บิลด์แอป | `pnpm bundle:zaicode`; ขณะ ZAICODE ทำงาน บิลด์ใหม่จะถูกเตรียมไว้และสลับเข้าในการสตาร์ตครั้งถัดไป |
| การสลับบิลด์ที่เตรียมไว้ | ล้าง `win-unpacked.previous` ที่เหลือจากความล้มเหลวของการสลับพาธยาว และสลับบิลด์ที่รออยู่เข้าเมื่อ ZAICODE ปิดอยู่ |
| Root launcher | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| ทางลัด | เดสก์ท็อปและเมนู Start `ZAICODE` -> `ZAICODE.exe` |
| การล็อกอิน Claude / Codex | รายงานเท่านั้น: ทุกการล็อกอิน `~\.claude*` / `~\.codex*` เป็นเอนจินของตัวเองใน ZAICODE (A1, A2, C1, ...); การล็อกอินที่ต้องให้คุณทำ ทำในเบราว์เซอร์ |

Root launcher ชี้ ZAICODE ไปที่ SAIPEN ที่ติดตั้งแล้ว (`saipen\`) และวาง
`.tools\` และ `.venv\Scripts` ไว้หน้าสุดของ PATH ของแอป เพื่อให้แอป เอเจนต์
และ worker ของมันใช้สำเนาที่ติดตั้งแล้ว

## หลายการสมัครสมาชิก

ทุก login ของ Claude Code หรือ Codex อยู่ใน home ของตัวเอง: `~\.claude`,
`~\.claude-account2`, ... และ `~\.codex`, `~\.codex-account2`, ... ZAICODE หาเจอทั้งหมด
หากต้องการเตรียมเพิ่มตอนติดตั้ง:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

ตัวติดตั้งสร้าง home และพิมพ์คำสั่ง login ที่แน่นอนของแต่ละอัน
(`$env:CODEX_HOME = '...'; codex login`) ใน ZAICODE ก็เหมือนกัน: Settings ->
Engines & limits -> เพิ่ม login อีกอัน

## ตรวจสอบและแก้ไขปัญหาอัตโนมัติ

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

สถานะต่อการตรวจ: OK, FIXED (เสีย แล้วซ่อมแล้ว), WARN (ใช้ได้ แต่ขาดบางอย่างที่เป็นตัวเลือก), INFO (ต้องให้คุณทำ: ต้อง login), FAIL อยู่ใน
`install\logs\` สรุปของการติดตั้งล่าสุดคือ `install\install-report.json`
ในแอป Router -> Autotroubleshoot ซ่อม router ที่กำลังรันและ pools

## ตัวเลือก

| พารามิเตอร์ | ค่าเริ่มต้น | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | ที่เก็บทุกอย่าง |
| `-ShortcutDir` | Desktop | ที่วาง shortcut ของ ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | ข้าม shortcut เหล่านั้น |
| `-PortableTools` | | ใช้ Git / Node.js / Python แบบ private แม้เครื่องจะมีอยู่แล้ว |
| `-Launch` | | เปิด ZAICODE เมื่อเสร็จ |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | the GitHub repos | แหล่งที่มาอื่น (fork, พาธ local clone) |

## หลักฐาน

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
ตรวจการติดตั้งใหม่ จาง fault (ลบ shortcut และ launcher, ชี้ launcher ของ SAIPEN
ไปที่ Python ที่ไม่มี, ลบ venv ของ SAIMAIL, บันทึก node_modules ของ lockfile อื่น,
เหลือโฟลเดอร์ build ที่ลึกกว่า MAX_PATH) แล้วยืนยันว่า doctor รายงานและซ่อมทุกรายการ จากนั้น
สตาร์ตเป้าหมายของ shortcut ด้วย profile แยก และหยุดเฉพาะ process tree ที่ตัวเองสตาร์ต

`install\tests\Test-ZaicodeUpdate.ps1` สร้าง repo ชั่วคราวสี่อันบนดิสก์ พร้อมติดตั้งของ clone เหล่านั้น แล้วพิสูจน์ว่า
การตรวจหนึ่งไม่เปลี่ยนอะไร, การอัปเดตแค่ส่วนเดียวเกิดพร้อมผลตามมา (launcher ของ
SAIPEN, root launcher), การแก้ไข local ที่ทับซ้อนและ local commit ยังถูกเก็บไว้, และชื่อส่วนที่
ไม่รู้จักถูกปฏิเสธ ไม่ใช้เน็ต

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
