# การขนส่งข้อมูล ZAICODE SAIPEN ผ่านคลาวด์

วิธีที่การเช็กเอาต์นี้กับเซสชัน Claude Code Cloud รันพื้นที่ทำงาน SAIPEN เดียวกัน
แต่คนละที่ทำงานของ executor และขอบเขตระหว่างสองฝั่งอยู่ตรงไหน

## รูปร่าง

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

มี branch เดียวที่ถือสถานะโปรโตคอล ไม่มีขั้นตอน merge ไม่มี rebase
และไม่มี branch local ที่สองต้องคอยซิงก์: executor ฝั่งไหนที่มี checkpoint ที่ตรวจสอบแล้ว
ก็ commit และ push ส่วนอีกฝั่งรับด้วย fast-forward

`master` คือประวัติก่อนการขนส่ง และเป็น branch เริ่มต้นที่เผยแพร่ มัน
ไม่ถูก force-update โดยการขนส่ง

## อะไรเดินทางไป อะไรไม่

checkpoint ใน repository นี้ถือสถานะโปรโตคอล SAIPEN, root
launcher, installer, เอกสาร และสคริปต์ขนส่งเหล่านี้ นั่นคือทั้งหมดของชั้น workspace

มันไม่พา **product byte ใดๆ** `zcode/` เป็น Git repository แยกอีกอัน ที่ระบุไว้
ใน `.saipen/source-nested-repos.json` และถูก gitignore ไว้ที่ root นี้
(`/zcode/`) งาน product ต้องมี clone ของ `vacterro/zaicode` เป็นของตัวเองบน branch
`zaicode` และ clone นั้นเป็นออบเจกต์ที่สองที่เป็นอิสระ มีประวัติของตัวเอง

ผลที่ตามมามักเข้าใจผิดง่าย: `git status` ที่สะอาดที่ root นี้บอกอะไร
เกี่ยวกับงาน product ที่ยังไม่ commit ไม่ได้เลย และ fast-forward ของ `saipen-live` ก็บอกอะไร
เกี่ยวกับโค้ด product ไม่ได้เลย ต้องตรวจ `git -C zcode status` โดยเฉพาะ

## ครึ่ง local

สองสคริปต์ ทั้งคู่เป็นของ repo เพื่อให้เครื่องใหม่ได้มาจาก repository
แทนที่จะจำจากความทรงจำ:

| ไฟล์ | บทบาท |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | ตรวจสอบความถูกต้อง, ปรับ branch ให้ตรงกัน, ติดตั้งและเริ่ม watcher, เขียนรายการ autostart, พิสูจน์ว่า local == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | ลูป: fetch, เปรียบเทียบ, fast-forward หรือ push, บันทึก, หยุดชั่วคราว; จากนั้นทำ product pass และ self-update |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | round-trip จาก executor อิสระ พร้อมหลักฐานการกู้คืนหลังเครื่องปิด |
| `tools/saipen-cloud/Test-ProductSync.ps1` | product pass และ self-update กับ Git repositories แบบ throwaway (ไม่มีเน็ต, ไม่มี remote จริง) |

ติดตั้งและซ่อมแซม:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

มันเป็น idempotent. สถานะระดับเครื่องเก็บอยู่ใน `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (สำเนา), `ZAICODE_cloud-sync.log` (หมุนเวียนที่
2 MB ไปยัง `.log.1`), `ZAICODE_cloud-sync.lock` (อินสแตนซ์เดียว),
`ZAICODE_cloud-sync.pid` และรายการในโฟลเดอร์ Startup
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

ตัวติดตั้งปฏิเสธเมื่อ tree สกปรก และไม่เคยล้างมัน หากทุกพาธที่สกปรกเป็น
สถานะ SAIPEN แบบ canonical ภายใต้ `.saipen/` มันจะแจ้งว่าเป็นเช่นนั้น
และพิมพ์คำสั่ง checkpoint ที่แน่นอน; นั่นคือสถานะ protocol ที่ยังไม่ได้
checkpoint ไม่ใช่ข้อผิดพลาดของการรับส่ง และตัวติดตั้งจะไม่ commit
มันโดยไม่ผ่านการรับรู้ของ protocol.

## พฤติกรรมของ watcher

| สถานการณ์ | การเคลื่อนที่ |
|-----------|------|
| สะอาด, local เป็น ancestor ของ remote | `git merge --ff-only` |
| สะอาด, remote เป็น ancestor ของ local | `git push` |
| สกปรก | หยุดชั่วคราว; ไม่แม้แต่ fetch |
| อยู่ branch อื่น | หยุดชั่วคราว |
| ทั้งสองฝ่ายเดินหน้า, ไม่มี ancestor ร่วม | หยุดชั่วคราว, บันทึก commit id ทั้งสอง, ไม่ merge อะไรเลย |
| fetch หรือเครือข่ายล้มเหลว | บันทึกว่า degraded, ลองใหม่ tick ถัดไป |
| มี merge/rebase/cherry-pick กำลังทำงานอยู่ | หยุดชั่วคราว |

ห้ามเด็ดขาด: force push, hard reset, stash, clean, checkout branch ต่างประเทศ,
commit หรือหยุด watcher ด้วยชื่อ process ตัวติดตั้งหยุด watcher ได้เฉพาะด้วย
pid ที่มันบันทึกไว้ใน pid file ของตัวเองเท่านั้น.

tree ที่สกปรกไม่ต้องจ่ายอะไร เพราะ watcher ตรวจ dirt ก่อน fetch
ดังนั้น checkout ที่ว่างจึงไม่มีการเรียกเครือข่ายเลยแม้แต่ครั้งเดียว.

### รอบผลิตภัณฑ์ (T-90)

`zcode/` เป็น repository ของตัวเอง ตารางข้างบนจึงไม่เคยย้ายโค้ดของ
product หลังจากนั้น tick เดียวกันจะจัดการ checkout ของ product (`-ProductRepo`,
ค่าเริ่มต้น `<repo>\zcode`; branch `-ProductBranch`, ค่าเริ่มต้น `zaicode`) การ
product pass ทำงานไม่ว่า tree ภายนอกจะสกปรกหรือไม่ และมัน pull เท่านั้น.

| สถานการณ์ | การดำเนินการ |
|-----------|------|
| remote ahead, ไฟล์ที่เข้ามาไม่มีตัวไหน dirty ที่นี่ | `git merge --ff-only`; งาน product ที่ยังไม่ commit คงเดิม |
| remote ahead, มีไฟล์ที่เข้ามา dirty ที่นี่ | HELD: บันทึกรายชื่อไฟล์ ไม่ merge ใด ๆ |
| local ahead | บันทึก; **ไม่ push เด็ดขาด** (product เผยแพร่โดย SAIPEN SHIP) |
| diverged | หยุด, บันทึกทั้งสอง id, ไม่ merge ใด ๆ |
| branch อื่น, มี git op ค้างอยู่, fetch ล้มเหลว | หยุด |
| ไม่มี checkout ของ `zcode/` หรือ `-NoProduct` | skipped |

git ปฏิเสธเองอยู่แล้วสำหรับ fast-forward ที่จะทับ local change การตรวจ HELD จึงเป็นการกันไว้ก่อนและชัดกว่า ไม่ใช่เพียงตัวเดียว fast-forward ของ product ไม่ rebuild อะไรทั้งสิ้น: ทดสอบด้วยการรัน `pnpm bundle:zaicode` (หรือ dev preview)

### อัปเดตตัวเอง (T-90)

watcher รันเป็นสำเนาภายใต้ `%APPDATA%\SAIPEN` ดังนั้น watcher ที่ใหม่กว่าใน repository จะไม่มีวันทำงานโดยไม่ได้ติดตั้งใหม่ ในโหมด loop ตอนนี้มันเปรียบเทียบไฟล์ของตัวเองกับสำเนาที่ commit ไว้ใน repository ทุกรอบ จากนั้นติดตั้งสำเนานั้นทับตัวเอง แล้วรีสตาร์ตพอดีหนึ่งครั้ง ด้วยอาร์กิวเมนต์เดิม และเฉพาะเมื่อเงื่อนไขทั้งหมดนี้ผ่าน:

- สองไฟล์ต่างกัน;
- สำเนาใน repository ไม่มีการแก้ไขที่ยังไม่ commit;
- สำเนาใน repository parse ได้โดยไม่มีข้อผิดพลาด

สำเนาที่ parse ไม่ผ่านจะถูกปฏิเสธและบันทึกลง log ส่วน watcher ที่กำลังรันก็ทำงานต่อ

watcher ที่ติดตั้งก่อน T-90 ไม่มีทั้ง product pass และ self-update ให้รัน `Install-SaipenLiveSync.ps1` อีกครั้งหนึ่งครั้งบนเครื่องแบบนั้น หลังจากนั้น watcher จะอัปเดตตัวเองได้เอง

## ครึ่ง cloud

`CLAUDE.md` ที่ root คือกฎขาเข้า และ `.claude/skills/saipen/SKILL.md` คือขั้นตอนการทำงาน skill ดึง kernel ของ SAIPEN จาก `github.com/vacterro/saipen` แล้วรันผ่าน engine surface ที่ประกาศไว้ `tools/saipen.py` kernel ถูกตรึงด้วย commit (`3088eff`) ไม่ใช่ด้วย tag tag `v8.0.1` เป็น kernel รุ่นเก่าที่มี `VERSION` เหมือนกัน `validate` ของมันแก้ไข state และ validator ของมันปฏิเสธ board นี้

`STATE.saipen_home` บันทึก kernel path ของ executor ที่ checkpoint ล่าสุด ใน cloud การ `saipen continue` ครั้งแรกบน kernel `3088eff` จะ converge มันไปยัง kernel ที่กำลังรัน เป็น `DEC` หนึ่งรายการที่บันทึกใน journal (E-1410) บนเครื่องของ operator pointer จะมาถึงตายแบบเดียวกัน kernel ที่มี automatic convergence จะซ่อมมันเองเมื่อ `continue` มิฉะนั้นให้รัน `saipen rebind-home --auto`

**พบการย้อนกลับแล้ว** E-1562 (cloud) converge pointer ไปที่ `/home/user/zaicode/.claude/saipen-protocol`; E-1571 (เครื่อง operator) converge กลับไปที่ `V:/.../_SAIPEN` ทันที โดยอัตโนมัติ ไม่ต้องมี `rebind-home` แบบ manual ทั้งสองทิศทางคือการ converge อัตโนมัติแบบเดียวกัน จึงคาดหวัง `saipen_home` `DEC` หนึ่งครั้งต่อการสลับ locality และถือเป็น noise ที่คาดไว้ ไม่ใช่ข้อบกพร่อง มันจะเป็น noise ต่อไปจนกว่า P1-2 (`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) จะย้าย pointer ออกจากสถานะ versioned อย่า implement P1-2 เป็นผลข้างเคียงเพียงเพราะสังเกตเห็น ห้ามแก้ pointer ด้วยมือ

`STATE.saipen_home` อาจชี้ไปที่ kernel **development checkout** ที่อยู่เลยกว่า pin ไม่ใช่ clone `3088eff` ที่สะอาด — บนเครื่อง operator มันคือ branch `accepted-debt-rebind` ที่ยังมีงานที่ยังไม่ commit kernel ที่ไม่ได้อยู่ที่ commit ตาม pin ไม่ได้ผิดโดยอัตโนมัติ แต่ก็ไม่ใช่แหล่ง clean-room เช่นกัน ดังนั้นกฎเรื่อง voice contract ข้างล่างยังบังคับใช้กับมันเต็มที่ ห้าม commit, stash, reset, check out หรือ clean สิ่งใดใน checkout แบบนั้น ข้อยกเว้นเดียวคือ restore แบบ single-file เจาะจงที่ `saipen/STYLE.md` และเฉพาะเมื่อ operator สั่งเท่านั้น

### STYLE.md ไม่ใช่ค่าตั้งที่อยู่ในเครื่อง

`saipen/STYLE.md` ต้อง **เหมือนไฟล์ของ kernel ที่ pin ไว้แบบ byte-identical** บนทุกเครื่อง ในทุกชุดสำเนา ไม่มีข้อยกเว้นและไม่มีการแก้ในเครื่อง และบนเครื่อง operator มีมากกว่าหนึ่งชุด:

- kernel checkout ที่ `STATE.saipen_home` (เป็น Git clone; บนเครื่อง operator เป็น development checkout);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md` ซึ่งถูกเติมข้อมูลโดย scheduled task `saipen-inject` (`bootstrap/schedule-run.ps1`) มัน **ไม่ใช่ Git repository** ดังนั้น `git checkout` ไม่มีทางซ่อมมันได้ — ทางเดียวคือ re-sync ผ่าน injector หรือเขียนเนื้อหาที่ publish ไว้ลงไปโดยตรง

token ของ `style_contract` ใน `.saipen/STATE.md` คือ hash ของข้อความในไฟล์นั้น (`tools/validate.py`, `style_contract_token`: normalize CRLF, ตัดบรรทัด `style_contract:` ออก) แก้ `reply_language` ในชุดสำเนาหนึ่ง token จะเปลี่ยนไป ส่วนอีกชุดสำเนาและ cloud ซึ่งดึง kernel ที่ publish ไว้ ยังคง token ที่ publish ไว้ และ CLI ทุกครั้งที่พยายามเขียนฝั่งที่ไม่ตรงกันจะถูกปฏิเสธด้วย `style_contract ... does not match the installed STYLE.md marker`
นี่คือความล้มเหลวทั้งหมด: ฝั่ง local เขียนสถานะที่ cloud เขียนไม่ได้

**การเปลี่ยนภาษาของคำตอบคือ kernel commit บวกกับ repin** ไม่ใช่การแก้ในเครื่อง ให้แก้ใน kernel repository, publish, re-pin commit ใน SKILL.md แล้วอัปเดต `STATE.style_contract` ผ่าน `saipen recover` การแก้ `STYLE.md` ในเครื่องจะทำให้ทุกเครื่องที่ไม่ใช่เครื่องที่แก้เข้าไม่ตรงกันทั้งหมด

กับดักที่ควรเอ่ยชื่อ: `bin/saipen` ที่ publish ไว้เป็น machine-bound shim ที่ hardcode absolute path ของ interpreter และ checkout ของ operator คนเดียว มันรันได้บนเครื่องเดียวเท่านั้น cloud ต้องใช้ `python3 tools/saipen.py`

ทางลัด: `cc` ดำเนิน Work ปัจจุบันต่อ; `cc all <text>` ดูดข้อความทั้งข้อความเป็น source/appends แล้วดำเนินต่อทุก Work ที่เข้าเกณฑ์ ไม่มีข้อใดที่ขอ confirmation ตามปกติ

## การจำแนกความสามารถ

**AVAILABLE_IN_CLOUD** — สถานะโปรโตคอลและชั้น workspace อ่านและเขียน
`.saipen/`, ตัว launcher (`tools/launcher/ZaicodeLauncher.cs`), ตัวติดตั้งใต้ `install/`, `docs/`,
`CLAUDE.md`, `.claude/skills/` และสคริปต์ transport Git read, commit, push และ
fetch บน `saipen-live` ทุก gate ที่เป็นการยืนยันไฟล์ การรีวิว diff หรือ
การตรวจข้อความ

**LOCAL_WINDOWS_ONLY** — gate ที่ต้องใช้เครื่องนี้

| Gate | เหตุผล |
|------|-----|
| `tools\launcher\build.cmd` | คอมไพล์ `ZaicodeLauncher.cs` ด้วย .NET Framework `csc`; บนอิมเมจ cloudไม่มี Windows SDK |
| Electron E2E แบบแพ็กเกจ (`zcode` desktop, Solo → queue → dispatch) | ต้องมีเซสชันเดสก์ท็อปและ provider profile ที่ seed ไว้ |
| 9router ตัวจริง | เป็น Windows service บนเครื่องนี้ |
| คลิกผ่านเดสก์ท็อปแบบโต้ตอบ | ต้องมีคนกับหน้าจอ |
| test case ของ runtime ตัว watcher | watcher รันเฉพาะเครื่องที่ถือ checkout |

บันทึกไว้เป็นขอบเขตยอมรับแบบ local-only ไม่เคยรายงานว่าผ่าน
เพียงเพราะ diff ดูถูกต้อง

**SAFE_TO_DEFER** — ชั้นผลิตภัณฑ์ เซสชันคลาวด์สามารถโคลน
`vacterro/zaicode` branch `zaicode` แล้วทำงานที่นั่นได้ งานชั้น workspace ไม่ต้องพึ่งงานชั้นผลิตภัณฑ์ แต่ต้องมีการโคลน:
`.saipen/source-nested-repos.json` ประกาศ `zcode/` และถ้าไม่มี validator จะล้มเหลวด้วย `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'` `pnpm` gate ต้องการ pnpm 10.33.2 ที่ pin ไว้และ workspace ที่เตรียมไว้แล้ว `pnpm bootstrap` บน image คลาวด์ใหม่คือวิธีเข้าใช้ที่ระบุไว้ในเอกสาร และ `package.json` ของผลิตภัณฑ์ก็ประกาศไว้แล้ว

cloud ตรวจได้แค่ไบต์ผลิตภัณฑ์ที่อยู่บน `origin/zaicode` ตัว
delta ของผลิตภัณฑ์ที่มีแค่ใน checkout ของ operator ที่ `zcode/` จะ
มองไม่เห็นที่นี่ ดังนั้นทุก gate ของผลิตภัณฑ์นั้นจะเป็น NOT RUN ใน cloud ไม่ว่า gateใดก็ตาม
T-84 คือกรณีแรก (E-1411) การแก้เป็น local-only ขณะที่
`origin/zaicode` ยังถือโค้ดก่อนแก้

**UNSAFE_TO_EMULATE** — สิ่งที่ทำให้ gate แบบ local-only ดูเขียว อย่า stub การ build
launcher อย่าจำลองการรันแอปแพ็กเกจ อย่า replay ผลลัพธ์ `pnpm verify:pre-push` ที่บันทึกไว้
ราวกับเพิ่งรัน และอย่าแปลง "โค้ดดูถูกต้อง" เป็นบรรทัด PASS ใน `.saipen/LOG.md`

**KNOWN_CLOUD_DIVERGENCE** — ข้อกำหนดความสอดคล้องที่ขึ้นกับตำแหน่ง checkout บน
kernel `3088eff` cloud validator รายงาน `closure-evidence`
FAIL (T-47, T-62, T-76, T-78 ณเวลาเขียน) ที่เครื่อง operator ไม่พบ

kernel ย้าย LOG event ที่เกิน 1024 ไบต์ไปไว้ใน
sidecar ของ `.saipen/recovery/log-detail/` ตอนอ่านจะคืน sidecar เฉพาะเมื่อ path แบบ
สัมบูรณ์ของ checkout ตรงกับ path ที่เขียนออกมา ดังนั้น verdict ของ
VERIFY ที่ยาวและเขียนบน Windows จึงอ่านไม่ได้ใน cloud และ
กรณีกลับกันก็จริงเช่นกัน

ข้อบกพร่องอยู่ใน kernel บันทึกเป็น P1-1 ใน
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md` จนกว่าจะ merge:

- อ้างคำตัดสินจากคลาวด์แล้วจัดเข้าขอบเขตนี้ ทีละ ticket
  (`SKILL.md` § 6 มีการตรวจสอบ);
- ห้ามเขียน sidecar ใหม่ ห้ามตรวจซ้ำเพื่อให้ผ่าน ห้ามแก้ kernel
  copy;
- ให้เหตุการณ์ใน LOG อยู่ใต้ 1024 bytes ทั้งสองฝั่ง

การผูกกับ machine-path เดียวกันนี้ยังบล็อกงานอยู่ด้วย Debt baseline ก่อน BUILD
จะถูกบันทึกครั้งแรกที่ ticket เข้าสู่ BUILD และตรวจซ้ำทุกครั้งที่เข้าอีก
ดังนั้น ticket ที่เคยเข้า BUILD ครั้งแรกบนเครื่อง operator จะเข้า BUILD ในคลาวด์ไม่ได้ ระบบ
ปฏิเสธการเปลี่ยนสถานะด้วย `DEBT_SNAPSHOT_FOREIGN_PROJECT` T-84 คือเคสที่บันทึกไว้: DEBT-000079
ถูกบันทึกที่ E-1377 และการเปลี่ยนสถานะถูกปฏิเสธที่ E-1446 ให้ ticket แบบนี้อยู่กับเครื่องที่
บันทึก baseline ของมัน

## การแยกสาย

ถ้า local กับ remote หยุดมี ancestor ร่วมกัน watcher จะหยุดทำงาน มันไม่
merge ไม่ rebase ไม่ force ทั้งสอง commit id จะเข้าไปใน log การแก้ไขเป็น
`git log --left-right --cherry-pick <branch>...origin/<branch>` โดยมือ และ
ผลลัพธ์จะถูก checkpoint เหมือนการเปลี่ยนแปลงอื่น ๆ

## คำสั่งที่ต้องทำบนฝั่งคลาวด์อย่างเจาะจง

### Setup script ของ environment (ทำครั้งเดียว ใน settings ของ environment ฝั่งคลาวด์)

เมนู Cloud environment ใน session title bar -> Edit -> Setup script มัน
จะรันก่อนทุก session ใหม่ ดังนั้นแต่ละ session จะเริ่มโดยมี product toolchain พร้อมใช้งาน:

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

### prompt สำหรับทุก session ใหม่

เริ่ม session บน repository `vacterro/zaicode` branch `saipen-live` และ
ตรวจสอบว่า agent บนเครื่อง operator ไม่ได้เขียนไฟล์พร้อมกัน
แทนที่บรรทัดสุดท้ายด้วย `cc all <new list>` เพื่อส่งงานใหม่ต่อ

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

บนเครื่อง operator watcher จะ fast-forward `zcode` จาก
`origin/zaicode`; `REBUILD.cmd` (หรือ `REBUILD_fast.lnk`) เป็นผู้ build และ
การเปิด ZAICODE ครั้งถัดไปจะเปลี่ยนมาใช้ build ใหม่

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
