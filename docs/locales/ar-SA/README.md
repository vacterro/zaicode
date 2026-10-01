# ZAICODE

**v0.0.2**

<div align="center">
  <img src="https://raw.githubusercontent.com/vacterro/zaicode/zaicode/packages/ui/src/assets/zaicode-working.png" alt="ZAICODE" width="96" height="96" />
</div>
<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.2-c9a227" alt="version 0.0.2" />
  <img src="https://img.shields.io/badge/platform-Windows-3b3527" alt="Windows" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-3b3527" alt="Apache-2.0" />
</p>
<p align="center">
  ZAICODE · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md">ZCode (简体中文)</a> · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.en.md">ZCode (English)</a>
</p>

<img width="1440" height="860" alt="ZAICODE hero — Do your best." src="../../screenshots/01-do-your-best.png" />

ZAICODE هي ورشة عمل للمشغّين لتشغيل عدة وكلاء برمجة بالذكاء الاصطناعي في وقت واحد
عبر مشاريع كثيرة، دون متابعتهم باستمرار. إنها نسخة معدّلة من
[ZCode](https://github.com/zai-org/ZCode) (تطبيق سطح مكتب، واجهة متصفح، ووكيل
CLI) مع طبقة منتج فوقه: كل مشروع يُدار عبر
بروتوكول [SAIPEN](https://github.com/vacterro/saipen)، ويبدأ العمل ويُستأنف
ويُجدوَل من نافذة واحدة، بينما تعمل CLIs للاشتراكات التي تدفع
لها بالفعل (Claude Code، Codex، Antigravity) كعمالاء مرافقين إلى جانب
الوكلاء داخل التطبيق.

**0.0.1** هي أول لقطة موسومة: بناء شخصي، مُعتمد على Windows،
يُستخدم يوميًا.

## التثبيت بنقرة واحدة

1. نزّل **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. انقر عليه مرتين واضغط **INSTALL**.

هذا كل شيء. يوفّر المثبّت ما ينقص الجهاز (Git، Node.js، Python، كنسخ
خاصة: دون صلاحيات مدير)، ويجلب ZAICODE وSAIPEN وSAIMAIL من GitHub،
ويبني التطبيق على الجهاز ويضع اختصار ZAICODE على سطح المكتب. يستغرق
التشغيل الأول 15-30 دقيقة؛ وتعرض النافذة كل خطوة.

النماذج المجانية تعمل فورًا: يشغّل ZAICODE موجّهه الخاص ويملأ مجمع **SAIFREN**
من طبقات مجانية بلا مفاتيح، فتُجيب أي مهمة تُكتب في New task دون
مفتاح ولا حساب ولا إعداد. اشتراكات Claude Code وCodex وAntigravity
اختيارية ويمكن تسجيل الدخول بها في أي وقت.

**كلٌّ واحد، أربعة أجزاء.** مساحة العمل (المشغّل، والمثبّت)، والتطبيق، وSAIPEN
وSAIMAIL هي أربعة مستودعات. كل منها يتحدّث وحده: *Settings -> ZAICODE ->
Updates* يعرض كل جزء، ويحدّثه يدويًا أو تلقائيًا (فحص بعد بضع
دقائق من البدء وكل ست ساعات). يُحضَّر بناء جديد للتطبيق أثناء تشغيل ZAICODE
ويبدأ مع التشغيل التالي؛ ولا تُطمس تعديلاتك في أي نسخة استُنسخت.
من طرفية: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
الفحص التلقائي للأعطال: `install\Doctor.cmd`. التفاصيل: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## جولة في الواجهة

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

## ما تضيفه إلى ZCode

- **المشاريع ذات جلسة MAIN.** كل مشروع له جلسة MAIN واحدة (START،
  `/goal cc all`) وجلسات مساعدة (subSaipens: WIKI، TEST، AUDIT، …). عرض
  الشريط الجانبي الافتراضي يعرض صف المشروع كـ MAIN له؛ ▶ يُكمل MAIN
  بدل فتح جلسة أخرى. CONTINUE ALL وDONE وCLEAR ALL DONE
  تمسح كل المشاريع؛ الجلسة المنقطعة منتصف عمل تظهر INTERRUPTED لا DONE.
- **الأمان عند الانهيار.** الجلسات التي قطعها عمودية ميتة والأهداف النشطة
  تستمر ذاتيًا بعد إعادة التشغيل؛ العمال الجاري تشغيلهم يُعاد تشغيلهم. الوكلاء
  داخل ZAICODE لا يستطيعون قتل ZAICODE باسم العملية.
- **العمال.** CLIs للاشتراكات تعمل في طرفيات مثبتة على أي حافة من
  النافذة (أو في نوافذها الخاصة القابلة للSnap). أسئلة "Trust this folder?"
  الأولى يُجاب عنها؛ والعامل الذي يبلغ حد الاستخدام يُبلَّغ عنه،
  وبالإعداد يُغلق أو يُعاد تشغيله بعد إعادة التعيين.
- **الحدود وإعادة التعيين.** مقاييس الحصة لكل حساب ومجمع، ومؤقّت في شريط
  العنوان لأقرب إعادة تعيين مع القائمة الكاملة لإعادة التعيينات القادمة عند
  التمرير.
- **SCHEDULER.** موجّهات تبدأ ذاتيًا: في وقت محدد، يوميًا، كل N
  دقيقة أو عند امتلاء نافذة حصة؛ في مشروع واحد أو قسم كامل من الشريط الجانبي،
  المشاريع الأسوأ (الأكثر انسدادًا / تذاكر SAIPEN المفتوحة) أولًا. الشروط
  يمكنها إيقاف الأعمال التح rentersية (جلسات المجمعات المجانية، العمال الأضعف)
  أولًا، أو العمل فقط على مشاريع خاملة، أو متابعة الجلسات المعلَّمة فقط.
  لا حد عملي لطول الموجّهات.
- **التوجيه.** 9router مضمّن (MIT) يوفّر مجمعات بلا إعداد: SAIFREN
  (الطبقات المجانية بلا مفتاح) وSAIOPP (اشتراكاتك).
- **SAIHOME، المؤقتات، الأصوات، الإبراز.** صفحة مشغّل بإحصاءات، مؤقتات
  وأجراس بنمط FastPrompter، أصوات لكل إجراء وواجهة Win95 داكنة ذهبية
  دقيقة البكسل.


## البناء

المتطلبات: Windows 10/11، Git، Node.js **24.14.0**، pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) هو المصدر الموثوق).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

التطبيق المحزوم يبدأ دائمًا في وضع ZAICODE. أثناء تشغيل نسخة ZAICODE أقدم،
 يحزم البناء الجديد في `packages/desktop/dist-next`؛ ومشغّل الجذر
(فرع `master`، `tools/launcher`) يستبدله عند التشغيل التالي.
 الصيغة المتجهية من Verdana المستخدمة في الواجهة ليست جزءًا من هذا المستودع؛
 وبدونها ترجع الواجهة إلى Verdana النظامي.

الفحوص: `pnpm typecheck`، `pnpm lint`، واختبارات ZAICODE، مثلًا
`node --import tsx --test test/zaicode*.test.ts` من `packages/ui`.

## بنية المستودع

| الفرع      | المحتويات                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | مساحة العمل المرجعية: المشغّل، المُثبِّت (`install/`)، توثيق المنتج (`UI.md`، `docs/`)، حالة SAIPEN وCHANGELOG |
| `zaicode`   | مصدر التطبيق المرجعي: تاريخ ZCode الأصلي زائد طبقة منتج ZAICODE المستخدمة للبناء والتحديث |

قد تظهر مراجع قديمة أو أُنشئت آليًا مؤقتًا، لكنها ليست
فروع منتج مرجعية. عمل مساحة العمل الجديد يكون على `master`؛ وعمل مصدر
التطبيق يكون على `zaicode`.

يقع كود التطبيق المملوك لـ ZAICODE غالبًا في `packages/ui/src/zaicode/`،
`packages/shared/src/zaicode-*.ts`، `packages/services/src/zaicode/` و
`packages/desktop/src/main/zaicode*.ts` على الفرع `zaicode`. توثيق مساحة العمل وأدوات
المشغّل/update تكون على `master`.

## المصدر الأصلي والترخيص

ZAICODE مشتق من ZCode عن طريق Z.ai وموزَّع تحت نفس
[رخصة Apache 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE)؛ إشعارات المصدر الأصلي محفوظة في
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) و[THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
عدّل الملفات مؤلف ZAICODE. ZAICODE مشروع مستقل،
غير تابع لـ Z.ai ولا معتمد منه. README الأصلي لـ ZCode محفوظ في
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) و[README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## شبكة المشاريع

هذا المستودع جزء من منظومة مشروع **SAIPEN / vacterro** الأوسع.

[**مركز المؤلف**](https://github.com/vacterro) · [**مقر SAIPEN**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**مجتمع SAIPEN**](https://discord.gg/SEYaYkuVgN)

لأخطاء قابلة لإعادة الإنتاج وطلبات ميزات دائمة، استخدم [issues GitHub لهذا المستودع](https://github.com/vacterro/zaicode/issues). استخدم Discord للنقاش السريع ولقطات الشاشة والملاحظات عبر المشاريع.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
