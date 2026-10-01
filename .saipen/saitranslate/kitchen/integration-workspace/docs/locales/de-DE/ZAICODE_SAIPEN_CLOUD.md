# ZAICODE SAIPEN Cloud-Transport

Wie dieser Checkout und eine Claude Code Cloud-Session einen SAIPEN-Arbeitsbereich
mit unterschiedlicher Executor-Lokalität betreiben – und wo die Grenze dazwischen verläuft.

## Die Form

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Ein Branch trägt den Protokollzustand. Es gibt keinen Merge-Schritt, keinen Rebase-Schritt
und keinen zweiten lokalen Branch, der mitgehalten werden müsste: Wer einen verifizierten
Checkpoint hat, committet und pusht ihn, die andere Seite holt ihn per
Fast-Forward.

`master` ist die Historie vor dem Transport und der veröffentlichte Standardbranch. Er wird
durch den Transport nicht force-aktualisiert.

## Was mitreist und was nicht

Ein Checkpoint in diesem Repository trägt den SAIPEN-Protokollzustand, den
Root-Launcher, den Installer, die Doku und diese Transport-Skripte. Das ist
die gesamte Workspace-Schicht.

Er trägt **kein Produktbyte**. `zcode/` ist ein separates Git-Repository, in `.saipen/source-nested-repos.json` aufgeführt
und in diesem Root ignoriert
(`/zcode/`). Produktarbeit braucht einen eigenen Clone von `vacterro/zaicode` auf Branch
`zaicode` – dieser Clone ist ein zweites, unabhängiges Objekt mit eigener Historie.

Die Folge ist leicht falsch zu verstehen: Ein sauberer `git status` in diesem Root sagt
nichts über nicht committete Produktarbeit aus, und ein `saipen-live`-Fast-Forward sagt
nichts über Produktcode. `git -C zcode status` explizit prüfen.

## Lokale Hälfte

Zwei Skripte, beide repo-eigen, damit eine neue Maschine sie aus dem Repository
bekommt statt aus dem Gedächtnis:

| Datei | Rolle |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | validiert, gleicht den Branch ab, installiert und startet den Watcher, schreibt den Autostart-Eintrag, belegt lokal == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | die Schleife: fetch, vergleichen, fast-forward oder push, loggen, pausieren; danach der Produktdurchlauf und das Self-Update |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | Roundtrip aus einem unabhängigen Executor plus Nachweis der Kaltwiederherstellung |
| `tools/saipen-cloud/Test-ProductSync.ps1` | Produktdurchlauf und Self-Update gegen Wegwerf-Git-Repositories (kein Netzwerk, kein echtes Remote) |


Installation und Reparatur:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Idempotent. Maschinenlokaler Zustand liegt in `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (eine Kopie), `ZAICODE_cloud-sync.log` (rotiert bei
2 MB nach `.log.1`), `ZAICODE_cloud-sync.lock` (einzelne Instanz),
`ZAICODE_cloud-sync.pid` sowie ein Eintrag im Startup-Ordner
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Der Installer verweigert einen schmutzigen Baum und bereinigt ihn nie. Ist jeder schmutzige Pfad kanonischer SAIPEN-Zustand unter `.saipen/`, meldet er das und gibt die exakten Checkpoint-Befehle aus; das ist ein nicht eingecheckter Protokollzustand, kein Transportfehler, und der Installer committet ihn nicht hinter dem Protokoll her.

## Verhalten des Watchers

| Situation | Aktion |
|-----------|------|
| sauber, lokal ist Vorfahre von remote | `git merge --ff-only` |
| sauber, remote ist Vorfahre von lokal | `git push` |
| schmutzig | pausieren; nicht einmal ein fetch |
| auf einem anderen Branch | pausieren |
| beide fortgeschritten, kein gemeinsamer Vorfahre | pausieren, beide Commit-Ids loggen, nichts mergen |
| fetch oder Netzwerk fehlgeschlagen | degraded loggen, im nächsten Tick erneut versuchen |
| Merge/Rebase/cherry-pick läuft | pausieren |

Nie: force push, hard reset, stash, clean, checkout eines fremden Branch,
commit oder Stopp per Prozessname. Der Installer stoppt einen Watcher nur über die
pid, die er in seiner eigenen pid-Datei aufgezeichnet hat.

Ein schmutziger Baum kostet nichts, weil der Watcher den Schmutz vor dem Fetch prüft.
Ein ungenutztes Checkout stellt daher überhaupt keine Netzwerkaufrufe an.

### Produktdurchlauf (T-90)

`zcode/` ist ein eigenes Repository, daher bewegt die Tabelle oben nie
Produktcode. Danach verarbeitet derselbe Tick das Produkt-Checkout (`-ProductRepo`,
Standard `<repo>\zcode`; Branch `-ProductBranch`, Standard `zaicode`). Der
Produktdurchlauf läuft, egal ob der äußere Baum schmutzig ist. Er pullt nur.

| Situation | Aktion |
|-----------|------|
| Remote voraus, keine eingehende Datei hier dirty | `git merge --ff-only`; nicht committete Produktarbeit bleibt unverändert |
| Remote voraus, eine eingehende Datei hier dirty | HELD: Dateien protokollieren, nichts mergen |
| lokal voraus | protokollieren; **nie gepusht** (Produkt wird von SAIPEN SHIP veröffentlicht) |
| divergiert | pausieren, beide Ids protokollieren, nichts mergen |
| anderer Branch, Git-Operation läuft, Fetch fehlgeschlagen | pausieren |
| kein `zcode/`-Checkout, oder `-NoProduct` | übersprungen |

git verweigert von sich aus ein Fast-Forward, das eine lokale Änderung überschreiben würde, daher
ist die HELD-Prüfung eine frühere, klarere Wache – nicht die einzige. Ein Produkt-
Fast-Forward baut nichts neu: zum Testen `pnpm bundle:zaicode` ausführen (oder
die Dev-Vorschau).

### Self-Update (T-90)

Der Watcher läuft als Kopie unter `%APPDATA%\SAIPEN`, daher lief ein neuerer Watcher im
Repository nie ohne Neuinstallation. Im Loop-Modus vergleicht er jetzt
bei jedem Durchgang seine eigene Datei mit der committeten Kopie im Repository. Er installiert
diese Kopie über sich selbst und startet genau einmal neu, mit denselben Argumenten,
nur wenn alle diese Bedingungen zutreffen:

- die beiden Dateien unterscheiden sich;
- die Repository-Kopie hat keine nicht committeten Änderungen;
- die Repository-Kopie lässt sich ohne Fehler parsen.

Eine Kopie, die nicht parst, wird abgelehnt und protokolliert, der laufende Watcher
macht weiter.

Watcher, die vor T-90 installiert wurden, haben weder den Produkt-Durchlauf noch Self-Update.
Auf einer solchen Maschine `Install-SaipenLiveSync.ps1` einmal erneut ausführen; danach
aktualisiert sich der Watcher selbst.

## Cloud-Hälfte

`CLAUDE.md` im Root ist die Eintrittsregel und
`.claude/skills/saipen/SKILL.md` ist das Ausführungsverfahren. Der Skill holt
den SAIPEN-Kernel von `github.com/vacterro/saipen` und führt ihn über die
deklarierte Engine-Oberfläche `tools/saipen.py` aus. Der Kernel ist per Commit
(`3088eff`) gepinnt, nie per Tag. Tag `v8.0.1` ist ein älterer Kernel mit demselben
`VERSION`; dessen `validate` mutiert den Zustand, und dessen Validator lehnt dieses Board ab.

`STATE.saipen_home`记录iert den Kernel-Pfad des zuletzt checkpointenden
Executors. In der Cloud konvergiert das erste `saipen continue` auf Kernel `3088eff` ihn
in einem einzigen protokollierten `DEC` auf den laufenden Kernel (E-1410). Auf der
Operator-Maschine kommt der Pointer genauso tot an. Ein Kernel mit automatischer
Konvergenz repariert ihn bei `continue`; sonst
`saipen rebind-home --auto` ausführen.

**Die Rückfahrt ist beobachtet.** E-1562 (Cloud) hat den Zeiger auf `/home/user/zaicode/.claude/saipen-protocol` konvergiert; E-1571 (Operator-Maschine) konvergierte ihn direkt zurück auf `V:/.../_SAIPEN`, automatisch, ohne manuelles `rebind-home`. Beide Richtungen sind dieselbe automatische Konvergenz, also pro Locality-Wechsel mit einem `saipen_home` `DEC` rechnen und als erwartetes Rauschen behandeln, nicht als Defekt. Es bleibt Rauschen, bis P1-2 (`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) den Zeiger aus dem versionierten Zustand holt; P1-2 nicht als Nebenwirkung des Bemerkens implementieren. Den Zeiger nie von Hand bearbeiten.

`STATE.saipen_home` kann auf einen Kernel-**Entwicklungs-Checkout** zeigen, der vor dem Pin liegt, nicht auf einen sauberen `3088eff`-Clone — auf der Operator-Maschine ist es der `accepted-debt-rebind`-Zweig mit nicht committeten Arbeiten. Ein Kernel, der nicht auf dem gepinnten Commit steht, ist nicht automatisch falsch, aber auch keine Cleanroom-Quelle; die Regel unten zum Voice-Vertrag gilt daher in vollem Umfang dafür. In einem solchen Checkout niemals committen, stashen, resetten, auschecken oder cleanen; ein gezieltes Single-File-Restore von `saipen/STYLE.md` ist die einzige erlaubte Ausnahme, und nur wenn der Operator darum gebeten hat.

### STYLE.md ist keine lokale Einstellung

`saipen/STYLE.md` muss auf jeder Maschine, in jeder Kopie **byte-identisch mit der Datei des gepinnten Kernels** sein, ohne Ausnahmen und ohne lokale Änderungen. Auf einer Operator-Maschine gibt es mehr als eine Kopie:

- den Kernel-Checkout unter `STATE.saipen_home` (ein Git-Clone, auf der Operator-Maschine ein Entwicklungschekout);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, befüllt durch den geplanten Task `saipen-inject` (`bootstrap/schedule-run.ps1`). Er ist **kein Git-Repository**, daher kann `git checkout` ihn nie reparieren — ein Re-Sync über den Injector oder ein direktes Schreiben des veröffentlichten Inhalts ist der einzige Weg.

Das `style_contract`-Token in `.saipen/STATE.md` ist ein Hash des Textes dieser Datei (`tools/validate.py`, `style_contract_token`: CRLF normalisiert, die `style_contract:`-Zeile ausgeschlossen). `reply_language` in einer Kopie ändern und das Token verschiebt sich; die andere Kopie und die Cloud, die den veröffentlichten Kernel holen, behalten das veröffentlichte Token, und jeder CLI-Schreibvorgang auf der abweichenden Seite wird mit `style_contract ... does not match the installed STYLE.md marker` abgelehnt.
Das ist der ganze Fehler: die lokale Seite schreibt Zustand, den die Cloud nicht schreiben kann.

**Die Antwortsprache zu ändern ist ein Kernel-Commit plus Repin**, niemals eine lokale Änderung. Im Kernel-Repository ändern, veröffentlichen, den Commit in SKILL.md neu pinnen und `STATE.style_contract` über `saipen recover` aktualisieren. Eine lokale Änderung an `STYLE.md` entsynchronisiert jede Maschine außer derjenigen, die sie vornimmt.

Eine Falle, die benannt werden sollte: das veröffentlichte `bin/saipen` ist ein maschinengebundener Shim, der die absoluten Interpreter- und Checkout-Pfade eines Operators fest einträgt. Er läuft auf genau einer Maschine. Die Cloud muss `python3 tools/saipen.py` verwenden.

Shortcuts: `cc` setzt die aktuelle Work fort; `cc all <text>` übernimmt die ganze Nachricht als Source/appends und setzt jede berechtigte Work fort. Keiner fragt nach einer routinemäßigen Bestätigung.

## Capability-Klassifizierung

**AVAILABLE_IN_CLOUD** — Protokollzustand und Workspace-Ebene. Lesen und
Schreiben von `.saipen/`, dem Launcher (`tools/launcher/ZaicodeLauncher.cs`), dem Installer unter
`install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` sowie den
Transport-Skripten. Git-Read, Commit, Push und Fetch auf `saipen-live`. Jeder
Gate, der eine Dateiprüfung, ein Diff-Review oder eine Textprüfung ist.

**LOCAL_WINDOWS_ONLY** — die Gates, die diese Maschine brauchen.

| Gate | Warum |
|------|-----|
| `tools\launcher\build.cmd` | kompiliert `ZaicodeLauncher.cs` mit .NET Framework `csc`; kein Windows SDK auf einem Cloud-Image |
| packaged Electron E2E (`zcode` Desktop, Solo → Queue → Dispatch) | braucht Desktop-Session und vorbereitetes Provider-Profil |
| das laufende 9router | ein Windows-Dienst auf dieser Maschine |
| interaktiver Desktop-Click-Through | ein Mensch und ein Bildschirm |
| die eigenen Laufzeitfälle des Watchers | der Watcher läuft nur auf der Maschine mit dem Checkout |

Diese werden als lokale Akzeptanzgrenzen festgehalten. Sie werden niemals
als bestanden gemeldet, nur weil der Diff richtig aussah.

**SAFE_TO_DEFER** — die Produktschicht. Eine Cloud-Session kann
`vacterro/zaicode` Branch `zaicode` klonen und dort arbeiten. Workspace-Arbeit
braucht keine Produktschicht, aber den Clone: `.saipen/source-nested-repos.json` deklariert `zcode/`,
und ohne ihn scheitert der Validator mit `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. `pnpm` brauchen das
gepinnte pnpm 10.33.2 und einen vorbereiteten Workspace. `pnpm bootstrap` auf einem
frischen Cloud-Image ist der dokumentierte Weg hinein, und das `package.json` des
Produkts deklariert ihn bereits.

Die Cloud kann nur Produkt-Bytes prüfen, die auf `origin/zaicode` liegen. Ein
Produkt-Delta, das nur im `zcode/`-Checkout des Operators existiert, ist hier
unsichtbar — daher ist jedes Produktgate dafür in der Cloud NOT RUN, egal welches.
T-84 ist der erste Fall (E-1411): der Fix war lokal-only, während
`origin/zaicode` noch den Code vor dem Fix trug.

**UNSAFE_TO_EMULATE** — alles, was ein lokal-only Gate grün aussehen ließe.
Den Launcher-Build nicht stubben, keinen verpackten App-Lauf vortäuschen, kein
aufgezeichnetes `pnpm verify:pre-push`-Ergebnis als gerade ausgeführt nachspielen und
"der Code sieht korrekt aus" nicht in eine PASS-Zeile in `.saipen/LOG.md` umwandeln.

**KNOWN_CLOUD_DIVERGENCE** — Konformität, die vom Ort des Checkouts abhängt.
Auf Kernel `3088eff` meldet der Cloud-Validator `closure-evidence`
FAILs (T-47, T-62, T-76, T-78 zum Zeitpunkt des Schreibens), die die
Operator-Maschine nicht meldet.

Der Kernel verschiebt jedes LOG-Events über 1024 Bytes in eine
`.saipen/recovery/log-detail/`-Sidecar-Datei. Beim Lesen stellt er die Sidecar nur wieder her,
wenn der absolute Pfad des Checkouts dem Pfad entspricht, von dem sie
geschrieben wurde. Ein auf Windows geschriebenes langes VERIFY-Ergebnis ist
daher in der Cloud nicht lesbar — und umgekehrt gilt dasselbe.

Der Defekt liegt im Kernel und ist als P1-1 in `docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md` erfasst. Bis er
landet:

- das Cloud-Vergeben zitieren und Ticket für Ticket als diese Grenze einstufen
  (`SKILL.md` § 6 enthält die Prüfung);
- Sidecars nie neu schreiben, nicht nur zur Grünmeldung erneut verifizieren oder die Kernel-
  Kopie patchen;
- LOG-Ereignisse auf beiden Seiten unter 1024 Bytes halten.

Dieselbe Bindung an den Maschinenpfad blockiert ebenfalls Arbeit. Die Schulden-Baseline vor
BUILD wird beim ersten Eintritt eines Tickets in BUILD erfasst und bei jedem späteren Eintritt
erneut geprüft. Ein Ticket, das erstmals auf der Operator-Maschine BUILD erreicht hat, kann
daher in der Cloud nicht in BUILD eingehen: der Übergang wird mit `DEBT_SNAPSHOT_FOREIGN_PROJECT` verweigert. T-84
ist der dokumentierte Fall: DEBT-000079 wurde bei E-1377 erfasst, der Übergang bei E-1446
verweigert. Solche Tickets der Maschine überlassen, die ihre Baseline erfasst hat.

## Divergenz

Teilen lokales und entferntes Repository keinen gemeinsamen Vorfahren mehr, stoppt der Watcher.
Er merged nicht, rebased nicht und erzwingt nichts. Beide Commit-Ids landen im Log, die
Korrektur erfolgt `git log --left-right --cherry-pick <branch>...origin/<branch>` von Hand, und
das Ergebnis wird wie jede andere Änderung als Checkpoint gesichert.

## Die exakte Aktion auf der Cloud-Seite

### Setup-Skript der Umgebung (einmalig, in den Einstellungen der Cloud-Umgebung)

Cloud-Umgebungsmenü in der Session-Titelleiste -> Bearbeiten -> Setup-Skript. Es
läuft vor jeder neuen Session, damit startet jede Session mit der Produkt-Toolchain bereit:

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

### Der Prompt für jede neue Session

Starte die Session auf Repository `vacterro/zaicode`, Branch `saipen-live`, und
stelle sicher, dass der Agent auf der Operator-Maschine nicht gleichzeitig schreibt.
Ersetze die letzte Zeile mit `cc all <new list>`, um neue Arbeit zu übergeben.

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

Auf der Operator-Maschine fast-forwardt der Watcher `zcode` von
`origin/zaicode`; `REBUILD.cmd` (oder `REBUILD_fast.lnk`) baut es, und beim
nächsten Start von ZAICODE wird der neue Build übernommen.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
