# ZAICODE इंस्टॉल करना

ZAICODE तीन प्रोजेक्ट हैं जो एक साथ काम करते हैं: ZAICODE ऐप, SAIPEN (वह प्रोटोकॉल जो एजेंट के काम को ट्रैक पर रखता है) और SAIMAIL (वह मेल जिससे एजेंट एक-दूसरे को बातें बताते हैं)। इन्हें हाथ से इंस्टॉल करने का मतलब तीन क्लोन, Node.js टूलचेन, Python एनवायरनमेंट और बिल्ड है। इंस्टॉलर यह सब कर देता है:
चलाइए, प्रतीक्षा कीजिए, और डेस्कटॉप पर ZAICODE शॉर्टकट तैयार है।

## एक क्लिक

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  डाउनलोड करें, डबल-क्लिक करें, **INSTALL** दबाएँ। विंडो (गहरे रंग पर सुनहरा, SAIPEN बैनर) हर चरण चलते हुए दिखाता है, अब तक का समय और माँग पर लॉग; अंत में **START ZAICODE**, या जब कोई चरण पूरा न हुआ हो तो **TRY AGAIN** / **Autotroubleshoot**
  / **Open log**। किसी मौजूदा ZAICODE फ़ोल्डर पर इसे लक्षित करने पर बटन **UPDATE** दिखता है: वही रन अपडेट और मरम्मत करता है। यह
  exe इंस्टॉल स्क्रिप्ट रखता है और साथ में कुछ नहीं चाहिए; इसे `install\setup\build.cmd` से बनाया
  गया है (.NET Framework कंपाइलर जो हर Windows 10/11 में होता है)।
- `install\Setup-ZAICODE.cmd` (डबल-क्लिक): कंसोल में वही इंस्टॉल।
- कुछ भी न हो, PowerShell में:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

सेटअप विकल्प: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (प्रीसेट फ़ोल्डर),
`/auto` (तुरंत शुरू होता है), `/quiet` (कोई विंडो नहीं: कंसोल इंस्टॉलर, एक्सिट कोड
= परिणाम)। पहली बार चलाने पर ऐप इस मशीन पर बनता है, जिसमें कुछ देर लगती है;
बाद की बार सिर्फ़ अपडेट और मरम्मत करता है।

## निःशुल्क मॉडल, सेटअप के लिए कुछ नहीं

ऐप अपना 9router साथ लेता है। जिस मशीन पर यह न हो, वहाँ ZAICODE इसे निजी रूप से चलाता है (आइसोलेटेड मोड, पोर्ट 20138), **SAIFREN** को बिना कुंजी वाले निःशुल्क टियर से भरता है और `SAIRoute / SAIFREN` को नए कार्यों का मॉडल बनाता है, ताकि New task में टाइप किया गया पहला कार्य उत्तर पा जाए: न कुंजी, न खाता, कोई सेटिंग नहीं। Claude Code, Codex और Antigravity के लॉगिन वैकल्पिक हैं; मशीन पर कभी सेटअप न किया गया कोई लॉगिन "वैकल्पिक, कभी भी साइन इन करें" के रूप में दिखता है, "आपकी ज़रूरत है" वाले आइटम के रूप में नहीं।
प्रमाण: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
खाली प्रोफ़ाइल (अपना HOME, APPDATA और LOCALAPPDATA) पर पैकेज किया हुआ ऐप चलाता है और तभी पास होता है जब राउटर आइसोलेटेड हो, SAIFREN अपना फ़र्स्ट-टोकन प्रोब का उत्तर दे और New task में किसी कार्य का उत्तर मिले।

## अपडेट: चार हिस्से, एक ZAICODE

वर्कस्पेस (लॉन्चर, इंस्टॉलर), ऐप, SAIPEN और SAIMAIL चार क्लोन हैं। हर एक अपने आप अपडेट होता है: **Settings -> ZAICODE -> Updates** उन्हें वर्ज़न और कमिट के साथ दिखाता है, एक-एक करके या सभी को अपडेट करता है, और हर हिस्से के लिए "अपने आप" स्विच रखता है (इंस्टॉल किए गए ZAICODE में डिफ़ॉल्ट रूप से चालू, डेवलपर चेकआउट में बंद)। ZAICODE शुरू होने के कुछ मिनट बाद फिर हर छह घंटे जाँच करता है। अपडेट के बाद हर हिस्से को ज़रूरी चीज़ मिलती है: ऐप को उसकी डिपेंडेंसीज़ (जब `pnpm-lock.yaml` बदला हो) और नया बिल्ड (ZCIDE चलने के दौरान स्टेज, अगली बार शुरू होने पर चालू), SAIPEN को उसका लॉन्चर, SAIMAIL को उसका `.venv` इंस्टॉल, वर्कस्पेस को नया रूट लॉन्चर। कोई क्लोन जो दूसरी ब्रांच पर हो, लोकल कमिट रखता हो, या ऐसे बदलाव रखता हो जिन्हें अपडेट ओवरराइट करेगा, रिपोर्ट होता है और बिल्कुल वैसा ही छोड़ दिया जाता है।

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## यह क्या करता है

इंस्टॉलर यही है: Autotroubleshoot की वे जाँचें जो "repair" के साथ खाली फ़ोल्डर पर इसी क्रम में चलाई जाती हैं। हर चरण इडेम्पोटेंट है, इसलिए उसे दोबारा चलाने पर इंस्टॉल अपडेट होता है और टूटा हुआ हिस्सा ठीक हो जाता है।

| जाँच | मरम्मत |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | जब मशीन की कॉपी उपयुक्त हो तो उसी का उपयोग; नहीं तो `.tools\` में निजी कॉपी (Git for Windows से MinGit, nodejs.org से Node.js 24.14.0, अपने NuGet पैकेज से Python)। किसी व्यवस्थापक अधिकार की ज़रूरत नहीं। |
| pnpm | `.tools\pnpm10` में पिन किया हुआ pnpm 10.33.2 |
| ZAICODE वर्कस्पेस | `vacterro/zaicode` की `master` ब्रांच का क्लोन (लॉन्चर सोर्स, इंस्टॉलर, डॉक्स; डेवलपर का `.saipen/` मेमोरी शामिल नहीं; `workspace` ब्रांच 2026-09-27 तक) |
| ZAICODE ऐप सोर्स | `zaicode` ब्रांच का क्लोन `zcode\` में |
| SAIPEN | `vacterro/saipen` का क्लोन `saipen\` में; इसका `bin\saipen.cmd` इस क्लोन और इस Python के लिए लिखा गया है |
| SAIMAIL | `vacterro/saimail` का क्लोन `saimail\` में, `.venv\` में इंस्टॉल |
| saimail-local | SAIMAIL का कमांड-लाइन क्लाइंट, जिसे ZAICODE के SAIMAIL पैनल इस्तेमाल करते हैं (SAIMAIL `0.0.2a3` से शामिल; `saimail-cli` जाँच OK बताती है) |
| 9router पैकेज | npm से `.tools\router` में `9router`, बंडल किया हुआ ताकि SAIFREN बिना किसी सेटअप के चले (npm उसे न पा सके तो WARN) |
| ऐप डिपेंडेंसीज़ | `pnpm install --frozen-lockfile` (जब `pnpm-lock.yaml` बदले तो फिर से) |
| ऐप बिल्ड | `pnpm bundle:zaicode`; ZAICODE चलने के दौरान नया बिल्ड स्टेज होता है और अगली बार शुरू होने पर बदल दिया जाता है |
| स्टेज्ड बिल्ड स्वैप | लंबे पथ की वजह से हुई स्वैप विफलता से छूटा हुआ `win-unpacked.previous` हटाता है और ZAICODE बंद होने पर इंतज़ार कर रहे बिल्ड को बदल देता है |
| रूट लॉन्चर | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| शॉर्टकट | डेस्कटॉप और स्टार्ट मेन्यू `ZAICODE` -> `ZAICODE.exe` |
| Claude / Codex लॉगिन | केवल रिपोर्ट: हर `~\.claude*` / `~\.codex*` लॉगिन ZAICODE में अपना अलग इंजन है (A1, A2, C1, ...); लॉगिन की ज़रूरत आपको है, ब्राउज़र में |

रूट लॉन्चर ZAICODE को इंस्टॉल किए गए SAIPEN (`saipen\`) की ओर इशारा कराता है और `.tools\` तथा `.venv\Scripts` को ऐप के PATH में सबसे आगे रखता है, ताकि ऐप, उसके एजेंट और उसके वर्कर इंस्टॉल की गई कॉपियाँ ही इस्तेमाल करें।

## कई सदस्यताएँ

हर Claude Code या Codex लॉगिन अपने होम में रहता है: `~\.claude`,
`~\.claude-account2`, ... और `~\.codex`, `~\.codex-account2`, ... ZAICODE सभी ढूँढ़ लेता है।
इंस्टॉल समय पर और तैयार करने के लिए:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

इंस्टॉलर होम बनाता है और हर एक के लिए सही लॉगिन कमांड छापता है
(`$env:CODEX_HOME = '...'; codex login`)। यही ZAICODE में भी है: Settings ->
Engines & limits -> दूसरा लॉगिन जोड़ें।

## ऑटोट्रबलशूट

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

हर जाँच की स्थिति: OK, FIXED (टूटा था, ठीक किया), WARN (चल रहा है, पर कुछ
वैकल्पिक नहीं है), INFO (आपसे चाहिए: लॉगिन), FAIL। लॉग `install\logs\` में हैं;
पिछले इंस्टॉल का सारांश `install\install-report.json` है।
ऐप में, Router -> Autotroubleshoot चल रहे राउटर और पूल ठीक करता है।

## विकल्प

| पैरामीटर | डिफ़ॉल्ट | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | सब कुछ कहाँ जाता है |
| `-ShortcutDir` | Desktop | ZAICODE शॉर्टकट कहाँ जाता है |
| `-NoStartMenu`, `-NoShortcut` | | वे शॉर्टकट छोड़ें |
| `-PortableTools` | | निजी Git / Node.js / Python, भले ही मशीन में मौजूद हों |
| `-Launch` | | काम पूरा होने पर ZAICODE चलाएँ |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | GitHub रिपॉज़िटरी | दूसरा स्रोत (फ़ोर्क, लोकल क्लोन पथ) |

## प्रमाण

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
फ्रेश इंस्टॉल जाँचता है, खराबियाँ पैदा करता है (शॉर्टकट और लॉन्चर डिलीट, SAIPEN
लॉन्चर गुम Python पर सेट, SAIMAIL की venv डिलीट, node_modules
दूसरे lockfile के लिए दर्ज, MAX_PATH से गहरा बचा बिल्ड फ़ोल्डर),
तय करता है कि doctor हर एक की रिपोर्ट दे और ठीक करे, फिर शॉर्टकट के लक्ष्य को
आइसोलेटेड प्रोफ़ाइल से चलाता है और ठीक वही प्रोसेस ट्री रोकता है जो उसने शुरू की थी।

`install\tests\Test-ZaicodeUpdate.ps1` डिस्क पर चार फेंकने-योग्य रिपॉज़िटरी और उनके क्लोन का इंस्टॉल
बनाता है, फिर साबित करता है कि जाँच कुछ नहीं बदलती, कि एक हिस्सा अपने
अगले अपडेट के साथ अकेला बदलता है (SAIPEN लॉन्चर, रूट लॉन्चर), कि ओवरलैप करती
लोकल एडिट और लोकल कमिट बनी रहती हैं, और कि अज्ञात हिस्से का नाम अस्वीकार किया
जाता है। कोई नेटवर्क नहीं।

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
