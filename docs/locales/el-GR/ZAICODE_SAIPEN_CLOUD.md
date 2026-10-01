# ZAICODE SAIPEN μεταφορά μέσω cloud

Πώς αυτό το checkout και μια συνεδρία Claude Code Cloud τρέχουν έναν χώρο εργασίας SAIPEN
με διαφορετική τοπικότητα εκτελεστή, και πού είναι το όριο μεταξύ τους.

## Η μορφή

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Ένας κλάδος μεταφέρει την κατάσταση του πρωτοκόλλου. Δεν υπάρχει βήμα merge, ούτε rebase,
ούτε δεύτερος τοπικός κλάδος προς συγχρονισμό: όποιος εκτελεστής έχει επαληθευμένο
checkpoint τον κάνει commit και push, και η άλλη πλευρά τον παίρνει με
fast-forward.

`master` είναι το ιστορικό πριν τη μεταφορά και ο δημοσιευμένος προεπιλεγμένος κλάδος. Δεν
αλλάζει με force-update από τη μεταφορά.

## Τι ταξιδεύει και τι όχι

Ένα checkpoint σε αυτό το αποθετήριο φέρει την κατάσταση του πρωτοκόλλου SAIPEN, τον
root launcher, τον installer, τα docs και αυτά τα transport scripts. Αυτό είναι
όλο το layer του χώρου εργασίας.

Φέρει **κανένα byte προϊόντος**. Το `zcode/` είναι ξεχωριστό αποθετήριο Git, καταχωρημένο
στο `.saipen/source-nested-repos.json` και στο gitignore σε αυτό το root
(`/zcode/`). Η δουλειά προϊόντος χρειάζεται δικό της clone του `vacterro/zaicode` στον κλάδο
`zaicode`, και αυτό το clone είναι δεύτερο, ανεξάρτητο αντικείμενο με δικό του ιστορικό.

Η συνέπεια ξεγελά περιεχομένου: ένα καθαρό `git status` σε αυτό το root δεν λέει
τίποτα για ανεπιβεβαίωτη δουλειά προϊόντος, και ένα fast-forward του `saipen-live` δεν λέει
τίποτα για τον κώδικα προϊόντος. Έλεγξε ρητά το `git -C zcode status`.

## Το τοπικό ήμισυ

Δύο scripts, και τα δύο ανήκουν στο αποθετήριο, ώστε ένα νέο μηχάνημα να τα παίρνει από το αποθετήριο
και όχι από τη μνήμη:

| File | Role |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | επικυρώνει, εναρμονίζει τον κλάδο, εγκαθιστά και ξεκινά τον watcher, γράφει την καταχώριση αυτόματης εκκίνησης, αποδεικνύει local == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | ο βρόχος: fetch, σύγκριση, fast-forward ή push, log, παύση· έπειτα το πέρασμα προϊόντος και η αυτοενημέρωση |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | round-trip από ανεξάρτητο executor plus απόδειξη cold-recovery |
| `tools/saipen-cloud/Test-ProductSync.ps1` | πέρασμα προϊόντος και αυτοενημέρωση σε προσωρινά Git repositories (χωρίς δίκτυο, χωρίς πραγματικό remote) |

Εγκατάσταση και επισκευή:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Είναι idempotent. Η κατάσταση σε επίπεδο μηχανής ζει στο `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (αντίγραφο), `ZAICODE_cloud-sync.log` (εναλλασσόμενο στα
2 MB προς `.log.1`), `ZAICODE_cloud-sync.lock` (μία μόνο εγκατάσταση),
`ZAICODE_cloud-sync.pid`, και μια καταχώριση στον φάκελο Startup
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

Ο installer αρνείται dirty tree και δεν το καθαρίζει ποτέ. Αν κάθε dirty διαδρομή είναι
κανονική κατάσταση SAIPEN κάτω από `.saipen/`, το λέει και τυπώνει τις ακριβείς
εντολές checkpoint· αυτό είναι απόθευση πρωτοκόλλου χωρίς checkpoint, όχι σφάλμα μεταφοράς,
και ο installer δεν θα κάνει commit πίσω από την πλάτη του πρωτοκόλλου.

## Συμπεριφορά watcher

| Situation | Move |
|-----------|------|
| clean, το local είναι πρόγονος του remote | `git merge --ff-only` |
| clean, το remote είναι πρόγονος του local | `git push` |
| dirty | παύση· ούτε καν fetch |
| σε άλλον κλάδο | παύση |
| και τα δύο προχώρησαν, χωρίς κοινό πρόγονο | παύση, log των δύο commit ids, κανένα merge |
| fetch ή δίκτυο απέτυχε | log degraded, επανάληψη στο επόμενο tick |
| εκκρεμεί merge/rebase/cherry-pick | παύση |

Ποτέ: force push, hard reset, stash, clean, checkout ξένου κλάδου,
commit, ή διακοπή βάσει ονόματος διεργασίας. Ο installer σταματά watcher μόνο μέσω
του pid που κατέγραψε στο δικό του pid file.

Ένα dirty tree δεν κοστίζει τίποτα, γιατί ο watcher ελέγχει το dirt πριν το fetch.
Άρα ένα αδρανές checkout δεν κάνει καθόλου κλήσεις δικτύου.

### Πέρασμα προϊόντος (T-90)

`zcode/` είναι δικό του repository, άρα ο παραπάνω πίνακας δεν κινεί ποτέ κώδικα
προϊόντος. Μετά από αυτό, το ίδιο tick χειρίζεται το checkout του προϊόντος (`-ProductRepo`,
προεπιλογή `<repo>\zcode`· κλάδος `-ProductBranch`, προεπιλογή `zaicode`). Το
πέρασμα προϊόντος τρέχει είτε το εξωτερικό tree είναι dirty είτε όχι. Κάνει μόνο pull.

| Κατάσταση | Ενέργεια |
|-----------|------|
| το remote προηγείται, κανένα εισερχόμενο αρχείο δεν είναι dirty εδώ | `git merge --ff-only`; η μη δεσμευμένη δουλειά παραμένει ως έχει |
| το remote προηγείται, κάποιο εισερχόμενο αρχείο είναι dirty εδώ | HELD: καταγραφή αρχείων, κανένα merge |
| το local προηγείται | καταγραφή· **ποτέ push** (το προϊόν δημοσιεύεται από SAIPEN SHIP) |
| αποκλίνουν | παύση, καταγραφή και των δύο id, κανένα merge |
| άλλο branch, git op σε εξέλιξη, αποτυχία fetch | παύση |
| κανένα checkout `zcode/`, ή `-NoProduct` | παραλείφθηκε |

Το git αρνείται μόνο του ένα fast-forward που θα έγραφε πάνω σε τοπική αλλαγή, άρα ο έλεγχος HELD είναι πρώιμη και σαφέστερη προστασία, όχι η μόνη. Ένα product fast-forward δεν ανακατασκευάζει τίποτα: για δοκιμή, τρέξε `pnpm bundle:zaicode` (ή το dev preview).

### Αυτοενημέρωση (T-90)

Ο watcher τρέχει ως αντίγραφο κάτω από `%APPDATA%\SAIPEN`, άρα ένας νεότερος watcher στο repository δεν έτρεξε ποτέ χωρίς επανεγκατάσταση. Σε loop mode τώρα συγκρίνει το δικό του αρχείο με το committed αντίγραφο του repository σε κάθε πέρασμα. Εγκαθιστά αυτό το αντίγραφο πάνω του και επανεκκινείται ακριβώς μία φορά, με τις ίδιες παραμέτρους, μόνο όταν ισχύουν όλα τα παρακάτω:

- τα δύο αρχεία διαφέρουν·
- το αντίγραφο του repository δεν έχει μη δεσμευμένες επεξεργασίες·
- το αντίγραφο του repository γίνεται parse χωρίς σφάλματα.

Ένα αντίγραφο που δεν γίνεται parse απορρίπτεται και καταγράφεται, και ο watcher συνεχίζει.

Οι watchers που εγκαταστάθηκαν πριν από το T-90 δεν έχουν ούτε το product pass ούτε την αυτοενημέρωση. Τρέξε ξανά `Install-SaipenLiveSync.ps1` μία φορά σε τέτοια μηχανή· μετά ο watcher ενημερώνει τον εαυτό του.

## Μισό σύννεφο

Το `CLAUDE.md` στη ρίζα είναι ο κανόνας εισόδου και το `.claude/skills/saipen/SKILL.md` η διαδικασία εκτέλεσης. Το skill ανακτά τον SAIPEN kernel από `github.com/vacterro/saipen` και τον τρέχει μέσω της δηλωμένης engine επιφάνειας `tools/saipen.py`. Ο kernel καρφιτζώνεται με commit (`3088eff`), ποτέ με tag. Το tag `v8.0.1` είναι παλιότερος kernel με το ίδιο `VERSION`· το `validate` του μεταβάλλει κατάσταση, και ο validator του απορρίπτει αυτόν τον πίνακα.

Το `STATE.saipen_home` καταγράφει το kernel path του executor που έκανε checkpoint τελευταίο. Στο σύννεφο, το πρώτο `saipen continue` σε kernel `3088eff` το συγκλίνει στον τρέχοντα kernel ως ένα καταχωρισμένο `DEC` (E-1410). Στη μηχανή του operator ο δείκτης φτάνει νεκρός με τον ίδιο τρόπο. Ένας kernel με αυτόματη σύγκλιση τον επισκευάζει στο `continue`· αλλιώς τρέξε `saipen rebind-home --auto`.

**Παρατηρείται η διαδρομή επιστροφής.** Το E-1562 (cloud) σύγκλινε τον δείκτη σε `/home/user/zaicode/.claude/saipen-protocol`; το E-1571 (μηχάνημα χειριστή) τον σύγκλινε απευθείας πίσω σε `V:/.../_SAIPEN`, αυτόματα, χωρίς χειροκίνητο `rebind-home`. Και οι δύο κατευθύνσεις είναι η ίδια αυτόματη σύγκλιση, οπότε αναμένετε ένα `saipen_home` `DEC` ανά εναλλαγή τοποθεσίας και να το θερείτε ως αναμενόμενο θόρυβο, όχι ως ελάττωμα. Παραμένει θόρυβος μέχρι το P1-2 (`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) να βγάλει τον δείκτη από την κατάσταση με εκδοχές· μην υλοποιείτε το P1-2 ως παρενέργεια του ότι το διαπιστώσατε. Ποτέ μην επεξεργάζεστε χειροκίνητα τον δείκτη.

`STATE.saipen_home` μπορεί να δείχνει σε ένα **checkout ανάπτυξης** του kernel που είναι μπροστά από το pin, όχι σε καθαρό clone `3088eff` — στο μηχάνημα χειριστή είναι η `accepted-debt-rebind` διακλάδωση με ανεπίτυπη δουλειά. Ένα kernel που δεν είναι στην καθαρά καθηλωμένη commit δεν είναι αυτόματα λάθος, αλλά ούτε και πηγή clean-room, άρα ο κανόνας παρακάτω για τη σύμβαση φωνής ισχύει γι' αυτό με πλήρη ισχύ. Ποτέ μην κάνετε commit, stash, reset, checkout ή clean σε τέτοιο checkout· η μόνη επιτρεπόμενη εξαίρεση είναι μια στοχευμένη επαναφορά ενός αρχείου για το `saipen/STYLE.md`, και μόνο όταν το ζητήσει ο χειριστής.

### Το STYLE.md δεν είναι τοπική ρύθμιση

`saipen/STYLE.md` πρέπει να είναι **byte-ταυτόσημο με το αρχείο του καθηλωμένου kernel** σε κάθε μηχάνημα, σε κάθε αντίγραφο, χωρίς εξαιρέσεις και χωρίς τοπικές επεξεργασίες. Στο μηχάνημα χειριστή υπάρχουν πάνω από ένα αντίγραφα:

- το checkout του kernel στο `STATE.saipen_home` (ένα Git clone, στο μηχάνημα χειριστή ένα checkout ανάπτυξης);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, που συμπληρώνεται από την προγραμματισμένη εργασία `saipen-inject` (`bootstrap/schedule-run.ps1`). **Δεν είναι Git repository**, άρα το `git checkout` δεν μπορεί ποτέ να το επισκευάσει — η μόνη διαδρομή είναι επανασυγχρονισμός μέσω του injector ή απευθείας εγγραφή του δημοσιευμένου περιεχομένου.

Το `style_contract` token στο `.saipen/STATE.md` είναι hash του κειμένου αυτού του αρχείου (`tools/validate.py`, `style_contract_token`: CRLF κανονικοποιημένα, η γραμμή `style_contract:` εξαιρούμενη). Επεξεργάζεστε το `reply_language` σε ένα αντίγραφο και το token μετακινείται· το άλλο αντίγραφο και το cloud, που τραβούν το δημοσιευμένο kernel, κρατούν το δημοσιευμένο token, και κάθε CLI εγγραφή στην ασύμμετρη πλευρά απορρίπτεται με `style_contract ... does not match the installed STYLE.md marker`.
Αυτό είναι όλη η βλάβη: η τοπική πλευρά γράφει κατάσταση που το cloud δεν μπορεί να γράψει.

**Η αλλαγή γλώσσας απάντησης είναι commit στο kernel συν επανακαθήλωση (repin), ποτέ τοπική επεξεργασία.** Αλλάξτε την στο kernel repository, δημοσιεύστε την, κάντε re-pin τη commit στο SKILL.md και ενημερώστε το `STATE.style_contract` μέσω `saipen recover`. Μια τοπική επεξεργασία στο `STYLE.md` αποσυγχρονίζει κάθε μηχάνημα εκτός από αυτό που την κάνει.

Μία παγίδα που αξίζει να ονομαστεί: το δημοσιευμένο `bin/saipen` είναι ένα shim δεσμευμένο σε μηχάνημα, με hardcoded απόλυτα μονοπάτια ερμηνευτή και checkout ενός χειριστή. Τρέχει σε ακριβώς ένα μηχάνημα. Το cloud πρέπει να χρησιμοποιεί `python3 tools/saipen.py`.

Συντομεύσεις: `cc` συνεχίζει το τρέχον Work· `cc all <text>` εισάγει ολόκληρο το μήνυμα ως πηγή/appends και συνεχίζει κάθε Work που επιτρέπεται. Καμία δεν ζητά ρουτίνη επιβεβαίωση.

## Ταξινόμηση δυνατοτήτων

**AVAILABLE_IN_CLOUD** — κατάσταση πρωτοκόλλου και το επίπεδο workspace. Ανάγνωση και
εγγραφή `.saipen/`, ο launcher (`tools/launcher/ZaicodeLauncher.cs`), ο
installer στο `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` και τα
transport scripts. Git read, commit, push, fetch στο `saipen-live`. Οποιαδήποτε
gate που είναι file assertion, diff review ή text check.

**LOCAL_WINDOWS_ONLY** — τα gates που χρειάζονται αυτό το μηχάνημα.

| Gate | Γιατί |
|------|-----|
| `tools\launcher\build.cmd` | κάνει compile `ZaicodeLauncher.cs` με το .NET Framework `csc`; κανένα Windows SDK σε cloud image |
| packaged Electron E2E (`zcode` desktop, Solo → queue → dispatch) | χρειάζεται desktop session και seeded provider profile |
| το live 9router | Windows service σε αυτό το μηχάνημα |
| interactive desktop click-through | ένας άνθρωπος και μια οθόνη |
| τα δικά runtime cases του watcher | ο watcher τρέχει μόνο στο μηχάνημα με το checkout |

Καταγράφονται ως local-only acceptance boundaries. Ποτέ δεν
αναφέρονται ως passed επειδή το diff φαινόταν σωστό.

**SAFE_TO_DEFER** — το επίπεδο του προϊόντος. Μια cloud session μπορεί να κάνει clone
το `vacterro/zaicode` branch `zaicode` και να δουλέψει εκεί. Η δουλειά στο επίπεδο
του workspace δεν απαιτεί δουλειά στο προϊόν, αλλά απαιτεί το clone:
το `.saipen/source-nested-repos.json` δηλώνει `zcode/`, και χωρίς αυτό ο
validator αποτυγχάνει με `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. Τα `pnpm` gates χρειάζονται το pinned pnpm 10.33.2
και ένα προετοιμασμένο workspace. Το `pnpm bootstrap` σε καθαρό cloud image είναι
ο τεκμηριωμένος τρόπος εισόδου, και το `package.json` του προϊόντος το δηλώνει ήδη.

Το cloud μπορεί να επαληθεύσει μόνο bytes προϊόντος που είναι στο `origin/zaicode`. Ένα
product delta που υπάρχει μόνο στο checkout `zcode/` του operator είναι
αόρατο εδώ, άρα κάθε product gate γι' αυτό είναι NOT RUN στο cloud, όποιο
και αν είναι το gate. Το T-84 είναι η πρώτη περίπτωση (E-1411): η διόρθωσή του ήταν local-only ενώ
το `origin/zaicode` είχε ακόμα τον pre-fix κώδικα.

**UNSAFE_TO_EMULATE** — οτιδήποτε θα έκανε ένα local-only gate να φαίνεται πράσινο.
Μην κάνεις stub του launcher build, μην προσομοιάζεις εκτέλεση packaged app, μην
αναπαίδεις καταγεγραμμένο
`pnpm verify:pre-push` αποτέλεσμα σαν να είχε μόλις τρέξει, μην μετατρέπεις το «ο κώδικας
φαίνεται σωστός» σε γραμμή PASS στο `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — συμμόρφωση που εξαρτάται από το πού βρίσκεται το
checkout. Στον kernel `3088eff` ο cloud validator αναφέρει `closure-evidence`
FAIL (T-47, T-62, T-76, T-78 κατά τη συγγραφή) που το μηχάνημα του
operator δεν έχει.

Ο kernel μεταφέρει κάθε LOG event άνω των 1024 bytes σε
sidecar `.saipen/recovery/log-detail/`. Κατά την ανάγνωση αποκαθιστά το sidecar μόνο
όταν η absolute path του checkout ταυτίζεται με από πού γράφτηκε. Άρα
ένα μεγάλο VERIFY verdict γραμμένο σε Windows είναι μη αναγνώσιμο στο
cloud, και το αντίστροφο ισχύει επίσης.

Το defect είναι στον kernel και έχει καταχωριστεί ως P1-1 στο
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Μέχρι να μπει:

- παραθέστε την απόφαση του cloud και χαρακτηρίστε την ως αυτό το όριο, ticket ανά ticket
  (`SKILL.md` § 6 έχει τον έλεγχο);
- ποτέ μην ξαναγράφετε τα sidecars, μην επανελέγχετε μόνο για να βγείτε πράσινο, μην παθάλετε το kernel
  copy;
- κρατήστε τα LOG events κάτω από 1024 bytes και στις δύο πλευρές.

Η ίδια δέσμευση machine-path μπλοκάρει δουλειά. Το pre-BUILD debt baseline καταγράφεται την πρώτη φορά που ένα ticket μπαίνει σε BUILD και επανελέγχεται σε κάθε μεταγενέστερη είσοδο. Ένα ticket που μπήκε πρώτο σε BUILD στη μηχανή του operator δεν μπορεί να μπει σε BUILD στο cloud: η μετάβαση απορρίπτεται με `DEBT_SNAPSHOT_FOREIGN_PROJECT`. Το T-84 είναι η περίπτωση που κρατάει ρεκόρ: το DEBT-000079 καταγράφηκε στο E-1377 και η μετάβαση απορρίφθηκε στο E-1446. Αφήστε τέτοια ticket στη μηχανή που κατέγραψε το baseline της.

## Απόκλιση

Αν το local και το remote σταματήσουν να μοιράζονται πρόγονο, ο watcher σταματά. Δεν κάνει merge, rebase ή force. Και τα δύο commit ids μπαίνουν στο log, η διόρθωση γίνεται `git log --left-right --cherry-pick <branch>...origin/<branch>` με το χέρι, και το
αποτέλεσμα αποθηκεύεται σε checkpoint όπως οποιαδήποτε άλλη αλλαγή.

## Η ακριβής ενέργεια στο cloud

### Script ρύθμισης περιβάλλοντος (μία φορά, στις ρυθμίσεις του cloud περιβάλλοντος)

Μενού του cloud περιβάλλοντος στη γραμμή τίτλου της συνεδρίας -> Edit -> Setup script. Τρέχει πριν από κάθε νέα συνεδρία, άρα κάθε συνεδρία ξεκινά με το product toolchain έτοιμο:

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

### Το prompt για κάθε νέα συνεδρία

Ξεκινήστε τη συνεδρία στο repository `vacterro/zaicode`, branch `saipen-live`, και
βεβαιωθείτε ότι ο agent της μηχανής του operator δεν γράφει ταυτόχρονα.
Αντικαταστήστε την τελευταία γραμμή με `cc all <new list>` για να παραδώσετε νέα δουλειά.

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

Στη μηχανή του operator ο watcher κάνει fast-forward `zcode` από
`origin/zaicode`; `REBUILD.cmd` (ή `REBUILD_fast.lnk`) το χτίζει, και η
επόμενη εκκίνηση του ZAICODE βάζει στη θέση το νέο build.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
