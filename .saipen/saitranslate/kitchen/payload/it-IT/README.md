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

ZAICODE è una postazione di lavoro per operatori che esegue molti agenti di coding AI contemporaneamente su
molti progetti, senza doverli sorvegliare. È una build modificata di
[ZCode](https://github.com/zai-org/ZCode) (app desktop, UI nel browser e agent
CLI) con uno strato di prodotto above: ogni progetto è pilotato dal
protocollo [SAIPEN](https://github.com/vacterro/saipen), il lavoro viene avviato, continuato
e pianificato da una sola finestra, e le CLI a abbonamento che già paghi
(Claude Code, Codex, Antigravity) girano come worker docked accanto agli agenti integrati.

**0.0.1** è il primo snapshot taggato: una build personale, pensata prima per Windows, usata ogni giorno.

## Installazione in un clic

1. Scarica **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Fai doppio clic e premi **INSTALL**.

Tutto qui. Il setup porta ciò che manca alla macchina (Git, Node.js, Python, come copie private: nessun diritto di amministratore), recupera ZAICODE, SAIPEN e SAIMAIL da GitHub, compila l'app sulla macchina e mette un collegamento ZAICODE sul desktop. Il primo avvio richiede 15-30 minuti; la finestra mostra ogni passaggio.

I modelli gratuiti funzionano subito: ZAICODE avvia il proprio router e riempie il pool **SAIFREN** con i piani gratuiti senza chiave, così un task digitato in New task ottiene una risposta senza chiave, account né impostazioni. Gli abbonamenti Claude Code, Codex e Antigravity sono opzionali: puoi accedere in qualsiasi momento.

**Un intero, quattro parti.** Il workspace (launcher, installer), l'app, SAIPEN e
SAIMAIL sono quattro repository. Ogni uno si aggiorna da solo: *Settings -> ZAICODE ->
Updates* mostra ogni parte, la aggiorna a mano o automaticamente (verifica pochi minuti
dopo l'avvio e ogni sei ore). Una nuova build dell'app viene preparata mentre ZAICODE gira
e parte con l'avvio successivo; le tue modifiche in un clone non vengono mai sovrascritte.
Da terminale: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Autotroubleshoot: `install\Doctor.cmd`. Dettagli: [docs/ZAICODE_INSTALL.md](docs/ZAICODE_INSTALL.md).

## Panoramica dell'interfaccia

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

## Cosa aggiunge a ZCode

- **Progetti con una sessione MAIN.** Ogni progetto ha una sessione MAIN (START,
  `/goal cc all`) e sessioni ausiliarie (subSaipens: WIKI, TEST, AUDIT, …). La
  vista predefinita della barra laterale mostra la riga del progetto come suo MAIN; ▶
  continua MAIN invece di aprire un'altra sessione. CONTINUE ALL, DONE e CLEAR ALL
  DONE scansionano ogni progetto; una sessione interrotta a metà turno mostra
  INTERRUPTED, mai DONE.
- **Sicurezza in caso di crash.** Le sessioni troncate da un processo morto e gli
  obiettivi ancora attivi riprendono da soli dopo un riavvio; i worker in esecuzione
  ripartono. Gli agenti dentro ZAICODE non possono uccidere ZAICODE per nome del
  processo.
- **Worker.** Le CLI in abbonamento girano in terminali ancorati a un qualsiasi
  bordo della finestra (o in finestre autonome con snap). Le domande "Trust this
  folder?" al primo avvio vengono gestite; un worker che raggiunge il limite di
  utilizzo viene segnalato e, tramite impostazione, chiuso o riavviato dopo il
  reset.
- **Limiti e reset.** Contatori di quota per account e pool, un timer nella barra
  del titolo per il reset più vicino con l'elenco completo dei prossimi reset al
  passaggio del mouse.
- **SCHEDULER.** Prompt che si avviano da soli: a un orario, ogni giorno, ogni N
  minuti o quando una finestra di quota si ricarica; in un progetto o in un'intera
  sezione della barra laterale, prima i progetti peggiori (più bloccati / ticket
  SAIPEN aperti). Le condizioni possono fermare prima i lavori temporanei (sessioni
  del pool gratuito, worker più deboli), eseguire solo sui progetti inattivi o
  continuare solo le sessioni contrassegnate. I prompt non hanno un limite di
  lunghezza pratico.
- **Routing.** Un 9router integrato (MIT) offre pool senza configurazione: SAIFREN
  (piani gratuiti senza chiave) e SAIOPP (le tue sottoscrizioni).
- **SAIHOME, timer, suoni, evidenziazioni.** Una home da operatore con statistiche,
  timer e allarmi in stile FastPrompter, suoni per azione e un'interfaccia Win95
  dark golden, nitida e pixel-perfect.

## Compilazione

Requisiti: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) è la fonte di verità).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

L'app pacchettizzata si avvia sempre in modalità ZAICODE. Mentre è in esecuzione
un ZAICODE più vecchio, il bundler mette in staging la nuova build in `packages/desktop/dist-next`;
il launcher di root (branch `master`, `tools/launcher`) la sostituisce al prossimo
avvio. La variante bitmap nitida di Verdana usata dalla UI non fa parte di questo
repository; senza di essa l'interfaccia ricade sul Verdana di sistema.

Controlli: `pnpm typecheck`, `pnpm lint` e i test ZAICODE, ad esempio
`node --import tsx --test test/zaicode*.test.ts` da `packages/ui`.

## Struttura del repository

| Branch      | Contenuti                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | il workspace canonico: launcher, installer (`install/`), documentazione del prodotto (`UI.md`, `docs/`), stato SAIPEN e CHANGELOG |
| `zaicode`   | il sorgente canonico dell'app: storia ZCode upstream più il layer di prodotto ZAICODE usato per build e aggiornamenti |

Riferimenti legacy o creati dall'automazione possono comparire ancora
temporaneamente, ma non sono branch di prodotto canonici. Il nuovo lavoro sul
workspace appartiene a `master`; il lavoro sul sorgente dell'app appartiene a
`zaicode`.

Il codice dell'app di proprietà ZAICODE vive quasi tutto in `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` e
`packages/desktop/src/main/zaicode*.ts` sul branch `zaicode`. La documentazione del
workspace e il tooling del launcher/update vivono su `master`.

## Upstream e licenza

ZAICODE deriva da ZCode di Z.ai ed è distribuito sotto la stessa licenza
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); gli avvisi upstream sono conservati in
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) e [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
I file sono stati modificati dall'autore di ZAICODE. ZAICODE è un progetto indipendente,
non affiliato né approvato da Z.ai. Il README originale di ZCode è conservato come
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) e [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Rete di progetto

Questo repository fa parte dell'ecosistema più ampio **SAIPEN / vacterro**.

[**Hub autori**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**Community SAIPEN**](https://discord.gg/SEYaYkuVgN)

Per bug riproducibili e richieste di funzionalità durature, usa le [GitHub Issues di questo repository](https://github.com/vacterro/zaicode/issues). Usa Discord per discussioni rapide, screenshot e feedback tra progetti.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
