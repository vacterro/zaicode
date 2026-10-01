# تثبيت ZAICODE

ZAICODE ثلاثة مشاريع تعمل كوحدة واحدة: تطبيق ZAICODE، وSAIPEN (البروتوكول
الذي يُبقي عمل الوكلاء على مساره) وSAIMAIL (البريد الذي تستخدمه الوكلاء
لإخبار بعضها بما يحدث). تثبيتها يدوياً يعني ثلاثة استنساخات، وسلسلة أدوات
Node.js، وبيئة Python، وخطوة بناء. المُثبِّت يتولى كل ذلك:
شغّله، انتظر، وستجد اختصار ZAICODE على سطح المكتب.

## بنقرة واحدة

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  نزّله، انقر نقراً مزدوجاً، اضغط **INSTALL**. النافذة (ذهبية على خلفية داكنة،
  مع شعار SAIPEN) تعرض كل خطوة أثناء تنفيذها، والمدة المنقضية، والسجل عند
  الطلب؛ في النهاية **START ZAICODE**، أو **TRY AGAIN** / **Autotroubleshoot**
  / **Open log** حين لا تُكمل某某某某某某某某某某某. عند الإشارة إلى مجلد ZAICODE
  موجود يصبح الزر **UPDATE**: نفس العملية تحدّث وتُصلح. الملف exe يحمل
  نصوص التثبيت ولا يحتاج أي شيء بجواره؛ بُني بواسطة `install\setup\build.cmd` (مُصرِّف
  .NET Framework الموجود في كل Windows 10/11).
- `install\Setup-ZAICODE.cmd` (نقرة مزدوجة): نفس التثبيت داخل وحدة تحكم.
- من الصفر، في PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

خيارات التثبيت: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (مجلد مُعد مسبقاً)،
`/auto` (يبدأ فوراً)، `/quiet` (بلا نافذة: مُثبِّت الطرفية، رمز الخروج
= النتيجة). التشغيل الأول يبني التطبيق على هذا الجهاز، Takes a while؛
التشغيلات التالية تحديث وإصلاح فقط.

## نماذج مجانية، بلا أي إعداد

يأتي التطبيق مع 9router الخاص به. على جهاز لا يحتوي واحداً، يشغّله ZAICODE
بشكل خاص (وضع معزول، المنفذ 20138)، ويملأ **SAIFREN** من طبقات مجانية
بلا مفاتيح، ويجعل `SAIRoute / SAIFREN` نموذج المهام الجديدة، فيحصل أول
مهمة تُكتب في New task على إجابة: بلا مفتاح، بلا حساب، بلا إعداد. تسجيلات الدخول إلى
Claude Code وCodex وAntigravity اختيارية؛ أي تسجيل دخول غير مُعد على الجهاز يظهر كـ
"اختياري، سجّل الدخول في أي وقت" لا كعنصر "يحتاجك".
الدليل: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
يشغّل التطبيق المُحزَّم على ملف تعريف فارغ (HOME وAPPDATA وLOCALAPPDATA خاصة به)
ولا ينجح إلا إذا كان الموجِّه معزولاً، وSAIFREN يجيب على فحص أول رمز،
وأن مهمة في New task قد إجابة.

## التحديثات: أربعة أجزاء، ZAICODE واحد

مساحة العمل (المُشغِّل، المُثبِّت)، والتطبيق، وSAIPEN وSAIMAIL هي أربعة
نسخ مستنسخة. كل جزء يُحدَّث وحده: **Settings -> ZAICODE -> Updates** يسردها
مع إصدارها وcommit الخاص بها، ويحدّث أياً منها يدوياً أو كلها، ويحوي مفتاح
"بمفرده" لكل جزء (مفعّل افتراضياً في ZAICODE مثبَّت، ومعطّل في نسخة المطور).
ZAICODE يفحص بعد دقائق من البدء ثم كل ست ساعات. بعد التحديث يحصل كل جزء على ما
يحتاجه: التطبيق تبعياته (عند تغيّر `pnpm-lock.yaml`) وبناءً جديداً (يُجهَّز أثناء
تشغيل ZAICODE، ويُشغَّل عند البدء التالي)، SAIPEN مُشغِّله، SAIMAIL تثبيت
`.venv` الخاص به، مساحة العمل مُشغِّلاً جذرياً جديداً. أي نسخة على فرع
آخر، أو بعمليات commit محلية، أو بتعديلات سيطمسها التحديث: يُبلَّغ عنها وتُترك
كما هي تماماً.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## ما يفعله

المُثبِّت هو فحوصات Autotroubleshoot التي تُشغَّل بـ "repair" على مجلد فارغ،
بهذا الترتيب. كل خطوة idempotent، فإعادة التشغيل تحدّث التثبيت وتُصلح ما انكسر.

| الفحص | الإصلاح |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | يستخدم نسخة الجهاز إن كانت مناسبة؛ وإلا نسخة خاصة في `.tools\` (MinGit من Git for Windows، وNode.js 24.14.0 من nodejs.org، وPython من حزمة NuGet الخاصة به). بلا صلاحيات مدير. |
| pnpm | pnpm 10.33.2 المثبَّت في `.tools\pnpm10` |
| مساحة عمل ZAICODE | استنساخ فرع `vacterro/zaicode` من `master` (مصدر المُشغِّل والمُثبِّت والتوثيق؛ تُستثنى ذاكرة المطور `.saipen/`؛ الفرع `workspace` حتى 2026-09-27) |
| مصدر تطبيق ZAICODE | استنساخ الفرع `zaicode` في `zcode\` |
| SAIPEN | استنساخ `vacterro/saipen` في `saipen\`؛ يُكتب `bin\saipen.cmd` الخاص به لهذا الاستنساخ وهذا Python |
| SAIMAIL | استنساخ `vacterro/saimail` في `saimail\`، يُثبَّت في `.venv\` |
| saimail-local | عميل سطر الأوامر لـ SAIMAIL، تستخدمه لوحات SAIMAIL في ZAICODE (مُحزَّم منذ SAIMAIL `0.0.2a3`؛ فحص `saimail-cli` يُبلّغ OK) |
| حزمة 9router | `9router` من npm إلى `.tools\router`، محزومة ليعمل SAIFREN بلا أي إعداد (WARN إن تعذّر على npm الوصول إليها) |
| تبعيات التطبيق | `pnpm install --frozen-lockfile` (ومرة أخرى عند تغيّر `pnpm-lock.yaml`) |
| بناء التطبيق | `pnpm bundle:zaicode`؛ أثناء تشغيل ZAICODE يُجهَّز البناء الجديد ويُستبدل عند البدء التالي |
| استبدال البناء المُجهَّز | ينظّف `win-unpacked.previous` المتروك من فشل استبدال بمسار طويل، ويُدخل البناء المنتظراً بينما ZAICODE مغلق |
| المُشغِّل الجذري | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| الاختصارات | `ZAICODE` سطح المكتب وقائمة ابدأ -> `ZAICODE.exe` |
| تسجيلات Claude / Codex | يُبلَّغ عنها فقط: كل تسجيل دخول `~\.claude*` / `~\.codex*` هو محرّك خاص به داخل ZAICODE (A1, A2, C1, ...)؛ أي تسجيل دخول يحتاجك، في المتصفح |

المُشغِّل الجذري يوجّه ZAICODE نحو SAIPEN المثبَّت (`saipen\`)، ويضع
`.tools\` و`.venv\Scripts` في مقدمة PATH الخاص بالتطبيق، فيستخدم التطبيق
ووكلاؤه وعمّاله النسخ المثبَّتة.

## عدة اشتراكات

كل تسجيل دخول لـ Claude Code أو Codex يعيش في مجلده: `~\.claude`،
`~\.claude-account2`، ... و `~\.codex`، `~\.codex-account2`، ... يعثر ZAICODE
عليها كلها. لتجهيز المزيد وقت التثبيت:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

ينشئ المُثبِّت المجلدات ويطبع أمر تسجيل الدخول الدقيق لكل منها
(`$env:CODEX_HOME = '...'; codex login`). الأمر نفسه في ZAICODE: Settings ->
Engines & limits -> إضافة تسجيل دخول آخر.

## التشخيص التلقائي

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

الحالة لكل فحص: OK، FIXED (كان معطوباً، تم إصلاحه)، WARN (يعمل، لكن ينقص شيء
اختياري)، INFO (يحتاجك: تسجيل دخول)، FAIL. السجلات في
`install\logs\`؛ ملخص آخر تثبيت في `install\install-report.json`.
داخل التطبيق: Router -> Autotroubleshoot يُصلح الموجّه قيد التشغيل والمجموعات.

## الخيارات

| المعامل | الافتراضي | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | مكان كل شيء |
| `-ShortcutDir` | Desktop | مكان اختصار ZAICODE |
| `-NoStartMenu`، `-NoShortcut` | | تخطّي تلك الاختصارات |
| `-PortableTools` | | Git / Node.js / Python خاصة حتى لو كانت موجودة على الجهاز |
| `-Launch` | | تشغيل ZAICODE عند الانتهاء |
| `-ZaicodeRepo`، `-SaipenRepo`، `-SaimailRepo` | مستودعات GitHub | مصدر آخر (fork، مسار نسخة محلية) |

## الدليل

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
يفحص تثبيتاً جديداً، يزرع أعطالاً (اختصار ومشغّل محذوفان، مشغّل SAIPEN
يشير إلى Python مفقودة، venv لـ SAIMAIL محذوف، node_modules
مُسجّلة لملف قفل آخر، مجلد بناء متبقٍ أعمق من MAX_PATH)،
يثبت أن التشخيص يُبلّغ عن كل عطل ويُصلحه، ثم يشغّل هدف الاختصار
بحساب معزول ويوقف شجرة العمليات التي بدأها بالضبط.

`install\tests\Test-ZaicodeUpdate.ps1` يبني أربعة مستودعات مؤقتة
على القرص وتثبيتاً لنسخها، ثم يثبت أن أي فحص لا يغيّر شيئاً، وأن جزءاً واحداً
يُحدَّث وحده مع متابعته (مشغّل SAIPEN، المشغّل الجذري)، وأن التعديلات
المحلية المتداخلة والالتزامات المحلية محفوظة، وأن اسم جزء غير معروف
يُرفض. بلا شبكة.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
