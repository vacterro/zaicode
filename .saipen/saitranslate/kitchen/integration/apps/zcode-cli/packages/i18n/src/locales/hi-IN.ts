import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "hi-IN",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `असमर्थित --locale मान: ${value}। समर्थित लोकेल: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto।`,
    },
    help: (version) => `zcode ${version}

उपयोग:
  zcode [command] [options]

कोई command नहीं देने पर, zcode पूर्ण-स्क्रीन TUI खोलता है।

Commands:
  app-server ZCode Protocol stdio ऐप सर्वर चलाएँ
  commands   कस्टम स्लैश commands सूचीबद्ध करें (\`commands list\`)
  doctor     रनटाइम और पैकेजिंग मान्यताओं की जाँच करें
  login [zai|bigmodel]  ब्राउज़र प्राधिकरण से साइन इन करें
  logout     साझा Z.AI लॉगिन क्रेडेंशियल हटाएँ
  plugins    प्लगइन और मार्केटप्लेस प्रबंधित करें (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     लोकल स्किल्स सूचीबद्ध करें (\`skills list\`)
  tui        टर्मिनल UI खोलें
  version    CLI संस्करण छापें

Options:
  -h, --help       सहायता दिखाएँ
  -v, --version    संस्करण दिखाएँ
  -p, --prompt <text>  TUI खोले बिना एकल प्रॉम्प्ट चलाएँ
  --memory-bench   --prompt के साथ, स्वचालित Memory एक्सट्रैक्शन चालू करें और बाहर निकलने से पहले प्रतीक्षा करें (Memory सक्षम होना चाहिए)
  --browser-use <mode> Browser Use बैकएंड सक्षम करें (समर्थित: headless)
  --surface <surface>  headless प्रॉम्प्ट/ऐप-सर्वर के लिए प्रेज़ेंटेशन सर्फ़ेस: terminal या desktop
  --browser-executable <path> headless Browser Use के लिए Chrome/Chromium एक्ज़िक्यूटेबल
  --attach <path>  --prompt में लोकल फ़ाइल अटैच करें; कई फ़ाइलों के लिए दोहराएँ
  --cwd <path>     दिए गए डिरेक्टरी से यह command चलाएँ
  --disallowed-tools, --disallowedTools <tools...>
    केवल इस प्रॉम्प्ट/TUI रन के लिए पूरे टूल हटाएँ; सहेजी गई सेटिंग्स अपरिवर्तित रहती हैं।
    कॉमा या स्पेस से अलग टूल नाम, जैसे "Bash Edit"।
    "Bash(git *)" सारे Bash हटाता है; command पैटर्न मेल नहीं खाते।
  --force-mcs      Anthropic प्रोवाइडर के लिए बीच-बीच में सिस्टम प्रोजेक्शन बल्यू करें
  --locale <locale>  UI लोकेल: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, या auto
  --mode <mode>    प्रॉम्प्ट के लिए अनुमति मोड: build, edit, plan, या yolo (--prompt के लिए डिफ़ॉल्ट: yolo)
  --resume <sessionId>  sessionId से सहेजा गया सत्र फिर शुरू करें (sess_...)
  --target <text>  headless मोड में सत्र लक्ष्य चलाएँ या सेट करें
  --target-replace --target द्वारा सेट किया गया कोई मौजूदा सत्र लक्ष्य बदलें
  -c, --continue        वर्तमान डिरेक्टरी के लिए नवीनतम सत्र फिर शुरू करें
  --json           जहाँ समर्थित हो, मशीन-पठनीय JSON छापें
  --no-browser     ब्राउज़र खोले बिना OAuth URL छापें
  --no-color       ANSI रंग अक्षम करें
  --verbose        अतिरिक्त डायग्नोस्टिक विवरण छापें

Slash Commands:
  /help [command]       स्लैश command सहायता दिखाएँ
  /login                Z.AI या BigModel ब्राउज़र लॉगिन चुनें
  /logout               साझा Z.AI लॉगिन क्रेडेंशियल हटाएँ
  /compact [instructions]  वर्तमान बातचीत को संक्षिप्त करें
  /expert [status|resume|stop|<task>]  विशेषज्ञ workflow चलाएँ या प्रबंधित करें
  /dwf [list|cancel|resume]  डायनेमिक workflow रन सूचीबद्ध करें, रद्द करें या फिर शुरू करें
  /fork [latest|checkpointId]  workspace checkpoint से नया सत्र फोर्क करें
  /mcp [list|status|connect|disconnect]  MCP सर्वर दिखाएँ या प्रबंधित करें
  /mode [mode]          अनुमति मोड दिखाएँ या बदलें: build, edit, plan, या yolo
  /model [id]           वर्तमान सत्र मॉडल दिखाएँ या बदलें
  /new                  TUI में नया सत्र शुरू करें
  /resume [sessionId]   sessionId से सत्र फिर शुरू करें; नवीनतम के लिए खाली छोड़ें
  /rewind [latest|checkpointId]  नवीनतम checkpoint दिखाएँ या workspace फ़ाइलें बहाल करें
  /skill [name] [task]  स्किल्स सूचीबद्ध करें, या अगले प्रॉम्प्ट को एक लोड करने पर बाध्य करें
  /goal [action]        वर्तमान सत्र लक्ष्य दिखाएँ या सेट करें
`,
  },
  tui: {
    copy: {
      copied: "चयनित टेक्स्ट क्लिपबोर्ड पर कॉपी हो गया।",
      failed: "चयनित टेक्स्ट कॉपी नहीं हो सका।",
      unavailable: "इस टर्मिनल में टेक्स्ट क्लिपबोर्ड कॉपी उपलब्ध नहीं है।",
    },
    effort: {
      disabled: "अक्षम",
      enabled: "सक्षम",
    },
    input: {
      activeStatusHint: "रोकने के लिए esc दबाएँ",
      busyPlaceholder: "इनपुट कतार में जोड़ने के लिए टाइप करें",
      placeholder: "कोई प्रॉम्प्ट लिखें",
      queuedMore: (count) => `+ ${count} और कतार में`,
      queuedSubmitHint: "अगले टूल कॉल के बाद जमा हुआ।",
      queuedTitle: (count) => ` कतार (${count}) `,
      title: "इनपुट",
      noHistorySource: "कोई इनपुट इतिहास स्रोत कॉन्फ़िगर नहीं है।",
      noPreviousInput: "इस प्रोजेक्ट के लिए कोई पिछला इनपुट नहीं।",
      restoredPreviousInput: "पिछला इनपुट बहाल किया गया।",
      restoredPreviousInputWithAttachments: (count) =>
        `पिछला इनपुट ${count} अटैचमेंट सहित बहाल किया गया।`,
      restorePreviousInputFailed: "पिछला इनपुट बहाल नहीं हो सका।",
      typePrompt: "कोई सवाल लिखें और Enter दबाएँ।",
    },
    loginRequired: {
      help: "मॉडल देखने के लिए /model का उपयोग करें, या Coding Plan खाता जोड़ने के लिए /login।",
      message: "कोई मॉडल उपलब्ध नहीं। कोई प्रोवाइडर कॉन्फ़िगर करें या /login से साइन इन करें।",
      status: "कोई मॉडल उपलब्ध नहीं। कोई प्रोवाइडर कॉन्फ़िगर करें या /login से साइन इन करें।",
      title: "मॉडल सेटअप आवश्यक",
    },
    loginSetup: {
      emptyMessage: "कोई लॉगिन विकल्प उपलब्ध नहीं।",
      help: "चुनने के लिए Up/Down, चयन के लिए Enter दबाएँ।",
      options: {
        bigmodelApiKey: {
          inputPrimary: "BigModel Coding Plan API Key दर्ज करें",
          inputSecondary: "कुंजी यहाँ पेस्ट करें। टाइप करते समय यह छिपा रहता है।",
          primary: "BigModel का Coding Plan API कुंजी",
          secondary: "Coding Plan API कुंजी मैन्युअल रूप से पेस्ट करें।",
        },
        bigmodelOauth: {
          pendingPrimary: "BigModel प्राधिकरण की प्रतीक्षा में",
          pendingSecondary:
            "अपने ब्राउज़र में साइन इन पूरा करें। प्राधिकरण अपने आप पहचान लिया जाता है।",
          primary: "BigModel का Coding Plan",
          secondary: "ब्राउज़र लॉगिन खोलें; प्राधिकरण अपने आप पहचान लिया जाता है।",
        },
        zaiApiKey: {
          inputPrimary: "Z.AI Coding Plan API Key दर्ज करें",
          inputSecondary: "कुंजी यहाँ पेस्ट करें। टाइप करते समय यह छिपा रहता है।",
          primary: "Z.AI का Coding Plan API कुंजी",
          secondary: "Coding Plan API कुंजी मैन्युअल रूप से पेस्ट करें।",
        },
        zaiOauth: {
          pendingPrimary: "Z.AI प्राधिकरण की प्रतीक्षा में",
          pendingSecondary:
            "अपने ब्राउज़र में साइन इन पूरा करें। प्राधिकरण पूरा होने पर मैं आगे बढ़ूँगा।",
          primary: "Z.AI Coding Plan",
          secondary: "ब्राउज़र में लॉगिन करें, Coding Plan API key बनाएं।",
        },
      },
      pending: {
        cancelStatus: "लॉगिन रद्द। सेटअप तरीका चुनें।",
        help: "Esc रद्द करके सेटअप विकल्पों पर लौटता है।",
        status: "ब्राउज़र प्राधिकरण की प्रतीक्षा...",
      },
      input: {
        cancelStatus: "API key दर्ज करना रद्द। सेटअप तरीका चुनें।",
        clearStatus: "API key इनपुट साफ़ हुआ।",
        emptyStatus: "API key ज़रूरी है।",
        help: "Enter key सेव करता है। Esc सेटअप विकल्पों पर लौटता है।",
        placeholder: "API key पेस्ट करें",
        status: "API key दर्ज करें, फिर Enter दबाएं।",
        submitStatus: "API key सेव हो रही है...",
      },
      prompt: "लॉगिन या API key सेटअप तरीका चुनें।",
      response: "Coding Plan provider कैसे सेटअप करना है, चुनें।",
      title: "Coding Plan सेटअप करें",
    },
    model: {
      requestFailed: (message) => `मॉडल अनुरोध विफल: ${message}`,
      responseReceived: "मॉडल प्रतिक्रिया मिली।",
      responseReceivedWithTokens: (tokens) => `मॉडल प्रतिक्रिया मिली। ${tokens} tokens।`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `मॉडल अनुरोध ${attempt}/${Math.max(1, maxAttempts - 1)} पुनः ${delay} में: ${reason}`,
      streamStalled: "मॉडल स्ट्रीम रुक गई।",
    },
    sidebar: {
      subagents: {
        title: "सबएजेंट",
        empty: "अभी कोई सबएजेंट नहीं।",
        emptyOutput: "अभी कोई आउटपुट नहीं।",
        back: "← मुख्य बातचीत",
        readonly: "केवल पढ़ने योग्य · वापसी के लिए Esc",
        loading: "सबएजेंट आउटपुट लोड हो रहा है...",
        unavailable: "सबएजेंट आउटपुट उपलब्ध नहीं।",
        retry: "पुनः प्रयास",
        more: "और लोड करें",
        pendingMain: "मुख्य बातचीत को आपके इनपुट की ज़रूरत है — जवाब देने के लिए लौटें",
        ended: (count) => `समाप्त (${count})`,
        status: {
          running: "चल रहा",
          waiting: "प्रतीक्षा में",
          blocked: "अवरुद्ध",
          success: "पूर्ण",
          failed: "विफल",
          cancelled: "रद्द",
          lost: "खोया",
        },
      },
      api: {
        empty: "अभी कोई API कॉल नहीं।",
        model: "मॉडल",
        more: (count) => `+${count} और`,
        requests: "रिक्वेस्ट",
        server: "सर्वर",
      },
      cache: {
        hit: "हिट",
        lastHit: "अंतिम हिट",
        lastMiss: "अंतिम मिस",
        readWrite: ({ read, write }) => `${read} रीड / ${write} राइट`,
        total: "कुल",
      },
      context: {
        cache: "कैश",
        cacheReadWrite: "कैश R/W",
        inputOutput: "I/O",
        reason: "कारण",
        tokens: "टोकन",
        used: "उपयोग",
        window: "विंडो",
      },
      modifiedFiles: {
        empty: "अभी तक कोई फ़ाइल परिवर्तन नहीं।",
        more: (count) => `+${count} और`,
      },
      mcp: {
        empty: "कोई MCP सर्वर कॉन्फ़िगर नहीं है।",
        loadFailed: "MCP स्थिति उपलब्ध नहीं।",
        loading: "MCP स्थिति लोड हो रही है...",
        more: (count) => `+${count} और`,
        servers: "सर्वर",
        status: {
          connected: "कनेक्टेड",
          connecting: "कनेक्ट हो रहा",
          disabled: "बंद",
          disconnected: "डिस्कनेक्टेड",
          failed: "विफल",
          untrusted: "अविश्वसित",
        },
        summary: ({ connected, total }) => `${connected}/${total} कनेक्टेड`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "पूर्ण",
        error: "त्रुटि",
        errorWithStatus: (statusCode) => `त्रुटि ${statusCode}`,
        pending: "लंबित",
      },
      status: {
        last: "अंतिम",
      },
      run: {
        draft: "ड्राफ़्ट",
        draftChars: (count) => `${count} वर्ण`,
        draftEmpty: "खाली",
        messages: "संदेश",
        mode: "मोड",
        model: "मॉडल",
        provider: "प्रोवाइडर",
        thought: "विचार",
        trace: "ट्रेस",
        turn: "टर्न",
        workspace: "वर्कस्पेस",
      },
      sections: {
        apis: "एपीआई",
        context: "संदर्भ",
        mcp: "MCP सेटअप",
        modifiedFiles: "संशोधित फ़ाइलें",
        run: "चलाएँ",
        status: "स्थिति",
        todos: "टोडो",
      },
      shellSubtitle: "OpenTUI शेल",
      title: "साइडबार",
      todos: {
        empty: "अभी कोई टोडो नहीं।",
        more: (count) => `+${count} और`,
        progress: "प्रगति",
      },
    },
    status: {
      compactFailed: "संदर्भ संपीड़न विफल।",
      compacted: "बातचीत संक्षिप्त की गई।",
      compacting: "संदर्भ संपीड़ित हो रहा है...",
      interruptedStreamDiscarded: "रुका हुआ मॉडल स्ट्रीम छोड़ दिया गया।",
      modelCalling: "मॉडल को कॉल किया जा रहा है...",
      permissionRequested: (toolName) => `${toolName} के लिए अनुमति माँगी गई।`,
      permissionResolved: (toolName) => `${toolName} के लिए अनुमति मिल गई।`,
      ready: "तैयार।",
      recoveringStream: "रुका हुआ मॉडल स्ट्रीम पुनः प्राप्त हो रहा है...",
      retryingStream: "मॉडल स्ट्रीम फिर से चालू...",
      sessionResumed: "सत्र फिर से शुरू हुआ।",
      targetChanged: (action) => `लक्ष्य ${action}।`,
      thinking: "विचार हो रहा है...",
      toolCompleted: (toolName) => `टूल ${toolName} पूरा हुआ।`,
      toolFailed: (toolName) => `टूल ${toolName} विफल।`,
      toolPending: (toolName) => `टूल ${toolName} लंबित।`,
      toolRunning: (toolName) => `टूल ${toolName} चल रहा है।`,
      turnFailed: "टर्न विफल।",
    },
    terminal: {
      requiresInteractive: "TUI के लिए इंटरैक्टिव टर्मिनल चाहिए।",
      starting: "ZCode शुरू हो रहा है... बाहर निकलने के लिए Ctrl+C",
    },
    transcript: {
      compact: {
        completed: "संदर्भ संपीड़ित",
        failed: "संदर्भ संपीड़न विफल",
        interrupted: "संदर्भ संपीड़न रुक गया",
        retry: (command) => `${command} फिर से करने के लिए Ctrl-R`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `संदर्भ संपीड़न का पुनः प्रयास (${attempt}/${maxAttempts})`
            : "संदर्भ संपीड़न का पुनः प्रयास",
        skipped: "संदर्भ अद्यतत है; संपीड़न आवश्यक नहीं",
        started: "संदर्भ संपीड़ित हो रहा है",
      },
      roles: {
        agent: "एजेंट",
        system: "सिस्टम",
        user: "उपयोगकर्ता",
      },
      thought: {
        complete: "विचार",
        thinking: "सोच रहा है...",
      },
      title: "ट्रांसक्रिप्ट",
      workflow: {
        actors: "एक्टर:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `उपयोग: ${spentTokens} टोकन`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `वर्कफ़्लो ${label} - ${status} (${nodesSettled}/${nodesTotal} चरण)`,
        error: (message) => `त्रुटि: ${message}`,
        expandHint: "+ विस्तार करने के लिए",
        collapseHint: "- संक्षिप्त करने के लिए",
        log: "लॉग:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} चरण निष्पन्न`,
        result: (preview) => `परिणाम: ${preview}`,
        status: {
          completed: "पूर्ण",
          errored: "त्रुटि",
          pending: "लंबित",
          running: "चल रहा है",
          stopped: "रुका हुआ",
        },
        stopReason: {
          user: "आपके द्वारा",
          model: "एजेंट द्वारा",
          provider: "मॉडल त्रुटि",
          interrupted: "प्रक्रिया समाप्त",
          superseded: "संशोधित रन द्वारा विस्थापित",
        },
        truncated: "(छोटा किया गया - पूरा इतिहास रन जर्नल में)",
        interruptedNotice: ({ label, runId }) =>
          `वर्कफ़्लो ${label} रुक गया और फिर से जारी किया जा सकता है: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter चुनता है, Esc रद्द करता है",
      disabled: (reason) => ` [अक्षम: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `फ़िल्टर: ${filter || "-"} | ${help ?? "Enter चुनता है, Esc रद्द करता है"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "कोई मेल खाता वर्कस्पेस पथ नहीं।",
      loading: "वर्कस्पेस पथ लोड हो रहे हैं...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "फ़ाइलें",
    },
    slash: {
      title: "कमांड",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
