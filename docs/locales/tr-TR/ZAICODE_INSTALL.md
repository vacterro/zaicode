# ZAICODE Kurulumu

ZAICODE, birlikte çalışan üç projedir: ZAICODE uygulaması, SAIPEN (ajan işini
doğru yolda tutan protokol) ve SAIMAIL (ajanların birbirine haber vermek için
kullandığı posta). Elle kurmak üç klon, bir Node.js araç zinciri, bir Python
ortamı ve bir derleme demektir. Kurulum sihirbazı hepsini yapar:
çalıştırın, bekleyin, masaüstünde ZAICODE kısayolu hazır.

## Tek tıkla

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  indirin, çift tıklayın, **KUR**'a basın. Pencere (koyu zeminde altın renkli, SAIPEN
  banner'ı) her adımı çalışırken, geçen süreyi ve isteğe bağlı olarak günlüğü
  gösterir; sonunda **ZAICODE'U BAŞLAT**, ya da bir adım tamamlanmadıysa
  **TEKRAR DENE** / **Otomatik Sorun Gider** / **Günlüğü aç**.
  Mevcut bir ZAICODE klasörü gösterildiğinde düğme **GÜNCELLE** yazar: aynı
  çalıştırma hem günceller hem onarır. exe kurulum betiklerini içinde taşır,
  yanında başka hiçbir şeye gerek yoktur; `install\setup\build.cmd` tarafından derlenmiştir
  (her Windows 10/11'de bulunan .NET Framework derleyicisi).
- `install\Setup-ZAICODE.cmd` (çift tıklama): aynı kurulumun konsol sürümü.
- Sıfırdan, PowerShell'de:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Kurulum seçenekleri: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (ön ayar klasörü),
`/auto` (tek seferde başlar), `/quiet` (penceresiz: konsol kurucusu, çıkış kodu
= sonuç). İlk çalıştırma uygulamayı bu makinede derler, biraz zaman alır;
sonraki çalıştırmalar yalnızca günceller ve onarır.

## Ücretsiz modeller, ayarlanacak bir şey yok

Uygulama kendi 9router'ı ile gelir. 9router'ı olmayan bir makinede ZAICODE onu
özel olarak çalıştırır (yalıtılmış mod, 20138 portu), **SAIFREN**'i anahtarsız ücretsiz
katmanlardan doldurur ve yeni görevlerin modelini `SAIRoute / SAIFREN` yapar; böylece Yeni görev'e
yazılan ilk görev yanıt alır: anahtar yok, hesap yok, ayar yok. Claude Code,
Codex ve Antigravity oturum açmaları isteğe bağlıdır; makinede hiç kurulmamış bir
oturum açma "isteğe bağlı, istediğin zaman aç" olarak görünür, "sizi bekliyor"
öğesi olarak değil.
Kanıt: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
paketlenmiş uygulamayı boş bir profille (kendi HOME, APPDATA ve
LOCALAPPDATA değerleriyle) başlatır ve yalnızca yönlendirici yalıtılmışken,
SAIFREN ilk-token probu yanıt veriyorken ve Yeni görev'deki bir görev
yanıtlanıyorken geçer.

## Güncellemeler: dört parça, tek ZAICODE

Çalışma alanı (başlatıcı, kurucu), uygulama, SAIPEN ve SAIMAIL dört ayrı klon'dur.
Her biri kendi başına güncellenir: **Ayarlar -> ZAICODE -> Güncellemeler** bunları
sürüm ve commit bilgisiyle listeler, tek tek veya hepsini birden günceller ve her
parça için bir "kendiliğinden" anahtarı sunar (kurulu ZAICODE'de varsayılan olarak
açık, geliştirici kontrolünde kapalı). ZAICODE başlangıçtan birkaç dakika sonra,
ardından altı saatte bir bakar. Bir güncellemeden sonra her parça ihtiyacını alır:
uygulama bağımlılıklarını (`pnpm-lock.yaml` taşındığında) ve yeni bir derlemeyi
(ZAICODE çalışırken hazırlanır, sonraki başlangıçta devreye girer), SAIPEN kendi
başlatıcısını, SAIMAIL kendi `.venv` kurulumunu, çalışma alanı ise yeni bir kök
başlatıcıyı. Başka bir dalda, yerel commit'leri olan veya güncellemenin üzerine
yazacağı düzenlemeleri bulunan bir klon raporlanır ve olduğu gibi bırakılır.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Ne yapar

Kurucu, boş bir klasörde "onar" ile çalıştırılan OtomatikSorunGiderme denetimleridir,
bu sırayla. Her adım idempotenttir, yani yeniden çalıştırmak kurulumu
günceller ve bozulanı onarır.

| Denetim | Onarım |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | uygun olduğunda makinenin kopyasını kullanır; aksi halde `.tools\` içinde özel kopya (Git for Windows'dan MinGit, nodejs.org'dan Node.js 24.14.0, Python kendi NuGet paketinden). Yönetici hakkı yok. |
| pnpm | `.tools\pnpm10` içinde sabitlenmiş pnpm 10.33.2 |
| ZAICODE çalışma alanı | `vacterro/zaicode` dalının `master` klonu (başlatıcı kaynağı, kurucu, belgeler; geliştiricinin `.saipen/` belleği dışarıda bırakılır; `workspace` dalı 2026-09-27'ye kadar) |
| ZAICODE uygulama kaynağı | `zaicode` dalının `zcode\` içine klonu |
| SAIPEN | `vacterro/saipen` dalının `saipen\` içine klonu; kendi `bin\saipen.cmd` dosyası bu klona ve bu Python'a göre yazılır |
| SAIMAIL | `vacterro/saimail` dalının `saimail\` içine klonu, `.venv\` içine kurulur |
| saimail-local | SAIMAIL'in ZAICODE'un SAIMAIL panellerinin kullandığı komut satırı istemcisi (SAIMAIL `0.0.2a3`'ten itibaren gelir; `saimail-cli` denetimi OK raporlar) |
| 9router paketi | npm'den `.tools\router` içine `9router`, SAIFREN'in sıfır ayarla çalışması için paketlenmiş (npm erişemezse WARN) |
| Uygulama bağımlılıkları | `pnpm install --frozen-lockfile` (`pnpm-lock.yaml` değiştiğinde yeniden) |
| Uygulama derlemesi | `pnpm bundle:zaicode`; ZAICODE çalışırken yeni derleme hazırlanır ve sonraki başlangıçta devreye girer |
| Hazırlanan derlemenin değiştirilmesi | uzun yol değiştirme hatasından kalan `win-unpacked.previous` temizlenir ve bekleyen derleme, ZAICODE kapalıyken devreye alınır |
| Kök başlatıcı | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Kısayollar | Masaüstü ve Başlat menüsü `ZAICODE` -> `ZAICODE.exe` |
| Claude / Codex oturum açmaları | yalnızca raporlanır: her `~\.claude*` / `~\.codex*` oturumu ZAICODE'de kendi motorudur (A1, A2, C1, ...); bir oturum açma sizi bekler, tarayıcıda |

Kök başlatıcı ZAICODE'u kurulu SAIPEN'e (`saipen\`) yönlendirir ve `.tools\` ile
`.venv\Scripts`'yi uygulamanın PATH'inin başına koyar; böylece uygulama, ajanları ve
işçileri kurulu kopyaları kullanır.

## Birden fazla abonelik

Her Claude Code veya Codex oturumum kendi ana dizininde durur: `~\.claude`,
`~\.claude-account2`, ... ve `~\.codex`, `~\.codex-account2`, ... ZAICODE hepsini bulur.
Kurulum anında daha fazlasını hazırlamak için:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Kurulum sihirbazı bu dizinleri oluşturur ve her biri için tam oturum komutunu yazdırır
(`$env:CODEX_HOME = '...'; codex login`). Aynısı ZAICODE içinde de var: Ayarlar ->
Motorlar ve limitler -> başka bir oturum ekle.

## Oto-sorun giderme

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Kontrol başına durum: OK, FIXED (bozuktu, onarıldı), WARN (çalışıyor ama bir şey
eyok — isteğe bağlı), INFO (siz gerekiyor: bir oturum), FAIL. Günlükler `install\logs\` içinde; son kurulumun özeti `install\install-report.json`.
Uygulamada Router -> Oto-sorun giderme çalışan yönlendiriciyi ve havuzları onarır.

## Seçenekler

| Parametre | Varsayılan | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | her şeyin gittiği yer |
| `-ShortcutDir` | Desktop | ZAICODE kısayolunun gittiği yer |
| `-NoStartMenu`, `-NoShortcut` | | bu kısayolları atla |
| `-PortableTools` | | makinede olsalar bile özel Git / Node.js / Python kur |
| `-Launch` | | bitince ZAICODE'yi başlat |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | GitHub depoları | başka kaynak (çatal, yerel kopya yolu) |

## Kanıt

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
temiz bir kurulumu denetler, hataları tohumlar (kısayol ve başlatıcı silinmiş, SAIPEN
başlatıcısı var olmayan bir Python'a yönlendirilmiş, SAIMAIL'in venv'i silinmiş,
node_modules başka bir kilit dosyası için kaydedilmiş, MAX_PATH'ten daha derinde kalmış
aşama klasörü), doctor'ın her birini bildirdiğini ve onardığını doğrular, sonra kısayolun
hedefini izole bir profil ile başlatır ve yalnızca kendi başlattığı süreç ağacını durdurur.

`install\tests\Test-ZaicodeUpdate.ps1` diskte dört geçici depo ve bunların kopyalarından bir kurulum oluşturur,
sonra bir kontrolün hiçbir şeyi değiştirmediğini, tek bir parçanın takibiyle kendi başına
güncellendiğini (SAIPEN başlatıcısı, kök başlatıcı), üst üste binen yerel düzenlemelerin ve
yerel commit'lerin korunduğunu, bilinmeyen parça adının reddedildiğini kanıtlar. Ağ yok.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
