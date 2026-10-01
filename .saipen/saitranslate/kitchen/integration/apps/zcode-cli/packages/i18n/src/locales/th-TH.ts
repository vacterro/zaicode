import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "th-TH",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `ค่า --locale ไม่รองรับ: ${value} ภาษาที่รองรับ: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto`,
    },
    help: (version) => `zcode ${version}

การใช้งาน:
  zcode [คำสั่ง] [ตัวเลือก]

หากไม่ระบุคำสั่ง zcode จะเปิด TUI แบบเต็มหน้าจอ

คำสั่ง:
  app-server รัน ZCode Protocol app server แบบ stdio
  commands   แสดงรายการ slash command แบบกำหนดเอง (\`commands list\`)
  doctor     ตรวจสอบสมมติฐานของ runtime และแพ็กเกจ
  login [zai|bigmodel]  เข้าสู่ระบบผ่านเบราว์เซอร์
  logout     ลบข้อมูลเข้าสู่ระบบ Z.AI ที่ใช้ร่วมกัน
  plugins    จัดการปลั๊กอินและ marketplace (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; ชื่อย่อ: plugin)
  skills     แสดงรายการ skills ในเครื่อง (\`skills list\`)
  tui        เปิด UI บนเทอร์มินัล
  version    แสดงเวอร์ชัน CLI

ตัวเลือก:
  -h, --help       แสดงความช่วยเหลือ
  -v, --version    แสดงเวอร์ชัน
  -p, --prompt <text>  รัน prompt เดียวโดยไม่เปิด TUI
  --memory-bench   เมื่อใช้ร่วมกับ --prompt ให้เปิดการสกัด Memory อัตโนมัติและรอก่อนออก (ต้องเปิดใช้ Memory)
  --browser-use <mode> เปิดใช้งาน backend Browser Use (รองรับ: headless)
  --surface <surface>  พื้นผิวการแสดงผลสำหรับ headless prompt/app-server: terminal หรือ desktop
  --browser-executable <path> ไฟล์ปฏิบัติการ Chrome/Chromium สำหรับ Browser Use แบบ headless
  --attach <path> แนบไฟล์ในเครื่องเข้ากับ --prompt; ทำซ้ำเพื่อแนบหลายไฟล์
  --cwd <path>     รันคำสั่งนี้จากไดเรกทอรีที่ระบุ
  --disallowed-tools, --disallowedTools <tools...>
    ปิดเครื่องมือทั้งหมดสำหรับการรัน prompt/TUI ครั้งนี้เท่านั้น; ค่าตั้งที่บันทึกไว้ไม่เปลี่ยน
    ชื่อเครื่องมือคั่นด้วยจุลภาคหรือช่องว่าง เช่น "Bash Edit"
    "Bash(git *)" จะปิด Bash ทั้งหมด; ไม่มีการจับคู่รูปแบบคำสั่ง
  --force-mcs      บังคับให้ถ่าย projection ระหว่างบทสนทนาสำหรับผู้ให้บริการ Anthropic
  --locale <locale>  ภาษาของ UI: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR หรือ auto
  --mode <mode>    โหมดสิทธิ์สำหรับ prompt: build, edit, plan หรือ yolo (ค่าเริ่มต้น yolo สำหรับ --prompt)
  --resume <sessionId>  เข้าสู่เซสชันที่บันทึกไว้ด้วย sessionId (sess_...)
  --target <text>  รันหรือกำหนดเป้าหมายของเซสชันในโหมด headless
  --target-replace แทนที่เป้าหมายเซสชันที่มีอยู่ซึ่งตั้งโดย --target
  -c, --continue        เข้าสู่เซสชันล่าสุดของไดเรกทอรีปัจจุบัน
  --json           พิมพ์ JSON ที่อ่านด้วยเครื่องจากส่วนที่รองรับ
  --no-browser     พิมพ์ URL ของ OAuth โดยไม่เปิดเบราว์เซอร์
  --no-color       ปิดสี ANSI
  --verbose        พิมพ์รายละเอียดวินิจฉัยเพิ่มเติม

Slash Commands:
  /help [คำสั่ง]       แสดงความช่วยเหลือของ slash command
  /login                เลือกเข้าสู่ระบบผ่านเบราว์เซอร์ Z.AI หรือ BigModel
  /logout               ลบข้อมูลเข้าสู่ระบบ Z.AI ที่ใช้ร่วมกัน
  /compact [คำแนะนำ]  ย่อบทสนทนาปัจจุบัน
  /expert [status|resume|stop|<task>]  รันหรือจัดการเวิร์กโฟลว์ผู้เชี่ยวชาญ
  /dwf [list|cancel|resume]  แสดง ยกเลิก หรือเข้าสู่การรันเวิร์กโฟลว์แบบไดนามิก
  /fork [latest|checkpointId]  แตกเซสชันใหม่จาก checkpoint ของ workspace
  /mcp [list|status|connect|disconnect]  แสดงหรือจัดการเซิร์ฟเวอร์ MCP
  /mode [mode]          แสดงหรือสลับโหมดสิทธิ์: build, edit, plan หรือ yolo
  /model [id]           แสดงหรือสลับโมเดลของเซสชันปัจจุบัน
  /new                  เริ่มเซสชันใหม่ใน TUI
  /resume [sessionId]   เข้าสู่เซสชันด้วย sessionId; ละเว้นไว้เพื่อใช้เซสชันล่าสุดใน cwd
  /rewind [latest|checkpointId]  แสดง checkpoint ล่าสุดหรือกู้คืนไฟล์ใน workspace
  /skill [name] [task]  แสดงรายการ skills หรือบังคับให้ prompt ถัดไปโหลด skill
  /goal [action]        แสดงหรือกำหนดเป้าหมายของเซสชันปัจจุบัน
`,
  },
  tui: {
    copy: {
      copied: "คัดลอกข้อความที่เลือกไปยังคลิปบอร์ดแล้ว",
      failed: "ไม่สามารถคัดลอกข้อความที่เลือกได้",
      unavailable: "ไม่รองรับการคัดลอกข้อความผ่านคลิปบอร์ดในเทอร์มินัลนี้",
    },
    effort: {
      disabled: "ปิดใช้งาน",
      enabled: "เปิดใช้งาน",
    },
    input: {
      activeStatusHint: "กด esc เพื่อขัดจังหวะ",
      busyPlaceholder: "พิมพ์เพื่อเข้าคิว",
      placeholder: "พิมพ์ prompt",
      queuedMore: (count) => `+ อีก ${count} รายการในคิว`,
      queuedSubmitHint: "ส่งหลังการเรียกเครื่องมือครั้งถัดไป",
      queuedTitle: (count) => ` คิว (${count}) `,
      title: "อินพุต",
      noHistorySource: "ยังไม่ได้กำหนดแหล่งข้อมูลประวัติอินพุต",
      noPreviousInput: "ไม่มีอินพุตก่อนหน้าสำหรับโปรเจกต์นี้",
      restoredPreviousInput: "กู้คืนอินพุตก่อนหน้าแล้ว",
      restoredPreviousInputWithAttachments: (count) =>
        `กู้คืนอินพุตก่อนหน้าพร้อมไฟล์แนบ ${count} รายการ`,
      restorePreviousInputFailed: "ไม่สามารถกู้คืนอินพุตก่อนหน้าได้",
      typePrompt: "พิมพ์คำถามแล้วกด Enter",
    },
    loginRequired: {
      help: "ใช้ /model เพื่อดูโมเดล หรือ /login เพื่อเชื่อมต่อบัญชี Coding Plan",
      message: "ไม่มีโมเดลที่ใช้ได้ กำหนดค่าผู้ให้บริการหรือเข้าสู่ระบบด้วย /login",
      status: "ไม่มีโมเดลที่ใช้ได้ กำหนดค่าผู้ให้บริการหรือเข้าสู่ระบบด้วย /login",
      title: "ต้องตั้งค่าโมเดล",
    },
    loginSetup: {
      emptyMessage: "ไม่มีตัวเลือกการเข้าสู่ระบบ",
      help: "ใช้ Up/Down เพื่อเลือก Enter เพื่อยืนยัน",
      options: {
        bigmodelApiKey: {
          inputPrimary: "กรอก BigModel Coding Plan API Key",
          inputSecondary: "วางคีย์ที่นี่ จะถูกซ่อนขณะพิมพ์",
          primary: "คีย์ API ของ BigModel Coding Plan",
          secondary: "วาง Coding Plan API key ด้วยมือ",
        },
        bigmodelOauth: {
          pendingPrimary: "กำลังรอการอนุญาตจาก BigModel",
          pendingSecondary:
            "เข้าสู่ระบบให้เสร็จในเบราว์เซอร์ ระบบจะตรวจจับการอนุญาตให้อัตโนมัติ",
          primary: "แพ็กเกจ BigModel Coding Plan",
          secondary: "เปิดเข้าสู่ระบบผ่านเบราว์เซอร์ ระบบจะตรวจจับการอนุญาตให้อัตโนมัติ",
        },
        zaiApiKey: {
          inputPrimary: "กรอก Z.AI Coding Plan API Key",
          inputSecondary: "วางคีย์ที่นี่ จะถูกซ่อนขณะพิมพ์",
          primary: "คีย์ API ของ Z.AI Coding Plan",
          secondary: "วาง Coding Plan API key ด้วยมือ",
        },
        zaiOauth: {
          pendingPrimary: "กำลังรอการอนุญาตจาก Z.AI",
          pendingSecondary:
            "เข้าสู่ระบบให้เสร็จในเบราว์เซอร์ ฉันจะดำเนินต่อเมื่อการอนุญาตเสร็จสิ้น",
          primary: "Z.AI Coding Plan",
          secondary: "เปิดเบราว์เซอร์เข้าสู่ระบบและสร้าง Coding Plan API key",
        },
      },
      pending: {
        cancelStatus: "ยกเลิกการเข้าสู่ระบบ เลือกวิธีตั้งค่า",
        help: "Esc ยกเลิกและกลับไปที่ตัวเลือกตั้งค่า",
        status: "กำลังรอการอนุญาตจากเบราว์เซอร์...",
      },
      input: {
        cancelStatus: "ยกเลิกการกรอก API key เลือกวิธีตั้งค่า",
        clearStatus: "ล้างข้อมูล API key แล้ว",
        emptyStatus: "ต้องใส่ API key",
        help: "Enter บันทึกคีย์ Esc กลับไปที่ตัวเลือกตั้งค่า",
        placeholder: "วาง API key",
        status: "ใส่ API key แล้วกด Enter",
        submitStatus: "กำลังบันทึก API key...",
      },
      prompt: "เลือกวิธีตั้งค่าด้วยการเข้าสู่ระบบหรือ API key",
      response: "เลือกวิธีตั้งค่าผู้ให้บริการ Coding Plan",
      title: "ตั้งค่า Coding Plan",
    },
    model: {
      requestFailed: (message) => `คำขอโมเดลล้มเหลว: ${message}`,
      responseReceived: "ได้รับการตอบจากโมเดลแล้ว",
      responseReceivedWithTokens: (tokens) => `ได้รับการตอบจากโมเดลแล้ว ${tokens} โทเคน`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `ลองคำขอโมเดลใหม่ ${attempt}/${Math.max(1, maxAttempts - 1)} ใน ${delay}: ${reason}`,
      streamStalled: "สตรีมโมเดลค้าง",
    },
    sidebar: {
      subagents: {
        title: "ซับเอเจนต์",
        empty: "ยังไม่มีซับเอเจนต์",
        emptyOutput: "ยังไม่มีผลลัพธ์",
        back: "← แชทหลัก",
        readonly: "อ่านอย่างเดียว · Esc เพื่อกลับ",
        loading: "กำลังโหลดผลลัพธ์ซับเอเจนต์...",
        unavailable: "ไม่มีผลลัพธ์ซับเอเจนต์",
        retry: "ลองอีกครั้ง",
        more: "โหลดเพิ่ม",
        pendingMain: "แชทหลักต้องการอินพุตจากคุณ — กลับไปตอบ",
        ended: (count) => `จบแล้ว (${count})`,
        status: {
          running: "กำลังทำงาน",
          waiting: "รอ",
          blocked: "ติดขัด",
          success: "สำเร็จ",
          failed: "ล้มเหลว",
          cancelled: "ยกเลิกแล้ว",
          lost: "ขาดหาย",
        },
      },
      api: {
        empty: "ยังไม่มีการเรียก API",
        model: "โมเดล",
        more: (count) => `+${count} รายการ`,
        requests: "คำขอ",
        server: "เซิร์ฟเวอร์",
      },
      cache: {
        hit: "พบ",
        lastHit: "พบล่าสุด",
        lastMiss: "ไม่พบล่าสุด",
        readWrite: ({ read, write }) => `${read} อ่าน / ${write} เขียน`,
        total: "รวม",
      },
      context: {
        cache: "แคช",
        cacheReadWrite: "แคช R/W",
        inputOutput: "I/O",
        reason: "เหตุผล",
        tokens: "โทเคน",
        used: "ใช้แล้ว",
        window: "ช่วง",
      },
      modifiedFiles: {
        empty: "ยังไม่มีการเปลี่ยนแปลงไฟล์",
        more: (count) => `+${count} รายการ`,
      },
      mcp: {
        empty: "ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์ MCP",
        loadFailed: "ไม่สามารถดูสถานะ MCP ได้",
        loading: "กำลังโหลดสถานะ MCP...",
        more: (count) => `+${count} รายการ`,
        servers: "เซิร์ฟเวอร์",
        status: {
          connected: "เชื่อมต่อแล้ว",
          connecting: "กำลังเชื่อมต่อ",
          disabled: "ปิดใช้งาน",
          disconnected: "เชื่อมต่อหลุด",
          failed: "ล้มเหลว",
          untrusted: "ไม่น่าเชื่อถือ",
        },
        summary: ({ connected, total }) => `เชื่อมต่อแล้ว ${connected}/${total}`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "เสร็จสมบูรณ์",
        error: "ข้อผิดพลาด",
        errorWithStatus: (statusCode) => `ข้อผิดพลาด ${statusCode}`,
        pending: "รออยู่",
      },
      status: {
        last: "ล่าสุด",
      },
      run: {
        draft: "ร่าง",
        draftChars: (count) => `${count} อักขระ`,
        draftEmpty: "ว่างเปล่า",
        messages: "ข้อความ",
        mode: "โหมด",
        model: "โมเดล",
        provider: "ผู้ให้บริการ",
        thought: "ความคิด",
        trace: "ร่องรอย",
        turn: "เทิร์น",
        workspace: "พื้นที่ทำงาน",
      },
      sections: {
        apis: "API",
        context: "บริบท",
        mcp: "MCP",
        modifiedFiles: "ไฟล์ที่ถูกแก้ไข",
        run: "รัน",
        status: "สถานะ",
        todos: "รายการงาน",
      },
      shellSubtitle: "เชลล์ OpenTUI",
      title: "แถบด้านข้าง",
      todos: {
        empty: "ยังไม่มีรายการงาน",
        more: (count) => `+${count} เพิ่มเติม`,
        progress: "ความคืบหน้า",
      },
    },
    status: {
      compactFailed: "การบีบอัดบริบทล้มเหลว",
      compacted: "ย่อบทสนทนาแล้ว",
      compacting: "กำลังบีบอัดบริบท...",
      interruptedStreamDiscarded: "ทิ้งสตรีมโมเดลที่ถูกขัดจังหวะแล้ว",
      modelCalling: "กำลังเรียกโมเดล...",
      permissionRequested: (toolName) => `ขอสิทธิ์สำหรับ ${toolName}`,
      permissionResolved: (toolName) => `แจ้งผลคำขอสิทธิ์สำหรับ ${toolName}แล้ว`,
      ready: "พร้อม",
      recoveringStream: "กำลังกู้สตรีมโมเดลที่ถูกขัดจังหวะ...",
      retryingStream: "กำลังลองสตรีมโมเดลใหม่...",
      sessionResumed: "กลับมาที่เซสชันแล้ว",
      targetChanged: (action) => `เป้าหมาย ${action}`,
      thinking: "กำลังคิด...",
      toolCompleted: (toolName) => `เครื่องมือ ${toolName} ทำงานสำเร็จ`,
      toolFailed: (toolName) => `เครื่องมือ ${toolName} ล้มเหลว`,
      toolPending: (toolName) => `เครื่องมือ ${toolName} รอดำเนินการ`,
      toolRunning: (toolName) => `เครื่องมือ ${toolName} กำลังทำงาน`,
      turnFailed: "เทิร์นล้มเหลว",
    },
    terminal: {
      requiresInteractive: "TUI ต้องใช้เทอร์มินัลแบบโต้ตอบ",
      starting: "กำลังเริ่ม ZCode... Ctrl+C เพื่อออก",
    },
    transcript: {
      compact: {
        completed: "บีบอัดบริบทแล้ว",
        failed: "การบีบอัดบริบทล้มเหลว",
        interrupted: "การบีบอัดบริบทถูกขัดจังหวะ",
        retry: (command) => `Ctrl-R เพื่อลองใหม่ ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `กำลังลองบีบอัดบริบทใหม่ (${attempt}/${maxAttempts})`
            : "กำลังลองบีบอัดบริบทใหม่",
        skipped: "บริบทอัปเดตแล้ว ไม่ต้องบีบอัด",
        started: "กำลังบีบอัดบริบท",
      },
      roles: {
        agent: "เอเจนต์",
        system: "ระบบ",
        user: "ผู้ใช้",
      },
      thought: {
        complete: "ความคิด",
        thinking: "กำลังคิด...",
      },
      title: "บทสนทนา",
      workflow: {
        actors: "ผู้ร่วม:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `ใช้: ${spentTokens} โทเคน`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `เวิร์กโฟลว์ ${label} - ${status} (${nodesSettled}/${nodesTotal} ขั้น)`,
        error: (message) => `ข้อผิดพลาด: ${message}`,
        expandHint: "+ เพื่อขยาย",
        collapseHint: "- เพื่อยุบ",
        log: "บันทึก:",
        nodes: ({ nodesSettled, nodesTotal }) => `ขั้น ${nodesSettled}/${nodesTotal} สรุปแล้ว`,
        result: (preview) => `ผล: ${preview}`,
        status: {
          completed: "เสร็จแล้ว",
          errored: "ผิดพลาด",
          pending: "รออยู่",
          running: "กำลังรัน",
          stopped: "หยุดแล้ว",
        },
        stopReason: {
          user: "โดยคุณ",
          model: "โดยเอเจนต์",
          provider: "โมเดลผิดพลาด",
          interrupted: "กระบวนการจบแล้ว",
          superseded: "ถูกแทนที่ด้วยรอบที่แก้ไข",
        },
        truncated: "(ตัดทอน - ประวัติทั้งหมดอยู่ใน run journal)",
        interruptedNotice: ({ label, runId }) =>
          `เวิร์กโฟลว์ ${label} ถูกขัดจังหวะ และทำต่อได้: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter เลือก, Esc ยกเลิก",
      disabled: (reason) => ` [ปิดใช้งาน: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `ตัวกรอง: ${filter || "-"} | ${help ?? "Enter เลือก, Esc ยกเลิก"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "ไม่พบพาธเวิร์กสเปซที่ตรงกัน",
      loading: "กำลังโหลดพาธเวิร์กสเปซ...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "ไฟล์",
    },
    slash: {
      title: "คำสั่ง",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
