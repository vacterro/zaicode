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

<img width="1440" height="860" alt="ZAICODE hero — Do your best." src="docs/screenshots/01-do-your-best.png" />

ZAICODE ist eine Operator-Workbench, um viele AI-Coding-Agents gleichzeitig über
viele Projekte zu betreiben – ohne sie zu beaufsichtigen. Es ist ein modifizierter Build
von [ZCode](https://github.com/zai-org/ZCode) (Desktop-App, Browser-UI und Agent-
CLI) mit einer Produktschicht darüber: Jedes Projekt wird über das
[SAIPEN](https://github.com/vacterro/saipen)-Protokoll gesteuert, Arbeit wird aus einem Fenster gestartet,
fortgesetzt und geplant, und die Abo-CLIs, die du bereits bezahlst
(Claude Code, Codex, Antigravity) laufen als angedockte Worker neben den In-App-
Agenten.

**0.0.1** ist der erste getaggte Snapshot: ein persönlicher, Windows-first Build, der
 täglich genutzt wird.

## Installation mit einem Klick

1. **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)** herunterladen.
2. Doppelklick, dann **INSTALL** drücken.

Das ist alles. Das Setup bringt mit, was dem Rechner fehlt (Git, Node.js, Python, als private
Kopien: keine Administratorrechte), holt ZAICODE, SAIPEN und SAIMAIL von GitHub,
baut die App auf dem Rechner und legt eine ZAICODE-Verknüpfung auf den Desktop. Der erste
Start dauert 15–30 Minuten; das Fenster zeigt jeden Schritt.

Kostenlose Modelle funktionieren sofort: ZAICODE startet seinen eigenen Router und füllt den **SAIFREN**-
Pool aus keylosen Free-Tiers, sodass eine in New task eingegebene Aufgabe ohne
Key, ohne Konto und ohne Einstellung eine Antwort bekommt. Claude Code-, Codex- und Antigravity-Abos
sind optional und jederzeit anmeldbar.

**Ein Ganzes, vier Teile.** Workspace (Launcher, Installer), App, SAIPEN und
SAIMAIL sind vier Repositories. Jedes aktualisiert sich selbst: *Settings -> ZAICODE ->
Updates* zeigt alle Teile, aktualisiert sie manuell oder automatisch (geprüft ein paar Minuten
nach dem Start und alle sechs Stunden). Ein neuer App-Build wird vorbereitet, während ZAICODE läuft
und startet mit dem nächsten Start; eigene Änderungen im Clone werden nie überschrieben.
Aus dem Terminal: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Auto-Fehlersuche: `install\Doctor.cmd`. Details: [docs/ZAICODE_INSTALL.md](docs/ZAICODE_INSTALL.md).

## Oberflächentour

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>SAIHOME</strong><br />
      The operator dashboard: quotas, health, projects, streaks, activity, and the live clock in one place.<br /><br />
      <img src="docs/screenshots/02-saihome-dashboard.png" alt="SAIHOME dashboard" />
    </td>
    <td width="50%" valign="top">
      <strong>Agents &amp; tasks</strong><br />
      Create roles, inspect queues, and see what is idle, running, finished, or waiting for you.<br /><br />
      <img src="docs/screenshots/03-agents-and-tasks.png" alt="Agents and tasks" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Scheduler</strong><br />
      Arm quota-aware autonomous runs and recurring prompts across one project or a whole sidebar section.<br /><br />
      <img src="docs/screenshots/04-scheduler.png" alt="Scheduler" />
    </td>
    <td width="50%" valign="top">
      <strong>Audits</strong><br />
      Run Quick 3 Waves audits, watch progress live, and jump straight to reports when something stops.<br /><br />
      <img src="docs/screenshots/05-audits.png" alt="Audits" />
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <strong>Active session</strong><br />
      The full working view: transcript, branch, prompt composer, state inspector, board, and backlog at the same time.<br /><br />
      <img src="docs/screenshots/06-active-session.png" alt="Active session" />
    </td>
  </tr>
</table>

## Was es zu ZCode hinzufügt

- **Projekte mit einer MAIN-Session.** Jedes Projekt hat eine MAIN-Session (START,
  `/goal cc all`) und Hilfs-Sessions (subSaipens: WIKI, TEST, AUDIT, …). Die
  Standard-Sidebar-Ansicht zeigt die Projektzeile als deren MAIN; ▶ setzt MAIN
  fort, statt eine weitere Session zu öffnen. CONTINUE ALL, DONE und CLEAR ALL
  DONE laufen über alle Projekte; eine mitten im Zug abgeschnittene Session zeigt
  INTERRUPTED, nie DONE.
- **Absturzsicherheit.** Sessions, die ein abgestürzter Prozess abgeschnitten hat,
  und noch aktive Ziele laufen nach einem Neustart von selbst weiter; laufende
  Worker starten erneut. Agents innerhalb von ZAICODE können ZAICODE nicht über
  den Prozessnamen beenden.
- **Worker.** Subscription-CLIs laufen in Terminals, die an eine beliebige
  Fensterseite angedockt sind (oder in eigenen Andock-Fenstern). Fragen wie
  "Diesem Ordner vertrauen?" beim ersten Start werden beantwortet; ein Worker,
  der sein Nutzungslimit erreicht, wird gemeldet und je nach Einstellung
  geschlossen oder nach dem Zurücksetzen neu gestartet.
- **Limits und Zurücksetzungen.** Kontingent-Anzeigen pro Konto und Pool, ein
  Timer in der Titelleiste bis zum nächsten Zurücksetzen, die vollständige Liste
  aller kommenden Zurücksetzungen beim Überfahren mit der Maus.
- **SCHEDULER.** Prompts, die von selbst starten: zu einer Uhrzeit, täglich, alle N
  Minuten oder wenn ein Kontingentfenster wieder gefüllt wird; in einem Projekt oder
  einem ganzen Sidebar-Abschnitt, die kritischsten Projekte zuerst (am meisten
  blockiert / offene SAIPEN-Tickets). Bedingungen können Aushilfsarbeit
  (Sessions aus kostenlosen Pools, schwächere Worker) zuerst beenden, nur in
  ruhenden Projekten laufen oder nur markierte Sessions fortsetzen. Prompts haben
  praktisch keine Längenbegrenzung.
- **Routing.** Ein mitgelieferter 9router (MIT) liefert Pools ohne Einrichtung:
  SAIFREN (kostenlose Stufen ohne Key) und SAIOPP (deine Abos).
- **SAIHOME, Timer, Sounds, Highlights.** Ein Operator-Home mit Statistiken,
  Timern und Alarmen im FastPrompter-Stil, Sounds pro Aktion und einem
  pixelgenauen dunkelgoldenen Win95-Interface.

## Bauen

Anforderungen: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) ist die maßgebliche Quelle).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Die verpackte App startet immer im ZAICODE-Modus. Läuft noch eine ältere
ZAICODE-Version, legt der Bundler den neuen Build in `packages/desktop/dist-next` bereit; der
Root-Launcher (Branch `master`, `tools/launcher`) tauscht ihn beim nächsten Start
aus. Die scharfe Bitmap-Variante von Verdana, die die UI nutzt, ist nicht Teil
dieses Repositorys; ohne sie fällt die Oberfläche auf das Systemverdana zurück.

Prüfungen: `pnpm typecheck`, `pnpm lint` und die ZAICODE-Tests, zum Beispiel
`node --import tsx --test test/zaicode*.test.ts` aus `packages/ui`.

## Repository-Aufbau

| Branch      | Inhalt                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | der kanonische Workspace: Launcher, Installer (`install/`), Produktdokumentation (`UI.md`, `docs/`), SAIPEN-State und CHANGELOG |
| `zaicode`   | der kanonische App-Quellcode: Upstream-ZCode-Historie plus die ZAICODE-Produktschicht für Builds und Updates |

Legacy- oder automatisch erzeugte Refs können noch vorübergehend
auftauchen, sind aber keine kanonischen Produktbranches. Neue Workspace-Arbeit
gehört auf `master`; Arbeit am App-Quellcode gehört auf `zaicode`.

ZAICODE-eigener App-Code liegt meist in `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` und
`packages/desktop/src/main/zaicode*.ts` im Branch `zaicode`. Die Workspace-Dokumentation und das
Launcher-Tooling/update liegen auf `master`.

## Upstream und Lizenz

ZAICODE ist von ZCode von Z.ai abgeleitet und wird unter der gleichen
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE) vertrieben; Upstream-Hinweise stehen in
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) und [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Dateien wurden vom ZAICODE-Autor geändert. ZAICODE ist ein unabhängiges Projekt,
nicht mit Z.ai verbunden und nicht von Z.ai unterstützt. Das originale ZCode-README bleibt als
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) und [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md) erhalten.

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Projektnetzwerk

Dieses Repository ist Teil des breiteren **SAIPEN / vacterro**-Projektökosystems.

[**Autoren-Hub**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN Community**](https://discord.gg/SEYaYkuVgN)

Für reproduzierbare Fehler und dauerhafte Feature-Anfragen nutze die [GitHub Issues dieses Repositories](https://github.com/vacterro/zaicode/issues). Discord eignet sich für schnelle Diskussionen, Screenshots und projektübergreifendes Feedback.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
