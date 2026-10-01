# ZAICODE SAIPEN transport chmurowy

Jak ten checkout i sesja Claude Code Cloud uruchamiają jedną przestrzeń roboczą SAIPEN
z różną lokalnością executora i gdzie przebiega granica między nimi.

## Kształt

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Jedna gałąź nosi stan protokołu. Nie ma kroku scalania, kroku rebase
ani drugiej gałęzi lokalnej do utrzymania w synchronizacji: którykolwiek executor ma
zweryfikowany checkpoint, ten go commituje i wypycha, a druga strona
odbiera go przez fast-forward.

`master` to historia sprzed transportu i opublikowana gałąź domyślna. Transport
nie wykonuje na niej force-update.

## Co podróżuje, a co nie

Checkpoint w tym repozytorium zawiera stan protokołu SAIPEN, launcher główny,
instalator, dokumentację i te skrypty transportowe. To cała warstwa przestrzeni roboczej.

Nie zawiera **żadnego bajtu produktu**. `zcode/` to osobne repozytorium Git,
wymienione w `.saipen/source-nested-repos.json` i zignorowane przez git w tym katalogu
(`/zcode/`). Praca nad produktem wymaga własnego klona `vacterro/zaicode` na gałęzi
`zaicode`, a ten klon to drugi, niezależny obiekt z własną historią.

Konsekwencja łatwa do pomylenia: czysty `git status` w tym katalogu mówi nic
o niezacommitowanej pracy nad produktem, a fast-forward w `saipen-live` mówi nic
o kodzie produktu. Sprawdź `git -C zcode status` wprost.

## Połowa lokalna

Dwa skrypty, oba należące do repozytorium, żeby nowa maszyna pobrała je z repozytorium,
a nie z pamięci:

| Plik | Rola |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | waliduje, uzgadnia gałąź, instaluje i uruchamia watcher, zapisuje wpis autostartu, dowodzi local == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | pętla: fetch, porównanie, fast-forward lub push, log, pauza; następnie przebieg produktowy i self-update |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | round-trip z niezależnego executor plus dowód odzyskania po restarcie |
| `tools/saipen-cloud/Test-ProductSync.ps1` | przebieg produktowy i self-update na jednorazowych repozytoriach Git (bez sieci, bez prawdziwego remote) |

Instalacja i naprawa:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Jest idempotentny. Stan lokalny maszyny mieszka w `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (kopia), `ZAICODE_cloud-sync.log` (rotowany
przy 2 MB do `.log.1`), `ZAICODE_cloud-sync.lock` (jedna instancja),
`ZAICODE_cloud-sync.pid` oraz wpis w folderze Startup
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Instalator odmawia pracy na brudnym drzewie i nigdy go nie czyści. Jeśli każda
brudna ścieżka to kanoniczny stan SAIPEN w `.saipen/`, mówi o tym
i wypisuje dokładne komendy checkpointu; to stan protokołu bez
checkpointu, a nie usterka transportu, i instalator nie zrobi tego
commita poza protokołem.

## Zachowanie watchera

| Sytuacja | Ruch |
|-----------|------|
| czyste, local jest przodkiem remote | `git merge --ff-only` |
| czyste, remote jest przodkiem local | `git push` |
| brudne | pauza; nawet bez fetch |
| na innej gałęzi | pauza |
| oba poszły do przodu, brak wspólnego przodka | pauza, log obu id commitów, zero merge |
| fetch lub sieć zawiodły | log degraded, ponowienie w następnym tick |
| w locie merge/rebase/cherry-pick | pauza |

Nigdy: force push, hard reset, stash, clean, checkout obcej gałęzi,
commit ani zatrzymanie po nazwie procesu. Instalator zatrzymuje watchera
wyłącznie według pid zapisanego we własnym pliku pid.

Brudne drzewo nic nie kosztuje, bo watcher sprawdza brudny stan przed
fetchem. Bezczynny checkout więc w ogóle nie wykonuje wywołań sieciowych.

### Przebieg produktowy (T-90)

`zcode/` jest własnym repozytorium, więc tabela powyżej nigdy nie rusza
kodu produktu. Po nim ten sam tick obsługuje checkout produktu (`-ProductRepo`,
domyślnie `<repo>\zcode`; gałąź `-ProductBranch`, domyślnie `zaicode`). Przebieg
produktowy działa niezależnie od tego, czy zewnętrzne drzewo jest brudne.
Wykonuje wyłącznie pull.

| Sytuacja | Działanie |
|-----------|------|
| remote wyprzedza, żaden nadchodzący plik nie jest tu brudny | `git merge --ff-only`; niezacommitowana praca produktowa zostaje bez zmian |
| remote wyprzedza, nadchodzący plik jest tu brudny | WSTRZYMANO: zaloguj pliki, nic nie scalaj |
| local wyprzedza | zaloguj; **nigdy nie wypychaj** (produkt publikuje SAIPEN SHIP) |
| rozjechane | wstrzymaj się, zaloguj oba id, nic nie scalaj |
| inna gałąź, trwa operacja git, fetch nieudany | wstrzymaj się |
| brak checkout `zcode/` lub `-NoProduct` | pominięto |


git sam odrzuca fast-forward, który nadpisałby lokalną zmianę,
więc kontrola WSTRZYMANO to wcześniejsza, jaśniejsza zabezpieczenie, a nie jedyne.
Fast-forward produktu nic nie przebudowuje: aby to sprawdzić, uruchom `pnpm bundle:zaicode`
(lub podgląd deweloperski).

### Samoaktualizacja (T-90)

Watcher działa jako kopia w `%APPDATA%\SAIPEN`, więc nowszy watcher z repozytorium
nigdy nie uruchomił się bez reinstalacji. W trybie pętli porównuje teraz
własny plik zcommittedowaną kopią z repozytorium przy każdym przebiegu.
Instaluje tę kopię nad siebie i restartuje dokładnie raz, z tymi samymi
argumentami, i tylko gdy spełnione są wszystkie te warunki:

- pliki różnią się;
- kopia z repozytorium nie ma niezacommitowanych zmian;
- kopia z repozytorium parsuje się bez błędów.

Kopia, która się nie parsuje, jest odrzucana i logowana, a działający watcher
pracuje dalej.

Watchery zainstalowane przed T-90 nie mają ani obsługi produktu, ani samoaktualizacji.
Uruchom `Install-SaipenLiveSync.ps1` raz na takiej maszynie; od tej pory watcher aktualizuje się sam.

## Chmura

`CLAUDE.md` w katalogu głównym to reguła wejścia, a
`.claude/skills/saipen/SKILL.md` to procedura wykonania. Skill pobiera
jądro SAIPEN z `github.com/vacterro/saipen` i uruchamia je przez
zadeklarowaną powierzchnię silnika `tools/saipen.py`. Jądro jest
przypięte commitem (`3088eff`), nigdy tagiem. Tag `v8.0.1`
to starsze jądro z tym samym `VERSION`; jego `validate` mutuje stan,
a jego walidator odrzuca tę tablicę.

`STATE.saipen_home` zapisuje ścieżkę jądra tego executora, który zrobił
ostatni checkpoint. W chmurze pierwszy `saipen continue` na jądrze `3088eff`
zbiega go z uruchomionym jądrem jako jeden zjournalowany `DEC` (E-1410).
Na maszynie operatora wskaźnik dociera martwy w ten sam sposób. Jądro
z automatycznym zbieganiem naprawia go przy `continue`; w przeciwnym razie
uruchom `saipen rebind-home --auto`.

**Powrót jest obserwowany.** E-1562 (chmura) zbiegł wskaźnik do
`/home/user/zaicode/.claude/saipen-protocol`; E-1571 (maszyna operatora)
zbiegł go z powrotem wprost do `V:/.../_SAIPEN`, automatycznie, bez ręcznego
`rebind-home`. Oba kierunki to ta sama automatyczna zbieżność, więc oczekuj
jednego `saipen_home` `DEC` na każdą zmianę lokalizacji i traktuj to jako oczekiwany szum,
nie defekt. Pozostaje szumem, dopóki P1-2
(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) nie przeniesie wskaźnika poza stan wersjonowany; nie implementuj
P1-2 jako skutku ubocznego samego zauważenia tego. Nigdy nie edytuj
ręcznie wskaźnika.

`STATE.saipen_home` może wskazywać na **checkout deweloperski** jądra
znajdujący się przed pinem, a nie na czysty clone `3088eff` — na maszynie
operatora to gałąź `accepted-debt-rebind` z niezacommitowaną pracą. Jądro, które nie
jest na zapiętym commicie, nie jest automatycznie błędne, ale nie jest też
źródłem clean-room, więc poniższa reguła o kontrakcie głosu obowiązuje je w
pełnej mierze. Nigdy nie commituj, nie stashuj, nie resetuj, nie przełączaj
ani nie czyść niczego w takim checkoutcie; jedynym dozwolonym wyjątkiem jest
ukierunkowane przywrócenie pojedynczego pliku `saipen/STYLE.md` i tylko wtedy, gdy
operator o to poprosił.

### STYLE.md nie jest ustawieniem lokalnym

`saipen/STYLE.md` musi być **bajt w bajt identyczny z plikiem przypiętego jądra**
na każdej maszynie, w każdej kopii, bez wyjątków i bez lokalnych edycji.
Na maszynie operatora jest więcej niż jedna kopia:

- checkout jądra w `STATE.saipen_home` (klon Git, na maszynie
  operatora checkout deweloperski);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, wypełniany przez
  zaplanowane zadanie `saipen-inject` (`bootstrap/schedule-run.ps1`). **Nie jest
  repozytorium Git**, więc `git checkout` nigdy go nie naprawi — jedyną drogą
  jest ponowna synchronizacja przez injector albo bezpośredni zapis
  opublikowanej treści.

Token `style_contract` w `.saipen/STATE.md` to hash tekstu tego pliku
(`tools/validate.py`, `style_contract_token`: CRLF znormalizowane, z
`style_contract:` linią wyłączoną). Edytuj `reply_language` w jednej kopii, a
token się przesunie; druga kopia i chmura, które pobierają opublikowane jądro,
zachowują opublikowany token, a każdy zapis CLI po stronie niezgodnej
zostaje odrzucony z `style_contract ... does not match the installed STYLE.md marker`.
To jest cała awaria: strona lokalna zapisuje stan, którego chmura nie może zapisać.

**Zmiana języka odpowiedzi to commit jądra plus ponowne przypięcie, nigdy
lokalna edycja.** Zmień go w repozytorium jądra, opublikuj, przypnij ponownie
commit w SKILL.md i zaktualizuj `STATE.style_contract` przez `saipen recover`. Lokalna
edycja `STYLE.md` desynchronizuje każdą maszynę, która nie jest maszyną ją
wykonującą.

Jedna pułapka, o której warto wspomnieć: opublikowany `bin/saipen` to shim
związany z maszyną, który na sztywno wpisuje absolutne ścieżki interpretera
i checkoutu jednego operatora. Działa na dokładnie jednej maszynie.
Chmura musi używać `python3 tools/saipen.py`.

Skróty: `cc` kontynuuje bieżącą Work; `cc all <text>` przyjmuje całą
wiadomość jako źródło/appends i kontynuuje każdą kwalifikującą się Work. Żaden
nie prosi o rutynowe potwierdzenie.

## Klasyfikacja możliwości

**AVAILABLE_IN_CLOUD** — stan protokołu i warstwa workspace. Odczyt i zapis `.saipen/`, launchera (`tools/launcher/ZaicodeLauncher.cs`), instalatora w `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` oraz skryptów transportowych. Git: odczyt, commit, push i fetch na `saipen-live`. Każda bramka będąca asercją pliku, przeglądem diffa lub kontrolą tekstu.

**LOCAL_WINDOWS_ONLY** — bramki wymagające tej maszyny.

| Bramka | Dlaczego |
|------|-----|
| `tools\launcher\build.cmd` | kompiluje `ZaicodeLauncher.cs` z .NET Framework `csc`; brak Windows SDK na obrazie chmurowym |
| spakowane E2E Electron (`zcode` desktop, Solo → kolejka → dispatch) | wymaga sesji pulpitu i wstępnie skonfigurowanego profilu dostawcy |
| działający 9router | usługa Windows na tej maszynie |
| interaktywne klikanie na pulpicie | człowiek i ekran |
| własne przypadki testowe watchera | watcher działa wyłącznie na maszynie z checkoutem |

Rejestrowane jako lokalne granice akceptacji. Nigdy nie raportowane jako zaliczone tylko dlatego, że diff wyglądał poprawnie.

**SAFE_TO_DEFER** — warstwa produktu. Sesja chmurowa może sklonować
`vacterro/zaicode` gałąź `zaicode` i pracować na niej. Praca nad warstwą workspace nie wymaga pracy nad produktem, ale wymaga klona:
`.saipen/source-nested-repos.json` deklaruje `zcode/`, a bez tego walidator kończy się błędem `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. Bramki `pnpm` wymagają przypiętego pnpm 10.33.2
i przygotowanego workspace. `pnpm bootstrap` na świeżym obrazie chmurowym to udokumentowana droga wejścia, a `package.json` produktu już go deklaruje.

Chmura może zweryfikować tylko bajty produktu obecne w `origin/zaicode`. Delta produktu istniejąca wyłącznie w checkoutem operatora `zcode/` jest tutaj niewidoczna, więc każda bramka produktowa dla niej ma w chmurze status NOT RUN, niezależnie od bramki. T-84 to pierwszy przypadek (E-1411): jego poprawka była tylko lokalna, a `origin/zaicode` wciąż zawierał kod sprzed poprawki.

**UNSAFE_TO_EMULATE** — wszystko, co kazałoby lokalnej bramce wyglądać na zieloną. Nie stubuj budowy launchera, nie udawaj uruchomienia spakowanej aplikacji, nie odtwarzaj zapisanego
wyniku `pnpm verify:pre-push` tak, jakby właśnie się wykonał, i nie zamieniaj „kod wygląda poprawnie" w linię PASS w `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — zgodność zależna od tego, gdzie leży checkout. Na jądrze `3088eff` walidator chmurowy raportuje FAILy `closure-evidence` (T-47, T-62, T-76, T-78 na moment pisania), których maszyna operatora nie raportuje.

Jądro przenosi każde zdarzenie LOG dłuższe niż 1024 bajty do
sidecara `.saipen/recovery/log-detail/`. Przy odczycie przywraca sidecar tylko
gdy absolutna ścieżka checkouta równa się ścieżce, z której go zapisano. Długi werdykt VERIFY zapisany na Windows jest więc w chmurze nieczytelny — i odwrotnie.

Wada jest w jądrze i jest zgłoszona jako P1-1 w
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Do czasu wdrożenia:

- zacytuj werdykt chmurowy i sklasyfikuj go jako tę granicę, ticket po tickecie
  (`SKILL.md` § 6 zawiera sprawdzenie);
- nigdy nie przepisuj sidecarów, nie weryfikuj ponownie tylko po to, by było zielono,
  ani nie łataj kopii kernela;
- utrzymuj zdarzenia LOG poniżej 1024 bajtów po obu stronach.

To samo wiązanie ścieżki maszynowej blokuje pracę. Bazowy poziom długu sprzed
BUILD jest zapisywany przy pierwszym wejściu ticketa do BUILD i sprawdzany ponownie
przy każdym kolejnym wejściu. Ticket, który po raz pierwszy wszedł do BUILD
na maszynie operatora, nie może więc wejść do BUILD w chmurze: przejście jest
odrzucane z `DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 to udokumentowany przypadek: DEBT-000079
zapisywano na E-1377, a przejście odrzucono na E-1446. Zostaw taki ticket
maszynie, która zapisała jego punkt odniesienia.

## Rozbieżność

Jeśli lokalny i zdalny przestaną mieć wspólnego przodka, watcher się zatrzymuje.
Nie scala, nie robi rebase, nie wymusza. Oba identyfikatory commitów trafiają
do logu, poprawka jest `git log --left-right --cherry-pick <branch>...origin/<branch>` ręcznie, a
wynik jest zapisywany jak każda inna zmiana.

## Dokładne działanie po stronie chmury

### Skrypt konfiguracji środowiska (jednorazowo, w ustawieniach środowiska chmurowego)

Menu środowiska chmurowego na pasku tytułu sesji -> Edit -> Setup script.
Uruchamia się przed każdą nową sesją, więc każda sesja zaczyna się z gotowym
toolchainem produktu:

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

### Prompt na każdą nową sesję

Zacznij sesję na repozytorium `vacterro/zaicode`, gałęzi `saipen-live` i
upewnij się, że agent maszyny operatora nie zapisuje w tym samym czasie.
Zastąp ostatnią linię przez `cc all <new list>`, aby przekazać nową pracę.

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

Na maszynie operatora watcher robi fast-forward `zcode` z
`origin/zaicode`; `REBUILD.cmd` (lub `REBUILD_fast.lnk`) go buduje, a
następne uruchomienie ZAICODE podmienia nową wersję.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
