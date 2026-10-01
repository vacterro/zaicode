# نقل ZAICODE SAIPEN عبر السحابة

كيف يشغّل هذا الـ checkout وجلسة Claude Code Cloud مساحة عمل SAIPEN واحدة
بموضعية منفّذين مختلفة، وأين الحدّ الفاصل بينهما.

## الشكل

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

فرع واحد يحمل حالة البروتوكول. لا خطوة merge ولا خطوة rebase
ولا فرع محلي ثانٍ يجب مزامنته: أي منفّذ يملك نقطة تحقّق
موثّقة ينفّذ commit وpush، والجهة الأخرى تأخذه بـ fast-forward.

`master` هو التاريخ السابق للنقل والفرع الافتراضي المنشور. لا
يُدفع forcefully من قِبل النقل.

## ما ينتقل وما لا ينتقل

نقطة التحقّق في هذا المستودع تحمل حالة بروتوكول SAIPEN، والمُشغّل
الجذري، والمثبّت، والوثائق، وسكربتات النقل هذه. هذه هي
طبقة مساحة العمل كاملة.

لا تحمل **أي بايت منتج**. `zcode/` مستودع Git منفصل، مُدرج
في `.saipen/source-nested-repos.json` ومُستبعَد من gitignore في هذا الجذر
(`/zcode/`). عمل المنتج يحتاج clone خاص به من `vacterro/zaicode` على الفرع
`zaicode`، وهذا الـ clone كائن ثانٍ مستقل بتاريخه الخاص.

النتيجة يسهل الخطأ فيها: `git status` نظيف في هذا الجذر لا
يقول شيئاً عن عمل منتج غير مُودَع، وfast-forward على `saipen-live` لا
يقول شيئاً عن كود المنتج. افحص `git -C zcode status` صراحةً.

## النصف المحلي

سكربتان، كليهما مملوكتان للمستودع، فتصلهما آلة جديدة من المستودع
بدلاً من الذاكرة:

| File | Role |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | يتحقق، يوفّق الفرع، يثبّت المراقب ويشغّله، يكتب إدخال التشغيل التلقائي، يثبت أن المحلي == البعيد |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | الحلقة: جلب، مقارنة، fast-forward أو push، تسجيل، إيقاف مؤقت؛ ثم مرور المنتج والتحديث الذاتي |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | ذهاب وإياب من منفّذ مستقل，加上 إثبات تعافٍ عند البرودة |
| `tools/saipen-cloud/Test-ProductSync.ps1` | مرور المنتج والتحديث الذاتي على مستودعات Git مؤقتة (بلا شبكة، بلا بعيد حقيقي) |

التثبيت والإصلاح:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

غير متكرر (idempotent). الحالة المحلية للجهاز تعيش في `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (نسخة)، `ZAICODE_cloud-sync.log` (يُدوَّر عند
2 MB إلى `.log.1`)، `ZAICODE_cloud-sync.lock` (نسخة واحدة فقط)،
`ZAICODE_cloud-sync.pid`، وإدخال في مجلد Startup
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

يرفض المُثبّت شجرة متّسخة ولا ينظّفها أبدًا. إذا كان كل مسار متّسخ هو
حالة SAIPEN القياسية تحت `.saipen/`، فيذكر ذلك ويطبع أوامر
نقطة الحفظ بالضبط؛ تلك حالة بروتوكول بلا نقطة حفظ، لا عطل نقل،
ولن يُثبّتها المُثبّت خلف البروتوكول.

## سلوك المراقب

| الحالة | الإجراء |
|-----------|------|
| نظيف، المحلي سلف للبعيد | `git merge --ff-only` |
| نظيف، البعيد سلف للمحلي | `git push` |
| متّسخ | إيقاف مؤقت؛ ولا حتى جلب |
| على فرع آخر | إيقاف مؤقت |
| كلاهما تقدّم، بلا سلف مشترك | إيقاف مؤقت، تسجيل معرّفي الكوميت للاثنين، لا دمج |
| فشل الجلب أو الشبكة | تسجيل تدهور، إعادة المحاولة في الدورة التالية |
| دمج/rebase/cherry-pick جارٍ | إيقاف مؤقت |

ممنوع أبدًا: push قسري، hard reset، stash، clean، تبديل إلى فرع غريب،
كوميت، أو إيقاف باسم العملية. المُثبّت يوقف المراقب فقط عبر
pid سجّله في ملف pid خاص به.

الشجرة المتّسخة لا تكلّف شيئًا، لأن المراقب يفحص الاتّساخ قبل الجلب.
لذلك لا تُجري نسخة خاملة أي نداءات شبكة إطلاقًا.

### مرور المنتج (T-90)

`zcode/` مستودع مستقل بذاته، لذا لا يحرّك الجدول أعلاه كود المنتج
مطلقًا. بعده، تعالج نفس الدورة نسخة المنتج (`-ProductRepo`،
الافتراضي `<repo>\zcode`؛ الفرع `-ProductBranch`، الافتراضي `zaicode`). يعمل
مرور المنتج سواء كانت الشجرة الخارجية متّسخة أو لا. وهو يسحب فقط دائمًا.

| الحالة | الإجراء |
|-----------|------|
| البعيد متقدّم، ولا ملف قادم متسخ هنا | `git merge --ff-only`؛ عمل المنتج غير الملتزم يبقى كما هو |
| البعيد متقدّم، وأحد الملفات القادمة متسخ هنا | مُعلَّق: سجّل الملفات، لا تدمج شيئًا |
| المحلّي متقدّم | سجّل؛ **لم يُدفع أبدًا** (المنتج يُنشر عبر SAIPEN SHIP) |
| تفرّع | أوقف مؤقتًا، سجّل المعرّفين، لا تدمج شيئًا |
| فرع آخر، أو عملية git جارية، أو فشل الجلب | أوقف مؤقتًا |
| لا خروج `zcode/`، أو `-NoProduct` | متخطّى |

يرفض git من تلقاء نفسه التقدّم السريع الذي يطمس تغييرًا محلّيًا، لذا
فحص HELD حارس أسبق وأوضح، لا الحارس الوحيد. التقدّم السريع
للمنتج لا يعيد بناء شيء: للاختبار، شغّل `pnpm bundle:zaicode` (أو
المعاينة التجريبية).

### التحديث الذاتي (T-90)

يعمل المراقب كنسخة تحت `%APPDATA%\SAIPEN`، لذا لم يعمل مراقب أحدث
في المستودع إطلاقًا دون إعادة تثبيت. في وضع الحلقة يقارن
ملفه الآن بالنسخة الملتزمة في المستودع في كل دورة. يثبّت
تلك النسخة فوق نفسه ويعيد التشغيل مرة واحدة بالضبط، بنفس
المعطيات، فقط حين تتحقّق كل هذه الشروط:

- الملفان مختلفان؛
- نسخة المستودع بلا تعديلات غير ملتزمة؛
- نسخة المستودع تُحلَّل بلا أخطاء.

تُرفض النسخة التي لا تُحلَّل وتُسجَّل، ويستمر المراقب
قيد التشغيل.

المراقبون المثبَّتون قبل T-90 ينقصهم مرور المنتج والتحديث الذاتي.
أعد تشغيل `Install-SaipenLiveSync.ps1` مرة واحدة على هذه الآلة؛ بعدها
يحدّث المراقب نفسه.

## النصف السحابي

`CLAUDE.md` في الجذر هو قاعدة الدخول، و
`.claude/skills/saipen/SKILL.md` هو إجراء التنفيذ. تجلب المهارة
نواة SAIPEN من `github.com/vacterro/saipen` وتشغّلها عبر
سطح المحرّك المُعلَن `tools/saipen.py`. النواة مثبَّتة بالالتزام
(`3088eff`)، لا بالوسم. الوسم `v8.0.1` نواة أقدم بـ
نفس `VERSION`؛ وآليّته `validate` تغيّر الحالة، ومدقّقها يرفض هذه اللوحة.

`STATE.saipen_home` يسجّل مسار نواة آخر منفّذ سوّر
نقطة تفتيش. في السحابة، أول `saipen continue` على نواة `3088eff` يُقاربها
مع النواة قيد التشغيل كـ `DEC` واحد مُدوَّن في المجلة (E-1410). على
آلة المشغّل يصل المؤشّر ميتًا بالطريقة نفسها. النواة ذات
التقارب التلقائي تُصلحه عند `continue`؛ وإلا فشغّل
`saipen rebind-home --auto`.

**رحلة العودة مُلاحَظة.** E-1562 (السحابة) قرّب المؤشر إلى `/home/user/zaicode/.claude/saipen-protocol`؛ E-1571 (جهاز المشغّل) قرّبه مباشرةً إلى `V:/.../_SAIPEN`، تلقائياً، دون أي `rebind-home` يدوي. الاتجاهان هو التقارب التلقائي نفسه، لذا توقّع `saipen_home` `DEC` واحداً لكل تبديل موقع، واعتبره ضجيجاً متوقعاً لا عيباً. يبقى ضجيجاً حتى ينقل P1-2 (`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) المؤشر خارج حالة الإصدارات؛ لا تنفّذ P1-2 كأثر جانبي لمجرد ملاحظته. لا تحرّر المؤشر يدوياً أبداً.

قد يشير `STATE.saipen_home` إلى **نسخة تطوير** للنواة تتقدّم على التثبيت (pin)، لا إلى نسخة `3088eff` نظيفة — وعلى جهاز المشغّل هو فرع `accepted-debt-rebind` مع عمل غير مُودَع. النواة غير الموجودة عند الالتزام المثبَّت ليست خاطئة تلقائياً، لكنها ليست مصدراً نظيفاً (clean-room) either، لذا يسري عليهما قاعدة عقد الصوت أدناه بكامل قوتها. لا تُودِع أو تُخزِّن (stash) أو تُعيد ضبط (reset) أو تُبدّل نسخة العمل (checkout) أو تنظّف أي شيء في نسخة تطوير كهذه؛ الاستعادة المستهدفة لملف واحد `saipen/STYLE.md` هي الاستثناء المسموح الوحيد، وعند طلب المشغّل له فقط.

### ملف STYLE.md ليس إعداداً محلياً

يجب أن يكون `saipen/STYLE.md` **مطابقاً بايت ببايت لملف النواة المثبَّت** على كل جهاز، في كل نسخة، بلا استثناءات وبلا تحريرات محلية. توجد أكثر من نسخة على جهاز المشغّل:

- نسخة kernel عند `STATE.saipen_home` (نسخة Git، على جهاز
  المشغّل نسخة تطوير);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`، تُملأ بواسطة
  المهمة المجدولة `saipen-inject` (`bootstrap/schedule-run.ps1`). وهي **ليست
  مستودع Git**، لذا لا يمكن لـ `git checkout` إصلاحها — إعادة مزامنة عبر
  المُحقن، أو كتابة مباشرة للمحتوى المنشور، هما المسار الوحيد.

الرمز `style_contract` في `.saipen/STATE.md` هو بصمة لنص ذلك الملف (`tools/validate.py`، `style_contract_token`: تطبيع CRLF، مع استثناء سطر `style_contract:`). حرّر `reply_language` في نسخة واحدة فيتحرّك الرمز؛ أمّا النسخة الأخرى والسحابة، فتجلبان النواة المنشورة فتحتفظان بالرمز المنشور، ويُرفَض كل كتابة CLI على الجانب غير المتطابق مع `style_contract ... does not match the installed STYLE.md marker`.
هذه هي المشكلة كاملة: الجانب المحلي يكتب حالة لا تستطيع السحابة كتابتها.

**تغيير لغة الرد هو التزام في النواة مع إعادة تثبيت (repin)**، وليس تحريراً محلياً. غيّره في مستودع النواة، وانشره، وأعد تثبيت الالتزام في SKILL.md، وحدّث `STATE.style_contract` عبر `saipen recover`. التحرير المحلي لـ `STYLE.md` يفك التزام كل جهاز ليس الجهاز الذي أجراه.

فخّ يستحق الذكر: `bin/saipen` المنشور مُشال (shim) مرتبط بجهاز واحد يثبّت مسارات مطلقة لمُفسّر واحد ونسخة عمل واحدة. يعمل على جهاز واحد بالضبط. على السحابة استخدم `python3 tools/saipen.py`.

الاختصارات: `cc` يُكمل العمل الحالي؛ `cc all <text>` يبتلع الرسالة كاملةً كمصدر/appends ويُكمل كل عمل مؤهَّل. لا يطلب أيٌّ منهما تأكيداً روتينياً.

## تصنيف القدرات

**AVAILABLE_IN_CLOUD** — حالة البروتوكول وطبقة مساحة العمل. قراءة وكتابة `.saipen/`، المُشغِّل (`tools/launcher/ZaicodeLauncher.cs`)، المُثبِّت تحت `install/`، `docs/`، `CLAUDE.md`، `.claude/skills/`، وسكربتات النقل. Git read وcommit وpush وfetch على `saipen-live`. أي بوابة تكون تأكيد ملف أو مراجعة diff أو فحص نصي.

**LOCAL_WINDOWS_ONLY** — البوابات التي تحتاج هذه الآلة تحديداً.

| البوابة | السبب |
|------|-----|
| `tools\launcher\build.cmd` | يترجم `ZaicodeLauncher.cs` مع .NET Framework `csc`؛ لا وجود لـ Windows SDK على صورة سحابية |
| Electron E2E مُحزَّم (`zcode` سطح مكتب، Solo ← الطابور ← الإرسال) | يتطلب جلسة سطح مكتب وملف مزوّد مُهيّأ مسبقًا |
| 9router الحيّ | خدمة Windows على هذا الجهاز |
| النقر التفاعلي على سطح المكتب | إنسان وشاشة |
| حالات وقت التشغيل الخاصة بالمراقب | المراقب لا يعمل إلا على الجهاز الحاوي لنسخة العمل |

تُسجَّل هذه كحدود قبول محلية فقط. لا تُبلَّغ كناجحة أبداً لمجرد أن الـ diff بدا صحيحاً.

**SAFE_TO_DEFER** — طبقة المنتج. يمكن لجلسة سحابية أن تنسخ
`vacterro/zaicode` فرع `zaicode` وتعمل فيه. عمل طبقة مساحة العمل لا يتطلب عملاً في المنتج، لكنه يتطلب النسخ:
`.saipen/source-nested-repos.json` يعلن `zcode/`، وبدونه يفشل
المُتحقِّق بـ `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. بوابات `pnpm` تتطلب pnpm 10.33.2 المثبَّت
ومساحة عمل مُجهَّزة. `pnpm bootstrap` على صورة سحابية جديدة هي الطريقة
الموثَّقة للدخول، و`package.json` في المنتج يعلنها بالفعل.

السحابة لا تستطيع التحقق إلا من بايتات المنتج الموجودة على `origin/zaicode`. أي فرق في المنتج موجود فقط في نسخة `zcode/` لدى المشغِّل يبقى غير مرئي هنا، لذا تكون كل بوابة منتج له NOT RUN في السحابة، مهما كانت nature البوابة. T-84 أول حالة (E-1411): كان إصلاحه محلياً فقط بينما `origin/zaicode` ما زال يحمل الكود قبل الإصلاح.

**UNSAFE_TO_EMULATE** — أي شيء يجعل بوابة محلية فقط تبدو خضراء. لا تُهمِل بناء المُشغِّل، ولا تُزيّف تشغيل تطبيق مُجمَّع، ولا تُعيد عرض نتيجة `pnpm verify:pre-push` مُسجَّلة كأنها حدثت للتو، ولا تحوّل «الكود يبدو صحيحاً» إلى سطر PASS في `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — مطابقة تعتمد على مكان وجود النسخة المحلية. على النواة `3088eff` يُبلِغ مُحقِّق السحابة عن `closure-evidence` كفاشلة (T-47، T-62، T-76، T-78 وقت كتابة هذا) بينما لا تظهر على آلة المشغِّل.

تنقل النواة أي حدث LOG يتجاوز 1024 بايت إلى ملف جانبي `.saipen/recovery/log-detail/`. وعند القراءة تستعيد ذلك الملف الجانبي فقط عندما يساوي المسار المطلق للنسخة المحلية المسار الذي كُتب منه. لذلك لا يُقرأ حكم VERIFY طويل مكتوب على Windows في السحابة، والعكس صحيح أيضاً.

العيب في النواة ومسجَّل كـ P1-1 في `docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. حتى يصل:

- انقل حكم السحابة وصنّفه على هذا الحدّ، تذكرة بتذكرة
  (`SKILL.md` § 6 يحتوي الفحص);
- لا تُعِد كتابة الـsidecars، ولا تُعِد التحقق لمجرد أخضر، ولا تُرقِّع نسخة الـkernel
  ;
- أبقِ أحداث LOG دون 1024 بايت على الجهتين.

حвяز المسار نفسه للآلة يوقف العمل أيضًا. خط أساس الدَّين قبل BUILD
يُلتقط أول مرة تدخل فيها تذكرة حالة BUILD، ويُفحص من جديد عند كل دخول
لاحق. لذلك التذكرة التي دخلت BUILD أولًا على جهاز المشغّل لا يمكنها
الدخول إلى BUILD في السحابة: يُرفض الانتقال بـ`DEBT_SNAPSHOT_FOREIGN_PROJECT`. وT-84 هي
الحالة المسجّلة: التُقط DEBT-000079 عند E-1377 ورُفض الانتقال عند E-1446.
اترك هذه التذكرة للآلة التي التقطت خط أساسها.

## التفرّع

إذا توقّف المحلي والبعيد عن مشاركة سلف، توقّف الـwatcher. هو
لا يدمج ولا يعيد الأساس ولا يفرض. يُدخَل معرّفا الالتزام في السجل،
ويُصلَح `git log --left-right --cherry-pick <branch>...origin/<branch>` يدويًا، وتُحفظ
النتيجة كنقطة تفتيش كأي تغيير آخر.

## الإجراء السحابي بالضبط

### سكربت تهيئة البيئة (مرة واحدة، في إعدادات البيئة السحابية)

قائمة البيئة السحابية في شريط عنوان الجلسة -> Edit -> Setup script. يعمل
قبل كل جلسة جديدة، فتبدأ كل جلسة وسلسلة أدوات المنتج جاهزة:

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

### موجّه كل جلسة جديدة

ابدأ الجلسة على المستودع `vacterro/zaicode`، الفرع `saipen-live`، وتأكد
أن وكيل جهاز المشغّل لا يكتب في الوقت نفسه.
استبدل السطر الأخير بـ`cc all <new list>` لتسليم عمل جديد.

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

على جهاز المشغّل يُسرِّع الـwatcher ‏`zcode` من
`origin/zaicode`؛ يبنيه `REBUILD.cmd` (أو `REBUILD_fast.lnk`)، وعند
التشغيل التالي لـ ZAICODE يُبدَّل البناء الجديد مكانه.
<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
