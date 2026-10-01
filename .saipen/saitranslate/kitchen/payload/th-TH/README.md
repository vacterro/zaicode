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

<img width="1440" height="860" alt="ZAICODE hero — Do your best." src="docs/screenshots/01-do-your-best.png" />

ZAICODE คือ workbench สำหรับ operatorในการรัน AI coding agent หลายตัวพร้อมกัน
หลายโปรเจกต์ โดยไม่ต้องคอยเฝ้าเป็น build ดัดแปลงของ
[ZCode](https://github.com/zai-org/ZCode) (แอปเดสก์ท็อป, UI ผ่านเบราว์เซอร์ และ agent
CLI)โดยเพิ่มชั้น productเข้าไป: ทุกโปรเจกต์ถูกขับเคลื่อนด้วย
protocol [SAIPEN](https://github.com/vacterro/saipen) เริ่ม ต่อ และตั้งเวลางานได้จากหน้าต่างเดียว
ส่วน subscription CLI ที่คุณจ่ายเงินอยู่แล้ว
(Claude Code, Codex, Antigravity) จะรันเป็น worker ที่ dock อยู่ข้าง agentในแอป

**0.0.1** คือ snapshotแรกที่ tagแล้ว: build ส่วนตัว เน้น Windows ใช้งานทุกวัน

## ติดตั้งคลิกเดียว

1. ดาวน์โหลด **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**
2. ดับเบิลคลิก แล้วกด **INSTALL**

จบแค่นี้ Setup จะเติมสิ่งที่เครื่องขาด (Git, Node.js, Python เป็น
สำเนาแยกส่วน: ไม่ต้องใช้สิทธิ์แอดมิน) ดึง ZAICODE, SAIPEN และ SAIMAIL จาก GitHub
build แอปบนเครื่อง และวาง shortcut ของ ZAICODE ไว้บนเดสก์ท็อป การรันครั้งแรก
ใช้เวลา 15-30 นาที หน้าต่างจะแสดงทุกขั้นตอน

โมเดลฟรีใช้ได้ทันที: ZAICODE สตาร์ต router ของตัวเองและเติม pool ของ
**SAIFREN** จากชั้นฟรีแบบไม่ต้องใช้คีย์ งานที่พิมพ์ใน New task จึงได้คำตอบโดยไม่ต้องมี
คีย์ ไม่ต้องมีบัญชี ไม่ต้องตั้งค่า ส่วน subscription ของ Claude Code, Codex
และ Antigravity เป็นตัวเลือก ล็อกอินเมื่อไรก็ได้

**หนึ่งทั้งหมด สี่ส่วน** workspace (launcher, installer), แอป, SAIPEN และ
SAIMAIL เป็นสี่ repository แต่ละส่วนอัปเดตแยกกัน: *Settings -> ZAICODE ->
Updates* จะแสดงทุกส่วน อัปเดตเองหรือด้วยมือก็ได้ (ตรวจอัตโนมัติไม่กี่นาที
หลังเริ่ม และทุกหกชั่วโมง) build ใหม่ของแอปจะถูกเตรียมไว้ระหว่างที่ ZAICODE ทำงาน
และเริ่มใช้ในการสตาร์ตครั้งถัดไป การแก้ไขของคุณเองใน clone จะไม่ถูกเขียนทับ
จากเทอร์มินัล: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
แก้ปัญหาอัตโนมัติ: `install\Doctor.cmd`. รายละเอียด: [docs/ZAICODE_INSTALL.md](docs/ZAICODE_INSTALL.md).

## ชม interface

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

## สิ่งที่เพิ่มจาก ZCode

- **โปรเจกต์ที่มี MAIN session** แต่ละโปรเจกต์มี MAIN session เดียว (START, `/goal cc all`) กับ helper session (subSaipens: WIKI, TEST, AUDIT, …) มุมมีดแถบด้านข้างแสดงแถวโปรเจกต์เป็น MAIN ▶ ทำต่อ MAIN ไม่เปิด session ใหม่ CONTINUE ALL, DONE และ CLEAR ALL DONE กวาดทุกโปรเจกต์ session ที่ถูกตัดกลางเทิร์นจะขึ้น INTERRUPTED ไม่ใช่ DONE
- **ทนแครช** session ที่ถูกตัดจากโปรเซสตาย และ goal ที่ยัง active จะทำต่อเองหลัง restart; worker ที่กำลังรันเริ่มใหม่เอง agent ใน ZAICODE ฆ่า ZAICODE ด้วยชื่อโปรเซสไม่ได้
- **Worker** CLI ของ subscription รันในเทอร์มินัลที่ dock ได้ทุกขอบหน้าต่าง (หรือหน้าต่าง snap แยก) คำถาม "Trust this folder?" ครั้งแรกถูกตอบให้แล้ว worker ที่ชน usage limit จะถูกรายงาน และตามการตั้งค่า ปิดหรือ restart หลังรีเซ็ต
- **Limit และการรีเซ็ต** มิเตอร์โควตาต่อบัญชีและต่อ pool, timer ในแถบชื่อหน้าต่างนับถอยหลังรีเซ็ตที่ใกล้ที่สุด พร้อมรายการรีเซ็ตทั้งหมดเมื่อ hover
- **SCHEDULER** prompt ที่สั่งตัวเองได้: เวลาที่กำหนด, ทุกวัน, ทุก N นาที หรือเมื่อหน้าต่างโควตาเติม ในโปรเจกต์เดียวหรือทั้ง section ในแถบด้านข้าง โดยโปรเจกต์ที่แย่สุด (ติดบล็อกมาก / ticket SAIPEN เปิดมาก) มาก่อน เงื่อนไขหยุดงานประทัดชั่วคราว (session ที่ใช้ pool ฟรี, worker ที่อ่อนกว่า) ได้ก่อน, รันเฉพาะโปรเจกต์ที่ว่าง, หรือทำต่อเฉพาะ session ที่ทำเครื่องหมาย prompt ไม่มีข้อจำกัดความยาวเชิงปฏิบัติ
- **Routing** 9router ที่รวมมาด้วย (MIT) ให้ pool แบบ zero-setup: SAIFREN (free tier ไม่ต้องใช้ key) และ SAIOPP (subscription ของคุณ)
- **SAIHOME, timer, เสียง, highlight** หน้าแรกสำหรับ operator พร้อมสถิติ, timer และ alarm แบบ FastPrompter, เสียงแยกต่อ action และอินเทอร์เฟส Win95 dark golden คมกริบทุกพิกเซล

## สร้าง

ความต้องการ: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2** ([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) คือแหล่งความจริง)

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

แอปที่แพ็กแล้วเริ่มในโหมด ZAICODE เสมอ ระหว่างที่ ZAICODE เวอร์ชันเก่ายังรัน bundler จะ stage build ใหม่ไว้ที่ `packages/desktop/dist-next`; launcher ที่ root (branch `master`, `tools/launcher`) จะสลับมันเข้าไปในการ start ครั้งถัดไป
Verdana bitmap เวอร์ชันคมชัดที่ UI ใช้ไม่อยู่ใน repository นี้ ถ้าไม่มี อินเทอร์เฟสจะ fallback ไปใช้ Verdana ของระบบ

Checks: `pnpm typecheck`, `pnpm lint` และเทสต์ของ ZAICODE เช่น `node --import tsx --test test/zaicode*.test.ts` จาก `packages/ui`

## โครงสร้าง repository

| Branch      | เนื้อหา                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | workspace หลัก: launcher, installer (`install/`), เอกสารผลิตภัณฑ์ (`UI.md`, `docs/`), state ของ SAIPEN และ CHANGELOG |
| `zaicode`   | source ของแอปหลัก: ประวัติ upstream ZCode บวกชั้นผลิตภัณฑ์ ZAICODE ที่ใช้ build และอัปเดต |

ref ที่เป็น legacy หรือสร้างโดย automation อาจโผล่ขึ้นชั่วคราว แต่ไม่ใช่ branch ผลิตภัณฑ์หลัก งาน workspace ใหม่อยู่ที่ `master`; งาน source แอปอยู่ที่ `zaicode`

โค้ดแอปที่ ZAICODE เป็นเจ้าของอยู่ใน `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` และ
`packages/desktop/src/main/zaicode*.ts` บน branch `zaicode` เอกสาร workspace
และเครื่องมือ launcher/update อยู่ที่ `master`

## Upstream และ license

ZAICODE 派生自 Z.ai 的 ZCode 依同一
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE) 授权分发；上游声明保留于
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) 与 [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md)。
文件经 ZAICODE 作者修改。ZAICODE 为独立项目，
与 Z.ai 无隶属或背书关系。原 ZCode README 保留于
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) 与 [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md)。

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## โครงการในเครือ

ที่เก็บนี้เป็นส่วนหนึ่งของระบบ **SAIPEN / vacterro**

[**ศูนย์รวมผู้เขียน**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN Community**](https://discord.gg/SEYaYkuVgN)

รายงานบั๊กแบบทำซ้ำได้และขอฟีเจอร์ระยะยาว ใช้ [GitHub Issues ของที่เก็บนี้](https://github.com/vacterro/zaicode/issues) ใช้ Discord สำหรับคุยสั้น ๆ ส่งภาพหน้าจอ และข้อมูลข้ามโครงการ

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
