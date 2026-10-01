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

Το ZAICODE είναι ένας πάγκος εργασίας χειριστή για την εκτέλεση πολλών AI πρακτόρων κωδικοποίησης ταυτόχρονα σε πολλά έργα, χωρίς να πρέπει να τους επιβλέπετε. Είναι τροποποιημένη έκδοση του [ZCode](https://github.com/zai-org/ZCode) (εφαρμογή υπολογιστή, διεπαφή browser και CLI πράκτορα) με ένα προϊοντικό επίπεδο από πάνω: κάθε έργο οδηγείται από το πρωτόκολλο [SAIPEN](https://github.com/vacterro/saipen), η εργασία ξεκινά, συνεχίζεται και προγραμματίζεται από ένα παράθυρο, και τα CLI συνδρομών που ήδη πληρώνετε (Claude Code, Codex, Antigravity) τρέχουν ως αγκυρωμένοι εργάτες δίπλα στους πράκτορες της εφαρμογής.

Η **0.0.1** είναι το πρώτο σημασμένο στιγμιότυπο: μια προσωπική έκδοση, με πρώτη προτεραιότητα τα Windows, που χρησιμοποιείται καθημερινά.

## Εγκατάσταση με ένα κλικ

1. Κατεβάστε το **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Κάντε διπλό κλικ σε αυτό και πατήστε **INSTALL**.

Αυτό είναι όλο. Το πρόγραμμα εγκατάστασης φέρνει ό,τι λείπει από τον υπολογιστή (Git, Node.js, Python, ως ιδιωτικά αντίγραφα: χωρίς δικαιώματα διαχειριστή), κατεβάζει τα ZAICODE, SAIPEN και SAIMAIL από το GitHub, χτίζει την εφαρμογή στον υπολογιστή και δημιουργεί συντομομέρωση ZAICODE στην επιφάνεια εργασίας. Η πρώτη εκτέλεση κρατά 15-30 λεπτά· το παράθυρο δείχνει κάθε βήμα.

Τα δωρεάν μοντέλα δουλεύουν αμέσως: το ZAICODE ξεκινά το δικό του router και γεμίζει τη **SAIFREN** δεξαμενή από δωρεάν επίπεδα χωρίς κλειδί, οπότε μια εργασία που πληκτρολογείτε στη New task παίρνει απάντηση χωρίς κλειδί, χωρίς λογαριασμό και χωρίς ρύθμιση. Οι συνδρομές Claude Code, Codex και Antigravity είναι προαιρετικές και μπορείτε να κάνετε σύνδεση ανά πάσα στιγμή.

**Ένα όλο, τέσσερα μέρη.** Ο χώρος εργασίας (launcher, installer), η εφαρμογή, το SAIPEN και το SAIMAIL είναι τέσσερα αποθετήρια. Το καθένα ενημερώνεται μόνο του: *Settings -> ZAICODE -> Updates* δείχνει κάθε μέρος και το ενημερώνει με το χέρι ή αυτόματα ( έλεγχος λίγα λεπτά μετά την εκκίνηση και κάθε έξι ώρες). Μια νέα έκδοση της εφαρμογής προετοιμάζεται όσο τρέχει το ZAICODE και ξεκινά με την επόμενη εκκίνηση· οι δικές σας αλλαγές σε ένα clone δεν αντικαθίστανται ποτέ.
Από τερματικό: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Αυτόματη αντιμετώπιση προβλημάτων: `install\Doctor.cmd`. Λεπτομέρειες: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Ξενάγη στην διεπαφή

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

## Τι προσθέτει στο ZCode

- **Έργα με MAIN συνεδρία.** Κάθε έργο έχει μία MAIN συνεδρία (START,
  `/goal cc all`) και συνεδρίες βοηθούς (subSaipens: WIKI, TEST, AUDIT, …). Η
  προεπιλεγμένη προβολή sidebar δείχνει τη γραμμή του έργου ως MAIN· το ▶ συνεχίζει τη MAIN
  αντί να ανοίγει άλλη συνεδρία. Τα CONTINUE ALL, DONE και CLEAR ALL DONE
  σαρώνουν κάθε έργο· συνεδρία που διακόπηκε στη μέση ενός turn δείχνει INTERRUPTED, ποτέ DONE.
- **Ασφάλεια έναντι πτώσεων.** Συνεδρίες που διέκοψε νεκρή διεργασία και στόχοι
  ακόμα ενεργοί συνεχίζουν μόνοι τους μετά επανεκκίνηση· οι ενεργοί workers
  ξεκινούν ξανά. Οι agents μέσα στο ZAICODE δεν μπορούν να σκοτώσουν το
  ZAICODE με βάση το όνομα διεργασίας.
- **Workers.** Τα subscription CLIs τρέχουν σε τερματικά προσαρμοσμένα σε
  οποιαδήποτε άκρη του παραθύρου (ή σε δικά τους snapping windows). Τα
  ερωτήματα «Trust this folder?» της πρώτης εκτέλεσης απαντώνται· worker
  που φτάσει το όριο χρήσης του αναφέρεται και, ανάλογα με τη ρύθμιση,
  κλείνεται ή επανεκκινείται μετά την επαναφόρ.
- **Όρια και επαναφορές.** Μετρητές quota ανά λογαριασμό και pool, timer στη
  γραμμή τίτλου για την πλησιέστερη επαναφορά, με πλήρη λίστα επαναφορών
  στο hover.
- **SCHEDULER.** Prompts που ξεκινούν μόνοι τους: σε συγκεκριμένη ώρα,
  καθημερινά, κάθε N λεπτά ή όταν γεμίζει ένα quota παράθυρο· σε ένα
  έργο ή σε ολόκληρη ενότητα sidebar, πρώτα τα χειρότερα έργα
  (περισσότερα μπλοκαρισμένα / ανοιχτά SAIPEN tickets). Οι συνθήκες
  μπορούν να σταματούν πρώτα τη stopgap δουλειά (συνεδρίες free-pool,
  ασθενέστερους workers), να τρέχουν μόνο σε αδρανή έργα ή να
  συνεχίζουν μόνο επισημασμένες συνεδρίες. Τα prompts δεν έχουν πρακτικό
  όριο μήκους.
- **Δρομολόγηση.** Ένα bundled 9router (MIT) δίνει pools χωρίς setup: SAIFREN
  (keyless free tiers) και SAIOPP (οι συνδρομές σας).
- **SAIHOME, timers, sounds, highlights.** Ένα σπίτι χειριστή με
  στατιστικά, timers και alarms τύπου FastPrompter, ήχους ανά ενέργεια
  και διεπαφή Win95 dark golden, pixel-crisp.

## Μεταγλώττιση

Απαιτήσεις: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) είναι η αρχή της αλήθειας).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

Η packaged εφαρμογή ξεκινά πάντα σε λειτουργία ZAICODE. Όσο τρέχει ένα
παλαιότερο ZAICODE, ο bundler σταδιοποιεί τη νέα μεταγλώττιση στο `packages/desktop/dist-next`· ο
root launcher (branch `master`, `tools/launcher`) την εναλλάσσει στην επόμενη
εκκίνηση. Η crisp bitmap παραλλαγή της Verdana που χρησιμοποιεί το UI δεν
περιλαμβάνεται σε αυτό το repository· χωρίς αυτήν η διεπαφή υποχωρεί στη
Verdana του συστήματος.

Έλεγχοι: `pnpm typecheck`, `pnpm lint`, και τα tests του ZAICODE, για
παράδειγμα `node --import tsx --test test/zaicode*.test.ts` από `packages/ui`.

## Διάταξη αποθεκηρίου

| Branch      | Περιεχόμενα                                                                |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | ο κανονικός χώρος εργασίας: launcher, installer (`install/`), τεκμηρίωση προϊόντος (`UI.md`, `docs/`), κατάσταση SAIPEN και CHANGELOG |
| `zaicode`   | ο κανονικός κώδικας εφαρμογής: ιστορικό upstream ZCode συν το product layer ZAICODE που χρησιμοποιείται για μεταγλωττίσεις και ενημερώσεις |

Τα legacy ή automation-created refs μπορεί να εμφανίζονται προσωρινά, αλλά
δεν είναι canonical product branches. Νέα δουλειά χώρου εργασίας ανήκει στο
`master`· δουλειά κώδικα εφαρμογής ανήκει στο `zaicode`.

Ο κώδικας εφαρμογής που ανήκει στο ZAICODE βρίσκεται κυρίως σε `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` και
`packages/desktop/src/main/zaicode*.ts` στο branch `zaicode`. Η τεκμηρίωση του χώρου
εργασίας και το tooling launcher/update βρίσκονται στο `master`.

## Upstream και άδεια χρήσης

Το ZAICODE προέρχεται από το ZCode της Z.ai και διανέμεται υπό την ίδια
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); οι σημειώσεις upstream διατηρούνται στο
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) και [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Τα αρχεία τροποποιήθηκαν από τον συγγραφέα του ZAICODE. Το ZAICODE είναι ανεξάρτητο έργο,
χωρίς σχέση ή έγκριση από τη Z.ai. Το αρχικό README του ZCode διατηρείται ως
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) και [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Δίκτυο έργου

Αυτό το repository αποτελεί μέρος του ευρύτερου οικοσυστήματος έργων **SAIPEN / vacterro**.

[**Hub συγγραφέα**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**Κοινότητα SAIPEN**](https://discord.gg/SEYaYkuVgN)

Για αναπαραγώγιμα bugs και μακροπρόθεσμα αιτήματα λειτουργιών, χρησιμοποιήστε τα [GitHub Issues αυτού του repository](https://github.com/vacterro/zaicode/issues). Χρησιμοποιήστε το Discord για γρήγορες συζητήσεις, screenshots και σχόλια μεταξύ έργων.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
