import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "id-ID",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Nilai --locale tidak didukung: ${value}. Lokal yang didukung: en-US, zh-CN, auto.`,
    },
    help: (version) => `zcode ${version}

Penggunaan:
  zcode [command] [options]

Tanpa perintah, zcode membuka TUI layar penuh.

Perintah:
  app-server Menjalankan app server stdio Protokol ZCode
  commands   Menampilkan daftar perintah slash khusus (\`commands list\`)
  doctor     Memeriksa asumsi runtime dan packaging
  login [zai|bigmodel]  Masuk lewat otorisasi browser
  logout     Menghapus kredensial login Z.AI bersama
  plugins    Mengelola plugin dan marketplace (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Menampilkan daftar skill lokal (\`skills list\`)
  tui        Membuka UI terminal
  version    Menampilkan versi CLI

Opsi:
  -h, --help       Tampilkan bantuan
  -v, --version    Tampilkan versi
  -p, --prompt <text>  Menjalankan satu prompt tanpa membuka TUI
  --memory-bench   Bersama --prompt, aktifkan ekstraksi Memory otomatis dan tunggu sebelum keluar (memerlukan Memory aktif)
  --browser-use <mode> Aktifkan backend Browser Use (didukung: headless)
  --surface <surface>  Permukaan tampilan untuk prompt headless/app-server: terminal atau desktop
  --browser-executable <path> Eksekutabel Chrome/Chromium untuk Browser Use headless
  --attach <path>  Lampirkan file lokal ke --prompt; ulangi untuk beberapa file
  --cwd <path>     Jalankan perintah ini dari direktori yang diberikan
  --disallowed-tools, --disallowedTools <tools...>
    Hapus seluruh tool hanya untuk prompt/run TUI ini; pengaturan tersimpan tidak berubah.
    Nama tool dipisah koma atau spasi, mis. "Bash Edit".
    "Bash(git *)" menghapus semua Bash; pola perintah tidak dicocokkan.
  --force-mcs      Paksa proyeksi sistem di tengah percakapan untuk provider Anthropic
  --locale <locale>  Lokal UI: en-US, zh-CN, atau auto
  --mode <mode>    Mode izin untuk prompt: build, edit, plan, atau yolo (default: yolo untuk --prompt)
  --resume <sessionId>  Lanjutkan sesi tersimpan berdasarkan sessionId (sess_...)
  --target <text>  Jalankan atau atur tujuan sesi dalam mode headless
  --target-replace Ganti tujuan sesi yang ada dari --target
  -c, --continue        Lanjutkan sesi terbaru untuk direktori ini
  --json           Tampilkan JSON yang dapat dibaca mesin jika didukung
  --no-browser     Tampilkan URL OAuth tanpa membuka browser
  --no-color       Matikan warna ANSI
  --verbose        Tampilkan detail diagnostik tambahan

Perintah Slash:
  /help [command]       Tampilkan bantuan perintah slash
  /login                Pilih login browser Z.AI atau BigModel
  /logout               Hapus kredensial login Z.AI bersama
  /compact [instructions]  Ringkas percakapan saat ini
  /expert [status|resume|stop|<task>]  Jalankan atau kelola alur kerja expert
  /dwf [list|cancel|resume]  Daftar, batalkan, atau lanjutkan run alur kerja dinamis
  /fork [latest|checkpointId]  Fork sesi baru dari checkpoint workspace
  /mcp [list|status|connect|disconnect]  Tampilkan atau kelola server MCP
  /mode [mode]          Tampilkan atau ganti mode izin: build, edit, plan, atau yolo
  /model [id]           Tampilkan atau ganti model sesi saat ini
  /new                  Mulai sesi baru di TUI
  /resume [sessionId]   Lanjutkan sesi berdasarkan sessionId; kosongkan untuk terbaru di cwd
  /rewind [latest|checkpointId]  Tampilkan checkpoint terbaru atau pulihkan file workspace
  /skill [name] [task]  Daftar skill, atau paksa prompt berikutnya memuat satu
  /goal [action]        Tampilkan atau atur tujuan sesi saat ini
`,
  },
  tui: {
    copy: {
      copied: "Teks yang dipilih disalin ke clipboard.",
      failed: "Tidak bisa menyalin teks yang dipilih.",
      unavailable: "Penyalinan teks ke clipboard tidak tersedia di terminal ini.",
    },
    effort: {
      disabled: "nonaktif",
      enabled: "aktif",
    },
    input: {
      activeStatusHint: "esc untuk interrompsi",
      busyPlaceholder: "Ketik untuk mengantre input",
      placeholder: "Ketik prompt",
      queuedMore: (count) => `+ ${count} lagi mengantre`,
      queuedSubmitHint: "Terkirim setelah panggilan tool berikutnya.",
      queuedTitle: (count) => ` Antrean (${count}) `,
      title: "Masukan",
      noHistorySource: "Tidak ada sumber riwayat input yang dikonfigurasi.",
      noPreviousInput: "Tidak ada input sebelumnya untuk proyek ini.",
      restoredPreviousInput: "Input sebelumnya dipulihkan.",
      restoredPreviousInputWithAttachments: (count) =>
        `Input sebelumnya dipulihkan dengan ${count} lampiran.`,
      restorePreviousInputFailed: "Tidak bisa memulihkan input sebelumnya.",
      typePrompt: "Ketik pertanyaan lalu tekan Enter.",
    },
    loginRequired: {
      help: "Gunakan /model untuk melihat model, atau /login untuk menghubungkan akun Coding Plan.",
      message: "Tidak ada model tersedia. Konfigurasi provider atau masuk dengan /login.",
      status: "Tidak ada model tersedia. Konfigurasi provider atau masuk dengan /login.",
      title: "penyiapan model diperlukan",
    },
    loginSetup: {
      emptyMessage: "Tidak ada opsi login tersedia.",
      help: "Gunakan Up/Down untuk memilih, Enter untuk mengonfirmasi.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Masukkan BigModel Coding Plan API Key",
          inputSecondary: "Tempel key di sini. Disembunyikan saat mengetik.",
          primary: "Kunci API BigModel Coding Plan",
          secondary: "Tempel API key Coding Plan secara manual.",
        },
        bigmodelOauth: {
          pendingPrimary: "Menunggu otorisasi BigModel",
          pendingSecondary:
            "Selesaikan login di browser. Otorisasi terdeteksi otomatis.",
          primary: "BigModel Coding Plan",
          secondary: "Buka login browser; otorisasi terdeteksi otomatis.",
        },
        zaiApiKey: {
          inputPrimary: "Masukkan Z.AI Coding Plan API Key",
          inputSecondary: "Tempel key di sini. Disembunyikan saat mengetik.",
          primary: "Kunci API Z.AI Coding Plan",
          secondary: "Tempel API key Coding Plan secara manual.",
        },
        zaiOauth: {
          pendingPrimary: "Menunggu otorisasi Z.AI",
          pendingSecondary:
            "Selesaikan login di browser. Saya lanjutkan setelah otorisasi selesai.",
          primary: "Z.AI Coding Plan",
          secondary: "Buka login browser dan buat kunci API Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Login dibatalkan. Pilih metode penyiapan.",
        help: "Esc membatalkan dan kembali ke pilihan penyiapan.",
        status: "Menunggu otorisasi browser...",
      },
      input: {
        cancelStatus: "Entri kunci API dibatalkan. Pilih metode penyiapan.",
        clearStatus: "Input kunci API dikosongkan.",
        emptyStatus: "Kunci API wajib diisi.",
        help: "Enter menyimpan kunci. Esc kembali ke pilihan penyiapan.",
        placeholder: "Tempel kunci API",
        status: "Masukkan kunci API, lalu tekan Enter.",
        submitStatus: "Menyimpan kunci API...",
      },
      prompt: "Pilih metode penyiapan login atau kunci API.",
      response: "Pilih cara menyiapkan penyedia Coding Plan.",
      title: "Siapkan Coding Plan",
    },
    model: {
      requestFailed: (message) => `Permintaan model gagal: ${message}`,
      responseReceived: "Respons model diterima.",
      responseReceivedWithTokens: (tokens) => `Respons model diterima. ${tokens} token.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Mencoba ulang permintaan model ${attempt}/${Math.max(1, maxAttempts - 1)} dalam ${delay}: ${reason}`,
      streamStalled: "Aliran model macet.",
    },
    sidebar: {
      subagents: {
        title: "Subagen",
        empty: "Belum ada subagen.",
        emptyOutput: "Belum ada output.",
        back: "← Percakapan utama",
        readonly: "Hanya baca · Esc untuk kembali",
        loading: "Memuat output subagen...",
        unavailable: "Output subagen tidak tersedia.",
        retry: "Coba lagi",
        more: "Muat lagi",
        pendingMain: "Percakapan utama memerlukan input Anda — kembali untuk merespons",
        ended: (count) => `Berakhir (${count})`,
        status: {
          running: "berjalan",
          waiting: "menunggu",
          blocked: "terblokir",
          success: "selesai",
          failed: "gagal",
          cancelled: "dibatalkan",
          lost: "hilang",
        },
      },
      api: {
        empty: "Belum ada panggilan API.",
        model: "Model AI",
        more: (count) => `+${count} lagi`,
        requests: "Permintaan",
        server: "Peladen",
      },
      cache: {
        hit: "cocok",
        lastHit: "hit terakhir",
        lastMiss: "miss terakhir",
        readWrite: ({ read, write }) => `${read} baca / ${write} tulis`,
        total: "jumlah",
      },
      context: {
        cache: "Tembolok",
        cacheReadWrite: "Tembolok B/T",
        inputOutput: "I/O",
        reason: "Alasan",
        tokens: "Token",
        used: "Dipakai",
        window: "Jendela",
      },
      modifiedFiles: {
        empty: "Belum ada perubahan file.",
        more: (count) => `+${count} lagi`,
      },
      mcp: {
        empty: "Belum ada server MCP yang dikonfigurasi.",
        loadFailed: "Status MCP tidak tersedia.",
        loading: "Memuat status MCP...",
        more: (count) => `+${count} lagi`,
        servers: "Server",
        status: {
          connected: "terhubung",
          connecting: "menghubungkan",
          disabled: "dinonaktifkan",
          disconnected: "terputus",
          failed: "gagal",
          untrusted: "tidak tepercaya",
        },
        summary: ({ connected, total }) => `${connected}/${total} terhubung`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "selesai",
        error: "kesalahan",
        errorWithStatus: (statusCode) => `kesalahan ${statusCode}`,
        pending: "menunggu",
      },
      status: {
        last: "Terakhir",
      },
      run: {
        draft: "Draf",
        draftChars: (count) => `${count} karakter`,
        draftEmpty: "kosong",
        messages: "Pesan",
        mode: "Modus",
        model: "Model AI",
        provider: "Penyedia",
        thought: "Pemikiran",
        trace: "Jejak",
        turn: "Giliran",
        workspace: "Ruang Kerja",
      },
      sections: {
        apis: "APIs",
        context: "Konteks",
        mcp: "MCP",
        modifiedFiles: "Berkas yang Diubah",
        run: "Jalankan",
        status: "Keadaan",
        todos: "Daftar Tugas",
      },
      shellSubtitle: "shell OpenTUI",
      title: "Bilah Samping",
      todos: {
        empty: "Belum ada todo.",
        more: (count) => `+${count} lagi`,
        progress: "Progres",
      },
    },
    status: {
      compactFailed: "Kompresi konteks gagal.",
      compacted: "Percakapan dipadatkan.",
      compacting: "Mengompresi konteks...",
      interruptedStreamDiscarded: "Stream model yang terputus dibuang.",
      modelCalling: "Memanggil model...",
      permissionRequested: (toolName) => `Izin diminta untuk ${toolName}.`,
      permissionResolved: (toolName) => `Izin diberikan untuk ${toolName}.`,
      ready: "Siap.",
      recoveringStream: "Memulihkan stream model yang terputus...",
      retryingStream: "Mencoba ulang stream model...",
      sessionResumed: "Sesi dilanjutkan.",
      targetChanged: (action) => `Targetkan ${action}.`,
      thinking: "Berpikir...",
      toolCompleted: (toolName) => `Alat ${toolName} selesai.`,
      toolFailed: (toolName) => `Alat ${toolName} gagal.`,
      toolPending: (toolName) => `Alat ${toolName} tertunda.`,
      toolRunning: (toolName) => `Alat ${toolName} berjalan.`,
      turnFailed: "Giliran gagal.",
    },
    terminal: {
      requiresInteractive: "TUI memerlukan terminal interaktif.",
      starting: "Memulai ZCode... Ctrl+C untuk keluar",
    },
    transcript: {
      compact: {
        completed: "Konteks dikompresi",
        failed: "Kompresi konteks gagal",
        interrupted: "Kompresi konteks terputus",
        retry: (command) => `Ctrl-R untuk mencoba ulang ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Mencoba ulang kompresi konteks (${attempt}/${maxAttempts})`
            : "Mencoba ulang kompresi konteks",
        skipped: "Konteks sudah terbaru; kompresi tidak diperlukan",
        started: "Mengompresi konteks",
      },
      roles: {
        agent: "Agen",
        system: "Sistem",
        user: "Pengguna",
      },
      thought: {
        complete: "Pemikiran",
        thinking: "Berpikir...",
      },
      title: "Transkrip",
      workflow: {
        actors: "aktor:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `pemakaian: ${spentTokens} token`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Alur kerja ${label} - ${status} (${nodesSettled}/${nodesTotal} langkah)`,
        error: (message) => `kesalahan: ${message}`,
        expandHint: "+ untuk membuka",
        collapseHint: "- untuk menutup",
        log: "catatan:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} langkah selesai`,
        result: (preview) => `hasil: ${preview}`,
        status: {
          completed: "selesai",
          errored: "gagal",
          pending: "menunggu",
          running: "berjalan",
          stopped: "dihentikan",
        },
        stopReason: {
          user: "oleh Anda",
          model: "oleh agen",
          provider: "kesalahan model",
          interrupted: "proses berhenti",
          superseded: "digantikan oleh eksekusi yang diperbarui",
        },
        truncated: "(dipotong - riwayat lengkap ada di jurnal eksekusi)",
        interruptedNotice: ({ label, runId }) =>
          `Alur kerja ${label} terinterupsi dan dapat dilanjutkan: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter memilih, Esc membatalkan",
      disabled: (reason) => ` [nonaktif: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `saring: ${filter || "-"} | ${help ?? "Enter memilih, Esc membatalkan"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Tidak ada path workspace yang cocok.",
      loading: "Memuat path workspace...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Berkas",
    },
    slash: {
      title: "Perintah",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
