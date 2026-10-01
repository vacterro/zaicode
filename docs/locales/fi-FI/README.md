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

ZAICODE on operaattorityöpöytä monen tekoälykoodausagentin ajamiseksi kerralla
useassa projektissa ilman jatkuvaa valvontaa. Se on muokattu versio
[ZCode](https://github.com/zai-org/ZCode)sta (työpöytäsovellus, selainkäyttöliittymä ja agentin
CLI), jonka päällä on tuotekerros: jokaista projektia ohjaa
[SAIPEN](https://github.com/vacterro/saipen) -protokolla, työ aloitetaan, jatketaan ja ajastetaan
yhdestä ikkunasta, ja jo maksamasi tilaus-CLI:t
(Claude Code, Codex, Antigravity) toimivat telakoituina työntekijöinä sovelluksen
sisäisten agenttien rinnalla.

**0.0.1** on ensimmäinen versioitu tilannekuva: henkilökohtainen, Windows-ensisijainen
versio, jota käytetään päivittäin.

## Asennus yhdellä klikkauksella

1. Lataa **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Kaksoisnapsauta ja paina **ASENNA**.

Siinä se. Asennus hakee puuttuvat osat (Git, Node.js, Python) omina yksityiskopioina:
ei ylläpitäjän oikeuksia, hakee ZAICODE-, SAIPEN- ja SAIMAIL-koodit GitHubista,
rakentaa sovelluksen koneelle ja lisää ZAICODE-pikakuvakkeen työpöydälle. Ensimmäinen
käynti kestää 15-30 minuuttia; ikkuna näyttää jokaisen vaiheen.

Ilmaiset mallit toimivat heti: ZAICODE käynnistää oman reitittimensä ja täyttää **SAIFREN**-poolin
avaimettömistä ilmaisista tasoista, joten Uusi tehtävä -kenttään kirjoitettu tehtävä
saa vastauksen ilman avainta, tiliä ja asetuksia. Claude Code-, Codex- ja
Antigravity-tilausvalinnat ovat vapaaehtoisia, ja niihin voi kirjautua milloin tahansa.

**Yksi kokonaisuus, neljä osaa.** Työtila (käynnistin, asennusohjelma), sovellus, SAIPEN ja
SAIMAIL ovat neljä repositoriota. Jokainen päivittyy erikseen: *Asetukset -> ZAICODE ->
Päivitykset* näyttää kaikki osat, ja ne voi päivittää käsin tai automaattisesti
(tarkistus muutaman minuutin kuluttua käynnistyksestä ja kuuden tunnin välein). Uusi
sovellusversio valmistellaan ZAICODEN ajon aikana ja otetaan käyttöön seuraavassa
käynnistyksessä; omat muokkauskloonissasi eivät koskaan sovi päälle.
Terminaalista: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Automaattinen vianmääritys: `install\Doctor.cmd`. Tarkemmat tiedot: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Käyttöliittymän kiertue

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

## Mitä se lisää ZCodeen

- **Projektit, joilla on MAIN-istunto.** Jokaisella projektilla on yksi MAIN-istunto (START,
  `/goal cc all`) ja apuistunnot (subSaipens: WIKI, TEST, AUDIT, …). Oletusarvoinen
  sivupalkkinäkymä näyttää projektirivin sen MAIN-istuntona; ▶ jatkaa MAIN-istuntoa
  sen sijaan, että avaisi toisen istunnon. CONTINUE ALL, DONE ja CLEAR ALL DONE
  käsittelevät kaikki projektit; kesken kierroksen katkaistu istunto näyttää INTERRUPTED,
  ei koskaan DONE.
- **Kaatumisen turvallisu.** Kuolleen prosessin katkaisemat istunnot ja edelleen
  aktiiviset tavoitteet jatkuvat itsestään uudelleenkäynnistyksen jälkeen; käynnissä
  olevat työntekijät käynnistyvät uudelleen. ZAICODEessa olevat agentit eivät voi
  tappaa ZAICODEa prosessinimen perusteella.
- **Työntekijät.** Tilaus-CLI:t kulkevat terminaaleissa, jotka on kiinnitetty ikkunan
  mille tahansa reunalle (tai omissa kiinnitysikkunoissaan). Ensimmisen käynnistyksen
  "Luotetaanko tähän kansioon?" -kysymyksiin vastataan; työntekijä, joka osuu
  käyttörajaansa, ilmoitetaan ja asetuksen mukaan suljetaan tai käynnistetään
  uudelleen nollauksen jälkeen.
- **Rajat ja nollaukset.** Kiintiömittarit tilin ja altaan mukaan, otsikkorivin ajastin
  lähimmälle nollaukselle sekä koko tulevien nollausten luettelo siirrettäessä.
- **SCHEDULER.** Kysymykset, jotka käynnistyvät itse: tiettyyn aikaan, päivittäin, joka
  N. minuutti tai kun kiintiöikkuna täyttyy uudelleen; yhdessä projektissa tai koko
  sivupalkkiosastossa, huonoimmat projektit (eniten estoja / avoimia SAIPEN-pyyntöjä)
  ensin. Ehdoilla voi pysäyttää korjaavat työt ensin (vapaan altaan istunnot,
  heikommat työntekijät), ajaa vain joutenol projects -projekteissa tai jatkaa vain
  merkittyjä istuntoja. Kysymysten pituudella ei ole käytännössä ylärajaa.
- **Reititys.** Mukana toimitettava 9router (MIT) antaa nollalla konfiguroinnin toimivat
  altaat: SAIFREN (avaimettomat ilmaisutasot) ja SAIOPP (omat tilauksesi).
- **SAIHOME, ajastimet, äänet, korostukset.** Operaattorin koti tilastoineen,
  FastPrompter-tyylisine ajastimineen ja hälytyksineen, toimintokohtaisine
  äänineen ja Win95-tyylisenä tumman-kultaisena, pikselitarkkana rajapintana.

## Rakennus

Vaatimukset: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) on totuuden lähde).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Pakattu sovellus käynnistyy aina ZAICODE-tilassa. Kun vanhempi ZAICODE on
käynnissä, pakkaaja asettaa uuden rakennuksen `packages/desktop/dist-next`ille; juurikäynnistin
(haara `master`, `tools/launcher`) vaihtaa sen seuraavalla käynnistyksellä.
UI:ssa käytettävää terävää bittikartta-Verdanaa ei sisälly tähän repositorioon;
ilman sitä rajapinta putoaa järjestelmän Verdanaan.

Tarkistukset: `pnpm typecheck`, `pnpm lint` sekä ZAICODE-testit, esimerkiksi
`node --import tsx --test test/zaicode*.test.ts` hakemistosta `packages/ui`.

## Repositorion rakenne

| Haara        | Sisältö                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | kanoninen työtila: käynnistin, asennusohjelma (`install/`), tuotedokumentaatio (`UI.md`, `docs/`), SAIPEN-tila ja CHANGELOG |
| `zaicode`   | kanoninen sovelluskoodi: ZCoden upstream-historia sekä ZAICODE-tuotekerros, jota käytetään rakennuksiin ja päivityksiin |

Vanhentuneita tai automaation luomia viittauksia voi olla tilapäisesti, mutta ne eivät
ole kanonisia tuotehaaroja. Uusi työtilatyö kuuluu haaraan `master`; sovelluskoodityö
kuuluu haaraan `zaicode`.

ZAICODEen kuuluva sovelluskoodi sijaitsee pääosin `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` ja `packages/desktop/src/main/zaicode*.ts` -kohteissa haaralla `zaicode`. Työtilan
dokumentaatio ja käynnistin/update-työkalut ovat haaralla `master`.

## Upstream ja lisenssi

ZAICODE on johdettu ZCodesta (Z.ai) ja jaetaan samalla
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE) -lisenssillä; upstream-ilmoitukset säilytetään
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md)- ja [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md)-tiedostoissa.
Tiedostoja on muokannut ZAICODEn tekijä. ZAICODE on itsenäinen projekti,
eikä se ole sidoksissa Z.aihin eikä Z.aien hyväksymä. Alkuperäinen ZCode README säilytetään
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md)- ja [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md)-tiedostona.

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Projektiverkko

Tämä repositorio kuuluu laajempaan **SAIPEN / vacterro** -projektiympäristöön.

[**Tekijäkeskus**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN-yhteisö**](https://discord.gg/SEYaYkuVgN)

Toistettavien bugien ja pysyvien ominaisuuspyyntöjen osalta käytä [tämän repositorion GitHub Issuesiä](https://github.com/vacterro/zaicode/issues). Discord nopeaan keskusteluun, kuvakaappauksiin ja projektien väliseen palautteeseen.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
