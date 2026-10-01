import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "ar-SA",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `قيمة --locale غير مدعومة: ${value}. اللغات المدعومة: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR، auto.`,
    },
    help: (version) => `zcode ${version}

الاستخدام:
  zcode [command] [options]

بدون أمر، يفتح zcode واجهة TUI بملء الشاشة.

الأوامر:
  app-server   تشغيل خادم تطبيقات ZCode Protocol عبر stdio
  commands   سرد أوامر الشرطة المخصصة (\`commands list\`)
  doctor     فحص افتراضات وقت التشغيل والحزم
  login [zai|bigmodel]  تسجيل الدخول عبر تفويض المتصفح
  logout     إزالة بيانات اعتماد Z.AI المشتركة
  plugins    إدارة الإضافات والمتاجر (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`؛ الاسم المستعار: plugin)
  skills     سرد المهارات المحلية (\`skills list\`)
  tui        فتح واجهة الطرفية
  version    طباعة إصدار CLI

الخيارات:
  -h, --help       عرض المساعدة
  -v, --version    عرض الإصدار
  -p, --prompt <text>  تنفيذ طلب واحد دون فتح TUI
  --memory-bench   مع --prompt، تفعيل استخراج Memory التلقائي والانتظار قبل الخروج (يتطلب تفعيل Memory)
  --browser-use <mode> تفعيل واجهة Browser Use الخلفية (المدعوم: headless)
  --surface <surface>  واجهة العرض لطلبات headless/app-server: terminal أو desktop
  --browser-executable <path> ملف Chrome/Chromium التنفيذي لاستخدام Browser Use في وضع headless
  --attach <path> إرفاق ملف محلي بـ --prompt؛ كرّر لإرفاق عدة ملفات
  --cwd <path>     تنفيذ هذا الأمر من المجلد المحدد
  --disallowed-tools، --disallowedTools <tools...>
    إزالة أدوات كاملة لهذا الطلب/تشغيل TUI فقط؛ الإعدادات المحفوظة لا تتغير.
    أسماء الأدوات مفصولة بفاصلة أو مسافة، مثال: "Bash Edit".
    "Bash(git *)" يزيل Bash بالكامل؛ أنماط الأوامر لا تُطابَق.
  --force-mcs      فرض إسقاط النظام أثناء المحادثة لمزوّدي Anthropic
  --locale <locale>  لغة الواجهة: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR أو auto
  --mode <mode>    وضع الإذن للطلبات: build أو edit أو plan أو yolo (الافتراضي: yolo لـ --prompt)
  --resume <sessionId>  استئناف جلسة محفوظة عبر sessionId (sess_...)
  --target <text>  تنفيذ هدف الجلسة أو تعيينه في وضع headless
  --target-replace استبدال أي هدف جلسة موجود عيّنه --target
  -c, --continue        استئناف أحدث جلسة للمجلد الحالي
  --json           طباعة JSON قابل للقراءة آليًا حيثما كان مدعومًا
  --no-browser     طباعة رابط OAuth دون فتح متصفح
  --no-color       تعطيل ألوان ANSI
  --verbose        طباعة تفاصيل تشخيصية إضافية

أوامر الشرطة المائلة:
  /help [command]       عرض مساعدة أوامر الشرطة المائلة
  /login                اختيار تسجيل الدخول عبر المتصفح لـ Z.AI أو BigModel
  /logout               إزالة بيانات اعتماد Z.AI المشتركة
  /compact [instructions]  ضغط المحادثة الحالية
  /expert [status|resume|stop|<task>]  تشغيل سير عمل الخبير أو إدارته
  /dwf [list|cancel|resume]  سرد تشغيلات سير العمل الديناميكية أو إلغاؤها أو استئنافها
  /fork [latest|checkpointId]  إنشاء جلسة جديدة من نقطة تفتيش لمساحة العمل
  /mcp [list|status|connect|disconnect]  عرض خوادم MCP أو إدارتها
  /mode [mode]          عرض وضع الإذن أو تبديله: build أو edit أو plan أو yolo
  /model [id]           عرض نموذج الجلسة الحالي أو تبديله
  /new                  بدء جلسة جديدة في TUI
  /resume [sessionId]   استئناف جلسة عبر sessionId؛ احذفه للحصول على أحدث جلسة في المجلد الحالي
  /rewind [latest|checkpointId]  عرض أحدث نقطة تفتيش أو استعادة ملفات مساحة العمل
  /skill [name] [task]  سرد المهارات، أو إجبار الطلب التالي على تحميل مهارة
  /goal [action]        عرض هدف الجلسة الحالي أو تعيينه
`,
  },
  tui: {
    copy: {
      copied: "تم نسخ النص المحدد إلى الحافظة.",
      failed: "تعذّر نسخ النص المحدد.",
      unavailable: "نسخ النص إلى الحافظة غير متاح في هذه الطرفية.",
    },
    effort: {
      disabled: "معطّل",
      enabled: "مفعّل",
    },
    input: {
      activeStatusHint: "esc للمقاطعة",
      busyPlaceholder: "اكتب لإضافته إلى الطابور",
      placeholder: "اكتب طلبًا",
      queuedMore: (count) => `+ ${count} أخرى في الطابور`,
      queuedSubmitHint: "أُرسل بعد استدعاء الأداة التالية.",
      queuedTitle: (count) => ` الطابور (${count}) `,
      title: "الإدخال",
      noHistorySource: "لم يُضبط أي مصدر لسجل الإدخال.",
      noPreviousInput: "لا يوجد إدخال سابق لهذا المشروع.",
      restoredPreviousInput: "تمت استعادة الإدخال السابق.",
      restoredPreviousInputWithAttachments: (count) =>
        `تمت استعادة الإدخال السابق مع ${count} مرفق.`,
      restorePreviousInputFailed: "تعذّرت استعادة الإدخال السابق.",
      typePrompt: "اكتب سؤالًا واضغط Enter.",
    },
    loginRequired: {
      help: "استخدم /model لعرض النماذج، أو /login لربط حساب Coding Plan.",
      message: "لا توجد نماذج متاحة. اضبط مزوّدًا أو سجّل الدخول عبر /login.",
      status: "لا توجد نماذج متاحة. اضبط مزوّدًا أو سجّل الدخول عبر /login.",
      title: "يلزم إعداد النموذج",
    },
    loginSetup: {
      emptyMessage: "لا تتوفر خيارات تسجيل الدخول.",
      help: "استخدم Up/Down للاختيار، Enter للتحديد.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "أدخل مفتاح BigModel Coding Plan API",
          inputSecondary: "الصق المفتاح هنا. يُخفى أثناء الكتابة.",
          primary: "مفتاح BigModel Coding Plan API",
          secondary: "الصق مفتاح Coding Plan API يدويًا.",
        },
        bigmodelOauth: {
          pendingPrimary: "في انتظار تفويض BigModel",
          pendingSecondary:
            "أكمل تسجيل الدخول في المتصفح. يُكتشف التفويض تلقائيًا.",
          primary: "BigModel Coding Plan",
          secondary: "افتح تسجيل الدخول عبر المتصفح؛ يُكتشف التفويض تلقائيًا.",
        },
        zaiApiKey: {
          inputPrimary: "أدخل مفتاح Z.AI Coding Plan API",
          inputSecondary: "الصق المفتاح هنا. يُخفى أثناء الكتابة.",
          primary: "مفتاح Z.AI Coding Plan API",
          secondary: "الصق مفتاح Coding Plan API يدويًا.",
        },
        zaiOauth: {
          pendingPrimary: "في انتظار تفويض Z.AI",
          pendingSecondary:
            "أكمل تسجيل الدخول في المتصفح. سأُكمل عند انتهاء التفويض.",
          primary: "Z.AI Coding Plan",
          secondary: "فتح تسجيل الدخول في المتصفح وإنشاء مفتاح API لـ Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "أُلغي تسجيل الدخول. اختر طريقة الإعداد.",
        help: "Esc يلغي ويعود إلى خيارات الإعداد.",
        status: "بانتظار تفويض المتصفح...",
      },
      input: {
        cancelStatus: "أُلغي إدخال مفتاح API. اختر طريقة الإعداد.",
        clearStatus: "مُسح إدخال مفتاح API.",
        emptyStatus: "مفتاح API مطلوب.",
        help: "Enter يحفظ المفتاح. Esc يعود إلى خيارات الإعداد.",
        placeholder: "الصق مفتاح API",
        status: "أدخل مفتاح API ثم اضغط Enter.",
        submitStatus: "جارٍ حفظ مفتاح API...",
      },
      prompt: "اختر طريقة إعداد الدخول أو مفتاح API.",
      response: "اختر طريقة إعداد مزوّد Coding Plan.",
      title: "إعداد Coding Plan",
    },
    model: {
      requestFailed: (message) => `فشل طلب النموذج: ${message}`,
      responseReceived: "تم استلام استجابة النموذج.",
      responseReceivedWithTokens: (tokens) => `تم استلام استجابة النموذج. ${tokens} رمزًا.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `إعادة محاولة طلب النموذج ${attempt}/${Math.max(1, maxAttempts - 1)} خلال ${delay}: ${reason}`,
      streamStalled: "توقف بث النموذج.",
    },
    sidebar: {
      subagents: {
        title: "الوكلاء الفرعيون",
        empty: "لا وكلاء فرعيون بعد.",
        emptyOutput: "لا مخرجات بعد.",
        back: "← المحادثة الرئيسية",
        readonly: "قراءة فقط · Esc للعودة",
        loading: "جارٍ تحميل مخرجات الوكيل الفرعي...",
        unavailable: "مخرجات الوكيل الفرعي غير متاحة.",
        retry: "إعادة المحاولة",
        more: "تحميل المزيد",
        pendingMain: "المحادثة الرئيسية تحتاج إدخالك — عد للرد",
        ended: (count) => `انتهى (${count})`,
        status: {
          running: "قيد التشغيل",
          waiting: "في الانتظار",
          blocked: "معطّل",
          success: "مكتمل",
          failed: "فشل",
          cancelled: "أُلغي",
          lost: "مفقود",
        },
      },
      api: {
        empty: "لا استدعاءات API بعد.",
        model: "النموذج",
        more: (count) => `+${count} أخرى`,
        requests: "الطلبات",
        server: "الخادم",
      },
      cache: {
        hit: "مُصيب",
        lastHit: "آخر إصابة",
        lastMiss: "آخر إخفاق",
        readWrite: ({ read, write }) => `${read} قراءة / ${write} كتابة`,
        total: "الإجمالي",
      },
      context: {
        cache: "الذاكرة المؤقتة",
        cacheReadWrite: "قراءة/كتابة الذاكرة المؤقتة",
        inputOutput: "I/O",
        reason: "السبب",
        tokens: "الرموز",
        used: "المستخدم",
        window: "النافذة",
      },
      modifiedFiles: {
        empty: "لا تغييرات في الملفات بعد.",
        more: (count) => `+${count} أخرى`,
      },
      mcp: {
        empty: "لم يتم إعداد أي خوادم MCP.",
        loadFailed: "حالة MCP غير متاحة.",
        loading: "جارٍ تحميل حالة MCP...",
        more: (count) => `+${count} أخرى`,
        servers: "الخوادم",
        status: {
          connected: "متصل",
          connecting: "جارٍ الاتصال",
          disabled: "معطّل",
          disconnected: "منقطع",
          failed: "فشل",
          untrusted: "غير موثوق",
        },
        summary: ({ connected, total }) => `${connected}/${total} متصل`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "مكتمل",
        error: "خطأ",
        errorWithStatus: (statusCode) => `خطأ ${statusCode}`,
        pending: "قيد الانتظار",
      },
      status: {
        last: "الأخير",
      },
      run: {
        draft: "المسودة",
        draftChars: (count) => `${count} حرف`,
        draftEmpty: "فارغ",
        messages: "الرسائل",
        mode: "الوضع",
        model: "النموذج",
        provider: "مزوّد",
        thought: "الأفكار",
        trace: "تتبّع",
        turn: "الدور",
        workspace: "مساحة العمل",
      },
      sections: {
        apis: "واجهات API",
        context: "السياق",
        mcp: "بروتوكول MCP",
        modifiedFiles: "الملفات المعدّلة",
        run: "تشغيل",
        status: "الحالة",
        todos: "المهام",
      },
      shellSubtitle: "صدفة OpenTUI",
      title: "الشريط الجانبي",
      todos: {
        empty: "لا توجد مهام بعد.",
        more: (count) => `+${count} أخرى`,
        progress: "التقدّم",
      },
    },
    status: {
      compactFailed: "فشل ضغط السياق.",
      compacted: "تم تلخيص المحادثة.",
      compacting: "جارٍ ضغط السياق...",
      interruptedStreamDiscarded: "تم تجاهل تدفّق النموذج المتقطع.",
      modelCalling: "جارٍ استدعاء النموذج...",
      permissionRequested: (toolName) => `طُلب إذن لـ ${toolName}.`,
      permissionResolved: (toolName) => `تم البتّ في الإذن لـ ${toolName}.`,
      ready: "جاهز.",
      recoveringStream: "جارٍ استعادة تدفّق النموذج المتقطع...",
      retryingStream: "إعادة محاولة تدفّق النموذج...",
      sessionResumed: "استُؤنفت الجلسة.",
      targetChanged: (action) => `الهدف ${action}.`,
      thinking: "جارٍ التفكير...",
      toolCompleted: (toolName) => `اكتملت الأداة ${toolName}.`,
      toolFailed: (toolName) => `فشلت الأداة ${toolName}.`,
      toolPending: (toolName) => `الأداة ${toolName} في الانتظار.`,
      toolRunning: (toolName) => `الأداة ${toolName} قيد التشغيل.`,
      turnFailed: "فشل الدور.",
    },
    terminal: {
      requiresInteractive: "تتطلب TUI طرفية تفاعلية.",
      starting: "بدء ZCode... Ctrl+C للخروج",
    },
    transcript: {
      compact: {
        completed: "تم ضغط السياق",
        failed: "فشل ضغط السياق",
        interrupted: "انقطع ضغط السياق",
        retry: (command) => `Ctrl-R لإعادة محاولة ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `إعادة محاولة ضغط السياق (${attempt}/${maxAttempts})`
            : "إعادة محاولة ضغط السياق",
        skipped: "السيار�� محدَّث؛ لا حاجة للضغط",
        started: "جارٍ ضغط السياق",
      },
      roles: {
        agent: "الوكيل",
        system: "النظام",
        user: "المستخدم",
      },
      thought: {
        complete: "الفكرة",
        thinking: "جارٍ التفكير...",
      },
      title: "النص",
      workflow: {
        actors: "الفاعلون:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `الاستخدام: ${spentTokens} رمز`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `سير العمل ${label} - ${status} (${nodesSettled}/${nodesTotal} خطوة)`,
        error: (message) => `خطأ: ${message}`,
        expandHint: "+ للتوسيع",
        collapseHint: "- للطي",
        log: "سجل:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} خطوة منجزة`,
        result: (preview) => `النتيجة: ${preview}`,
        status: {
          completed: "مكتمل",
          errored: "به خطأ",
          pending: "قيد الانتظار",
          running: "قيد التشغيل",
          stopped: "متوقف",
        },
        stopReason: {
          user: "منك",
          model: "من الوكيل",
          provider: "خطأ النموذج",
          interrupted: "انتهت العملية",
          superseded: "استُبدلت بتشغيل معدَّل",
        },
        truncated: "(مقتطع - السجل الكامل في سجل التشغيل)",
        interruptedNotice: ({ label, runId }) =>
          `توقّف سير العمل ${label} ويمكن استئنافه: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter للتحديد، Esc للإلغاء",
      disabled: (reason) => ` [معطّل: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `تصفية: ${filter || "-"} | ${help ?? "Enter للتحديد، Esc للإلغاء"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "لا توجد مسارات لمساحة العمل مطابقة.",
      loading: "جارٍ تحميل مسارات مساحة العمل...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "الملفات",
    },
    slash: {
      title: "الأوامر",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
