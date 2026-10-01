# Transport cloud ZAICODE SAIPEN

Cara checkout ini dan sesi Claude Code Cloud menjalankan satu workspace SAIPEN
dengan lokalitas executor berbeda, dan di mana batas keduanya.

## Bentuknya

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Satu cabang membawa state protokol. Tidak ada langkah merge, tidak ada rebase,
tidak ada cabang lokal kedua yang harus disinkronkan: executor yang punya
checkpoint terverifikasi melakukan commit dan push, sisi lain mengambilnya
dengan fast-forward.

`master` adalah riwayat pre-transport dan branch default yang dipublikasikan. Ini
tidak di-force-update oleh transport.

## Yang travels dan yang tidak

Checkpoint di repo ini membawa state protokol SAIPEN, root
launcher, installer, docs, dan script transport ini. Itu seluruh lapisan workspace.

Ini membawa **nol byte produk**. `zcode/` adalah repositori Git terpisah, terdaftar
di `.saipen/source-nested-repos.json` dan di-gitignore di root ini
(`/zcode/`). Pekerjaan produk butuh clone sendiri dari `vacterro/zaicode` pada branch
`zaicode`, dan clone itu objek kedua yang independen dengan riwayatnya sendiri.

Konsekuensinya mudah salah paham: `git status` yang bersih di root ini tidak
apa-apa soal pekerjaan produk yang belum di-commit, dan fast-forward `saipen-live` tidak
apa-apa soal kode produk. Periksa `git -C zcode status` secara eksplisit.

## Setengah lokal

Dua script, keduanya milik repo agar mesin baru mendapatkannya dari repositori
bukan dari ingatan:

| File | Peran |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | memvalidasi, merekonsiliasi branch, memasang dan memulai watcher, menulis entri autostart, membuktikan lokal == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | loop: fetch, bandingkan, fast-forward atau push, log, jeda; lalu product pass dan self-update |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | round-trip dari executor independen plus bukti pemulihan saat cold |
| `tools/saipen-cloud/Test-ProductSync.ps1` | product pass dan self-update pada repositori Git sekali pakai (tanpa jaringan, tanpa remote nyata) |


Pasang dan perbaiki:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Idempoten. Status lokal mesin berada di `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (salinan), `ZAICODE_cloud-sync.log` (dirotasi pada
2 MB ke `.log.1`), `ZAICODE_cloud-sync.lock` (instansi tunggal),
`ZAICODE_cloud-sync.pid`, dan entri folder Startup
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Installer menolak worktree yang kotor dan tidak pernah membersihkannya. Jika setiap path yang kotor adalah status SAIPEN kanonik di bawah `.saipen/`, installer akan menyatakannya dan mencetak perintah checkpoint persisnya; itu adalah status protokol yang belum di-checkpoint, bukan kesalahan transport, dan installer tidak akan.commit-nya di belakang protokol.

## Perilaku watcher

| Situasi | Tindakan |
|-----------|------|
| bersih, lokal adalah ancestor dari remote | `git merge --ff-only` |
| bersih, remote adalah ancestor dari lokal | `git push` |
| kotor | jeda; bahkan tidak fetch |
| berada di branch lain | jeda |
| keduanya maju, tidak ada ancestor bersama | jeda, catat kedua commit id, jangan merge apa pun |
| fetch atau jaringan gagal | catat degraded, coba lagi di tick berikutnya |
| ada merge/rebase/cherry-pick yang sedang berjalan | jeda |

Tidak pernah: force push, hard reset, stash, clean, checkout branch asing,
commit, atau menghentikan berdasarkan nama proses. Installer hanya
menghentikan watcher berdasarkan pid yang dicatat di file pid miliknya sendiri.

Pohon yang kotor tidak antim biaya apa pun, karena watcher memeriksa kondisi kotor sebelum menarik.
Checkout yang menganggur karena itu tidak melakukan panggilan jaringan sama sekali.

### Pass produk (T-90)

`zcode/` adalah repositori mandiri, sehingga tabel di atas tidak pernah memindahkan
kode produk. Setelah itu, tick yang sama menangani checkout produk (`-ProductRepo`,
default `<repo>\zcode`; branch `-ProductBranch`, default `zaicode`). Pass
produk berjalan ada atau tidaknya pohon luar dalam keadaan kotor. Pass ini hanya menarik.

| Situasi | Tindakan |
|-----------|------|
| remote maju, tidak ada file incoming yang dirty di sini | `git merge --ff-only`; pekerjaan produk yang belum di-commit dibiarkan apa adanya |
| remote maju, ada file incoming yang dirty di sini | HELD: catat file, jangan merge apa pun |
| local maju | catat; **tidak pernah di-push** (produk dipublikasikan oleh SAIPEN SHIP) |
| diverged | jeda, catat kedua id, jangan merge apa pun |
| branch lain, ada operasi git berjalan, fetch gagal | jeda |
| tidak ada checkout `zcode/`, atau `-NoProduct` | dilewati |

git sendiri menolak fast-forward yang akan menimpa perubahan lokal, jadi
pemeriksaan HELD itu penjaga yang lebih awal dan lebih jelas, bukan satu-satunya.
Fast-forward produk tidak membangun ulang apa pun: untuk menguji, jalankan
`pnpm bundle:zaicode` (atau pratinjau dev).

### Pembaruan mandiri (T-90)

Watcher berjalan sebagai salinan di bawah `%APPDATA%\SAIPEN`, jadi watcher yang lebih baru
di repository tidak pernah berjalan tanpa instalasi ulang. Dalam mode loop, kini
watcher membandingkan file-nya sendiri dengan salinan yang sudah di-commit di
repository pada setiap putaran. Watcher memasang salinan itu di atas dirinya
sendiri lalu restart tepat satu kali, dengan argumen yang sama, hanya jika
semua ini terpenuhi:

- kedua file berbeda;
- salinan repository tidak punya edit yang belum di-commit;
- salinan repository bisa di-parse tanpa error.

Salinan yang gagal di-parse ditolak dan dicatat, watcher yang sedang berjalan
tetap lanjut.

Watcher yang diinstal sebelum T-90 tidak punya pass produk maupun pembaruan
mandiri. Jalankan `Install-SaipenLiveSync.ps1` satu kali di mesin seperti itu; setelah itu,
watcher memperbarui dirinya sendiri.

## Bagian cloud

`CLAUDE.md` di root adalah aturan masuk, `.claude/skills/saipen/SKILL.md` adalah prosedur eksekusi.
Skill mengambil kernel SAIPEN dari `github.com/vacterro/saipen` dan menjalankannya melalui permukaan
engine yang dideklarasikan `tools/saipen.py`. Kernel dikunci dengan commit
(`3088eff`), tidak pernah dengan tag. Tag `v8.0.1` adalah kernel lama dengan
`VERSION` yang sama; `validate`-nya mengubah state, dan validator-nya menolak
board ini.

`STATE.saipen_home` mencatat jalur kernel dari executor mana pun yang terakhir
checkpoint. Di cloud, `saipen continue` pertama pada kernel `3088eff` menyelaraskan
itu ke kernel yang sedang berjalan sebagai satu `DEC` berjurnal (E-1410).
Di mesin operator, pointer tiba mati dengan cara yang sama. Kernel dengan
konvergensi otomatis memperbaikinya di `continue`; jika tidak, jalankan
`saipen rebind-home --auto`.

**Perjalanan balik teramati.** E-1562 (cloud) menyelaraskan pointer ke
`/home/user/zaicode/.claude/saipen-protocol`; E-1571 (mesin operator)
menyelaraskannya kembali ke `V:/.../_SAIPEN`, otomatis, tanpa manual
`rebind-home`. Kedua arah adalah konvergensi otomatis yang sama, jadi nanom
satu `saipen_home` `DEC` per pergantian lokasi dan perlakukan sebagai derau yang
expected, bukan cacat. Tetap derau sampai P1-2
(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) memindahkan pointer keluar dari state
versioned; janganimplementasikan P1-2 sebagai efek samping dari
perhatiannya. Never hand-edit
pointer-nya.

`STATE.saipen_home` bisa menunjuk ke **checkout pengembangan** kernel yang
lebih maju dari pin, bukan ke clone `3088eff` yang bersih — di mesin
operator itu adalah branch `accepted-debt-rebind` dengan pekerjaan belum di-commit. Kernel
yang tidak pada commit yang di-pin tidak otomatis salah, tapi juga bukan
sumber clean-room, sehingga aturan di bawah tentang kontrak suara berlaku
sepenuhnya. Jangan pernah commit, stash, reset, check out, atau clean
apa pun di checkout semacam itu; restore satu file `saipen/STYLE.md` yang
dit目标和 adalah satu-satunya pengecualian yang diizinkan, dan hanya bila
operator memintanya.

### STYLE.md bukan setelan lokal

`saipen/STYLE.md` harus **byte-identik dengan file kernel yang di-pin** di
setiap mesin, di setiap salinan, tanpa pengecualian dan tanpa edit lokal. Ada
lebih dari satu salinan di mesin operator:

- checkout kernel di `STATE.saipen_home` (clone Git, di mesin
  operator berupa checkout pengembangan);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, diisi oleh
  `saipen-inject` terjadwal (`bootstrap/schedule-run.ps1`). Ini **bukan
  repositori Git**, jadi `git checkout` tidak pernah bisa memperbaikinya —
  re-sync lewat injector, atau tulis langsung konten yang dipublikasikan, adalah
  satu-satunya jalan.

Token `style_contract` di `.saipen/STATE.md` adalah hash dari teks file itu
(`tools/validate.py`, `style_contract_token`: CRLF dinormalisasi, baris
`style_contract:` dikecualikan). Edit `reply_language` di satu salinan dan
token-nya bergeser; salinan lain dan cloud, yang mengambil kernel
terpublikasi, mempertahankan token yang dipublikasikan, dan setiap
tulisan CLI di sisi yang tidak cocok ditolak dengan `style_contract ... does not match the installed STYLE.md marker`.
Itu seluruh kegagalannya: sisi lokal menulis state yang tidak bisa ditulis
cloud.

**Mengubah bahasa balasan adalah kernel commit plus repin**, bukan edit
lokal. Ubah di repositori kernel, publikasikan, re-pin commit di
SKILL.md, dan perbarui `STATE.style_contract` melalui `saipen recover`. Edit lokal
pada `STYLE.md` membuat desinkronisasi di setiap mesin selain mesin
yang melakukannya.

Satu jebakan yang perlu disebut: `bin/saipen` yang dipublikasikan adalah
shim terikat mesin yang meng-hardcode path interpreter dan checkout absolut
satu operator. Ia hanya berjalan di tepat satu mesin. Cloud harus
memakai `python3 tools/saipen.py`.

Pintasan: `cc` melanjutkan Work saat ini; `cc all <text>` ingesting
seluruh pesan sebagai source/appends dan melanjutkan setiap Work yang
layak. Keduanya tidak meminta konfirmasi rutin.

## Klasifikasi kapabilitas

**AVAILABLE_IN_CLOUD** — status protokol dan lapisan workspace. Membaca dan menulis `.saipen/`, launcher (`tools/launcher/ZaicodeLauncher.cs`), installer di bawah `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/`, dan skrip transport. Git read, commit, push dan fetch pada `saipen-live`. Gate mana pun yang berupa pemeriksaan file, tinjauan diff, atau cek teks.

**LOCAL_WINDOWS_ONLY** — gate yang membutuhkan mesin ini.

| Gate | Mengapa |
|------|-----|
| `tools\launcher\build.cmd` | mengompilasi `ZaicodeLauncher.cs` dengan .NET Framework `csc`; tidak ada Windows SDK di citra cloud |
| E2E Electron terpackages (desktop `zcode`, Solo → queue → dispatch) | butuh sesi desktop dan profil penyedia yang sudah terisi |
| 9router yang aktif | layanan Windows di mesin ini |
| click-through desktop interaktif | butuh manusia dan layar |
| kasus runtime milik watcher itu sendiri | watcher hanya berjalan di mesin yang memegang checkout tersebut |

Ini dicatat sebagai batas penerimaan khusus lokal. Tidak pernah dilaporkan lulus hanya karena diff-nya terlihat benar.

**SAFE_TO_DEFER** — lapisan produk. Sesi cloud dapat mengkloning `vacterro/zaicode` cabang `zaicode` dan bekerja di sana. Pekerjaan lapisan workspace tidak memerlukan pekerjaan produk, tetapi memerlukan clone: `.saipen/source-nested-repos.json` mendeklarasikan `zcode/`, dan tanpanya validator gagal dengan `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. Gate `pnpm` memerlukan pnpm 10.33.2 yang di-pin dan workspace yang telah disiapkan. `pnpm bootstrap` pada citra cloud segar adalah cara masuk yang terdokumentasi, dan `package.json` milik produk sudah mendeklarasikannya.

Cloud hanya bisa memverifikasi byte produk yang ada di `origin/zaicode`. Delta
produk yang hanya ada di checkout `zcode/` operator tidak terlihat di
sini, jadi setiap product gate untuknya TIDAK DIJALANKAN di cloud, apa pun
gate-nya. T-84 adalah kasus pertama (E-1411): perbaikannya hanya lokal
sementara `origin/zaicode` masih membawa kode pra-perbaikan.

**UNSAFE_TO_EMULATE** — apa pun yang membuat gate khusus lokal tampak hijau. Jangan stub build launcher, jangan palsukan proses aplikasi terpackages, jangan putar ulang hasil `pnpm verify:pre-push` yang terekam seolah baru dijalankan, dan jangan ubah "kodenya terlihat benar" menjadi baris PASS di `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — kesesuaian yang bergantung pada lokasi checkout. Di kernel `3088eff`, validator cloud melaporkan FAIL `closure-evidence` (T-47, T-62, T-76, T-78 pada saat ditulis) yang tidak dilaporkan mesin operator.

Kernel memindahkan setiap event LOG di atas 1024 byte ke sidecar `.saipen/recovery/log-detail/`. Saat dibaca, ia hanya memulihkan sidecar bila path absolut checkout sama dengan path tempat sidecar itu ditulis. Jadi verdict VERIFY panjang yang ditulis di Windows tidak terbaca di cloud, dan sebaliknya juga berlaku.

Defeknya ada di kernel dan filed sebagai P1-1 di `docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Sampai patch-nya masuk:

- kutip vonis cloud dan klasifikasikan sebagai batas ini, ticket demi ticket
  (`SKILL.md` § 6 punya pemeriksaan);
- jangan pernah menulis ulang sidecar, jangan hanya verifikasi ulang demi hijau, atau menambal salinan kernel;
- jaga event LOG di bawah 1024 byte di kedua sisi.

Pengikatan jalur mesin yang sama juga memblokir pekerjaan. Baseline utang pra-BUILD
tercatat saat pertama kali sebuah ticket masuk BUILD, lalu diperiksa ulang tiap
entri berikutnya. Jadi ticket yang pertama kali masuk BUILD di mesin operator
tidak bisa masuk BUILD di cloud: transisinya ditolak dengan `DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 adalah
kasus tercatat: DEBT-000079 tercatat di E-1377 dan transisinya ditolak di E-1446.
Biarkan ticket seperti itu ditangani mesin yang mencatat baseline-nya.

## Divergensi

Kalau lokal dan remote berhenti berbagi leluhur, watcher berhenti. Tidak
merge, rebase, atau paksa. Dua id commit masuk log, perbaikannya `git log --left-right --cherry-pick <branch>...origin/<branch>`
secara manual, dan hasilnya di-checkpoint seperti perubahan lain.

## Tindakan sisi cloud yang persis

### Skrip setup lingkungan (sekali, di pengaturan lingkungan cloud)

Menu lingkungan cloud di title bar sesi -> Edit -> Setup script. Skrip ini
jalan sebelum tiap sesi baru, jadi tiap sesi mulai dengan toolchain produk siap:

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

### Prompt untuk tiap sesi baru

Mulai sesi di repository `vacterro/zaicode`, branch `saipen-live`, dan
pastikan agent di mesin operator tidak menulis bersamaan.
Ganti baris terakhir dengan `cc all <new list>` untuk menyerahkan pekerjaan baru.

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

Di mesin operator, watcher melakukan fast-forward `zcode` dari
`origin/zaicode`; `REBUILD.cmd` (atau `REBUILD_fast.lnk`) membangunnya, dan
start berikutnya ZAICODE menukar build baru itu masuk.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
