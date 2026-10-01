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

ZAICODE, birçok AI kodlama ajanını aynı anda, çok sayıda proje üzerinde
bebek baktırmadan çalıştırmak için bir operatör tezgâhıdır.
[ZCode](https://github.com/zai-org/ZCode) (masaüstü uygulaması, tarayıcı arayüzü ve ajan
CLI) üzerine ürün katmanı eklenmiş bir derlemedir: her proje
[SAIPEN](https://github.com/vacterro/saipen) protokolüyle sürülür, iş tek bir pencereden başlatılır,
devam ettirilir ve zamanlanır; zaten ödediğiniz abonelik CLI'ları
(Claude Code, Codex, Antigravity) uygulama içi ajanların yanında yana yerleştirilmiş
işçiler olarak çalışır.

**0.0.1** ilk etiketli anlık görüntüdür: kişisel, önce Windows'a yönelik, her gün
kullanılan bir derleme.

## Tek tıkla kurulum

1. **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)** dosyasını indirin.
2. Çift tıklayın ve **INSTALL** tuşuna basın.

Hepsi bu. Kurulum, makinede eksik olan her şeyi özel kopyalar olarak getirir
(Git, Node.js, Python; yönetici hakkı gerekmez), ZAICODE, SAIPEN ve SAIMAIL'ı
GitHub'dan çeker, uygulamayı makinede derler ve masaüstüne bir ZAICODE kısayolu
eyler. İlk çalıştırma 15-30 dakika sürer; pencere her adımı gösterir.

Ücretsiz modeller anında çalışır: ZAICODE kendi yönlendiricisini başlatır ve **SAIFREN**
havuzunu anahtarsız ücretsiz katmanlarla doldurur; böylece New task'a yazılan bir iş
anahtarsız, hesapsız ve ayarsız yanıt alır. Claude Code, Codex ve Antigravity
abonelikleri isteğe bağlıdır ve istendiği zaman oturum açılabilir.

**Bütün olarak bir, dört parça.** Çalışma alanı (başlatıcı, kurulum), uygulama, SAIPEN
ve SAIMAIL dört depodur. Her biri kendi başına güncellenir: *Settings -> ZAICODE ->
Updates* her parçayı gösterir, elle veya kendiliğinden günceller (başlatmadan birkaç
dakika sonra ve her altı saatte bir). ZAICODE çalışırken yeni bir uygulama derlemesi
hazırlanır ve bir sonraki başlatmada devreye girer; klon içindeki kendi
düzenlemeleriniz asla üzerine yazılmaz. Terminalden: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Otomatik sorun giderme: `install\Doctor.cmd`. Ayrıntılar: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Arayüz turu

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

## ZCode'a ekledikleri

- **MAIN oturumu olan projeler.** Her proje bir MAIN oturumu (START,
  `/goal cc all`) ve yardımcı oturumlar (subSaipens: WIKI, TEST, AUDIT, …) içerir. Varsayılan
  kenar çubuğu görünümü proje satırını MAIN olarak gösterir; ▶ yeni oturum açmak yerine
  MAIN'i sürdürür. CONTINUE ALL, DONE ve CLEAR ALL DONE
  her projeyi tarar; tur ortasında kesilen oturum DONE değil INTERRUPTED gösterir.
- **Çökme güvenliği.** Ölü bir sürecin kestiği oturumlar ve hâlâ etkin hedefler
  yeniden başlatma sonrası kendiliğinden devam eder; çalışan worker'lar yeniden başlar.
  ZAICODE içindeki ajanlar süreç adıyla ZAICODE'u öldüremez.
- **Worker'lar.** Abonelik CLI'ları pencerenin herhangi bir kenarına sabitlenmiş terminallerde
  (veya kendi yapışkan pencerelerinde) çalışır. İlk çalıştırmadaki "Bu klasörü güveniyor musun?"
  soruları yanıtlanır; kullanım limitine takılan worker bildirilir ve ayara göre limit
  sıfırlandıktan sonra kapatılır veya yeniden başlatılır.
- **Limitler ve sıfırlamalar.** Hesap ve havuz başına kota göstergeleri, en yakın sıfırlamaya
  kadar başlık çubuğu zamanlayıcı ve üzerine gelince gelen tüm sıfırlamaların listesi.
- **SCHEDULER.** Kendiliğinden başlayan istemler: belirli bir saatte, günlük, her N
  dakikada ya da kota penceresi dolduğunda; tek projede veya kenar çubuğunun tüm
  bölümünde, en kötü projeler (en çok engellenen / açık SAIPEN ticket'ı) önce.
  Koşullar geçici işleri önce durdurabilir (ücretsiz havuz oturumları, zayıf worker'lar), yalnızca
  boştaki projelerde çalışabilir veya yalnızca işaretli oturumları sürdürebilir. İstemlerde
  pratik bir uzunluk sınırı yoktur.
- **Yönlendirme.** Paketlenmiş 9router (MIT) sıfır kurulumlu havuzlar sunar: SAIFREN
  (anahtarsız ücretsiz kademeler) ve SAIOPP (abonelikleriniz).
- **SAIHOME, zamanlayıcılar, sesler, vurgular.** İstatistikli operatör ana ekranı,
  FastPrompter tarzı zamanlayıcılar ve alarmlar, eyleme özel sesler ve Win95 koyu
  altın, piksel keskin arayüz.

## Derleme

Gereksinimler: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) doğruluk kaynağıdır).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Paketlenmiş uygulama her zaman ZAICODE modunda başlar. Eski bir ZAICODE çalışırken
bundler yeni derlemeyi `packages/desktop/dist-next` içinde hazırlar; kök
launcher (branch `master`, `tools/launcher`) sonraki başlatmada onu yerine koyar.
Arayüzün kullandığı net bitmap Verdana varyantı bu depoda yer almaz; onsuz
arayüz sistemin Verdana'sına düşer.

Kontroller: `pnpm typecheck`, `pnpm lint` ve ZAICODE testleri, örneğin
`packages/ui` konumundan `node --import tsx --test test/zaicode*.test.ts`.

## Depo yerleşimi

| Branch      | İçerik                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | kanonik çalışma alanı: launcher, installer (`install/`), ürün dokümanları (`UI.md`, `docs/`), SAIPEN durumu ve CHANGELOG |
| `zaicode`   | kanonik uygulama kaynağı: yukarı akış ZCode geçmişi plus derlemeler ve güncellemeler için kullanılan ZAICODE ürün katmanı |

Eski ya da otomasyonla oluşturulmuş referanslar geçici olarak hâlâ görünebilir, ancak
kanonik ürün branch'leri değildir. Yeni çalışma alanı işi `master` üzerinde; uygulama kaynağı
işi `zaicode` üzerinde yürür.

ZAICODE'a ait uygulama kodu esas olarak `zaicode` branch'indeki
`packages/ui/src/zaicode/`, `packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` ve
`packages/desktop/src/main/zaicode*.ts` içinde yaşar. Çalışma alanı
dokümantasyonu ve launcher/update araçları `master` üzerinde yaşar.

## Yukarı akış ve lisans

ZAICODE, Z.ai tarafından ZCode'den türetilmiştir ve aynı
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE) koşullarıyla dağıtılır; yukarı kaynak bildirimleri
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) ve [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md) dosyalarında tutulur.
Dosyalar ZAICODE yazarı tarafından değiştirilmiştir. ZAICODE bağımsız bir projedir;
Z.ai ile ilişkili değildir ve Z.ai tarafından desteklenmez. Özgün ZCode README dosyası
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) ve [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md) olarak korunur.

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Proje ağı

Bu depo, daha geniş **SAIPEN / vacterro** proje ekosistemimin parçasıdır.

[**Yazar merkezi**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN Community**](https://discord.gg/SEYaYkuVgN)

Tekrarlanabilir hatalar ve kalıcı özellik istekleri için bu deponun [GitHub Issues](https://github.com/vacterro/zaicode/issues) bölümünü kullanın. Hızlı tartışma, ekran görüntüleri ve projeler arası geri bildirim için Discord'u kullanın.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
