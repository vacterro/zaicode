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

ZAICODE एक ऑपरेटर वर्कबेंच है — कई प्रोजेक्ट पर एक साथ कई AI कोडिंग एजेंट चलाने के लिए, बिना उनकी देखभाल किए। यह [ZCode](https://github.com/zai-org/ZCode) (डेस्कटॉप ऐप, ब्राउज़र UI और एजेंट CLI) का संशोधित बिल्ड है, जिस पर एक प्रोडक्ट लेयर जुड़ा है: हर प्रोजेक्ट [SAIPEN](https://github.com/vacterro/saipen) प्रोटोकॉल से चलता है, काम एक ही विंडो से शुरू, जारी और शेड्यूल होता है, और आपके पास पहले से खरीदे सब्सक्रिप्शन CLI (Claude Code, Codex, Antigravity) ऐप के अंदरूनी एजेंट के बगल में डॉक्ड वर्कर की तरह चलते हैं।

**0.0.1** पहला टैग किया गया स्नैपशॉट है: एक व्यक्तिगत, Windows-आधारित बिल्ड जो रोज़ इस्तेमाल होता है।

## एक क्लिक में इंस्टॉल करें

1. **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)** डाउनलोड करें।
2. उसे डबल-क्लिक करें और **INSTALL** दबाएँ।

बस इतना ही। सेटअप जो कुछ मशीन में नहीं है, वह लाता है (Git, Node.js, Python — निजी कॉपी के रूप में: एडमिनिस्ट्रेटर अधिकारों की ज़रूरत नहीं), GitHub से ZAICODE, SAIPEN और SAIMAIL लाता है, मशीन पर ऐप बिल्ड करता है और डेस्कटॉप पर ZAICODE शॉर्टकट रखता है। पहला रन 15-30 मिनट लेता है; विंडो हर चरण दिखाती है।

फ्री मॉडल तुरंत चलते हैं: ZAICODE अपना राउटर शुरू करता है और **SAIFREN** पूल को बिना-की फ्री टियर से भरता है, इसलिए New task में टाइप किया गया कोई भी काम बिना की, बिना अकाउंट और बिना किसी सेटिंग के जवाब पा लेता है। Claude Code, Codex और Antigravity सब्सक्रिप्शन वैकल्पिक हैं, कभी भी साइन इन किए जा सकते हैं।

**एक पूरा, चार हिस्से।** वर्कस्पेस (लॉन्चर, इंस्टॉलर), ऐप, SAIPEN और SAIMAIL — चार रिपॉज़िटरी। हर एक अपने आप अपडेट होता है: *Settings -> ZAICODE -> Updates* हर हिस्सा दिखाता है, उसे हाथ से या अपने आप अपडेट करता है (शुरुआत के कुछ मिनट बाद और हर छह घंटे)। ZAICODE चलने के दौरान नया ऐप बिल्ड तैयार हो जाता है और अगली बार शुरू होने पर लगता है; आपके क्लोन में किए गए अपने बदलाव कभी ओवरराइट नहीं होते। टर्मिनल से: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`।
स्वतः समस्या-निवारण: `install\Doctor.cmd`। विवरण: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md)।

## इंटरफ़ेस टूर

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

## यह ZCode में क्या जोड़ता है

- **MAIN सत्र वाले प्रोजेक्ट।** हर प्रोजेक्ट में एक MAIN सत्र (START,
  `/goal cc all`) और सहायक सत्र (subSaipens: WIKI, TEST, AUDIT, …) होते हैं।
  साइडबार का डिफ़ॉल्ट व्यू प्रोजेक्ट को उसके MAIN के रूप में दिखाता है; ▶ दूसरा
  सत्र खोलने के बजाय MAIN जारी रखता है। CONTINUE ALL, DONE और CLEAR ALL DONE
  हर प्रोजेक्ट को छानते हैं; बीच में कटा सत्र INTERRUPTED दिखाता है, DONE कभी नहीं।
- **क्रैश सुरक्षा।** मृत प्रोसेस के काटे गए सत्र और अभी सक्रिय लक्ष्य रीस्टार्ट के बाद
  अपने आप जारी रहते हैं; चल रहे वर्कर दोबारा शुरू होते हैं। ZAICODE के भीतर के
  एजेंट प्रोसेस नाम से ZAICODE को नहीं मार सकते।
- **वर्कर।** सब्सक्रिप्शन CLI विंडो के किसी भी किनारे में डॉक किए टर्मिनलों में चलते हैं
  (या अपने स्नैपिंग विंडो में)। पहली बार पूछे जाने वाले "इस फ़ोल्डर पर भरोसा है?"
  सवालों के जवाब दिए जा सकते हैं; उपयोग सीमा पर पहुँचने वाले वर्कर की रिपोर्ट होती है
  और सेटिंग के अनुसार रीसेट के बाद उसे बंद या रीस्टार्ट किया जाता है।
- **सीमाएँ और रीसेट।** हर खाते और पूल के लिए कोटा मीटर, निकटतम रीसेट के लिए टाइटल-बार
  टाइमर और हॉवर पर आने वाले सभी रीसेट की पूरी सूची।
- **SCHEDULER।** अपने आप शुरू होने वाले प्रॉम्प्ट: किसी समय, दैनिक, हर N मिनट या
  कोटा विंडो भरने पर; एक प्रोजेक्ट में या पूरी साइडबार सेक्शन में, सबसे बुरे प्रोजेक्ट
  (सबसे ज़्यादा ब्लॉक / खुले SAIPEN टिकट) पहले। शर्तें स्टॉपगैप काम (फ्री-पूल सत्र,
  कमज़ोर वर्कर) पहले रोक सकती हैं, केवल आइडल प्रोजेक्ट पर चला सकती हैं, या केवल
  चिह्नित सत्र जारी रख सकती हैं। प्रॉम्प्ट की व्यावहारिक लंबाई सीमा नहीं है।
- **रूटिंग।** बंडल 9router (MIT) शून्य-सेटअप पूल देता है: SAIFREN
  (keyless free tiers) और SAIOPP (आपकी सब्सक्रिप्शन)।
- **SAIHOME, टाइमर, ध्वनियाँ, हाइलाइट्स।** आँकड़ों वाला ऑपरेटर होम, FastPrompter-शैली के
  टाइमर और अलार्म, हर क्रिया की अलग ध्वनि और Win95 डार्क गोल्डन, पिक्सेल-क्रिस्प इंटरफ़ेस।

## बिल्ड

आवश्यकताएँ: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) ही स्रोत-सत्य है)।

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

पैकेज किया गया ऐप हमेशा ZAICODE मोड में शुरू होता है। पुराना ZAICODE चलने के दौरान,
बंडलर नया बिल्ड `packages/desktop/dist-next` में स्टेज करता है; रूट
लॉन्चर (ब्रांच `master`, `tools/launcher`) उसे अगली बार शुरू होने पर अपनी जगह लेता है।
UI द्वारा इस्तेमाल होने वाला क्रिस्प बिटमैप Verdana वेरिएंट इस रिपॉज़िटरी में नहीं है;
उसके बिना इंटरफ़ेस सिस्टम Verdana पर गिर जाता है।

जाँचें: `pnpm typecheck`, `pnpm lint`, और ZAICODE टेस्ट, उदाहरण
`node --import tsx --test test/zaicode*.test.ts`, `packages/ui` से।

## रिपॉज़िटरी लेआउट

| ब्रांच      | सामग्री                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | कैननिकल वर्कस्पेस: लॉन्चर, इंस्टॉलर (`install/`), प्रोडक्ट डॉक्स (`UI.md`, `docs/`), SAIPEN स्टेट और CHANGELOG |
| `zaicode`   | कैननिकल ऐप स्रोत: अपस्ट्रीम ZCode हिस्ट्री के साथ बिल्ड और अपडेट के लिए उपयोग होने वाला ZAICODE प्रोडक्ट लेयर |

लेगेसी या ऑटोमेशन से बने रेफ़ अभी कुछ देर दिख सकते हैं, पर वे कैननिकल
प्रोडक्ट ब्रांच नहीं हैं। नया वर्कस्पेस काम `master` पर; ऐप-स्रोत
काम `zaicode` पर।

ZAICODE-स्वामित्व वाला ऐप कोड मुख्यतः `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` और
`packages/desktop/src/main/zaicode*.ts` में `zaicode` ब्रांच पर रहता है। वर्कस्पेस
डॉक्युमेंटेशन और लॉन्चर/update टूलिंग `master` पर है।

## अपस्ट्रीम और लाइसेंस

ZAICODE, Z.ai द्वारा ZCode से लिया गया है और उसी
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE) के तहत वितरित होता है; अपस्ट्रीम नोटिस
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) और [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md) में रखे गए हैं।
फ़ाइलें ZAICODE लेखक द्वारा बदली गई हैं। ZAICODE एक स्वतंत्र प्रोजेक्ट है,
Z.ai से संबद्ध या अनुमोदित नहीं। मूल ZCode README
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) और [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md) के रूप में रखा गया है।

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## प्रोजेक्ट नेटवर्क

यह रिपॉज़िटरी व्यापक **SAIPEN / vacterro** प्रोजेक्ट इकोसिस्टम का हिस्सा है।

[**लेखक हब**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN समुदाय**](https://discord.gg/SEYaYkuVgN)

पुनरुत्पादन योग्य बग और टिकाऊ फ़ीचर अनुरोधों के लिए [इस रिपॉज़िटरी के GitHub Issues](https://github.com/vacterro/zaicode/issues) का उपयोग करें। तेज़ चर्चा, स्क्रीनशॉट और परियोजना-पार फ़ीडबैक के लिए Discord रखें।

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
