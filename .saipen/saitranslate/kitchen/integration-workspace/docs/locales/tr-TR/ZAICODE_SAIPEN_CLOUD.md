# ZAICODE SAIPEN bulut taşıması

Bu ödeme akışı ile bir Claude Code Cloud oturumu, tek bir SAIPEN çalışma alanını
farklı yürütücü konumlarıyla nasıl çalıştırır ve sınır nerede.

## Biçim

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Protokol durumunu tek bir dal taşır. Birleştirme adımı, yeniden tabanlama
adımı ve eşitlenmesi gereken ikinci bir yerel dal yoktur: doğrulanmış kontrol
noktasına sahip yürütücü onu commit edip iter, diğer taraf fast-forward ile alır.

`master`, taşıma öncesi geçmiş ve yayınlanmış varsayılan daldır. Taşıma
tarafından zorla güncellenmez.

## Ney seyahat eder, ne seyahat etmez

Bu depodaki bir kontrol noktası; SAIPEN protokol durumunu, kök başlatıcıyı,
kurulum dosyasını, belgeleri ve bu taşıma betiklerini taşır. Çalışma alanı
katmanının tamamı budur.

**Hiçbir ürün baytı taşımaz.** `zcode/` ayrı bir Git deposudur, `.saipen/source-nested-repos.json`
içinde listelenir ve bu kökte .gitignore edilir (`/zcode/`). Ürün çalışması,
`zaicode` dalında `vacterro/zaicode` deposunun kendi klonunu gerektirir; bu klon
g kendi geçmişi olan ikinci, bağımsız bir nesnedir.

Sonuç yanlış anlaşılması kolaydır: bu kökte temiz bir `git status`, commit edilmemiş
ürün çalışması hakkında hiçbir şey söylemez; `saipen-live` fast-forward ise
ürün kodu hakkında hiçbir şey söylemez. `git -C zcode status` dosyasını açıkça kontrol edin.

## Yerel yarı

İki betik; ikisi de depoya ait, böylece yeni bir makine onları bellekten değil
depodan alır:

| Dosya | Rol |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | doğrular, dalı uzlaştırır, watcher'ı kurar ve başlatır, otomatik başlatma kaydını yazar, yerel == uzak olduğunu kanıtlar |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | döngü: fetch, karşılaştır, fast-forward veya push, log, duraklat; ardından ürün geçişi ve kendini güncelleme |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | bağımsız bir çalıştırıcıdan gidiş-dönüş artı soğuk kurtarma kanıtı |
| `tools/saipen-cloud/Test-ProductSync.ps1` | geçici Git depolarına karşı ürün geçişi ve kendini güncelleme (ağ yok, gerçek uzak yok) |

Kurulum ve onarım:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

İdempotenttir. Makineye yerel durum burada yaşar: `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (bir kopya), `ZAICODE_cloud-sync.log` (`.log.1` hedefinde
2 MB'de döndürülür), `ZAICODE_cloud-sync.lock` (tek örnek),
`ZAICODE_cloud-sync.pid` ve bir Startup klasörü kaydı
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Kurulum aracı kirli bir ağacı reddeder ve asla onu temizlemez. Her kirli yol `.saipen/` altındaki kanonik SAIPEN durumundaysa, bunu söyler ve tam kontrol noktası komutlarını yazdırır; bu, aktarım hatası değil, kontrol noktası alınmamış bir protokol durumudur ve kurulum aracı onu protokolün arkasından commit etmez.

## Watcher davranışı

| Durum | Hamle |
|-----------|------|
| temiz, yerel uzağın atası | `git merge --ff-only` |
| temiz, uzak yerelin atası | `git push` |
| kirli | duraklat; fetch bile yok |
| başka bir dalda | duraklat |
| ikisi de ilerledi, ortak ata yok | duraklat, iki commit id'yi de logla, hiçbir şeyi birleştirme |
| fetch veya ağ başarısız | bozuldu olarak logla, sonraki tick'te yeniden dene |
| bir merge/rebase/cherry-pick sürüyor | duraklat |

Asla: force push, hard reset, stash, clean, yabancı dal checkout'u,
commit veya süreç adına göre durdurma. Kurulum aracı bir watcher'ı yalnızca
kendi pid dosyasına kaydettiği pid ile durdurur.

Kirli bir ağaç hiçbir şeye mal olmaz, çünkü watcher fetch'ten önce kirliliği kontrol eder.
Boşta duran bir checkout bu yüzden hiç ağ çağrısı yapmaz.

### Ürün geçişi (T-90)

`zcode/` kendi başına bir depodur, dolayısıyla yukarıdaki tablo ürün
kodunu asla taşımaz. Sonrasında, aynı tick ürün checkout'unu da ele alır (`-ProductRepo`,
varsayılan `<repo>\zcode`; dal `-ProductBranch`, varsayılan `zaicode`). Ürün
geçişi, dış ağaç kirli olsa da olmasa da çalışır. Yalnızca pull yapar.

| Durum | Hareket |
|-----------|------|
| uzak önde, gelen dosyaların hiçbiri burada kirli değil | `git merge --ff-only`; commit edilmemiş ürün çalışması olduğu gibi kalır |
| uzak önde, gelen dosyalardan biri burada kirli | BEKLETİLDİ: dosyaları günlüğe yaz, hiçbir şeyi birleştirme |
| yerel önde | günlüğe yaz; **asla gönderilmez** (ürün SAIPEN SHIP ile yayınlanır) |
| ayrışmış | duraklat, iki kimliği de günlüğe yaz, hiçbir şeyi birleştirme |
| başka dal, uçuşta bir git işlemi, fetch başarısız | duraklat |
| `zcode/` çalışma ağacı yok ya da `-NoProduct` | atlandı |

git, yerel bir değişikliği ezdi bir fast-forward'u kendi başına reddeder,
bu yüzden BEKLETİLDİ kontrolü daha önce ve daha açık bir korumadır, tek koruma değil. Ürün
fast-forward'u hiçbir şeyi yeniden derlemez: test için `pnpm bundle:zaicode` çalıştır
(ya da geliştirme önizlemesi).

### Kendini güncelleme (T-90)

Gözlemci `%APPDATA%\SAIPEN` altında bir kopya olarak çalışır, yani depodaki daha yeni
gözlemci yeniden kurulum olmadan hiç çalışmadı. Döngü modunda artık her turda
kendi dosyasını deponun commit edilmiş kopyasıyla karşılaştırır. Bu kopyayı
kendi üzerine kurar ve aynı argümanlarla, yalnızca şu koşulların tümü sağlanıyorsa
tam olarak bir kez yeniden başlatır:

- iki dosya farklı;
- depo kopyasında commit edilmemiş düzenleme yok;
- depo kopyası hatasız ayrıştırılıyor.

Ayrıştırılmayan kopya reddedilir ve günlüğe yazılır, çalışan gözlemci
devam eder.

T-90'dan önce kurulan gözlemcilerde hem ürün geçişi hem kendini güncelleme yoktur.
Böyle bir makinede `Install-SaipenLiveSync.ps1` dosyasını bir kez yeniden çalıştırın; ondan sonra
gözlemci kendini günceller.

## Bulut yarısı

Kök dizindeki `CLAUDE.md` giriş kuralı, `.claude/skills/saipen/SKILL.md` ise yürütme prosedürüdür. Beceri, SAIPEN çekirdeğini
`github.com/vacterro/saipen` adresinden çeker ve onu tanımlanmış motor yüzeyi `tools/saipen.py` üzerinden çalıştırır. Çekirdek etiketle değil, commit ile sabitlenir
(`3088eff`). `v8.0.1` etiketi, aynı `VERSION` değerine sahip eski bir çekirdektir; onun
`validate` durumu değiştirir ve doğrulayıcısı bu tahtayı reddeder.

`STATE.saipen_home`, en son kontrol noktasını kaydeden yürütücünün çekirdek yolunu tutar. Bulutta, `3088eff` çekirdeği üzerindeki ilk `saipen continue`, onu
günlüklü tek bir `DEC` olarak çalışan çekirdeğe yakınsar (E-1410). Operatör
makinesinde de işaretçi aynı şekilde ölü olarak ulaşır. Otomatik yakınsama
yapan bir çekirdek bunu `continue` üzerinde onarır; aksi halde `saipen rebind-home --auto` çalıştırın.

**Dönüş yolculuğu gözlemlendi.** E-1562 (cloud) işaretçiyi `/home/user/zaicode/.claude/saipen-protocol` üzerine
yakınsadı; E-1571 (operatör makinesi) onu otomatik olarak, elle
`rebind-home` olmadan doğrudan `V:/.../_SAIPEN` üzerine geri yakınsadı. Her iki yön de aynı
otomatik yakınsama, bu yüzden her yerellik değişiminde bir `saipen_home` `DEC`
bekleyin ve bunu kusur değil, beklenen gürültü olarak değerlendirin.
P1-2 (`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) işaretçiyi sürümlenmiş durumdan çıkarana kadar gürültü olarak kalır;
P1-2'yi bunu fark etmenin yan etkisi olarak uygulamayın. İşaretçiyi asla elle
düzenlemeyin.

`STATE.saipen_home`, sabitlenmiş (pinned) sürümden ileri olan bir çekirdek **geliştirme
kopyasını** gösterebilir, temiz bir `3088eff` klonunu değil — operatör makinesinde
bu, commit edilmemiş çalışma içeren `accepted-debt-rebind` branch'idir. Sabitlenmiş commit'te
olmayan bir çekirdek otomatik olarak yanlış değildir, ama temiz oda kaynağı da
değildir; bu nedenle aşağıdaki ses sözleşmesi kuralı ona da tam kuvvetle geçerlidir.
Böyle bir kopyada hiçbir şeyi asla commit, stash, reset, checkout veya clean
etmeyin; `saipen/STYLE.md` için hedefli tek dosya geri yüklemesi tek istisnadır ve
yalnızca operatör istediğinde yapılır.

### STYLE.md yerel bir ayar değildir

`saipen/STYLE.md`, her makinede, her kopyada, istisnasız ve yerel düzenleme olmadan
**sabitlenmiş çekirdeğin dosyasıyla bayt bayt aynı** olmalıdır. Bir operatör
makinesinde birden fazla kopyası vardır:

- `STATE.saipen_home` konumundaki çekirdek checkout'u (bir Git klonu, operatör
  makinesinde bir geliştirme checkout'u);
- `saipen-inject` zamanlanmış görevi (`bootstrap/schedule-run.ps1`) tarafından doldurulan `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`.
  Bu **bir Git deposu değildir**, bu yüzden `git checkout` onu asla onarayamaz —
  injector üzerinden yeniden eşitleme veya yayınlanan içeriğin doğrudan yazılması
  tek yoldur.

`.saipen/STATE.md` içindeki `style_contract` belirteci, o dosyanın metninin bir
hash'idir (`tools/validate.py`, `style_contract_token`: CRLF normalize edilmiş, `style_contract:` satırı
hariç). `reply_language` dosyasını bir kopyada düzenleyin; belirteç değişir; diğer
kopyada ve yayınlanan çekirdeği çeken cloud'da yayınlanan belirteç kalır ve
eşleşmeyen taraftaki her CLI yazımı `style_contract ... does not match the installed STYLE.md marker` ile reddedilir.
Tüm hata budur: yerel taraf, cloud'un yazamadığı durumu yazıyor.

**Yanıt dilini değiştirmek, yerel düzenleme değil; çekirdek commit'i artı yeniden
sabitlemedir (repin).** Bunu çekirdek deposunda değiştirin, yayınlayın, commit'i
SKILL.md içinde yeniden sabitleyin ve `STATE.style_contract` dosyasını `saipen recover` üzerinden
güncelleyin. `STYLE.md` üzerindeki yerel düzenleme, değişikliği yapan makine
dışındaki tüm makineleri desenkronize eder.

Adı konmasına değer bir tuzak: yayınlanan `bin/saipen`, tek bir operatörün mutlak
interpreter ve checkout yollarını sabit kodlayan, makineye bağlı bir shim'dir. Tam olarak
bir makinede çalışır. Cloud `python3 tools/saipen.py` kullanmalıdır.

Kısayollar: `cc` mevcut Work'i sürdürür; `cc all <text>` mesajın tamamını
kaynak/appends olarak alır ve uygun olan her Work'i sürdürür. Hiçbiri rutin
onay istemez.

## Yetenek sınıflandırması

**AVAILABLE_IN_CLOUD** — protokol durumu ve workspace katmanı. `.saipen/` okuma ve yazma, launcher (`tools/launcher/ZaicodeLauncher.cs`), `install/` altındaki installer, `docs/`, `CLAUDE.md`, `.claude/skills/` ve transport script'leri. `saipen-live` üzerinde Git okuma, commit, push ve fetch. Dosya doğrulaması, diff incelemesi veya metin kontrolü olan her gate.

**LOCAL_WINDOWS_ONLY** — bu makineyi gerektiren gate'ler.

| Gate | Neden |
|------|-------|
| `tools\launcher\build.cmd` | `ZaicodeLauncher.cs` bileşenini .NET Framework `csc` ile derler; cloud imajda Windows SDK yok |
| paketlenmiş Electron E2E (`zcode` masaüstü, Solo → kuyruk → dispatch) | masaüstü oturumu ve tohumlanmış sağlayıcı profili gerekir |
| canlı 9router | bu makinede bir Windows servisi |
| etkileşimli masaüstü tıklama testi | bir insan ve bir ekran |
| watcher'ın kendi çalışma zamanı testleri | watcher yalnızca checkout'u tutan makinede çalışır |

Bunlar yalnızca yerel kabul sınırları olarak kaydedilir. Diff doğru göründü diye asla başarılı olarak raporlanmaz.

**SAFE_TO_DEFER** — ürün katmanı. Bir cloud oturumu `vacterro/zaicode` branch `zaicode` klonlayıp orada çalışabilir. Workspace katmanı işi ürün işi gerektirmez, ama klonu gerektirir: `.saipen/source-nested-repos.json`, `zcode/` bildirir; bunun olmadan validator `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'` ile başarısız olur. `pnpm` gate'leri sabitlenmiş pnpm 10.33.2 ve hazırlanmış bir workspace ister. `pnpm bootstrap`, taze bir cloud imajda belgelenmiş giriş yoludur ve ürünün `package.json` bunu zaten bildirir.

Cloud yalnızca `origin/zaicode` üzerinde bulunan ürün baytlarını doğrulayabilir. Yalnızca operatörün `zcode/` checkout'unda var olan bir ürün farkı burada görünmez; dolayısıyla o fark için her ürün gate'i, gate ne olursa olsun, cloud'da NOT RUN'dır. T-84 ilk vakadır (E-1411): düzeltmesi yalnızca yereldi ve `origin/zaicode` hâlâ düzeltme öncesi kodu taşıyordu.

**UNSAFE_TO_EMULATE** — yerel bir gate'i yeşil gösteren her şey. Launcher derlemesini stub'lamayın, paketlenmiş uygulama çalıştırmasını taklit etmeyin, kaydedilmiş bir `pnpm verify:pre-push` sonucunu az önce çalışmış gibi replay etmeyin veya `.saipen/LOG.md` içinde "kod doğru görünüyor" ifadesini PASS satırına çevirmeyin.

**KNOWN_CLOUD_DIVERGENCE** — checkout'un nerede bulunduğuna bağlı olan uyumluluk. `3088eff` çekirdeğinde cloud validator, operatör makinesinde oluşmayan `closure-evidence` FAIL'lerini raporlar (yazıldığı sırada T-47, T-62, T-76, T-78).

Çekirdek, 1024 bayttan büyük her LOG olayını bir `.saipen/recovery/log-detail/` sidecar dosyasına taşır. Okuma sırasında sidecar'ı yalnızca checkout'un mutlak yolu, onun yazıldığı yola eşitse geri yükler. Bu nedenle Windows'ta yazılmış uzun bir VERIFY kararı cloud'da okunamaz ve tersi de geçerlidir.

Kusur çekirdektedir ve `docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md` içinde P1-1 olarak kaydedilmiştir. Uygulanana kadar:

- bulut hükmünü alıntıla, ticket başına bu sınır olarak sınıflandır
  (`SKILL.md` § 6 kontrolü içerir);
- sidecar'ları asla yeniden yazma, yalnızca yeşil almak için yeniden doğrulama yapma, kernel
  kopyasını yamalama;
- LOG olaylarını her iki tarafta 1024 baytın altında tut.

Aynı machine-path bağlama işi de bloke eder. BUILD öncesi borç tabanı, ticket ilk kez BUILD'e girdiğinde alınır ve sonraki her girişte yeniden kontrol edilir. Bu yüzden ilk kez operatör makinesinde BUILD'e giren bir ticket bulutta BUILD'e giremez: geçiş `DEBT_SNAPSHOT_FOREIGN_PROJECT` ile reddedilir. Kayıttaki vaka T-84: DEBT-000079 E-1377'de alındı, geçiş E-1446'da reddedildi. Böyle bir ticket'ı tabanını yakalayan makineye bırak.

## Ayrışma

Yerel ve uzak ortak bir atayı paylaşmayı bırakırsa watcher durur. Birleştirme, rebase veya zorlama yapmaz. Her iki commit id log'a yazılır, düzeltme elle `git log --left-right --cherry-pick <branch>...origin/<branch>` olur ve sonuç diğer her değişiklik gibi checkpoint'lenir.

## Bulut tarafındaki tam işlem

### Ortam kurulum script'i (tek sefer, bulut ortamının ayarlarında)

Oturum başlık çubuğundaki bulut ortamı menüsü -> Edit -> Setup script. Her yeni oturumdan önce çalışır, böylece her oturum ürün toolchain'i hazır başlar:

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

### Her yeni oturum için prompt

Oturumu `vacterro/zaicode` deposunda, `saipen-live` branch'inde başlat ve operatör makinesinin agent'ının aynı anda yazmadığından emin ol. Yeni işi devretmek için son satırı `cc all <new list>` ile değiştir.

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

Operatör makinesinde watcher `zcode`'i `origin/zaicode`'den fast-forward eder; `REBUILD.cmd` (ya da `REBUILD_fast.lnk`) onu derer ve ZAICODE'nin bir sonraki başlatılışı yeni build'i devreye alır.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
