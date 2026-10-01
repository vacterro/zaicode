# Inštalácia ZAICODE

ZAICODE sú tri projekty, ktoré fungujú ako jeden: aplikácia ZAICODE, SAIPEN (protokol,
ktorý udržiava prácu agentov na správnej ceste) a SAIMAIL (pošta, ktorou si agenti
navzájom posiela správy). Ručná inštalácia znamená tri klonovania, Node.js
nástrojový reťazec, Python prostredie a zostavenie. Inštalátor urobí všetko:
spustite ho, počkajte a na ploche je zástupca ZAICODE.

## Jedno kliknutie

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  stiahnite, dvakrát kliknite, stlačte **INSTALL**. Okno (zlaté na tmavom,
  banner SAIPEN) zobrazuje každý krok priebežne, doterajší čas a log na
  vyžiadanie; na konci **START ZAICODE**, prípadne **TRY AGAIN** / **Autotroubleshoot**
  / **Open log**, ak sa niektorý krok nedokončil. Namierené na existujúci
  priečinok ZAICODE, tlačidlo sa zmení na **UPDATE**: rovnaký beh aktualizuje a opraví.
  Exe obsahuje inštalačné skripty a nepotrebuje nič vedľa seba; zostavuje ho
  `install\setup\build.cmd` (kompilátor .NET Framework, ktorý má každý Windows 10/11).
- `install\Setup-ZAICODE.cmd` (dvojklik): rovnaká inštalácia v konzole.
- Úplne od nuly, v PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Možnosti inštalácie: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (pripravený priečinok),
`/auto` (spustí sa hneď), `/quiet` (bez okna: konzolový inštalátor, exit code
= výsledok). Prvý beh zostaví aplikáciu na tomto stroji, čo chvíľu trvá;
nasledné behy len aktualizujú a opravia.

## Bezplatné modely, nič sa nenastavuje

Aplikácia si nesie vlastný 9router. Na stroji bez neho ho ZAICODE spustí
privátne (izolovaný režim, port 20138), naplní **SAIFREN** z bezplatných
tierov bez kľúča a nastaví `SAIRoute / SAIFREN` ako model nových úloh, takže prvá
úloha zadaná v New task dostane odpoveď: bez kľúča, bez účtu, bez nastavenia. Prihlásenia
Claude Code, Codex a Antigravity sú voliteľné; prihlásenie nenastavené na stroji
sa zobrazí ako "voliteľné, prihláste sa kedykoľvek", nie ako položka "vyžaduje vás".
Dôkaz: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
spustí zabalenú aplikáciu na prázdnom profile (vlastné HOME, APPDATA a
LOCALAPPDATA) a prejde len vtedy, keď je router izolovaný, SAIFREN odpovie na
svoju probe prvého tokenu a úloha v New task dostane odpoveď.

## Aktualizácie: štyri časti, jedno ZAICODE

Pracovný priestor (launcher, inštalátor), aplikácia, SAIPEN a SAIMAIL sú štyri klony. Každý
sa aktualizuje sám: **Settings -> ZAICODE -> Updates** ich vypíše s verziou a
commitom, aktualizuje jeden ručne alebo všetky a má prepínač "sám od seba" pre
každú časť (v nainštalovanom ZAICODE zapnutý, vo vývojárskom checkoute vypnutý). ZAICODE
sa na aktualizácie pozrie pár minút po štarte a potom každých šesť hodín. Po
aktualizácii dostane každá časť čo potrebuje: aplikácia závislosti (keď sa `pnpm-lock.yaml`
zmenil) a nový build (pripravený počas behu ZAICODE, spustený pri ďalšom štarte),
SAIPEN vlastný launcher, SAIMAIL vlastnú `.venv` inštaláciu, pracovný priestor nový
root launcher. Klon na inej vetve, s lokálnymi commitmi alebo s úpravami, ktoré by
aktualizácia prepísala, sa nahlási a zostane presne tak, ako je.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Čo to robí

Inštalátor tvoria kontroly Autotroubleshoot spustené s "repair" na prázdnom
priečinku, v tomto poradí. Každý krok je idempotentný, takže opätovné spustenie
aktualizuje inštaláciu a opraví, čo sa pokazilo.

| Kontrola | Oprava |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | použije kópiu zo stroja, keď vyhovuje; inak privátnu kópiu v `.tools\` (MinGit z Git for Windows, Node.js 24.14.0 z nodejs.org, Python zo svojho NuGet balíka). Bez administrátorských práv. |
| pnpm | pripnutý pnpm 10.33.2 v `.tools\pnpm10` |
| Pracovný priestor ZAICODE | klon vetvy `vacterro/zaicode` `master` (zdroj launchera, inštalátor, dokumentácia; vývojárská pamäť `.saipen/` sa nezahŕňa; vetva `workspace` do 2026-09-27) |
| Zdroj aplikácie ZAICODE | klon vetvy `zaicode` do `zcode\` |
| SAIPEN | klon `vacterro/saipen` do `saipen\`; jeho `bin\saipen.cmd` je napísaný pre tento klon a tento Python |
| SAIMAIL | klon `vacterro/saimail` do `saimail\`, nainštalovaný do `.venv\` |
| saimail-local | klient SAIMAIL v príkazovom riadku, ktorý používajú panely SAIMAIL v ZAICODE (dodávaný od SAIMAIL `0.0.2a3`; kontrola `saimail-cli` hlási OK) |
| 9router balík | `9router` z npm do `.tools\router`, zabundlovaný, aby SAIFREN fungoval bez nastavenia (WARN, ak k nemu npm nemá prístup) |
| Závislosti aplikácie | `pnpm install --frozen-lockfile` (znova, keď sa `pnpm-lock.yaml` zmení) |
| Build aplikácie | `pnpm bundle:zaicode`; kým ZAICODE beží, nový build sa pripraví a vymení pri ďalšom štarte |
| Výmena pripraveného buildu | vyčistí `win-unpacked.previous`, ktorý zostal po neúspešnej výmene s dlhou cestou, a vymení čakajúci build, kým ZAICODE je zavretý |
| Root launcher | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Skratky | `ZAICODE` na ploche a v ponuke Štart -> `ZAICODE.exe` |
| Prihlásenia Claude / Codex | len hlásené: každé prihlásenie `~\.claude*` / `~\.codex*` je vlastný engine v ZAICODE (A1, A2, C1, ...); prihlásenie vyžaduje vás, v prehliadači |

Root launcher nasmeruje ZAICODE na nainštalovaný SAIPEN (`saipen\`) a dá
`.tools\` a `.venv\Scripts` na prvé miesto v PATH aplikácie, takže aplikácia, jej agenti
aj workery použijú nainštalované kópie.

## Viacero predplatných

Každé prihlásenie Claude Code alebo Codex má vlastný domov: `~\.claude`,
`~\.claude-account2`, ... a `~\.codex`, `~\.codex-account2`, ... ZAICODE nájde
všetky. Ak si chceš pripraviť viac pri inštalácii:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Inštalátor vytvorí domovy a vypíše presný prihlasovací príkaz pre každý
(`$env:CODEX_HOME = '...'; codex login`). Rovnaké je aj v ZAICODE: Settings ->
Engines & limits -> pridať ďalšie prihlásenie.

## Automatická diagnostika

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Stav pre každú kontrolu: OK, FIXED (bolo rozbité, opravené), WARN (funguje, ale
niečo voliteľné chýba), INFO (potrebuje ťa: prihlásenie), FAIL. Logy sú v
`install\logs\`; súhrn poslednej inštalácie je `install\install-report.json`.
V aplikácii Router -> Autotroubleshoot opraví bežiaci router a pooly.

## Možnosti

| Parameter | Predvolené | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | kam ide všetko |
| `-ShortcutDir` | Desktop | kam ide skratka ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | preskočiť tieto skratky |
| `-PortableTools` | | súkromný Git / Node.js / Python, aj keď ich zariadenie má |
| `-Launch` | | po dokončení spustiť ZAICODE |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | repozitáre GitHub | iný zdroj (fork, lokálna cesta klonu) |

## Dôkaz

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
overuje čistú inštaláciu, nasadí poruchy (skratka aj spúšťač odstránené, spúšťač
SAIPEN ukazujúci na chýbajúci Python, venv SAIMAIL odstránený, node_modules
zapísaný pre iný lockfile, zvyškový build priečinok hlbší než MAX_PATH),
overí, že diagnostika nahlási a opraví každú z nich, potom spustí cieľ skratky
s izolovaným profilom a zastaví presne strom procesov, ktorý spustil.

`install\tests\Test-ZaicodeUpdate.ps1` vytvorí štyri jednorazové repozitáre
na disku a nainštaluje ich klonovanie, potom dokáže, že kontrola nič nemení,
že jedna súčasť sa aktualizuje sama so svojou nadväznou opravou (spúšťač SAIPEN,
koreňový spúšťač), že prekrývajúce sa lokálne úpravy a lokálne commity zostanú
zachované a že neznámy názov súčasti sa odmietne. Bez siete.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
