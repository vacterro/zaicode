import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "tr-TR",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Desteklenmeyen --locale değeri: ${value}. Desteklenen yereller: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR, auto.`,
    },
    help: (version) => `zcode ${version}

Kullanım:
  zcode [command] [options]

Komut verilmezse zcode tam ekran TUI'yi açar.

Komutlar:
  app-server ZCode Protocol stdio uygulama sunucusunu çalıştır
  commands   Özel eğik çizgi komutlarını listele (\`commands list\`)
  doctor     Çalışma zamanı ve paketleme varsayımlarını incele
  login [zai|bigmodel]  Tarayıcı yetkilendirmesiyle giriş yap
  logout     Paylaşılan Z.AI giriş kimlik bilgilerini kaldır
  plugins    Eklentileri ve pazaryerlerini yönet (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; takma ad: plugin)
  skills     Yerel becerileri listele (\`skills list\`)
  tui        Terminal arayüzünü aç
  version    CLI sürümünü yazdır

Seçenekler:
  -h, --help       Yardım göster
  -v, --version    Sürümü göster
  -p, --prompt <text>  TUI açmadan tek bir istem çalıştır
  --memory-bench   --prompt ile birlikte otomatik Memory çıkarımını etkinleştir ve çıkmadan önce bekle (Memory etkin olmalı)
  --browser-use <mode> Browser Use arka uç motorunu etkinleştir (desteklenen: headless)
  --surface <surface>  Headless istemler/uygulama sunucusu için sunum yüzeyi: terminal veya desktop
  --browser-executable <path> Headless Browser Use için Chrome/Chromium çalıştırılabilir dosyası
  --attach <path> Yerel bir dosyayı --prompt değerine ekle; birden çok dosya için tekrarla
  --cwd <path>     Bu komutu verilen dizinden çalıştır
  --disallowed-tools, --disallowedTools <tools...>
    Bu istem/TUI çalışması için yalnızca tüm araçları kaldır; kayıtlı ayarlar değişmez.
    Virgül veya boşlukla ayrılmış araç adları, örn. "Bash Edit".
    "Bash(git *)" Bash'ın tamamını kaldırır; komut desenleri eşleştirilmez.
  --force-mcs      Anthropic sağlayıcıları için konuşma ortası sistem projeksiyonunu zorla
  --locale <locale>  Arayüz yereli: en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR veya auto
  --mode <mode>    İstemler için izin modu: build, edit, plan veya yolo (--prompt için varsayılan: yolo)
  --resume <sessionId>  Kalıcı bir oturumu sessionId ile sürdür (sess_...)
  --target <text>  Headless modda oturum hedefini çalıştır veya ayarla
  --target-replace --target tarafından ayarlanmış mevcut oturum hedefini değiştir
  -c, --continue        Bu dizin için en son oturumu sürdür
  --json           Desteklendiği yerlerde makine tarafından okunabilir JSON yazdır
  --no-browser     OAuth URL'sini tarayıcı açmadan yazdır
  --no-color       ANSI renklerini devre dışı bırak
  --verbose        Ek tanı bilgisi ayrıntısı yazdır

Eğik Çizgi Komutları:
  /help [command]       Eğik çizgi komutu yardımını göster
  /login                Z.AI veya BigModel tarayıcı girişini seç
  /logout               Paylaşılan Z.AI giriş kimlik bilgilerini kaldır
  /compact [instructions]  Mevcut konuşmayı özetle
  /expert [status|resume|stop|<task>]  Uzman iş akışını çalıştır veya yönet
  /dwf [list|cancel|resume]  Dinamik iş akışı çalıştırmalarını listele, iptal et veya sürdür
  /fork [latest|checkpointId]  Bir çalışma alanı kontrol noktasından yeni oturum çatallandır
  /mcp [list|status|connect|disconnect]  MCP sunucularını göster veya yönet
  /mode [mode]          İzin modunu göster veya değiştir: build, edit, plan veya yolo
  /model [id]           Mevcut oturum modelini göster veya değiştir
  /new                  TUI'de yeni bir oturum başlat
  /resume [sessionId]   Oturumu sessionId ile sürdür; cwd için en sonuncuyu almak için boş bırak
  /rewind [latest|checkpointId]  En son kontrol noktasını göster veya çalışma alanı dosyalarını geri yükle
  /skill [name] [task]  Becerileri listele veya bir sonraki istemin birini yüklemesini zorla
  /goal [action]        Mevcut oturum hedefini göster veya ayarla
`,
  },
  tui: {
    copy: {
      copied: "Seçili metin panoya kopyalandı.",
      failed: "Seçili metin kopyalanamadı.",
      unavailable: "Bu terminalde metin panoya kopyalama kullanılamıyor.",
    },
    effort: {
      disabled: "devre dışı",
      enabled: "etkin",
    },
    input: {
      activeStatusHint: "kesmek için esc",
      busyPlaceholder: "Girdi kuyruğa almak için yazın",
      placeholder: "Bir istem yazın",
      queuedMore: (count) => `+ ${count} daha kuyrukta`,
      queuedSubmitHint: "Sonraki araç çağrısından sonra gönderildi.",
      queuedTitle: (count) => ` Kuyruk (${count}) `,
      title: "Girdi",
      noHistorySource: "Girdi geçmişi kaynağı yapılandırılmadı.",
      noPreviousInput: "Bu proje için önceki giriş yok.",
      restoredPreviousInput: "Önceki girdi geri yüklendi.",
      restoredPreviousInputWithAttachments: (count) =>
        `Önceki girdi ${count} ek(ler) ile geri yüklendi.`,
      restorePreviousInputFailed: "Önceki girdi geri yüklenemedi.",
      typePrompt: "Bir soru yazın ve Enter'a basın.",
    },
    loginRequired: {
      help: "Modelleri görmek için /model, bir Coding Plan hesabı bağlamak için /login kullanın.",
      message: "Kullanılabilir model yok. Bir sağlayıcı yapılandırın veya /login ile giriş yapın.",
      status: "Kullanılabilir model yok. Bir sağlayıcı yapılandırın veya /login ile giriş yapın.",
      title: "model kurulumu gerekli",
    },
    loginSetup: {
      emptyMessage: "Kullanılabilir giriş seçeneği yok.",
      help: "Seçmek için Yukarı/Aşağı, onaylamak için Enter kullanın.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "BigModel Coding Plan API Key girin",
          inputSecondary: "Anahtarı buraya yapıştırın. Yazarken gizlenir.",
          primary: "BigModel Coding Plan API Anahtarı",
          secondary: "Bir Coding Plan API anahtarını elle yapıştırın.",
        },
        bigmodelOauth: {
          pendingPrimary: "BigModel yetkilendirmesi bekleniyor",
          pendingSecondary:
            "Tarayıcınızda giriş işlemini tamamlayın. Yetkilendirme otomatik algılanır.",
          primary: "BigModel Coding Plan Paketi",
          secondary: "Tarayıcıyla giriş aç; yetkilendirme otomatik algılanır.",
        },
        zaiApiKey: {
          inputPrimary: "Z.AI Coding Plan API Key girin",
          inputSecondary: "Anahtarı buraya yapıştırın. Yazarken gizlenir.",
          primary: "Z.AI Coding Plan API Anahtarı",
          secondary: "Bir Coding Plan API anahtarını elle yapıştırın.",
        },
        zaiOauth: {
          pendingPrimary: "Z.AI yetkilendirmesi bekleniyor",
          pendingSecondary:
            "Tarayıcınızda giriş işlemini tamamlayın. Yetkilendirme bitince devam edeceğim.",
          primary: "Z.AI Coding Plan",
          secondary: "Tarayıcıyla giriş yap, Coding Plan API anahtarı oluştur.",
        },
      },
      pending: {
        cancelStatus: "Giriş iptal edildi. Bir kurulum yöntemi seç.",
        help: "Esc iptal eder, kurulum seçeneklerine döner.",
        status: "Tarayıcı yetkilendirmesi bekleniyor...",
      },
      input: {
        cancelStatus: "API anahtarı girişi iptal edildi. Bir kurulum yöntemi seç.",
        clearStatus: "API anahtarı girdisi temizlendi.",
        emptyStatus: "API anahtarı zorunlu.",
        help: "Enter anahtarı kaydeder. Esc kurulum seçeneklerine döner.",
        placeholder: "API anahtarını yapıştır",
        status: "API anahtarını gir, sonra Enter'a bas.",
        submitStatus: "API anahtarı kaydediliyor...",
      },
      prompt: "Bir giriş veya API anahtarı kurulum yöntemi seç.",
      response: "Coding Plan sağlayıcısının nasıl kurulacağını seç.",
      title: "Coding Plan Kur",
    },
    model: {
      requestFailed: (message) => `Model isteği başarısız: ${message}`,
      responseReceived: "Model yanıtı alındı.",
      responseReceivedWithTokens: (tokens) => `Model yanıtı alındı. ${tokens} token.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Model isteği ${attempt}/${Math.max(1, maxAttempts - 1)} yeniden deneniyor, ${delay}: ${reason}`,
      streamStalled: "Model akışı durdu.",
    },
    sidebar: {
      subagents: {
        title: "Alt ajanlar",
        empty: "Henüz alt ajan yok.",
        emptyOutput: "Henüz çıktı yok.",
        back: "← Ana konuşma",
        readonly: "Salt okunur · Dönmek için Esc",
        loading: "Alt ajan çıktısı yükleniyor...",
        unavailable: "Alt ajan çıktısı alınamadı.",
        retry: "Yeniden dene",
        more: "Daha fazla yükle",
        pendingMain: "Ana konuşma yanıtını bekliyor — dönüp yanıtla",
        ended: (count) => `Bitti (${count})`,
        status: {
          running: "çalışıyor",
          waiting: "bekliyor",
          blocked: "engellendi",
          success: "tamamlandı",
          failed: "başarısız",
          cancelled: "iptal edildi",
          lost: "kayıp",
        },
      },
      api: {
        empty: "Henüz API çağrısı yok.",
        model: "Model adı",
        more: (count) => `+${count} tane daha`,
        requests: "İstekler",
        server: "Sunucu",
      },
      cache: {
        hit: "isabet",
        lastHit: "son isabet",
        lastMiss: "son ıskalama",
        readWrite: ({ read, write }) => `${read} okuma / ${write} yazma`,
        total: "toplam",
      },
      context: {
        cache: "Önbellek",
        cacheReadWrite: "Önbellek O/Y",
        inputOutput: "I/O",
        reason: "Sebep",
        tokens: "Tokenlar",
        used: "Kullanılan",
        window: "Pencere",
      },
      modifiedFiles: {
        empty: "Henüz dosya değişikliği yok.",
        more: (count) => `+${count} tane daha`,
      },
      mcp: {
        empty: "Yapılandırılmış MCP sunucusu yok.",
        loadFailed: "MCP durumu alınamıyor.",
        loading: "MCP durumu yükleniyor...",
        more: (count) => `+${count} tane daha`,
        servers: "Sunucular",
        status: {
          connected: "bağlı",
          connecting: "bağlanıyor",
          disabled: "devre dışı",
          disconnected: "bağlantı kesildi",
          failed: "başarısız",
          untrusted: "güvenilmeyen",
        },
        summary: ({ connected, total }) => `${connected}/${total} bağlı`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "tamamlandı",
        error: "hata",
        errorWithStatus: (statusCode) => `hata ${statusCode}`,
        pending: "beklemede",
      },
      status: {
        last: "Son",
      },
      run: {
        draft: "Taslak",
        draftChars: (count) => `${count} karakter`,
        draftEmpty: "boş",
        messages: "Mesajlar",
        mode: "Mod",
        model: "Model adı",
        provider: "Sağlayıcı",
        thought: "Düşünce",
        trace: "İz",
        turn: "Tur",
        workspace: "Çalışma Alanı",
      },
      sections: {
        apis: "API'ler",
        context: "Bağlam",
        mcp: "MCP",
        modifiedFiles: "Değiştirilen Dosyalar",
        run: "Çalıştır",
        status: "Durum",
        todos: "Yapılacaklar",
      },
      shellSubtitle: "OpenTUI kabuğu",
      title: "Kenar Çubuğu",
      todos: {
        empty: "Henüz yapılacak yok.",
        more: (count) => `+${count} daha`,
        progress: "İlerleme",
      },
    },
    status: {
      compactFailed: "Bağlam sıkıştırması başarısız oldu.",
      compacted: "Sohbet sıkıştırıldı.",
      compacting: "Bağlam sıkıştırılıyor...",
      interruptedStreamDiscarded: "Kesilen model akışı atıldı.",
      modelCalling: "Model çağrılıyor...",
      permissionRequested: (toolName) => `${toolName} için izin istendi.`,
      permissionResolved: (toolName) => `${toolName} izni çözüldü.`,
      ready: "Hazır.",
      recoveringStream: "Kesilen model akışı kurtarılıyor...",
      retryingStream: "Model akışı yeniden deneniyor...",
      sessionResumed: "Oturum sürdürüldü.",
      targetChanged: (action) => `Hedef ${action}.`,
      thinking: "Düşünüyor...",
      toolCompleted: (toolName) => `${toolName} aracı tamamlandı.`,
      toolFailed: (toolName) => `${toolName} aracı başarısız oldu.`,
      toolPending: (toolName) => `${toolName} aracı beklemede.`,
      toolRunning: (toolName) => `${toolName} aracı çalışıyor.`,
      turnFailed: "Tur başarısız oldu.",
    },
    terminal: {
      requiresInteractive: "TUI etkileşimli bir terminal gerektirir.",
      starting: "ZCode başlatılıyor... Çıkmak için Ctrl+C",
    },
    transcript: {
      compact: {
        completed: "Bağlam sıkıştırıldı",
        failed: "Bağlam sıkıştırması başarısız",
        interrupted: "Bağlam sıkıştırması kesildi",
        retry: (command) => `${command} yeniden denemek için Ctrl-R`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Bağlam sıkıştırma yeniden deneniyor (${attempt}/${maxAttempts})`
            : "Bağlam sıkıştırma yeniden deneniyor",
        skipped: "Bağlam güncel; sıkıştırma gerekmiyor",
        started: "Bağlam sıkıştırılıyor",
      },
      roles: {
        agent: "Ajan",
        system: "Sistem",
        user: "Kullanıcı",
      },
      thought: {
        complete: "Düşünce",
        thinking: "Düşünülüyor...",
      },
      title: "Transkript",
      workflow: {
        actors: "aktörler:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `kullanım: ${spentTokens} jeton`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `İş akışı ${label} - ${status} (${nodesSettled}/${nodesTotal} adım)`,
        error: (message) => `hata: ${message}`,
        expandHint: "+ ile genişlet",
        collapseHint: "- ile daralt",
        log: "günlük:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} adım sonuçlandı`,
        result: (preview) => `sonuç: ${preview}`,
        status: {
          completed: "tamamlandı",
          errored: "hata verdi",
          pending: "beklemede",
          running: "çalışıyor",
          stopped: "durdu",
        },
        stopReason: {
          user: "sizin tarafınızdan",
          model: "ajan tarafından",
          provider: "model hatası",
          interrupted: "süreç sonlandı",
          superseded: "düzeltilmiş bir çalıştırma ile değiştirildi",
        },
        truncated: "(kısaltıldı - tam geçmiş çalıştırma günlüğünde)",
        interruptedNotice: ({ label, runId }) =>
          `İş akışı ${label} kesildi ve sürdürülebilir: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter seçer, Esc iptal eder",
      disabled: (reason) => ` [devre dışı: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filtre: ${filter || "-"} | ${help ?? "Enter seçer, Esc iptal eder"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Eşleşen çalışma alanı yolu yok.",
      loading: "Çalışma alanı yolları yükleniyor...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Dosyalar",
    },
    slash: {
      title: "Komutlar",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
