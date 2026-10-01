# Transport cloud ZAICODE SAIPEN

Cum rulează acest checkout și o sesiune Claude Code Cloud un singur workspace SAIPEN
cu executorul localizat diferit, și unde este granița dintre ele.

## Structura

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

O ramură transportă starea protocolului. Nu există pas de merge, pas de rebase
și nicio a doua ramură locală de sincronizat: executorul care are un checkpoint
verificat îl comite și îl trimite cu push, iar cealaltă parte îl preia prin
fast-forward.

`master` este istoricul pre-transport și ramura publicată implicit. Nu este
actualizat forțat de transport.

## Ce se transmite și ce nu

Un checkpoint din acest repository conține starea protocolului SAIPEN, launcherul
rădăcină, instalatorul, documentația și aceste scripturi de transport. Aceasta este
întregul strat de workspace.

Nu conține **niciun byte de produs**. `zcode/` este un repository Git separat, listat
în `.saipen/source-nested-repos.json` și ignorat de git la această rădăcină
(`/zcode/`). Lucrul la produs are nevoie de propriul clone al lui `vacterro/zaicode` pe ramura
`zaicode`, iar acel clone este un al doilea obiect independent, cu istoria lui.

Consecința se înțelege greșit ușor: un `git status` curat la această rădăcină nu spune
nimic despre munca necomitată la produs, iar un fast-forward `saipen-live` nu spune
nimic despre codul produsului. Verifică `git -C zcode status` explicit.

## Jumătatea locală

Două scripturi, ambele deținute de repo, ca o mașină nouă să le primească din repository
și nu din memorie:

| Fișier | Rol |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | validează, reconciliază ramura, instalează și pornește watcherul, scrie intrarea de autostart, demonstrează că local == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | bucla: fetch, compară, fast-forward sau push, log, pauză; apoi trecerea de produs și auto-actualizarea |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | dus-întors de la un executor independent plus dovadă de recuperare la rece |
| `tools/saipen-cloud/Test-ProductSync.ps1` | trecere de produs și auto-actualizare pe repository Git de unică folosință (fără rețea, fără remote real) |

Instalare și reparare:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Este idempotent. Starea locală a mașinii trăiește în `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (o copie), `ZAICODE_cloud-sync.log` (rotit la
2 MB la `.log.1`), `ZAICODE_cloud-sync.lock` (instanță unică),
`ZAICODE_cloud-sync.pid`, și o intrare în folderul Startup
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Instalatorul refuză un arbore dirty și nu îl curăță niciodată. Dacă fiecare cale dirty este
stare SAIPEN canonică sub `.saipen/`, spune asta și afișează comenzile exacte
de checkpoint; aceasta este o stare de protocol fără checkpoint, nu o eroare de transport,
iar instalatorul nu va face commit în spatele protocolului.

## Comportamentul watcherului

| Situație | Mișcare |
|-----------|------|
| curat, local este strămoș al remote-ului | `git merge --ff-only` |
| curat, remote-ul este strămoș al local-ului | `git push` |
| dirty | pauză; nici măcar fetch |
| pe altă ramură | pauză |
| ambele au avansat, fără strămoș comun | pauză, loghează id-urile ambelor commit, nu face merge |
| fetch sau rețea au eșuat | loghează „degraded”, reîncearcă la următorul tick |
| un merge/rebase/cherry-pick este în desfășurare | pauză |

Niciodată: force push, hard reset, stash, clean, checkout al unei ramuri străine,
commit sau oprire după numele procesului. Instalatorul oprește un watcher doar
după pid-ul înregistrat în propriul pid file.

Un arbore dirty nu costă nimic, pentru că watcherul verifică dirty înainte de fetch.
Așadar un checkout inactiv nu face deloc apeluri de rețea.

### Trecerea de produs (T-90)

`zcode/` este propriul repository, deci tabelul de mai sus nu mută niciodată cod
de produs. După el, același tick gestionează checkoutul de produs (`-ProductRepo`,
implicit `<repo>\zcode`; ramura `-ProductBranch`, implicit `zaicode`). Trecerea
de produs rulează indiferent dacă arborele exterior este dirty. Face doar pull.

| Situație | Acțiune |
|-----------|------|
| remote ahead, niciun fișier primit nu e dirty aici | `git merge --ff-only`; lucra necomisă rămâne cum e |
| remote ahead, un fișier primit e dirty aici | HELD: loghează fișierele, nu merge nimic |
| local ahead | loghează; **niciodată push** (produsul e publicat de SAIPEN SHIP) |
| diverged | pauză, loghează ambele id, nu merge nimic |
| altă branch, o operație git în curs, fetch eșuat | pauză |
| fără checkout `zcode/`, sau `-NoProduct` | skipped |

git refuză singur un fast-forward care ar suprascrie o modificare locală, deci
verificarea HELD e o gardă anterioară, mai clară, nu unica. Un
fast-forward de produs nu reconstruiește nimic: pentru test, rulează `pnpm bundle:zaicode` (sau
previzualizarea dev).

### Auto-actualizare (T-90)

Watcherul rulează ca o copie sub `%APPDATA%\SAIPEN`, deci un watcher mai nou din
repository nu a rulat niciodată fără reinstalare. În modul loop, acum își
compară propriul fișier cu copia commitată din repository la fiecare pas. Instalează
acea copie peste el și repornește exact o dată, cu aceleași argumente,
doar când toate acestea se îndeplinesc:

- cele două fișiere diferă;
- copia din repository nu are editări necomitate;
- copia din repository se parsează fără erori.

O copie care nu se parsează e refuzată și logată, iar watcherul care rulează
continuă.

Watcherii instalați înainte de T-90 nu au nici pasul de produs, nici auto-actualizare.
Rulează `Install-SaipenLiveSync.ps1` o singură dată pe o asemenea mașină; după aceea,
watcherul se actualizează singur.

## Jumătatea cloud

`CLAUDE.md` de la rădăcină e regula de intrare, iar
`.claude/skills/saipen/SKILL.md` e procedura de execuție. Skillul preia
kernelul SAIPEN din `github.com/vacterro/saipen` și îl rulează prin
suprafața de engine declarată `tools/saipen.py`. Kernelul e fixat prin commit
(`3088eff`), niciodată prin tag. Tagul `v8.0.1` e un kernel mai vechi cu același
`VERSION`; `validate` al lui mută starea, iar validatorul lui respinge acest board.

`STATE.saipen_home` înregistrează calea kernelului executorului care a făcut
ultimul checkpoint. În cloud, primul `saipen continue` pe kernelul `3088eff` îl
convergează la kernelul curent ca un singur `DEC` journalizat (E-1410). Pe
mașina operatorului, pointerul ajunge mort în același mod. Un kernel cu
convergență automată îl repară la `continue`; altfel rulează
`saipen rebind-home --auto`.

**Drumul de întoarcere este observat.** E-1562 (cloud) a convergit indicatorul spre
`/home/user/zaicode/.claude/saipen-protocol`; E-1571 (mașina operatorului)
l-a convergit direct înapoi la `V:/.../_SAIPEN`, automat, fără `rebind-home` manual.
Ambele direcții sunt aceeași convergență automată, deci așteaptă
un `saipen_home` `DEC` la fiecare schimbare de localitate și tratează-l ca zgomot
așteptat, nu ca defect. Rămâne zgomot până când P1-2
(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) mută indicatorul din stare
versionată; nu implementa P1-2 ca efect secundar al observării lui. Nu edita niciodată
manual indicatorul.

`STATE.saipen_home` poate indica un **checkout de dezvoltare** al kernelului, în avans
față de pin, nu o clonă curată `3088eff` — pe mașina operatorului este
ramura `accepted-debt-rebind` cu lucru necomitat. Un kernel care nu e la
commitul pinuit nu e automat greșit, dar nici nu e o sursă clean-room,
deci regula de mai jos despre contractul de voce se aplică integral.
Nu comita, nu stash, nu reset, nu checkout și nu clean nimic într-un
astfel de checkout; singura excepție permisă este restaurarea țintită a unui singur fișier `saipen/STYLE.md`,
și doar când operatorul o cere.

### STYLE.md nu este o setare locală

`saipen/STYLE.md` trebuie să fie **identic octet cu octet cu fișierul kernelului pinuit** pe
everycare mașină, în fiecare copie, fără excepții și fără editări locale.
Există mai mult de o copie pe mașina operatorului:

- checkout-ul kernelului la `STATE.saipen_home` (o clonă Git; pe mașina
  operatorului, un checkout de dezvoltare);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, populat de
  sarcina programată `saipen-inject` (`bootstrap/schedule-run.ps1`). **Nu
  este un repository Git**, deci `git checkout` nu îl poate repara niciodată — doar
  o resincronizare prin injector sau o scriere directă a conținutului publicat.

Tokenul `style_contract` din `.saipen/STATE.md` este un hash al textului acelui fișier
(`tools/validate.py`, `style_contract_token`: CRLF normalizat, linia
`style_contract:` exclusă). Editezi `reply_language` într-o copie și
tokenul se deplasează; cealaltă copie și cloudul, care preiau kernelul publicat,
păstrează tokenul publicat, iar fiecare scriere CLI pe partea cu nepotrivire
este refuzată cu `style_contract ... does not match the installed STYLE.md marker`.
Aceasta e toată defecțiunea: partea locală scrie o stare pe care cloudul nu o poate scrie.

**Schimbarea limbii răspunsului este un commit de kernel plus un repin**, niciodată o editare
locală. Schimb-o în repository-ul kernelului, public-o, re-pune pinul commitului în
SKILL.md și actualizează `STATE.style_contract` prin `saipen recover`. O editare
locală a `STYLE.md` desincronizează orice mașină care nu e cea care face schimbarea.

O capcană care merită numită: `bin/saipen` publicat este un shim legat de mașină, care
hardcodează căile absolute ale interpretorului și checkout-ului unui singur operator. Rulează pe
exact o mașină. Cloudul trebuie să folosească `python3 tools/saipen.py`.

Scurtături: `cc` continuă Work-ul curent; `cc all <text>` ingerează mesajul întreg ca sursă/appends și continuă fiecare Work eligibil. Niciuna nu cere
confirmare de rutină.

## Clasificarea capabilităților

**AVAILABLE_IN_CLOUD** — starea protocolului și stratul workspace. Citirea și
scrierea `.saipen/`, launcherul (`tools/launcher/ZaicodeLauncher.cs`), instalatorul din `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` și
scripturile de transport. Git read, commit, push și fetch pe `saipen-live`. Orice
gate care e o aserțiune pe fișier, o revizuire de diff sau o verificare de text.

**LOCAL_WINDOWS_ONLY** — gate-urile care necesită această mașină.

| Gate | De ce |
|------|-----|
| `tools\launcher\build.cmd` | compilează `ZaicodeLauncher.cs` cu .NET Framework `csc`; niciun Windows SDK pe imaginea cloud |
| Electron E2E împachetat (`zcode` desktop, Solo → coadă → dispatch) | necesită sesiune desktop și un profil de provider inițializat |
| 9router-ul activ | un serviciu Windows pe această mașină |
| click-through interactiv pe desktop | un om și un ecran |
| cazurile de runtime proprii watcher-ului | watcher-ul rulează doar pe mașina care deține checkout-ul |

Acestea sunt înregistrate ca limite de acceptanță doar-locale. Nu sunt
raportate niciodată ca trecute doar fiindcă diff-ul arăta bine.

**SAFE_TO_DEFER** — stratul de produs. O sesiune cloud poate clona
`vacterro/zaicode` ramura `zaicode` și poate lucra acolo. Lucrul la stratul workspace nu
necesită lucrul la produs, dar necesită clonarea:
`.saipen/source-nested-repos.json` declară `zcode/`, iar fără ea
validatorul eșuează cu `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. Porțile `pnpm` au nevoie de pnpm 10.33.2 fixat
și de un workspace pregătit. `pnpm bootstrap` pe o imagine cloud proaspătă este
calea documentată de intrare, iar `package.json` al produsului o declară deja.

Cloud-ul poate verifica doar octeții de produs aflați pe `origin/zaicode`. Un
delta de produs care există doar în checkout-ul `zcode/` al operatorului
este invizibil aici, deci fiecare gate de produs pentru el este NOT RUN în cloud,
indiferent de gate. T-84 e primul caz (E-1411): fix-ul a fost doar local, în timp ce
`origin/zaicode` încă purta codul pre-fix.

**UNSAFE_TO_EMULATE** — orice ar face să pară verde un gate doar-local.
Nu fă stub la build-ul launcherului, nu falsifica o rulare de app împachetat, nu
reda un rezultat `pnpm verify:pre-push` înregistrat ca și cum tocmai ar fi rulat, nu transforma
"codul arată corect" într-un PASS în `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — conformitatea care depinde de unde se află checkout-ul.
Pe kernel `3088eff` validatorul cloud raportează FAIL-uri `closure-evidence`
(T-47, T-62, T-76, T-78 la momentul scrierii) pe care mașina
operatorului nu le are.

Kernel-ul mută orice eveniment LOG peste 1024 octeți într-un
sidecar `.saipen/recovery/log-detail/`. La citire restaurează sidecar-ul doar
când calea absolută a checkout-ului e egală cu cea din care a fost scris. Un verdict
VERIFY lung scris pe Windows e deci ilizibil în cloud, și invers la fel.

Defectul e în kernel și e înregistrat ca P1-1 în
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Până când ajunge:

- citește verdictul cloud și clasifică-l ca această limită, ticket cu ticket
  (`SKILL.md` § 6 conține verificarea);
- nu rescrie sidecars, nu re-verifică doar ca să iasă verde și nu petrecești
  copia kernelului;
- păstrează evenimentele LOG sub 1024 de octeți pe ambele părți.

Aceeași legare de cale a mașinii blochează și munca. Baza de datorie
pre-BUILD se captează prima dată când un ticket intră în BUILD și se
re-verifică la fiecare intrare ulterioară. Un ticket care a intrat prima dată
în BUILD pe mașina operatorului nu poate intra în BUILD în cloud:
tranziția este refuzată cu `DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 este cazul din registru:
DEBT-000079 a fost capturat la E-1377, iar tranziția refuzată la E-1446.
Lasă un asemenea ticket pe mașina care i-a capturat baza.

## Divergență

Dacă localul și remote-ul nu mai împart un strămoș comun, watcher-ul se
oprește. Nu face merge, rebase sau force. Ambele id-uri de commit intră
în log, corecția se aplică `git log --left-right --cherry-pick <branch>...origin/<branch>` de mână, iar
rezultatul primește checkpoint ca orice altă schimbare.

## Acțiunea exactă din partea cloud

### Script de configurare a mediului (o singură dată, în setările mediului cloud)

Meniul mediului cloud din bara de titlu a sesiunii -> Editare -> Script de
configurare. Rulește înainte de fiecare sesiune nouă, deci fiecare sesiune
pornește cu toolchain-ul de produs gata:

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

### Promptul pentru fiecare sesiune nouă

Pornește sesiunea pe repository-ul `vacterro/zaicode`, ramura `saipen-live` și
asigură-te că agentul de pe mașina operatorului nu scrie în același timp.
Înlocuiește ultima linie cu `cc all <new list>` pentru a preda lucru nou.

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

Pe mașina operatorului, watcher-ul face fast-forward la `zcode` din
`origin/zaicode`; `REBUILD.cmd` (sau `REBUILD_fast.lnk`) îl construiește, iar
următoarea pornire a ZAICODE-ului schimbă noua versiune.
<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
