# ZAICODE SAIPEN क्लाउड ट्रांसपोर्ट

यह checkout और Claude Code Cloud सेशन एक ही SAIPEN वर्कस्पेस को अलग-अलग executor locality के साथ कैसे चलाते हैं, और दोनों के बीच की सीमा कहाँ है।

## आकार

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

एक शाखा protocol state रखती है। कोई merge चरण नहीं, कोई rebase चरण नहीं
और रखने के लिए दूसरी लोकल शाखा नहीं: जिस भी executor के पास verified
checkpoint होता है, वह उसे commit करके push करता है, और दूसरा पक्ष उसे
fast-forward से ले लेता है।

`master` pre-transport history है और published default branch। यह
transport द्वारा force-update नहीं होता।

## क्या जाता है और क्या नहीं

इस repository में एक checkpoint में SAIPEN protocol state, root
launcher, installer, docs और ये transport scripts होते हैं। यही पूरा workspace layer है।

इसमें **कोई product byte नहीं**। `zcode/` एक अलग Git repository है, `.saipen/source-nested-repos.json` में
सूचीबद्ध और इस root पर gitignored
(`/zcode/`)। Product काम के लिए `vacterro/zaicode` का अपना clone, शाखा
`zaicode` पर चाहिए, और वह clone दूसरा, स्वतंत्र object है, अपनी history के साथ।

नतीजा आसानी से गलत समझा जाता है: इस root पर साफ़ `git status` अनकमिटेड product काम के बारे में
कुछ नहीं बताता, और `saipen-live` का fast-forward product code के बारे में
कुछ नहीं बताता। `git -C zcode status` स्पष्ट रूप से जाँचें।

## लोकल आधा हिस्सा

दो scripts, दोनों repo-owned, ताकि नई मशीन उन्हें repository से ले
स्मरण से नहीं:

| फ़ाइल | भूमिका |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | मान्यता जाँचता है, ब्रांच सिंक करता है, watcher इंस्टॉल व शुरू करता है, autostart एंट्री लिखता है, साबित करता है कि local == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | लूप: fetch, तुलना, fast-forward या push, लॉग, रोकें; फिर product pass और self-update |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | स्वतंत्र executor से round-trip, साथ में cold-recovery प्रमाण |
| `tools/saipen-cloud/Test-ProductSync.ps1` | throwaway Git repositories पर product pass और self-update (कोई नेटवर्क नहीं, कोई असली remote नहीं) |

इंस्टॉल और मरम्मत:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

यह idempotent है। मशीन-स्थानीय state `%APPDATA%\SAIPEN` में रहता है:
`ZaicodeSaipenLiveWatcher.ps1` (एक कॉपी), `ZAICODE_cloud-sync.log` (`.log.1` पर 2 MB पर rotate),
`ZAICODE_cloud-sync.lock` (एकल instance),
`ZAICODE_cloud-sync.pid`, और Startup-folder एंट्री
`SAIPEN-ZAICODE-Cloud-Sync.cmd`।

इंस्टॉलर dirty tree अस्वीकार करता है, सफ़ाई कभी नहीं करता। यदि हर dirty path `.saipen/` के अंतर्गत canonical SAIPEN state है, तो यह बताता है और सटीक checkpoint कमांड छापता है; यह uncheckpointed protocol state है, transport fault नहीं, और इंस्टॉलर इसे protocol की पीठ पीछे commit नहीं करेगा।

## Watcher व्यवहार

| स्थिति | कदम |
|-----------|------|
| clean, local remote का ancestor है | `git merge --ff-only` |
| clean, remote local का ancestor है | `git push` |
| dirty | रुकें; fetch भी नहीं |
| किसी दूसरी branch पर | रुकें |
| दोनों आगे बढ़े, कोई साझा ancestor नहीं | रुकें, दोनों commit id लॉग करें, कुछ merge न करें |
| fetch या नेटवर्क विफल | degraded लॉग करें, अगले tick पर पुनः प्रयास |
| कोई merge/rebase/cherry-pick चल रहा है | रुकें |

कभी नहीं: force push, hard reset, stash, clean, किसी विदेशी branch का checkout,
commit, या process name से रोकना। इंस्टॉलर watcher को केवल अपने pid file में दर्ज pid से रोकता है।

Dirty tree की कोई कीमत नहीं, क्योंकि watcher fetch से पहले dirt जाँचता है।
इसलिए idle checkout बिल्कुल कोई नेटवर्क कॉल नहीं करता।

### उत्पाद समीक्षा चरण (T-90)

`zcode/` अपना ही repository है, इसलिए ऊपर की तालिका product code को कभी नहीं हिलाती। उसके बाद, वही tick product checkout संभालता है (`-ProductRepo`,
default `<repo>\zcode`; branch `-ProductBranch`, default `zaicode`)।
Product pass चलता है चाहे outer tree dirty हो या न हो। यह केवल pull करता है।

| स्थिति | कार्रवाई |
|-----------|------|
| रिमोट आगे, यहाँ कोई आने वाली फ़ाइल डर्टी नहीं | `git merge --ff-only`; अनकमिटेड प्रोडक्ट काम ज्यों का त्यों |
| रिमोट आगे, यहाँ कोई आने वाली फ़ाइल डर्टी है | HELD: फ़ाइलें लॉग करें, कुछ भी मर्ज न करें |
| लोकल आगे | लॉग करें; **कभी push नहीं** (प्रोडक्ट SAIPEN SHIP प्रकाशित करता है) |
| diverged | रोकें, दोनों id लॉग करें, कुछ भी मर्ज न करें |
| दूसरी ब्रांच, कोई git op चल रहा, fetch fail | रोकें |
| `zcode/` checkout नहीं, या `-NoProduct` | छोड़ा गया |

git स्वयं वह fast-forward अस्वीकार कर देता है जो लोकल बदलाव ओवरराइट करेगा, इसलिए HELD जाँच पहला और स्पष्ट पहरा है, एकमात्र नहीं। प्रोडक्ट fast-forward कुछ पुनर्निर्मित नहीं करता: जाँच के लिए `pnpm bundle:zaicode` चलाएँ (या dev preview)।

### सेल्फ-अपडेट (T-90)

वॉचर `%APPDATA%\SAIPEN` के तहत एक कॉपी के रूप में चलता है, इसलिए repository में नया वॉचर कभी reinstall के बिना नहीं चला। लूप मोड में यह अब हर पास पर अपनी फ़ाइल repository की committed कॉपी से तुलना करता है। वह उस कॉपी को अपने ऊपर इंस्टॉल करता है और ठीक एक बार, उन्हीं तर्कों के साथ, restart करता है — जबकि ये सभी शर्तें पूरी हों:

- दोनों फ़ाइलें अलग हों;
- repository कॉपी में कोई uncommitted edit न हो;
- repository कॉपी बिना त्रुटि parse हो।

जो कॉपी parse नहीं होती, अस्वीकार करके लॉग की जाती है; चल रहा वॉचर जारी रहता है।

T-90 से पहले इंस्टॉल किए वॉचरों में प्रोडक्ट पास और self-update दोनों नहीं होते। ऐसी मशीन पर `Install-SaipenLiveSync.ps1` एक बार फिर चलाएँ; उसके बाद वॉचर खुद अपडेट होगा।

## क्लाउड हिस्सा

`CLAUDE.md` root में entry rule है, `.claude/skills/saipen/SKILL.md` execution procedure है। स्किल `github.com/vacterro/saipen` से SAIPEN kernel fetch करता है और उसे घोषित engine surface `tools/saipen.py` से चलाता है। Kernel commit से pinned है (`3088eff`), tag से कभी नहीं। Tag `v8.0.1` पुराना kernel है, उसमें वही `VERSION`; उसका `validate` state बदलता है, और उसका validator यह board अस्वीकार करता है।

`STATE.saipen_home` उस executor का kernel path दर्ज करता है जिसने आख़िरी बार checkpoint किया। क्लाउड में kernel `3088eff` पर पहला `saipen continue` उसे journaled `DEC` के रूप में running kernel तक converge करा देता है (E-1410)। operator machine पर pointer उसी तरह मृत आता है। जिस kernel में automatic convergence होता है, वह `continue` पर इसे ठीक कर देता है; अन्यथा `saipen rebind-home --auto` चलाएँ।

**वापसी का यात्रा देखा गया है।** E-1562 (क्लाउड) ने पॉइंटर को `/home/user/zaicode/.claude/saipen-protocol` पर समेटा; E-1571 (ऑपरेटर मशीन) ने सीधे वापस `V:/.../_SAIPEN` पर समेटा, स्वतः, बिना किसी मैन्युअल
`rebind-home` के। दोनों दिशाएँ एक ही स्वतः समेटन हैं, इसलिए प्रत्येक locality switch पर एक `saipen_home` `DEC` की अपेक्षा करें और इसे अपेक्षित शोर मानें, कमी नहीं। यह तब तक शोर ही रहता है जब तक P1-2
(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) पॉइंटर को versioned state से बाहर नहीं निकालता; इसे देखते ही P1-2 को side effect के रूप में लागू न करें। पॉइंटर को कभी हाथ से संपादित न करें।

`STATE.saipen_home` पिन से आगे kernel **development checkout** पर भी संकेत कर सकता है, साफ़ `3088eff` क्लोन पर नहीं — ऑपरेटर मशीन पर यह uncommitted कार्य वाली `accepted-debt-rebind` branch है। पिन किए commit पर न होने वाला kernel अपने आप गलत नहीं है, पर यह clean-room source भी नहीं है, इसलिए नीचे दिया गया voice contract का नियम उस पर पूरी ताक़त से लागू होता है। ऐसे checkout में कुछ भी commit, stash, reset, check out या clean न करें; `saipen/STYLE.md` का targeted single-file restore ही एकमात्र अनुमत अपवाद है, और वह भी तभी जब ऑपरेटर ने कहा हो।

### STYLE.md एक local setting नहीं है

`saipen/STYLE.md` हर मशीन पर, हर कॉपी में, बिना किसी अपवाद या local संपादन के, pinned kernel की फ़ाइल से **byte-identical** होना चाहिए। ऑपरेटर मशीन पर इसकी एक से अधिक कॉपियाँ होती हैं:

- `STATE.saipen_home` पर kernel checkout (एक Git क्लोन, ऑपरेटर
  मशीन पर development checkout);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, जिसे `saipen-inject` scheduled task (`bootstrap/schedule-run.ps1`) भरता है। यह
  **Git repository नहीं** है, इसलिए `git checkout` इसे कभी ठीक नहीं कर सकता — injector से
  re-sync, या प्रकाशित सामग्री की direct write, ही एकमात्र रास्ता है।

`.saipen/STATE.md` में `style_contract` token उस फ़ाइल के text का hash है
(`tools/validate.py`, `style_contract_token`: CRLF normalized, `style_contract:` line excluded)। एक कॉपी में
`reply_language` संपादित करें और token बदल जाता है; दूसरी कॉपी और क्लाउड, जो प्रकाशित kernel
लाते हैं, published token बनाए रखते हैं, और mismatch वाली ओर हर CLI write
`style_contract ... does not match the installed STYLE.md marker` के साथ अस्वीकार हो जाता है।
यही पूरी विफलता है: local ओर ऐसी state लिखता है जो क्लाउड नहीं लिख सकता।

**Reply language बदलना kernel commit plus repin है, local संपादन कभी नहीं।** इसे
kernel repository में बदलें, प्रकाशित करें, SKILL.md में commit को re-pin करें, और
`saipen recover` के ज़रिए `STATE.style_contract` अपडेट करें। `STYLE.md` में local
संपादन हर उस मशीन को desynchronize कर देता है जो यह संपादन नहीं कर रही।

एक trap जिसका नाम लेना उचित है: प्रकाशित `bin/saipen` एक machine-bound shim है जो
एक ऑपरेटर के absolute interpreter और checkout paths hardcode करता है। यह ठीक
एक ही मशीन पर चलता है। क्लाउड को `python3 tools/saipen.py` उपयोग करना चाहिए।

शॉर्टकट: `cc` मौजूदा Work जारी रखता है; `cc all <text>` पूरे
message को source/appends के रूप में लेता है और हर eligible Work जारी रखता है। दोनों routine
confirmation नहीं माँगते।

## क्षमता वर्गीकरण

**AVAILABLE_IN_CLOUD** — प्रोटोकॉल स्थिति और वर्कस्पेस लेयर। `.saipen/` का पढ़ना और लिखना, लॉन्चर (`tools/launcher/ZaicodeLauncher.cs`), `install/` के नीचे इंस्टॉलर, `docs/`, `CLAUDE.md`, `.claude/skills/`, और ट्रांसपोर्ट स्क्रिप्ट। `saipen-live` पर Git read, commit, push, fetch। कोई भी गेट जो फ़ाइल असर्शन, डिफ़ रिव्यू या टेक्स्ट चेक हो।

**LOCAL_WINDOWS_ONLY** — वे गेट जिन्हें इसी मशीन की ज़रूरत है।

| गेट | क्यों |
|------|-----|
| `tools\launcher\build.cmd` | `ZaicodeLauncher.cs` को .NET Framework `csc` के साथ कंपाइल करता है; क्लाउड इमेज में कोई Windows SDK नहीं |
| पैकेज्ड Electron E2E (`zcode` डेस्कटॉप, Solo → queue → dispatch) | डेस्कटॉप सेशन और सीड किए गए प्रोवाइडर प्रोफ़ाइल की ज़रूरत |
| लाइव 9router | इसी मशीन पर एक Windows सेवा |
| इंटरैक्टिव डेस्कटॉप क्लिक-थ्रू | एक इंसान और एक स्क्रीन |
| वॉचर के अपने रनटाइम केस | वॉचर सिर्फ़ उसी मशीन पर चलता है जहाँ चेकआउट है |

इन्हें लोकल-ओनली स्वीकृति सीमाओं के रूप में दर्ज किया जाता है। इन्हें कभी "पास" नहीं बताया जाता, चाहे डिफ़ सही लगे।

**SAFE_TO_DEFER** — प्रोडक्ट लेयर। क्लाउड सेशन `vacterro/zaicode` ब्रांच `zaicode` क्लोन करके वहीं काम कर सकता है। वर्कस्पेस-लेयर का काम प्रोडक्ट काम नहीं माँगता, पर क्लोन ज़रूर चाहिए:
`.saipen/source-nested-repos.json` `zcode/` घोषित करता है, और उसके बिना वैलिडेटर `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'` से विफल होता है। `pnpm` गेट के लिए पिन किया pnpm 10.33.2 और तैयार वर्कस्पेस चाहिए। ताज़ा क्लाउड इमेज पर `pnpm bootstrap` दस्तावेज़ीकृत तरीका है, और प्रोडक्ट का `package.json` उसे पहले से घोषित करता है।

क्लाउड केवल वही प्रोडक्ट बाइट्स वेरीफ़ाई कर सकता है जो `origin/zaicode` पर हैं। जो प्रोडक्ट डेल्टा केवल ऑपरेटर के `zcode/` चेकआउट में है, वह यहाँ अदृश्य है, इसलिए उसका कोई भी प्रोडक्ट गेट क्लाउड में NOT RUN है, गेट कोई भी हो। T-84 पहला केस है (E-1411): उसका फ़िक्स लोकल-ओनली था जबकि `origin/zaicode` में अभी फ़िक्स से पहले का कोड था।

**UNSAFE_TO_EMULATE** — कुछ भी जो लोकल-ओनली गेट को हरा दिखाने की कोशिश करे। लॉन्चर बिल्ड का स्टब न बनाएँ, पैकेज्ड-ऐप रन का नकल न करें, दर्ज `pnpm verify:pre-push` परिणाम को ऐसे न रीप्ले करें जैसे वह अभी-अभी चला हो, और `.saipen/LOG.md` में "कोड सही लगता है" को PASS लाइन में न बदलें।

**KNOWN_CLOUD_DIVERGENCE** — अनुरूपता जो इस पर निर्भर करती है कि चेकआउट कहाँ है। कर्नेल `3088eff` पर क्लाउड वैलिडेटर `closure-evidence` FAIL दर्ज करता है (लेखन के समय T-47, T-62, T-76, T-78) जो ऑपरेटर मशीन नहीं करती।

कर्नेल कोई भी 1024 बाइट से बड़ा LOG इवेंट `.saipen/recovery/log-detail/` साइडकार में डालता है। पढ़ते समय वह साइडकार तभी वापस जोड़ता है जब चेकआउट का निरपेक्ष पाथ उसी पाथ के बराबर हो जिससे वह लिखा गया था। इसलिए Windows पर लिखा गया लंबा VERIFY निर्णय क्लाउड में अपठनीय है, और उल्टा भी सत्य है।

दोष कर्नेल में है और `docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md` में P1-1 के रूप में दर्ज है। जब तक यह लैंड नहीं होता:

- क्लाउड निर्णय को उद्धृत करें और उसे इस सीमा के रूप में वर्गीकृत करें, टिकट दर टिकट
  (`SKILL.md` § 6 में जाँच है);
- साइडकार कभी न लिखें, सिर्फ़ हरा होने के लिए दोबारा सत्यापन न करें, न कर्नेल
  कॉपी में पैच लगाएँ;
- LOG घटनाएँ दोनों तरफ़ 1024 बाइट से कम रखें।

मशीन-पाथ बंधन वही काम भी रोकता है। BUILD से पहले का ऋण आधार-रेखा
पहली बार टिकट के BUILD में प्रवेश पर दर्ज होती है और हर बाद के प्रवेश पर
दोबारा जाँची जाती है। इसलिए जो टिकट पहली बार ऑपरेटर मशीन पर BUILD में
गया, वह क्लाउड में BUILD में नहीं जा सकता: यह संक्रमण `DEBT_SNAPSHOT_FOREIGN_PROJECT` के साथ
अस्वीकार कर दिया जाता है। T-84 दर्ज मामला है: DEBT-000079 E-1377 पर दर्ज हुआ
और E-1446 पर संक्रमण अस्वीकार हुआ। ऐसे टिकट को उसी मशीन पर छोड़ें
जिसने उसकी आधार-रेखा दर्ज की।

## विचलन

यदि स्थानीय और दूरस्थ साझा पूर्वज नहीं रखते, तो वॉचर रुक जाता है। यह
मर्ज, रीबेस या फ़ोर्स नहीं करता। दोनों कमिट आईडी लॉग में जाती हैं, सुधार
`git log --left-right --cherry-pick <branch>...origin/<branch>` के द्वारा हाथ से किया जाता है, और
परिणाम किसी भी अन्य बदलाव की तरह चेकपॉइंट होता है।

## क्लाउड-तरफ़ की ठीक यही क्रिया

### एनवायरनमेंट सेटअप स्क्रिप्ट (एक बार, क्लाउड एनवायरनमेंट की सेटिंग्स में)

सत्र टाइटल बार में क्लाउड एनवायरनमेंट मेन्यू -> Edit -> Setup script। यह
हर नए सत्र से पहले चलता है, इसलिए हर सत्र प्रोडक्ट टूलचेन तैयार होकर शुरू होता है:

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

### हर नए सत्र के लिए प्रॉम्प्ट

सत्र को रिपॉज़िटरी `vacterro/zaicode`, ब्रांच `saipen-live` पर शुरू करें, और
यह सुनिश्चित करें कि ऑपरेटर मशीन का एजेंट एक ही समय पर न लिख रहा हो।
नया काम सौंपने के लिए अंतिम पंक्ति को `cc all <new list>` से बदलें।

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

ऑपरेटर मशीन पर वॉचर `zcode` को `origin/zaicode` से फ़ास्ट-फ़ॉरवर्ड करता है;
`REBUILD.cmd` (या `REBUILD_fast.lnk`) उसे बिल्ड करता है, और ZAICODE का अगला
शुरुआत नया बिल्ड इस्तेमाल में ला देता है।

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
