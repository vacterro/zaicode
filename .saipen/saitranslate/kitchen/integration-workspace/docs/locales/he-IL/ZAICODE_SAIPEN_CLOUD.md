# תעבורת ענן ZAICODE SAIPEN

כיצד checkout זה וסשן Claude Code Cloud מריצים סביבת עבודה אחת של SAIPEN
במקומיות מבצע שונה, ואיפה הגבול ביניהם.

## המבנה

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

ענף אחד נושא את מצב הפרוטוקול. אין שלב merge, אין שלב rebase
ואין ענף מקומי שני שצריך לשמור מסונכרן: המבצע שיש לו נקודת ביקורת מאומתת
מבצע commit ו-push, והצד השני לוקח אותו
ב-fast-forward.

`master` הוא ההיסטוריה שלפני ההעברה וענף ברירת המחדל שפורסם. הוא
לא מתעדכן ב-force-update על ידי ההעברה.

## מה עובר ומה לא

נקודת ביקורת במאגר זה נושאת את מצב הפרוטוקול של SAIPEN, את מפעיל השורש,
את המתקין, את התיעוד ואת סקריפטי ההעברה האלה. זו כל
שכבת סביבת העבודה.

היא אינה נושאת **שום בייט של מוצר**. `zcode/` הוא מאגר Git נפרד, המופיע
ב-`.saipen/source-nested-repos.json` ומבוטל ב-gitignore בשורש הזה
(`/zcode/`). עבודת מוצר דורשת clone משלו של `vacterro/zaicode` על ענף
`zaicode`, וה-clone הזה הוא אובייקט שני, עצמאי, עם היסטוריה משלו.

התוצאה מבלבלת בקלות: `git status` נקי בשורש הזה אומר
שום דבר על עבודת מוצר שלא נשמרה, ו-fast-forward של `saipen-live` אומר
שום דבר על קוד המוצר. בדוק `git -C zcode status` במפורש.

## הצד המקומי

שני סקריפטים, שניהם בבעלות המאגר כדי שמכונה חדשה תקבל אותם מהמאגר
ולא מזיכרון:

| קובץ | תפקיד |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | מאמת, מיישב את הענף, מתקין ומפעיל את הצופה, כותב את רשומת ההפעלה-אוטומטית, מוכיח שמקומי == מרוחק |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | הלולאה: fetch, השוואה, fast-forward או push, יומן, השהיה; ואז מעבר המוצר ועדכון עצמי |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | round-trip מתוך מבצע עצמאי בנוסף הוכחת התאוששות מקוררת |
| `tools/saipen-cloud/Test-ProductSync.ps1` | מעבר מוצר ועדכון עצמי מול מאגרי Git חד-פעמיים (ללא רשת, ללא מרוחק אמיתי) |

התקנה ותיקון:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

זה אידמפוטנטי. מצב מקומי למכונה חי ב-`%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (עותק), `ZAICODE_cloud-sync.log` (מסובב ב
2 MB אל `.log.1`), `ZAICODE_cloud-sync.lock` (מופע יחיד),
`ZAICODE_cloud-sync.pid`, ורשומה בתיקיית Startup
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

המתקין מסרב לעץ מלוכלך ולעולם אינו מנקה אותו. אם כל נתיב מלוכלך הוא
מצב SAIPEN קנוני תחת `.saipen/`, הוא אומר זאת ומדפיס את פקודות
ה-checkpoint המדויקות; זו מצב פרוטוקול ללא checkpoint, לא תקלת תעבורה,
והמתקין לא יבצע commit מאחורי גב הפרוטוקול.

## התנהגות הצופה

| מצב | פעולה |
|-----------|------|
| נקי, מקומי הוא ancestor של מרוחק | `git merge --ff-only` |
| נקי, מרוחק הוא ancestor של מקומי | `git push` |
| מלוכלך | השהיה; אפילו לא fetch |
| בענף אחר | השהיה |
| שניהם התקדמו, אין ancestor משותף | השהיה, יומן שני מזהי commit, לא ממזג דבר |
| fetch או הרשת נכשלו | יומן degraded, ניסיון חוזר ב-tick הבא |
| merge/rebase/cherry-pick בתהליך | השהיה |

לעולם: force push, hard reset, stash, clean, checkout של ענף זר,
commit, או עצירה לפי שם תהליך. המתקין עוצר צופה רק לפי
ה-pid שרשם בקובץ pid שלו.

עץ מלוכלך אינו עולה כלום, מפני שהצופה בודקת לכלוך לפני שהיא עושה fetch.
לכן checkout במנוחה אינו אומר כלל שיחות רשת.

### מעבר מוצר (T-90)

`zcode/` הוא מאגר בפני עצמו, ולכן הטבלה למעלה אינה מזיזה לעולם קוד
מוצר. אחריו, אותו tick מטפל ב-checkout של המוצר (`-ProductRepo`,
ברירת מחדל `<repo>\zcode`; ענף `-ProductBranch`, ברירת מחדל `zaicode`).
מעבר המוצר רץ בין אם עץ החיצוני מלוכלך או לא. הוא רק מושך.

| מצב | פעולה |
|-----------|------|
| ה־remote קדים, אין כאן שינוי מקומי בקובץ הנכנס | `git merge --ff-only`; עבודת מוצר שלא נשמרה נשארת כמות שהיא |
| ה־remote קדים, יש כאן שינוי מקומי בקובץ הנכנס | HELD: רשום את הקבצים, אל תמזג דבר |
| המקומי קדים | רשום; **לעולם לא נדחף** (המוצר מתפרסם על ידי SAIPEN SHIP) |
| הסתעפות | הפסק, רשום את שני המזהים, אל תמזג דבר |
| ענף אחר, פעולת git בתהליך, fetch נכשל | הפסק |
| אין checkout של `zcode/`, או `-NoProduct` | דילוג |

‏git בעצמו מסרב fast-forward שידרוס שינוי מקומי, ולכן בדיקת HELD היא מגן קודם, ברור יותר, ולא היחיד. fast-forward של המוצר אינו בונה מחדש דבר: לבדיקה, הרץ `pnpm bundle:zaicode` (או תצוגת הפיתוח).

### עדכון עצמי (T-90)

הצופה רצה כעותק תחת `%APPDATA%\SAIPEN`, ולכן צופה חדשה יותר שבמאגר מעולם לא הופעלה ללא התקנה מחדש. במצב לולאה היא כעת משווה את הקובץ שלה מול העותק המחויב במאגר בכל מעבר. היא מתקינה את העותק הזה על עצמה ומופעלת מחדש בדיוק פעם אחת, עם אותם ארגומנטים, רק כשכל התנאים הבאים מתקיימים:

- שני הקבצים שונים;
- לעותק במאגר אין עריכות שלא נשמרו;
- העותק במאגר מפועל ללא שגיאות.

עותק שאינו מפועל נדחה ונרשם, והצופה הרצה ממשיכה בפעולה.

צופות שהותקנו לפני T-90 חסרות גם את מעבר המוצר וגם את העדכון העצמי. הרץ `Install-SaipenLiveSync.ps1` פעם אחת במכונה כזאת; אחרי זה, הצופה מעדכנת את עצמה.

## חצי הענן

`CLAUDE.md` בשורש הוא כלל הכניסה, ו`.claude/skills/saipen/SKILL.md` הוא נוהל ההרצה. ה-skill טוען את הקרנל של SAIPEN מ`github.com/vacterro/saipen` ומריץ אותו דרך משטח המנוע המוצג `tools/saipen.py`. הקרנל מוצמד לפי commit (`3088eff`), לעולם לא לפי tag. ‏Tag `v8.0.1` הוא קרנל ישן עם אותו `VERSION`; ‏`validate` שלו משנה מצב, וה-validator שלו דוחה את הלוח הזה.

`STATE.saipen_home` רשום את נתיב הליבה של ה-executor שעשה checkpoint אחרון.
בענן, ה-`saipen continue` הראשון על ליבה `3088eff` מתכנס אל הליבה
הפעילה כ-`DEC` אחת עם יומן (E-1410). במכונת המפעיל
המצביע מגיע מת באותו אופן. ליבה עם התכנסות אוטומטית
מתקנת אותו ב-`continue`; אחרת הרץ `saipen rebind-home --auto`.

**המסע החוזר נצפה.** E-1562 (ענן) התכנס את המצביע אל `/home/user/zaicode/.claude/saipen-protocol`; E-1571 (מכונת המפעיל)
התכנס אותו בחזרה ל־`V:/.../_SAIPEN`, אוטומטית, ללא `rebind-home` ידני.
שני הכיוונים הם אותה התכנסות אוטומטית, ולכן צפו ל־`saipen_home` אחד
`DEC` לכל החלפת מקומיות, והתייחסו אליו כרעש צפוי
ולא כתקלה. הוא נשאר רעש עד ש־P1-2
(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) יוציא את המצביע ממצב מגורסן; אל תממשו את
P1-2 כתוצאה של זיהויו. אף פעם אל תערכו ידנית את המצביע.

`STATE.saipen_home` עשוי להצביע על **checkout פיתוח** של הקרנל שמקדים
את ה־pin, ולא על clone נקי של `3088eff` — במכונת המפעיל זו
הענף `accepted-debt-rebind` עם עבודה שלא נשמרה. קרנל שאינו
ב־commit המנוקד אינו בהכרח שגוי, אבל גם אינו מקור clean-room,
ולכן הכלל שלהלן על חוזה הקול חל עליו במלואו. אף פעם אל תבצעו
commit, stash, reset, checkout או clean בתוך checkout כזה;
שחזור ממוקד של קובץ בודד — `saipen/STYLE.md` — הוא החריגה
היחידה המותרת, ורק כאשר המפעיל ביקש זאת.

### STYLE.md אינו הגדרה מקומית

`saipen/STYLE.md` חייב להיות **זהה בייתי לקובץ של הקרנל המנוקד**
בכל מכונה, בכל עותק, ללא חריגים וללא עריכות מקומיות. קיימים
יותר מעותק אחד במכונת המפעיל:

- checkout הקרנל ב־`STATE.saipen_home` (Git clone; במכונת
  המפעיל זהו checkout פיתוח);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, המאוכלס על ידי
  המשימה המתוזמנת `saipen-inject` (`bootstrap/schedule-run.ps1`). הוא **אינו
  מאגר Git**, ולכן `git checkout` לעולם לא יוכל לתקנו — רק
  re-sync דרך ה־injector, או כתיבה ישירה של התוכן שפורסם, היא
  הדרך היחידה.

ה־token של `style_contract` ב־`.saipen/STATE.md` הוא hash של טקסט
הקובץ (`tools/validate.py`, `style_contract_token`: CRLF מנורמל, שורת
`style_contract:` מוחרגת). עורכים את `reply_language` בעותק אחד וה־token
זז; העותק האחר והענן, אשר שולפים את הקרנל שפורסם,
שומרים על ה־token שפורסם, וכל כתיבה של CLI בצד שאינו
תואם נדחית עם `style_contract ... does not match the installed STYLE.md marker`.
זו כל התקלה: הצד המקומי כותב מצב שהענן אינו יכול לכתוב.

**שינוי שפת התשובה הוא commit בקרנל בתוספת re-pin**, אף פעם
עריכה מקומית. משנים אותה במאגר הקרנל, מפרסמים, מבצעים
re-pin ל־commit ב־SKILL.md, ומעדכנים את `STATE.style_contract` דרך
`saipen recover`. עריכה מקומית של `STYLE.md` מגדירה שוני
בכל מכונה שאינה המכונה שביצעה אותה.

| מלכודה אחת שכדאי לציין: `bin/saipen` שפורסם הוא shim
מ绑 מכונה שמקבע את הנתיבים המוחלטים של interpreter ושל checkout
של מפעיל מסוים. הוא רץ בדיוק על מכונה אחת. הענן חייב להשתמש
ב־`python3 tools/saipen.py`.

קיצורי דרך: `cc` ממשיך את ה־Work הנוכחי; `cc all <text>` קורא
את כל ההודעה כ־source/appends וממשיך כל Work זמין. אף אחד מהם
לא מבקש אישור שגרתי.

## סיווג יכולות

**AVAILABLE_IN_CLOUD** — מצב הפרוטוקול ושכבת סביבת העבודה. קריאה ו
כתיבה של `.saipen/`, ה-launcher (`tools/launcher/ZaicodeLauncher.cs`), ה
installer שמתחת ל-`install/`, `docs/`, `CLAUDE.md`, `.claude/skills/`, ו-
סקריפטי התעבורה. קריאת Git, commit, push ו-fetch על `saipen-live`. כל
gate שהוא אסרטציה על קובץ, סקירת diff או בדיקת טקסט.

**LOCAL_WINDOWS_ONLY** — ה-gates שדורשים את המכונה הזו.

| Gate | למה |
|------|-----|
| `tools\launcher\build.cmd` | מקמפל את `ZaicodeLauncher.cs` עם .NET Framework `csc`; אין Windows SDK בדמות ענן |
| Electron E2E ארוז (`zcode` desktop, Solo → queue → dispatch) | דורש הפעלה דסקטופית ופרופיל provider מוכן |
| 9router פעיל | שירות Windows במכונה הזו |
| לחיצה אינטראקטיבית בדסקטופ | אדם ומסך |
| מקרי הריצה של ה-watcher עצמו | ה-watcher רץ רק במכונה שמחזיקה את ה-checkout |

אלה נרשמים כגבולות קבלה מקומיים בלבד. הם לא
מדווחים כעברו לעולם רק משום שה-diff נראה נכון.

**SAFE_TO_DEFER** — שכבת המוצר. סשן ענן יכול לשכפל
את `vacterro/zaicode` branch `zaicode` ולעבוד שם. עבודה ברמת סביבת העבודה אינה
דורשת עבודת מוצר, אך היא דורשת את ה-clone:
`.saipen/source-nested-repos.json` מכריז על `zcode/`, ובלעדיו ה-validator
נכשל עם `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. gates של `pnpm` דורשים pnpm 10.33.2
מוצמד וסביבת עבודה מוכנה. `pnpm bootstrap` על דמות ענן חדשה הוא
הדרך המתועדת להיכנס, ו-`package.json` של המוצר כבר מכריז עליו.

הענן יכול לאמת רק בייטים של מוצר שנמצאים ב-`origin/zaicode`. delta
של מוצר שקיים רק ב-`zcode/` checkout של המפעיל
לא נראה כאן, ולכן כל gate של מוצר עבורו הוא NOT RUN בענן, לא
משנה מה ה-gate. T-84 הוא המקרה הראשון (E-1411): התיקון שלו היה מקומי בלבד
בזמן ש-`origin/zaicode` עדיין נשא את הקוד מהתיקון ולפניו.

**UNSAFE_TO_EMULATE** — כל דבר שהיה גורם ל-gate מקומי להיראות ירוק.
אל תדחה stub לבניית ה-launcher, תדמה הרצת אפליקציה ארוזה, תשחזר
תוצאת `pnpm verify:pre-push` מוקלטת כאילו זו רכה עכשיו, או תמיר "הקוד
נראה נכון" לשורת PASS ב-`.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — התאמה שתלויה במיקום ה-checkout.
ב-`3088eff` של ה-kernel ה-validator של הענן מדווח על
כ-FAILים של `closure-evidence` (T-47, T-62, T-76, T-78 בזמן כתיבה) שאינם
קיימים במכונת המפעיל.

ה-kernel מעביר כל אירוע LOG גדול מ-1024 בתים ל
sidecar ב-`.saipen/recovery/log-detail/`. בקריאה הוא משחזר את ה-sidecar רק
כאשר הנתיב המוחלט של ה-checkout שווה לנתיב שממנו נכתב. פסקת VERIFY
ארוכה שנכתבה ב-Windows לכן אינה קריאה בענן, וההפך נכון
גם כן.

הפגם הוא ב-kernel ומדווח כ-P1-1 ב
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. עד שיתמזג:

- ציטוט הפסק הענן וסיווגו כגבול זה, כרטיס לכרטיס
  (`SKILL.md` § 6 מכיל את הבדיקה);
- לעולם אין לשכתב sidecars, לא לאמת מחדש רק כדי להפוך הכול לירוק, ולא לתקן את
  העותק של ה-kernel;
- לשמור על אירועי LOG מתחת ל-1024 סימנים בשני הצדדים.

אותה קשירה לנתיב המכונה גם חוסמת עבודה. קו הבסיס לחוב שלפני BUILD נלכד בפעם הראשונה שכרטיס נכנס
ל-BUILD ונבדק מחדש בכל כניסה מאוחרת יותר. כרטיס שנכנס ל-BUILD לראשונה על מכונת המפעיל
לכן אינו יכול להיכנס ל-BUILD בענן: המעבר נדח עם
`DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 הוא המקרה המתועד: DEBT-000079 נלכד ב-E-1377 והמעבר נדח ב-E-1446.
השאירו כרטיס כזה למכונה שלפדה את קו הבסיס שלו.

## סטייה

אם מקומי ומרוחק מפסיקים לשתף אב משותף, הצופה עוצר. הוא לא ממזג, לא מבצע rebase ולא מאלץ.
שני מזהי ה-commit נכנסים ליומן, התיקון מתבצע ב-`git log --left-right --cherry-pick <branch>...origin/<branch>` ידנית, ו
התוצאה נשמרת כנקודת שחזור כמו כל שינוי אחר.

## פעולת הצד המדוייקת בענן

### סקריפט הגדרת הסביבה (פעם אחת, בהגדרות של סביבת הענן)

תפריט סביבת הענן בסרגל הכותרת של ההפעלה -> Edit -> Setup script. הוא
רץ לפני כל הפעלה חדשה, ולכן כל הפעלה מתחילה עם כלי העבודה של המוצר מוכן:

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

### ההנחיה לכל הפעלה חדשה

התחילו את ההפעלה על מאגר `vacterro/zaicode`, ענף `saipen-live`, ו
ודאו שהסוכן של מכונת המפעיל אינו כותב באותו זמן.
החליפו את השורה האחרונה ב-`cc all <new list>` כדי להעביר עבודה חדשה.

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

על מכונת המפעיל הצופה מבצע fast-forward ל-`zcode` מ
`origin/zaicode`; `REBUILD.cmd` (או `REBUILD_fast.lnk`) בונה אותו, וה
הפעלה הבאה של ZAICODE מחליפה את ה-build החדש.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
