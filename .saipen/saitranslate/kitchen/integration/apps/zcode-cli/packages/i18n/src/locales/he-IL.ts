import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "he-IL",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `ערך --locale שאינו נתמך: ${value}. שפות נתמכות: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

שימוש:
  zcode [command] [options]

ללא פקודה, zcode פותח את ממשק ה-TUI המלא.

פקודות:
  app-server הרצת שרת האפליקציות של ZCode Protocol דרך stdio
  commands   הצגת פקודות slash מותאמות (\`commands list\`)
  doctor     בדיקת הנחות ריצה ואריזה
  login [zai|bigmodel]  התחברות דרך אישור בדפדפן
  logout     הסרת פרטי ההתחברות המשותפים של Z.AI
  plugins    ניהול תוספים וחנויות (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; כינוי: plugin)
  skills     הצגת מיומנויות מקומיות (\`skills list\`)
  tui        פתיחת ממשק הטרמינל
  version    הדפסת גרסת ה-CLI

אפשרויות:
  -h, --help       הצגת עזרה
  -v, --version    הצגת גרסה
  -p, --prompt <text>  הרצת prompt אחד ללא פתיחת ה-TUI
  --memory-bench   עם --prompt, הפעלת חילוץ Memory אוטומטי והמתנה לפני יציאה (דורש Memory מופעל)
  --browser-use <mode> הפעלת מנוע Browser Use (נתמך: headless)
  --surface <surface>  משטח תצוגה ל-prompts/app-server ללא ממשק: terminal או desktop
  --browser-executable <path> קובץ ההפעלה של Chrome/Chromium עבור Browser Use ללא ממשק
  --attach <path>  צירוף קובץ מקומי אל --prompt; חזרו על כך לכמה קבצים
  --cwd <path>     הרצת הפקודה מהתיקייה שניתנה
  --disallowed-tools, --disallowedTools <tools...>
    הסרת כל הכלים להרצת prompt/TUI זו בלבד; ההגדרות השמורות אינן משתנות.
    שמות כלים מופרדים בפסיק או ברווח, למשל "Bash Edit".
    "Bash(git *)" מסיר את כל Bash; תבניות פקודות אינן מתאימות.
  --force-mcs      כפיית system projection באמצע שיחה עבור ספקי Anthropic
  --locale <locale>  שפת ממשק: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR או auto
  --mode <mode>    מצב הרשאות ל-prompts: build, edit, plan או yolo (ברירת מחדל: yolo עבור --prompt)
  --resume <sessionId>  המשך session שנשמר לפי sessionId (sess_...)
  --target <text>  הרצה או הגדרה של מטרת ה-session במצב ללא ממשק
  --target-replace החלפת מטרת session קיימת שהוגדרה על ידי --target
  -c, --continue        המשך ה-session האחרון של התיקייה הנוכחית
  --json           הדפסת JSON קריא למכונה היכן שנתמך
  --no-browser     הדפסת כתובת ה-OAuth ללא פתיחת דפדפן
  --no-color       השבתת צבעי ANSI
  --verbose        הדפסת פרטי אבחון נוספים

פקודות Slash:
  /help [command]       הצגת עזרה לפקודות slash
  /login                בחירת התחברות בדפדפן ל-Z.AI או ל-BigModel
  /logout               הסרת פרטי ההתחברות המשותפים של Z.AI
  /compact [instructions]  דחיסת השיחה הנוכחית
  /expert [status|resume|stop|<task>]  הרצה או ניהול של תהליך ה-expert
  /dwf [list|cancel|resume]  הצגה, ביטול או המשך של הרצות dynamic workflow
  /fork [latest|checkpointId]  יצירת session חדש מ-checkpoint של סביבת העבודה
  /mcp [list|status|connect|disconnect]  הצגה או ניהול של שרתי MCP
  /mode [mode]          הצגה או החלפה של מצב הרשאות: build, edit, plan או yolo
  /model [id]           הצגה או החלפה של מודל ה-session הנוכחי
  /new                  התחלת session חדש ב-TUI
  /resume [sessionId]   המשך session לפי sessionId; השמיטו אותו לאחרון ב-cwd
  /rewind [latest|checkpointId]  הצגת ה-checkpoint האחרון או שחזור קובצי סביבת העבודה
  /skill [name] [task]  הצגת מיומנויות, או כפייה על prompt הבא לטעון מיומנות
  /goal [action]        הצגה או הגדרה של מטרת ה-session הנוכחית
`,
  },
  tui: {
    copy: {
      copied: "הטקסט שנבחר הועתק ללוח.",
      failed: "לא ניתן להעתיק את הטקסט שנבחר.",
      unavailable: "העתקת טקסט ללוח אינה זמינה במסוף זה.",
    },
    effort: {
      disabled: "מושבת",
      enabled: "מופעל",
    },
    input: {
      activeStatusHint: "esc להפסקה",
      busyPlaceholder: "הקלד כדי להוסיף קלט לתור",
      placeholder: "הקלד prompt",
      queuedMore: (count) => `+ עוד ${count} בתור`,
      queuedSubmitHint: "נשלח אחרי קריאת הכלי הבאה.",
      queuedTitle: (count) => ` תור (${count}) `,
      title: "קלט",
      noHistorySource: "לא הוגדר מקור היסטוריית קלט.",
      noPreviousInput: "אין קלט קודם לפרויקט זה.",
      restoredPreviousInput: "הקלט הקודם שוחזר.",
      restoredPreviousInputWithAttachments: (count) =>
        `הקלט הקודם שוחזר עם ${count} קבצים מצורפים.`,
      restorePreviousInputFailed: "לא ניתן לשחזר את הקלט הקודם.",
      typePrompt: "הקלד שאלה ולחץ Enter.",
    },
    loginRequired: {
      help: "השתמשו ב-/model להצגת מודלים, או ב-/login לחיבור חשבון Coding Plan.",
      message: "אין מודלים זמינים. הגדירו provider או התחברו עם /login.",
      status: "אין מודלים זמינים. הגדירו provider או התחברו עם /login.",
      title: "נדרשת הגדרת מודל",
    },
    loginSetup: {
      emptyMessage: "אין אפשרויות התחברות זמינות.",
      help: "השתמשו ב-Up/Down לבחירה, Enter לאישור.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "הזינו מפתח API של BigModel Coding Plan",
          inputSecondary: "הדביקו את המפתח כאן. הוא מוסתר בזמן ההקלדה.",
          primary: "מפתח API של BigModel Coding Plan",
          secondary: "הדביקו מפתח API של Coding Plan ידנית.",
        },
        bigmodelOauth: {
          pendingPrimary: "ממתין לאישור BigModel",
          pendingSecondary:
            "השלימו את ההתחברות בדפדפן. האישור מזוהה אוטומטית.",
          primary: "BigModel Coding Plan",
          secondary: "פתיחת התחברות בדפדפן; האישור מזוהה אוטומטית.",
        },
        zaiApiKey: {
          inputPrimary: "הזינו מפתח API של Z.AI Coding Plan",
          inputSecondary: "הדביקו את המפתח כאן. הוא מוסתר בזמן ההקלדה.",
          primary: "מפתח API של Z.AI Coding Plan",
          secondary: "הדביקו מפתח API של Coding Plan ידנית.",
        },
        zaiOauth: {
          pendingPrimary: "ממתין לאישור Z.AI",
          pendingSecondary:
            "השלימו את ההתחברות בדפדפן. אמשיך כשהאישור יסתיים.",
          primary: "Z.AI Coding Plan",
          secondary: "פתח התחברות בדפדפן וצור מפתח API ל-Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "ההתחברות בוטלה. בחר שיטת הגדרה.",
        help: "Esc מבטל ומחזיר לאפשרויות ההגדרה.",
        status: "ממתין לאישור בדפדפן...",
      },
      input: {
        cancelStatus: "הזנת מפתח ה-API בוטלה. בחר שיטת הגדרה.",
        clearStatus: "קלט מפתח ה-API נוקה.",
        emptyStatus: "נדרש מפתח API.",
        help: "Enter שומר את המפתח. Esc מחזיר לאפשרויות ההגדרה.",
        placeholder: "הדבק מפתח API",
        status: "הזן את מפתח ה-API, ולאחר מכן לחץ Enter.",
        submitStatus: "שומר מפתח API...",
      },
      prompt: "בחר שיטת הגדרה: התחברות או מפתח API.",
      response: "בחר כיצד להגדיר ספק Coding Plan.",
      title: "הגדרת Coding Plan",
    },
    model: {
      requestFailed: (message) => `בקשת המודל נכשלה: ${message}`,
      responseReceived: "תגובת המודל התקבלה.",
      responseReceivedWithTokens: (tokens) => `תגובת המודל התקבלה. ${tokens} טוקנים.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `בקשת המודל מנסה שוב ${attempt}/${Math.max(1, maxAttempts - 1)} תוך ${delay}: ${reason}`,
      streamStalled: "זרם המודל נתקע.",
    },
    sidebar: {
      subagents: {
        title: "סוכני משנה",
        empty: "אין עדיין סוכני משנה.",
        emptyOutput: "אין עדיין פלט.",
        back: "← שיחת Main",
        readonly: "קריאה בלבד · Esc לחזרה",
        loading: "טוען פלט של סוכן משנה...",
        unavailable: "פלט סוכן המשנה אינו זמין.",
        retry: "נסה שוב",
        more: "טען עוד",
        pendingMain: "השיחה הראשית זקוקה לקלט שלך — חזור כדי לענות",
        ended: (count) => `הסתיים (${count})`,
        status: {
          running: "פועל",
          waiting: "ממתין",
          blocked: "חסום",
          success: "הושלם",
          failed: "נכשל",
          cancelled: "בוטל",
          lost: "אבד",
        },
      },
      api: {
        empty: "אין עדיין קריאות API.",
        model: "מודל",
        more: (count) => `+${count} נוספים`,
        requests: "בקשות",
        server: "שרת",
      },
      cache: {
        hit: "פגיעה",
        lastHit: "פגיעה אחרונה",
        lastMiss: "החמרה אחרונה",
        readWrite: ({ read, write }) => `${read} קריאה / ${write} כתיבה`,
        total: "סך הכול",
      },
      context: {
        cache: "מטמון",
        cacheReadWrite: "קריאה/כתיבה במטמון",
        inputOutput: "I/O",
        reason: "סיבה",
        tokens: "טוקנים",
        used: "בשימוש",
        window: "חלון",
      },
      modifiedFiles: {
        empty: "אין עדיין שינויים בקבצים.",
        more: (count) => `+${count} נוספים`,
      },
      mcp: {
        empty: "לא הוגדרו שרתי MCP.",
        loadFailed: "מצב MCP אינו זמין.",
        loading: "טוען מצב MCP...",
        more: (count) => `+${count} נוספים`,
        servers: "שרתים",
        status: {
          connected: "מחובר",
          connecting: "מתחבר",
          disabled: "מושבת",
          disconnected: "מנותק",
          failed: "נכשל",
          untrusted: "לא מהימן",
        },
        summary: ({ connected, total }) => `${connected}/${total} מחוברים`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "הושלם",
        error: "שגיאה",
        errorWithStatus: (statusCode) => `שגיאה ${statusCode}`,
        pending: "ממתין",
      },
      status: {
        last: "אחרון",
      },
      run: {
        draft: "טיוטה",
        draftChars: (count) => `${count} תווים`,
        draftEmpty: "ריק",
        messages: "הודעות",
        mode: "מצב",
        model: "מודל",
        provider: "ספק",
        thought: "מחשבות",
        trace: "מעקב",
        turn: "תור",
        workspace: "סביבת עבודה",
      },
      sections: {
        apis: "ממשקי API",
        context: "הקשר",
        mcp: "MCP",
        modifiedFiles: "קבצים ששונו",
        run: "הרצה",
        status: "מצב",
        todos: "משימות",
      },
      shellSubtitle: "מעטפת OpenTUI",
      title: "סרגל צד",
      todos: {
        empty: "אין משימות עדיין.",
        more: (count) => `+${count} נוספים`,
        progress: "התקדמות",
      },
    },
    status: {
      compactFailed: "דחיסת ההקשר נכשלה.",
      compacted: "השיחה דוחסה.",
      compacting: "דוחס הקשר...",
      interruptedStreamDiscarded: "זרם המודל שהופרק נדחה.",
      modelCalling: "מתקשר למודל...",
      permissionRequested: (toolName) => `הועתקה בקשת הרשאה עבור ${toolName}.`,
      permissionResolved: (toolName) => `הרשאה נפתרה עבור ${toolName}.`,
      ready: "מוכן.",
      recoveringStream: "משחזר זרם מודל שהופרק...",
      retryingStream: "מנסה שוב את זרם המודל...",
      sessionResumed: "ההפעלה הומשכה.",
      targetChanged: (action) => `יעד ${action}.`,
      thinking: "חושב...",
      toolCompleted: (toolName) => `הכלי ${toolName} הושלם.`,
      toolFailed: (toolName) => `הכלי ${toolName} נכשל.`,
      toolPending: (toolName) => `הכלי ${toolName} ממתין.`,
      toolRunning: (toolName) => `הכלי ${toolName} רץ.`,
      turnFailed: "התור נכשל.",
    },
    terminal: {
      requiresInteractive: "TUI דורש מסוף אינטראקטיבי.",
      starting: "מפעיל ZCode... Ctrl+C ליציאה",
    },
    transcript: {
      compact: {
        completed: "ההקשר דוחס",
        failed: "דחיסת ההקשר נכשלה",
        interrupted: "דחיסת ההקשר הופרקה",
        retry: (command) => `Ctrl-R לנסות שוב ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `מנסה שוב דחיסת הקשר (${attempt}/${maxAttempts})`
            : "מנסה שוב דחיסת הקשר",
        skipped: "ההקשר מעודכן; אין צורך בדחיסה",
        started: "דוחס הקשר",
      },
      roles: {
        agent: "סוכן",
        system: "מערכת",
        user: "משתמש",
      },
      thought: {
        complete: "מחשבה",
        thinking: "חושב...",
      },
      title: "תמליל",
      workflow: {
        actors: "שחקנים:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `שימוש: ${spentTokens} טוקנים`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `תהליך ${label} - ${status} (${nodesSettled}/${nodesTotal} שלבים)`,
        error: (message) => `שגיאה: ${message}`,
        expandHint: "+ להרחבה",
        collapseHint: "- לכיווץ",
        log: "יומן:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} שלבים הושלמו`,
        result: (preview) => `תוצאה: ${preview}`,
        status: {
          completed: "הושלם",
          errored: "נכשל",
          pending: "ממתין",
          running: "רץ",
          stopped: "נעצר",
        },
        stopReason: {
          user: "על ידך",
          model: "על ידי הסוכן",
          provider: "שגיאת מודל",
          interrupted: "התהליך יצא",
          superseded: "הוחלף על ידי הרצה מתוקנת",
        },
        truncated: "(נקטע - היסטוריה מלאה ביומן ההרצה)",
        interruptedNotice: ({ label, runId }) =>
          `תהליך ${label} הופרע וניתן להמשיכו: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter לבחירה, Esc לביטול",
      disabled: (reason) => ` [מושבת: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `סינון: ${filter || "-"} | ${help ?? "Enter לבחירה, Esc לביטול"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "אין נתיבי סביבת עבודה תואמים.",
      loading: "טוען נתיבי סביבת עבודה...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "קבצים",
    },
    slash: {
      title: "פקודות",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
