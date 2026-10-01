# ZAICODE

<div align="center">
  <img src="https://raw.githubusercontent.com/vacterro/zaicode/zaicode/packages/ui/src/assets/zaicode-working.png" alt="ZAICODE" width="96" height="96" />
</div>
<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.1-c9a227" alt="version 0.0.1" />
  <img src="https://img.shields.io/badge/platform-Windows-3b3527" alt="Windows" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-3b3527" alt="Apache-2.0" />
</p>
<p align="center">
  ZAICODE · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md">ZCode (简体中文)</a> · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.en.md">ZCode (English)</a>
</p>

<img width="1440" height="860" alt="ZAICODE hero — Do your best." src="../../screenshots/01-do-your-best.png" />

ZAICODE on operaatori tööpink, millega saab käitada korraga paljusid AI-koodimisagente eri projektides, ilma igaühel eraldi silma peal hoidmata. See on [ZCode](https://github.com/zai-org/ZCode) kohandatud versioon (töölauarakendus, brauseriliides ja agendi CLI), millele on lisatud tootekiht: iga projekti juhib [SAIPEN](https://github.com/vacterro/saipen) protokoll, tööd alustatakse, jätkatakse ja ajastatakse ühest aknast ning juba tasutud tellimustega CLI-d (Claude Code, Codex, Antigravity) töötavad rakenduse agentide kõrval dokitud töölistena.

**0.0.1** on esimene märgistatud väljalase: isiklik Windowsile mõeldud versioon, mida kasutatakse iga päev.

## Paigalda ühe klikiga

1. Laadi alla **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Topeltklõpsa sellel ja vajuta **INSTALL**.

See on kõik. Paigaldaja toob masinale puuduvad osad (Git, Node.js, Python privaatsete
koopiatena: administraatoriõigusi pole), laeb ZAICODE, SAIPEN ja SAIMAIL GitHubist,
ehitab rakenduse masinal ning lisab töölauale ZAICODE otsetee. Esimene
käivitus võtab 15-30 minutit; aknas on näha iga samm.

Tasuta mudelid töötavad kohe: ZAICODE käivitab oma marsruuteri ja täidab **SAIFREN**-i võtmeta tasuta teenustega, nii et väljale New task sisestatud ülesanne saab vastuse ilma võtme, konto ja seadistamiseta. Claude Code, Codex ja Antigravity tellimused on valikulised; sisse saab logida igal ajal.

**Üks tervik, neli osa.** Tööala (käivitaja ja paigaldaja), rakendus, SAIPEN ning SAIMAIL asuvad neljas hoidlas. Igaüks uueneb eraldi: *Settings -> ZAICODE -> Updates* näitab kõiki osi ja uuendab neid käsitsi või automaatselt (kontroll paar minutit pärast käivitust ning iga kuue tunni järel). Uus rakenduse versioon valmistatakse ette ZAICODE töötamise ajal ja võetakse kasutusele järgmisel käivitusel; sinu kohalikke muudatusi kloonis ei kirjutata üle.
Terminalist: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Automaatne veaotsing: `install\Doctor.cmd`. Üksikasjad: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Liidese ülevaade

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

## Mis lisandub ZCode-le

- **Projektid MAIN-seansiga.** Igal projektil on üks MAIN-seanss (START, `/goal cc all`) ning abiseansid (subSaipens: WIKI, TEST, AUDIT, …). Kõrvalriba koondvaade näitab projekti rida selle MAIN-seansina; ▶ jätkab MAIN-seanssi ega ava uut. CONTINUE ALL, DONE ja CLEAR ALL DONE töötavad kõigi projektidega; katkenud seansi olek on INTERRUPTED, mitte DONE.
- **Taastumine pärast tõrget.** Lõppenud protsessi pooleli jäänud seansid ja aktiivsed eesmärgid jätkuvad pärast taaskäivitust automaatselt; töötanud töölised käivitatakse uuesti. ZAICODE sees olevad agendid ei saa ZAICODE-d protsessi nime järgi lõpetada.
- **Töölised.** Tellimusega CLI-d töötavad terminalides, mida saab kinnitada akna igale servale või paigutada eraldi dokitavatesse akendesse. Esimese käivituse kausta usaldamise küsimused on vastatud; kasutuspiirini jõudnud töölisest teatatakse ning vastavalt seadistusele see suletakse või käivitatakse pärast piirangu lähtestumist uuesti.
- **Piirangud ja lähtestumine.** Kvoodimõõturid iga konto ja kogumi kohta, pealkirjariba taimer lähima lähtestumiseni ning kõik tulevased lähtestumised hiirega üle liikudes.
- **SCHEDULER.** Päringud käivituvad määratud ajal, iga päev, iga N minuti järel või kvoodi taastumisel; ühes projektis või kogu kõrvalriba jaotises. Kõige rohkem blokeeritud või avatud SAIPENi piletitega projektid lähevad esimesena. Tingimused võivad esmalt peatada ajutise töö (tasuta kogumi seansid, nõrgemad töölised), käivitada ainult jõude projektides või jätkata ainult märgitud seansse. Päringute pikkusel pole praktilist piirangut.
- **Marsruutimine.** Kaasas olev 9router (MIT) pakub kohe kasutatavaid kogumeid: SAIFREN (võtmeta tasuta teenused) ja SAIOPP (sinu tellimused).
- **SAIHOME, taimerid, helid ja esiletõstmised.** Operaatori avaleht statistikaga, FastPrompteri-laadsete taimerite ja alarmidega, tegevuspõhiste helidega ning Win95-st inspireeritud tumeda kuldse, teravate pikslitega liidesega.

## Ehitus

Nõuded: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2** ([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) on alusallikas).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Pakendatud rakendus käivitub alati ZAICODE-režiimis. Kui vana ZAICODE töötab, paigutab pakkija uue versiooni kausta `packages/desktop/dist-next`; juurkäivitaja (haru `master`, `tools/launcher`) vahetab selle järgmisel käivitusel sisse. Liidese terav raster-Verdana variant ei kuulu sellesse hoidlasse; selle puudumisel kasutatakse süsteemi Verdana fonti.

Kontrollid: `pnpm typecheck`, `pnpm lint` ja ZAICODE testid, näiteks
`node --import tsx --test test/zaicode*.test.ts` kaustust `packages/ui`.

## Hoidla paigutus

| Haru       | Sisu                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | kanoniline tööala: käivitaja, paigaldaja (`install/`), tootedokumendid (`UI.md`, `docs/`), SAIPENi olek ja CHANGELOG |
| `zaicode`   | kanoniline rakenduse lähteallikas: ülesvoo ZCode ajalugu pluss ZAICODE tootekiht, mida kasutatakse ehitusteks ja uuendusteks |

Pärand- või automaatikatest loodud viited võivad ajutiselt veel esineda,
kuid need ei ole kanonilised tooteharud. Uus tööala-arendus kuulub
`master`-le; rakenduse lähteallika arendus kuulub `zaicode`-le.

ZAICODE-i omatud rakenduse kood asub peamiselt `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` ja
`packages/desktop/src/main/zaicode*.ts` harus `zaicode`. Tööala
dokumentatsioon ja käivitaja/update tööriistad asuvad harus `master`.

## Algprojekt ja litsents

ZAICODE põhineb Z.ai loodud ZCode-l ja seda levitatakse sama [Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE) alusel. Algprojekti teatised on säilitatud failides [NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) ja [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md). Faile on muutnud ZAICODE autor. ZAICODE on sõltumatu projekt, mis pole Z.ai-ga seotud ega selle heakskiitu saanud. ZCode algne README on säilitatud failides [README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) ja [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Projekti võrgustik

See hoidla kuulub laiemasse **SAIPEN / vacterro** projektide ökosüsteemi.

[**Autori keskus**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN Community**](https://discord.gg/SEYaYkuVgN)

Korratavatest vigadest ja pikaajalisematest funktsioonisoovidest teata [selle hoidla GitHub Issues-is](https://github.com/vacterro/zaicode/issues). Kiireks aruteluks, ekraanipiltideks ja projektidevaheliseks tagasisideks kasuta Discordi.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
