# התקנת ZAICODE

ZAICODE הוא שלושה פרויקטים שעובדים כשלם אחד: אפליקציית ZAICODE,‏ SAIPEN (הפרוטוקול שמשמר את עבודת הסוכנים על מסלול) ו-SAIMAIL (הדואר שהסוכנים משתמשים בו כדי להודיע זה לזה). התקנה ידנית פירושה שלושה clones,‏ סביבת Node.js,‏ סביבת Python ו-build. מתקין הכול: הריצו אותו, המתינו, וקיצור דרך ל-ZAICODE יופיע שולחן העבודה.

## קליק אחד

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  הורידו, לחלוץ פעמיים, לחצו **INSTALL**. החלון (זהב על רקע כהה, דגלן SAIPEN)
  מציג כל שלב בזמן הריצה, את הזמן שחלף ואת היומן לפי הצורך; בסיום
  **START ZAICODE**, או **TRY AGAIN** / **Autotroubleshoot**
  / **Open log** אם שלב לא הושלם. כשמפנים אותו לתיקיית ZAICODE
  קיימת הכפתור נקרא **UPDATE**: אותה ריצה גם מעדכנת וגם מתקנת. קובץ
  ה-exe נושא את סקריפטי ההתקנה ואינו זקוק לדברים לידו; הוא נבנה
  על ידי `install\setup\build.cmd` (מהדר ה-.NET Framework שיש לכל Windows 10/11).
- `install\Setup-ZAICODE.cmd` (לחיצה כפולה): אותה התקנה בקונסולה.
- מאפס, ב-PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

אפשרויות התקנה: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (תיקיית preset),
`/auto` (מתחיל מיד), `/quiet` (ללא חלון: מתקין קונסולה, קוד יציאה
= תוצאה). ההרצה הראשונה בונה את האפליקציה במכונה הזו, לוקחת זמן;
הרצות הבאות רק מעדכנות ומתקנות.

## מודלים חינמיים, שום דבר להגדיר

לאפליקציה מגיעה עם 9router משלה. במכונה בלי 9router, ZAICODE מריץ אותו פרטית (מצב מבודד, פורט 20138), ממלא את **SAIFREN** משכבות חינמיות ללא מפתח והופך את `SAIRoute / SAIFREN` למודל של משימות חדשות, כך שמשימה ראשונה שמקלידים ב"משימה חדשה" מקבלת תשובה: בלי מפתח, בלי חשבון, בלי הגדרות. התחברויות Claude Code, Codex ו-Antigravity אופציונליות; התחברות שלא הוגדרה מעולם במכונה מוצגת כ"אופציונלי, התחבר בכל עת", לא כפריט "צריך אותך". הוכחה: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
מפעיל את האפליקציה הארוזה על פרופיל ריק (HOME, APPDATA ו-LOCALAPPDATA משלו) ועובר רק כשהנתב מבודד, SAIFREN עונה על בדיקת האסימון הראשון ומשימה ב"משימה חדשה" מקבלת תשובה.

## עדכונים: ארבעה חלקים, ZAICODE אחד

ה-workspace (מפעיל, מתקין), האפליקציה, SAIPEN ו-SAIMAIL הם ארבעה clone. כל אחד מתעדכן בנפרד: **הגדרות -> ZAICODE -> עדכונים** מציג אותם עם הגרסה וה-commit שלהם, מעדכן ידנית אחד אחד או את כולם, ולכל חלק יש מתג "בעצמו" (דלוק כברירת מחדל ב-ZAICODE מותקן, כבוי ב-checkout של מפתח). ZAICODE בודק כמה דקות אחרי ההפעלה ואז כל שש שעות. אחרי עדכון כל חלק מקבל את מה שנדרש לו: האפליקציה את התלויות שלה (כש-`pnpm-lock.yaml` השתנה) ו-build חדש (נדרג בזמן ש-ZAICODE רץ, נפעל בהפעלה הבאה), SAIPEN את המפעיל שלו, SAIMAIL את התקנת `.venv` שלו, ה-workspace מפעיל root חדש. clone על ענף אחר, עם commits מקומיים או עם עריכות שהעדכון היה ידרוס, מדווח ונשאר בדיוק כפי שהוא.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## מה זה עושה

המתקין הוא בדיקות Autotroubleshoot שרצות עם "repair" על תיקייה ריקה, בסדר הזה. כל שלב אידמפוטנטי, כך שהרצה נוספת מעדכנת את ההתקנה ומתקנת מה שנשבר.

| בדיקה | תיקון |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | משתמש בעותק של המכונה כשהוא מתאים; אחרת עותק פרטי ב-`.tools\` (MinGit מ-Git for Windows, Node.js 24.14.0 מ-nodejs.org, Python מחבילת ה-NuGet שלו). ללא הרשאות מנהל. |
| pnpm | pnpm 10.33.2 המוצמד ב-`.tools\pnpm10` |
| ZAICODE workspace | clone של `vacterro/zaicode`, ענף `master` (מקור המפעיל, מתקין, תיעוד; זיכרון המפתח `.saipen/` מושמט; ענף `workspace` עד 2026-09-27) |
| מקור אפליקציית ZAICODE | clone של ענף `zaicode` אל `zcode\` |
| SAIPEN | clone של `vacterro/saipen` אל `saipen\`; `bin\saipen.cmd` שלו נכתב ל-clone הזה ול-Python הזה |
| SAIMAIL | clone של `vacterro/saimail` אל `saimail\`, מותקן אל `.venv\` |
| saimail-local | לקוח שורת הפקודה של SAIMAIL, שפאנלי ה-SAIMAIL ב-ZAICODE משתמשים בו (נשלח מאז SAIMAIL `0.0.2a3`; בדיקת `saimail-cli` מדווחת OK) |
| חבילת 9router | `9router` מ-npm אל `.tools\router`, נארזת כך ש-SAIFREN עובד בלי שום הגדרה (WARN אם npm לא מצליח להגיע אליה) |
| תלויות האפליקציה | `pnpm install --frozen-lockfile` (שוב כש-`pnpm-lock.yaml` משתנה) |
| build האפליקציה | `pnpm bundle:zaicode`; בזמן ש-ZAICODE רץ ה-build החדש נדרג ונחלף בהפעלה הבאה |
| החלפת build שנדרג | מוחק `win-unpacked.previous` שנותר אחרי כישלון החלפה בנתיב ארוך, ומחליף build שממתין בזמן ש-ZAICODE סגור |
| מפעיל root | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| קיצורי דרך | שולחן עבודה ותפריט Start `ZAICODE` -> `ZAICODE.exe` |
| התחברויות Claude / Codex | דיווח בלבד: כל התחברות `~\.claude*` / `~\.codex*` היא מנוע משלה ב-ZAICODE (A1, A2, C1, ...); התחברות צריכה אותך, בדפדפן |

מפעיל ה-root מפנה את ZAICODE ל-SAIPEN המותקן (`saipen\`) ומציב את `.tools\` ו-`.venv\Scripts` בראש ה-PATH של האפליקציה, כך שהאפליקציה, הסוכנים שלה וה-workers שלה משתמשים בעותקים המותקנים.

## כמה מנויים

כל התחברות של Claude Code או Codex חיות בבית משלה: `~\.claude`,
`~\.claude-account2`, ... ו־`~\.codex`, `~\.codex-account2`, ... ZAICODE מוצא את כולן. כדי להכין יותר בזמן התקנה:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

המתקין יוצר את הבתים ומדפיס את פקודת ההתחברות המדויקת לכל אחת
(`$env:CODEX_HOME = '...'; codex login`). אותו דבר ב־ZAICODE: Settings ->
Engines & limits -> להוסיף התחברות נוספת.

## אבחון ותיקון אוטומטי

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

מצב לכל בדיקה: OK, FIXED (היה שבור, תוקן), WARN (עובד, אך חסר משהו
רשותי), INFO (צריך אותך: התחברות), FAIL. היומנים ב־
`install\logs\`; סיכום ההתקנה האחרונה הוא `install\install-report.json`.
באפליקציה, Router -> Autotroubleshoot מתקן את הנתב הפעיל ואת המאגרים.

## אפשרויות

| פרמטר | ברירת מחדל | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | הכל הולך לשם |
| `-ShortcutDir` | Desktop | היכן קיצור הגישה של ZAICODE נמצא |
| `-NoStartMenu`, `-NoShortcut` | | דלג על קיצורי הגישה האלה |
| `-PortableTools` | | Git / Node.js / Python פרטיים גם אם כבר מותקנים במכונה |
| `-Launch` | | הפעל את ZAICODE בסיום |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | מאגרי GitHub | מקור אחר (פורק, נתיב clone מקומי) |

## אימות

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
בודק התקנה חדשה, מזריע תקלות (קיצור דרך וlauncher נמחקו, launcher של SAIPEN
מופנה ל־Python חסר, venv של SAIMAIL נמחק, node_modules
רשום עבור lockfile אחר, תיקיית build שנותרה עמוקה יותר מ־MAX_PATH),
מאמת שהdoctor מדווח ומתקן כל אחת, ואז מפעיל את מטרת קיצור הדרך עם
profile מבודד ועוצר בדיוק את עץ התהליכים שהפעיל.

`install\tests\Test-ZaicodeUpdate.ps1` בונה ארבעה מאגרים חד־פעמיים
בדיסק והתקנה של ה־clones שלהם, ואז מוכיח שבדיקה לא משנה דבר, שחלק אחד
מתעדכן לבדו עם ההמשך שלו (launcher של SAIPEN, launcher שורש),
שעריכות מקומיות ו־commits מקומיים נשמרים, וששם חלק לא מוכר נדחה. ללא רשת.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
