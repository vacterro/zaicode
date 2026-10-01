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

ZAICODE adalah meja kerja operator untuk menjalankan banyak AI coding agent sekaligus di
banyak proyek, tanpa mengawasi satu per satu. Ini adalah build modifikasi dari
[ZCode](https://github.com/zai-org/ZCode) (aplikasi desktop, UI browser dan agent
CLI) dengan lapisan produk di atasnya: setiap proyek dijalankan melalui protokol
[SAIPEN](https://github.com/vacterro/saipen), pekerjaan dimulai, dilanjutkan
dan dijadwalkan dari satu jendela, serta CLI langganan yang sudah Anda bayar
(Claude Code, Codex, Antigravity) berjalan sebagai worker yang tertambat di samping agent
dalam aplikasi.

**0.0.1** adalah snapshot bertag pertama: build pribadi yang mengutamakan Windows dan
dipakai harian.

## Instal sekali klik

1. Unduh **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Klik ganda lalu tekan **INSTALL**.

Selesai. Setup memasang apa yang kurang dari mesin (Git, Node.js, Python, sebagai
salinan privat: tanpa hak administrator), mengambil ZAICODE, SAIPEN dan SAIMAIL dari GitHub,
build aplikasi di mesin tersebut dan membuat shortcut ZAICODE di desktop. Jalankan pertama
memakan 15-30 menit; jendela menampilkan setiap langkah.

Model gratis langsung jalan: ZAICODE menjalankan router sendiri dan mengisi pool **SAIFREN**
dari tingkatan gratis tanpa kunci, sehingga tugas yang diketik di New task langsung
mendapat jawaban tanpa kunci, tanpa akun dan tanpa pengaturan. Langganan Claude Code,
Codex dan Antigravity bersifat opsional dan bisa masuk kapan saja.

**Satu kesatuan, empat bagian.** Workspace (launcher, installer), aplikasi, SAIPEN dan
SAIMAIL adalah empat repositori. Masing-masing memperbarui sendiri: *Settings -> ZAICODE ->
Updates* menampilkan setiap bagian, memperbaruinya manual atau otomatis (dicek beberapa
menit setelah mulai dan setiap enam jam). Build aplikasi baru disiapkan saat ZAICODE berjalan
dan mulai pada start berikutnya; suntingan Anda sendiri di clone tidak pernah ditimpa.
Dari terminal: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Autotroubleshoot: `install\Doctor.cmd`. Detail: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Tur antarmuka

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

## Apa yang ditambahkan ZAICODE ke ZCode

- **Proyek dengan sesi MAIN.** Setiap proyek punya satu sesi MAIN (START,
  `/goal cc all`) dan sesi pembantu (subSaipens: WIKI, TEST, AUDIT, …). Tampilan
  sidebar bawaan menampilkan baris proyek sebagai MAIN-nya; ▶ melanjutkan MAIN
  alih-alih membuka sesi baru. LANJUTKAN SEMUA, SELESAI dan BERSIHKAN YANG
  SELESAI menyapu semua proyek; sesi yang terpotong di tengah giliran menampilkan
  TERGANGGU, tidak pernah SELESAI.
- **Keamanan dari crash.** Sesi yang terputus oleh proses mati dan tujuan yang masih
  aktif melanjutkan sendiri setelah restart; worker yang berjalan mulai lagi. Agent
  di dalam ZAICODE tidak bisa mematikan ZAICODE berdasarkan nama proses.
- **Worker.** CLI langganan berjalan di terminal yang ditambatkan ke tepi jendela
  mana pun (atau di jendela snap-nya sendiri). Pertanyaan "Trust this folder?"
  saat pertama kali dijalankan sudah dijawab; worker yang mencapai batas pakai
  dilaporkan dan, sesuai pengaturan, ditutup atau dimulai ulang setelah reset.
- **Batas dan reset.** Meter kuota per akun dan per pool, pengatur waktu di
  bilah judul untuk reset terdekat dengan daftar lengkap reset mendatang saat hover.
- **SCHEDULER.** Prompt yang mulai sendiri: pada jam tertentu, harian, setiap N
  menit atau saat jendela kuota terisi; di satu proyek atau satu bagian sidebar,
  proyek terburuk (paling banyak terblokir / tiket SAIPEN terbuka) lebih dulu. Kondisi
  bisa menghentikan lebih dulu pekerjaan sementara (sesi pool gratis, worker
  lebih lemah), hanya berjalan pada proyek idle, atau hanya melanjutkan sesi yang
  ditandai. Prompt tidak punya batas panjang praktis.
- **Routing.** 9router bawaan (MIT) memberi pool tanpa setup: SAIFREN
  (tier gratis tanpa kunci) dan SAIOPP (langganan Anda).
- **SAIHOME, pengatur waktu, suara, sorotan.** Beranda operator dengan statistik,
  pengatur waktu dan alarm ala FastPrompter, suara per aksi, serta antarmuka
  Win95 gelap keemasan, tajam piksel.

## Persyaratan

Persyaratan: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) adalah sumber kebenaran).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Aplikasi paket selalu mulai dalam mode ZAICODE. Saat ZAICODE lama masih berjalan,
bundler menaruh build baru di `packages/desktop/dist-next`; launcher root
(branch `master`, `tools/launcher`) menukarnya pada start berikutnya.
Varian bitmap Verdana tajam yang dipakai UI tidak ada di repositori ini;
tanpa itu, antarmuka kembali ke Verdana sistem.

Pemeriksaan: `pnpm typecheck`, `pnpm lint`, dan pengujian ZAICODE, misalnya
`node --import tsx --test test/zaicode*.test.ts` dari `packages/ui`.

## Struktur repositori

| Branch      | Isi                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | workspace kanonik: launcher, installer (`install/`), dokumentasi produk (`UI.md`, `docs/`), state SAIPEN dan CHANGELOG |
| `zaicode`   | sumber aplikasi kanonik: riwayat ZCode upstream plus lapisan produk ZAICODE yang dipakai untuk build dan pembaruan |

Ref lama atau yang dibuat otomatisasi mungkin masih muncul sementara, tetapi itu bukan
branch produk kanonik. Pekerjaan workspace baru ada di `master`; pekerjaan sumber
aplikasi ada di `zaicode`.

Kode aplikasi milik ZAICODE sebagian besar ada di `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` dan
`packages/desktop/src/main/zaicode*.ts` pada branch `zaicode`. Dokumentasi
workspace dan tooling launcher/update ada di `master`.

## Upstream dan lisensi

ZAICODE berasal dari ZCode oleh Z.ai dan didistribusikan di bawah lisensi yang sama,
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); pemberitahuan upstream disimpan di
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) dan [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Berkas dimodifikasi oleh penulis ZAICODE. ZAICODE adalah proyek independen,
tidak berafiliasi dengan maupun didukung oleh Z.ai. README asli ZCode disimpan sebagai
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) dan [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Jaringan proyek

Repositori ini bagian dari ekosistem proyek **SAIPEN / vacterro** yang lebih luas.

[**Hub penulis**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN Community**](https://discord.gg/SEYaYkuVgN)

Untuk bug yang dapat direproduksi dan permintaan fitur yang berkelanjutan, gunakan [GitHub Issues repositori ini](https://github.com/vacterro/zaicode/issues). Gunakan Discord untuk diskusi cepat, tangkapan layar, dan umpan balik lintas proyek.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
