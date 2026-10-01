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

ZAICODE הוא סביבת עבודה למפעילים, להרצת סוכני קוד AI רבים בבת אחת
על פני רבים מהפרויקטים, בלי לשמור עליהם. זו בנייה מותקנת של
[ZCode](https://github.com/zai-org/ZCode) (אפליקציית דסקטופ, ממשק דפדפן ו
CLI לסוכנים) עם שכבת מוצר מעליה: כל פרויקט מונע על ידי
פרוטוקול [SAIPEN](https://github.com/vacterro/saipen), העבודה מתחילה, נמשכת
ומתוזמנת מחלון אחד, וה-CLI של המנויים שכבר יש לך
(Claude Code, Codex, Antigravity) רצים כעובדים מעוגנים לצד הסוכנים באפליקציה.

**0.0.1** הוא Snapshot ראשון מתויג: בנייה אישית, ממוקדת ב-Windows, שבשימוש
יומי.

## התקנה בקליק אחד

1. הורד את **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. לחיצה כפולה עליו ולחיצה על **INSTALL**.

זהו הכל. ההתקנה מביאה למכונה את מה שחסר לה (Git, Node.js, Python, כעות פרטיות:
בלי הרשאות מנהל), מושכת את ZAICODE, SAIPEN ו-SAIMAIL מ-GitHub,
בונה את האפליקציה על המכונה וממקם קיצור דרך ל-ZAICODE שולחן העבודה. ההרצה
הראשונה אורכת 15-30 דקות; החלון מציג כל שלב.

מודלים חינמיים עובדים מיד: ZAICODE מפעיל נתב משלו וממלא את מאגר **SAIFREN**
משכבות חינמיות ללא מפתח, כך שמשימה שמוקלדת ב-New task מקבלת תשובה בלי
מפתח, בלי חשבון ובלי הגדרה. מנויי Claude Code, Codex ו-Antigravity הם
אופציונליים ואפשר להתחבר איתם בכל רגע.

**שלם אחד, ארבעה חלקים.** סביבת העבודה (מפעיל, מתקין), האפליקציה, SAIPEN ו
SAIMAIL הם ארבעה מאגרים. כל אחד מתעדכן בנפרד: *Settings -> ZAICODE ->
Updates* מציג את כל החלקים, מעדכן ידנית או אוטומטית (בדיקה כמה דקות
אחרי ההפעלה וכל שש שעות). בנייה חדשה של האפליקציה מוכנה בזמן ש-ZAICODE רץ
ומתחילה בהפעלה הבאה; העריכות שלך ב-clone לעולם לא נדרסות.
מהטרמינל: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
אבחון אוטומטי: `install\Doctor.cmd`. פירוט: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## סיור בממשק

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

## מה מוסיף ל-ZCode

- **פרויקטים עם סשן MAIN.** לכל פרויקט סשן MAIN אחד (START,
  `/goal cc all`) וסשני עזר (subSaipens: WIKI, TEST, AUDIT, …). תצוגת
  סרגל הצד כברירת מחדל מציגה את שורת הפרויקט כ-MAIN שלו; ▶ ממשיך את
  MAIN במקום לפתוח סשן נוסף. CONTINUE ALL, DONE ו-CLEAR ALL DONE
  מנקים את כל הפרויקטים; סשן שנותק באמצע תור מוצג כ-INTERRUPTED, לעולם לא DONE.
- **בטיחות קריסה.** סשנים שתהליך מת ניתק ומשימות שעדיין פעילות
  ממשיכים מעצמם אחרי הפעלה מחדש; עובדים רצים מופעלים שוב. סוכנים
  בתוך ZAICODE אינם יכולים להרוג את ZAICODE לפי שם תהליך.
- **עובדים.** CLIs של המנוי מרצים בטרמינלים העוגנים לכל צד של החלון
  (או בחלונות נפרדים שנצמדים). שאלות "לסמוך בתיקייה זו?" בהרצה ראשונה
  נענות; עובד שהגיע למגבלת השימוש מדווח ו, לפי הגדרה, נסגר או מופעל
  מחדש לאחר האיפוס.
- **מגבלות ואיפוסים.** מדי מכסה לכל חשבון ולכל מאגר, וטיימר בסרגל הכותרת
  עד האיפוס הקרוב, עם הרשימה המלאה של האיפוסים הקרובים בריח עכבר.
- **SCHEDULER.** פרומפטים שמתחילים מעצמם: בשעה מסוימת, יומית, כל N
  דקות או כאשר חלון מכסה מתמלא; בפרויקט אחד או בקטע שלם של סרגל
  הצד, פרויקטים גרועים ביותר (הכי חסומים / רליונטיות SAIPEN פתוחות) ראשונים.
  תנאים יכולים לעצור קודם עבודת קצרה-קצץ (סשני מאגר חינמי, עובדים חלשים
  יותר), לרוץ רק בפרויקטים סרקים, או להמשיך רק סשנים מסומנים. אין לפרומפטים
  מגבלת אורך מעשית.
- **ניתוב.** 9router מצורף (MIT) נותן מאגרים ללא הגדרה: SAIFREN
  (שכבות חינמיות ללא מפתח) ו-SAIOPP (המנויים שלך).
- **SAIHOME, טיימרים, צלילים, הדגשות.** דף בית למפעיל עם סטטיסטיקה,
  טיימרים ואזעקות בסגנון FastPrompter, צלילים לכל פעולה וממשק
  זהוב כהה בסגנון Win95, חד ומדויק בפיקסלים.

- **Crash safety.** Sessions a dead process cut off and goals still active
  continue by themselves after a restart; running workers start again. Agents
  inside ZAICODE cannot kill ZAICODE by process name.
- **Workers.** Subscription CLIs run in terminals docked to any edge of the
  window (or in their own snapping windows). First-run "Trust this folder?"
  questions are answered; a worker that hits its usage limit is reported and,
  by setting, closed or restarted after the reset.
- **Limits and resets.** Quota meters per account and pool, a title-bar timer
  for the nearest reset with the full list of coming resets on hover.
- **SCHEDULER.** Prompts that start by themselves: at a time, daily, every N
  minutes or when a quota window refills; in one project or a whole sidebar
  section, worst projects (most blocked / open SAIPEN tickets) first. Conditions
  can stop stopgap work (free-pool sessions, weaker workers) first, run only on
  idle projects, or continue only marked sessions. Prompts have no practical
  length limit.
- **Routing.** A bundled 9router (MIT) gives zero-setup pools: SAIFREN
  (keyless free tiers) and SAIOPP (your subscriptions).
- **SAIHOME, timers, sounds, highlights.** An operator home with statistics,
  FastPrompter-style timers and alarms, per-action sounds and a Win95 dark
  golden, pixel-crisp interface.

דרישות: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) הוא מקור האמת).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

האפליקציה הארוזה תמיד מופעלת במצב ZAICODE. בזמן ש-ZAICODE ישן רץ,
ה-bundler מכין את הגרסה החדשה ב-`packages/desktop/dist-next`; ה-launcher הראשי (branch `master`, `tools/launcher`) מחליף אותה בהפעלה הבאה.
גרסת Verdana החדה (bitmap) שבה הממשק משתמש אינה חלק ממאגר זה;
בלעדיה הממשק נופל חזרה ל-Verdana של המערכת.

בדיקות: `pnpm typecheck`, `pnpm lint`, ובדיקות ZAICODE, לדוגמה
`node --import tsx --test test/zaicode*.test.ts` מתוך `packages/ui`.

## מבנה המאגר

| Branch      | תוכן                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | סביבת העבודה הקנונית: launcher, installer (`install/`), תיעוד מוצר (`UI.md`, `docs/`), מצב SAIPEN ו-CHANGELOG |
| `zaicode`   | קוד האפליקציה הקנוני: היסטוריית ZCode מהמקור + שכבת המוצר ZAICODE שמשמשת לבניות ולעדכונים |

ייתכן ש-refs ישנים או שנוצרו ע"י אוטומציה עדיין מופיעים זמנית, אך אינם
branch-ים קנוניים של המוצר. עבודת סביבת עבודה חדשה שייכת ל-`master`; עבודת קוד
האפליקציה שייכת ל-`zaicode`.

קוד האפליקציה בבעלות ZAICODE נמצא בעיקר ב-`packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` וב-
`packages/desktop/src/main/zaicode*.ts` על branch `zaicode`. התיעוד של סביבת העבודה
וה-launcher/update tooling נמצאים ב-`master`.

## מקור ורישיון

ZAICODE נגזר מ-ZCode של Z.ai ומופץ תחת אותה
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); התראות upstream נשמרות ב
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) וב-[THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
קבצים שונו על ידי מחבר ZAICODE. ZAICODE הוא פרויקט עצמאי,
ללא קשר ל-Z.ai וללא אישור ממנו. README המקורי של ZCode נשמר ב
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) וב-[README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## רשת הפרויקט

מאגר זה הוא חלק מאקוסיסטמת הפרויקטים הרחבה יותר **SAIPEN / vacterro**.

[**מרכז המחבר**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**קהילת SAIPEN**](https://discord.gg/SEYaYkuVgN)

לדיווחי באגים לשחזור ולבקשות תכונות עתידניות, השתמשו ב-[GitHub Issues של מאגר זה](https://github.com/vacterro/zaicode/issues). השתמשו ב-Discord לדיון מהיר, צילומי מסך ומשוב חוצה-פרויקטים.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
