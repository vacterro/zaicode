# Memasang ZAICODE

ZAICODE adalah tiga proyek yang bekerja sebagai satu: aplikasi ZAICODE, SAIPEN (protokol
yang menjaga agar pekerjaan agen tetap pada jalannya) dan SAIMAIL (mail yang dipakai agen
untuk saling memberi tahu). Memasangnya secara manual berarti tiga clone, toolchain Node.js,
lingkungan Python, dan proses build. Installer melakukan semuanya itu:
jalankan, tunggu, dan pintasan ZAICODE sudah ada di desktop.

## Sekali klik

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  unduh, klik dua kali, tekan **INSTALL**. Jendela (emas di atas gelap, banner
  SAIPEN) menampilkan setiap langkah saat berjalan, waktu yang sudah lewat, dan log
  bila diminta; di akhir **START ZAICODE**, atau **TRY AGAIN** / **Autotroubleshoot**
  / **Open log** bila sebuah langkah tidak selesai. Jika diarahkan ke folder ZAICODE
  yang sudah ada, tombolnya berbunyi **UPDATE**: proses yang sama memperbarui dan
  memperbaiki. Exe ini memuat skrip instalasi dan tidak butuh berkas lain di sampingnya;
  dibangun oleh `install\setup\build.cmd` (kompiler .NET Framework yang ada di setiap Windows 10/11).
- `install\Setup-ZAICODE.cmd` (klik dua kali): instalasi yang sama di konsol.
- Dari nol, di PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Opsi setup: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (folder preset),
`/auto` (mulai langsung), `/quiet` (tanpa jendela: installer konsol, exit code
= hasil). Run pertama membangun app di mesin ini, butuh waktu;
run berikutnya hanya update dan perbaikan.

## Model gratis, tanpa perlu setup

App membawa 9router-nya sendiri. Di mesin yang tidak punya, ZAICODE menjalankannya
secara privat (mode terisolasi, port 20138), mengisi **SAIFREN** dari tier gratis
tanpa kunci dan menjadikan `SAIRoute / SAIFREN` model untuk task baru, jadi task pertama
yang diketik di New task langsung dijawab: tanpa kunci, tanpa akun, tanpa setelan. Login
Claude Code, Codex dan Antigravity bersifat opsional; login yang belum diatur di
mesin tampil sebagai "opsional, masuk kapan saja", bukan item "menunggu kamu".
Bukti: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
menjalankan app terpaket pada profil kosong (HOME, APPDATA dan
LOCALAPPDATA sendiri) dan lulus hanya bila router terisolasi, SAIFREN menjawab probe
token pertamanya, dan task di New task terjawab.

## Update: empat bagian, satu ZAICODE

Workspace (launcher, installer), app, SAIPEN dan SAIMAIL adalah empat
clone. Masing-masing update sendiri: **Settings -> ZAICODE -> Updates** mencantumkan
mereka beserta versi dan commit, bisa update satu per satu atau semuanya, dan punya
sakelar "otomatis" per bagian (nyala pada ZAICODE terinstal, mati pada checkout
pengembang). ZAICODE mengecek beberapa menit setelah start, lalu setiap enam jam.
Setelah update tiap bagian mendapat yang dibutuhkannya: app dependensinya (saat
`pnpm-lock.yaml` berpindah) dan build baru (didisiapkan saat ZAICODE berjalan, dijalankan
pada start berikutnya), SAIPEN launcher-nya, SAIMAIL instalasi `.venv`-nya, workspace
launcher root baru. Clone di branch lain, dengan commit lokal, atau dengan edit yang
akan ditimpa update dilaporkan dan dibiarkan persis seperti adanya.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Apa yang dil Communities

Installer adalah pemeriksaan Autotroubleshoot yang dijalankan dengan "repair" pada folder
kosong, dengan urutan berikut. Setiap langkah idempoten, jadi menjalankannya lagi
memperbarui instalasi dan memperbaiki yang rusak.

| Pemeriksaan | Perbaikan |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | memakai salinan mesin bila cocok; jika tidak, salinan privat di `.tools\` (MinGit dari Git for Windows, Node.js 24.14.0 dari nodejs.org, Python dari paket NuGet-nya). Tanpa hak admin. |
| pnpm | pnpm 10.33.2 yang dipin di `.tools\pnpm10` |
| Workspace ZAICODE | clone `vacterro/zaicode` branch `master` (sumber launcher, installer, docs; memori `.saipen/` pengembang tidak disertakan; branch `workspace` sampai 2026-09-27) |
| Sumber app ZAICODE | clone branch `zaicode` ke `zcode\` |
| SAIPEN | clone `vacterro/saipen` ke `saipen\`; `bin\saipen.cmd`-nya ditulis untuk clone ini dan Python ini |
| SAIMAIL | clone `vacterro/saimail` ke `saimail\`, diinstal ke `.venv\` |
| saimail-local | klien command-line SAIMAIL yang dipakai panel SAIMAIL di ZAICODE (dikirim sejak SAIMAIL `0.0.2a3`; pemeriksaan `saimail-cli` melaporkan OK) |
| Paket 9router | `9router` dari npm ke `.tools\router`, dibundel agar SAIFREN jalan tanpa setup sama sekali (WARN bila npm tidak bisa menjangkau) |
| Dependensi app | `pnpm install --frozen-lockfile` (lagi saat `pnpm-lock.yaml` berubah) |
| Build app | `pnpm bundle:zaicode`; saat ZAICODE berjalan build baru disiapkan dan ditukar pada start berikutnya |
| Penukaran build tersiap | membersihkan `win-unpacked.previous` yang tertinggal dari kegagalan swap long-path dan menukar build yang menunggu saat ZAICODE ditutup |
| Launcher root | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Shortcut | Desktop dan Start menu `ZAICODE` -> `ZAICODE.exe` |
| Login Claude / Codex | hanya dilaporkan: setiap login `~\.claude*` / `~\.codex*` adalah engine tersendiri di ZAICODE (A1, A2, C1, ...); login butuh kamu, di browser |

Launcher root menunjuk ZAICODE ke SAIPEN terinstal (`saipen\`) dan menaruh
`.tools\` serta `.venv\Scripts` di depan PATH app, jadi app, agent dan worker-nya memakai
salinan terpasang.

## Beberapa langganan

Setiap login Claude Code atau Codex punya home sendiri: `~\.claude`,
`~\.claude-account2`, ... dan `~\.codex`, `~\.codex-account2`, ... ZAICODE menemukan
semuanya. Untuk menyiapkan lebih banyak saat instalasi:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Installer membuat home tersebut dan mencetak perintah login persis untuk setiap
(`$env:CODEX_HOME = '...'; codex login`). Sama saja di ZAICODE: Pengaturan ->
Engine & batas -> tambah login lain.

## Perbaikan Otomatis

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Status per cek: OK, FIXED (rusak, diperbaiki), WARN (berfungsi, tapi ada yang
opsional hilang), INFO (butuh kamu: login), FAIL. Log ada di
`install\logs\`; ringkasan instalasi terakhir di `install\install-report.json`.
Di aplikasi, Router -> Autotroubleshoot memperbaiki router dan pool yang berjalan.

## Opsi

| Parameter | Default | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | tempat semua ditaruh |
| `-ShortcutDir` | Desktop | tempat shortcut ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | lewati shortcut tersebut |
| `-PortableTools` | | Git / Node.js / Python privat meski mesin sudah punya |
| `-Launch` | | jalankan ZAICODE setelah selesai |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | repo GitHub | sumber lain (fork, path clone lokal) |

## Bukti

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
memeriksa instalasi segar, menyuntik kegagalan (shortcut dan launcher dihapus, launcher
SAIPEN menunjuk Python yang hilang, venv SAIMAIL dihapus, node_modules
tercatat untuk lockfile lain, folder build sisa lebih dalam dari MAX_PATH),
pastikan doctor melaporkan dan memperbaiki tiapnya, lalu menjalankan target shortcut
dengan profil terisolasi dan menghentikan tepat process tree yang dia mulai.

`install\tests\Test-ZaicodeUpdate.ps1` membangun empat repo sekali pakai di
disk plus instalasi clone-nya, lalu membuktikan bahwa satu cek tidak mengubah apa pun, bahwa satu bagian saja diperbarui beserta pengikutnya (launcher SAIPEN, launcher
root), bahwa edit lokal dan commit lokal yang bertumpang tindih kept, dan bahwa nama
part tak dikenal ditolak. Tanpa jaringan.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
