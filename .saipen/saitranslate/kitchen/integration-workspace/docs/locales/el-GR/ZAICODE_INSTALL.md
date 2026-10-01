# Εγκατάσταση του ZAICODE

Το ZAICODE είναι τρία έργα που λειτουργούν ως ένα: η εφαρμογή ZAICODE, το SAIPEN (το πρωτόκολλο που κρατά τη δουλειά των agents σε τροχιά) και το SAIMAIL (το mail που χρησιμοποιούν οι agents για να ενημερώνουν ο ένας τον άλλον). Η χειροκίνητη εγκατάστασή τους σημαίνει τρία clones, ένα toolchain Node.js, ένα περιβάλλον Python και ένα build. Ο installer τα κάνει όλα:
τρέξτε τον, περιμένετε, και η συντόμευση ZAICODE βρίσκεται στην επιφάνεια εργασίας.

## Με ένα κλικ

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  κατεβάστε, κάντε διπλό κλικ, πατήστε **INSTALL**. Το παράθυρο (χρυσό σε σκούρο, το banner του SAIPEN) δείχνει κάθε βήμα καθώς εκτελείται, τον χρόνο που πέρασε και το log κατά παραγγελία· στο τέλος **START ZAICODE**, ή **TRY AGAIN** / **Autotroubleshoot**
  / **Open log** όταν κάποιο βήμα δεν ολοκληρώθηκε. Όταν δείχνει σε υπάρχον φάκελο ZAICODE, το κουμπί γράφει **UPDATE**: η ίδια εκτέλεση ενημερώνει και επισκευάζει. Το
  exe περιέχει τα scripts εγκατάστασης και δεν χρειάζεται τίποτα δίπλα του· κατασκευάζεται από
  `install\setup\build.cmd` (ο compiler .NET Framework που έχει κάθε Windows 10/11).
- `install\Setup-ZAICODE.cmd` (διπλό κλικ): η ίδια εγκατάσταση σε κονσόλα.
- Από την αρχή, σε PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Επιλογές εγκατάστασης: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (preset φάκελος),
`/auto` (ξεκινά αμέσως), `/quiet` (χωρίς παράθυρο: εγκαταστάτης σε κονσόλα, κωδικός εξόδου
= αποτέλεσμα). Η πρώτη εκτέλεση χτίζει την εφαρμογή σε αυτό το μηχάνημα, κάτι που παίρνει χρόνο;
οι επόμενες εκτελέσεις κάνουν μόνο ενημέρωση και επισκευή.

## Δωρεάν μοντέλα, τίποτα για ρύθμιση

Η εφαρμογή έχει δικό της 9router. Σε μηχάνημα χωρίς, το ZAICODE το τρέχει
ιδιωτικά (isolated mode, θύρα 20138), γεμίζει το **SAIFREN** από δωρεάν
επίπεδα χωρίς κλειδί και κάνει το `SAIRoute / SAIFREN` το μοντέλο των νέων εργασιών, ώστε η πρώτη εργασία
που πληκτρολογείς στη Νέα εργασία να παίρνει απάντηση: χωρίς κλειδί, χωρίς λογαριασμό, χωρίς ρύθμιση. Οι
συνδέσεις Claude Code, Codex και Antigravity είναι προαιρετικές· μια σύνδεση που δεν έχει
ρυθμιστεί στο μηχάνημα εμφανίζεται ως «προαιρετική, σύνδεση οποτεδήποτε», όχι ως στοιχείο
«χρειάζεται εσένα». Απόδειξη: το `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
ξεκινά τη συσκευασμένη εφαρμογή σε κενό προφίλ (δικά της HOME, APPDATA,
LOCALAPPDATA) και περνά μόνο αν ο router είναι απομονωμένος, το SAIFREN απαντά στο
έλεγχο first-token και μια εργασία στη Νέα εργασία παίρνει απάντηση.

## Ενημερώσεις: τέσσερα μέρη, ένα ZAICODE

Ο χώρος εργασίας (launcher, εγκαταστάτης), η εφαρμογή, το SAIPEN και το SAIMAIL είναι τέσσερα
clones. Το καθένα ενημερώνεται μόνο του: **Settings -> ZAICODE -> Updates** τα
παραθέτει με έκδοση και commit, ενημερώνει ένα-ένα ή όλα, και έχει διακόπτη «μόνο του»
ανά μέρος (ενεργός από προεπιλογή σε εγκατεστημένο ZAICODE, ανενεργός σε developer
checkout). Το ZAICODE κοιτάζει λίγα λεπτά μετά την έναρξη και έπειτα κάθε έξι ώρες. Μετά από
ενημέρωση κάθε μέρος παίρνει όσο χρειάζεται: η εφαρμογή τις εξαρτήσεις της (όταν άλλαξε το
`pnpm-lock.yaml`) και νέο build (σταδιακά ενώ τρέχει το ZAICODE, ξεκινά στην επόμενη εκκίνηση), το
SAIPEN το launcher του, το SAIMAIL την εγκατάστασή του στο `.venv`, ο χώρος εργασίας
νέο root launcher. Clone σε άλλο branch, με τοπικά commits ή με αλλαγές που θα
αναγραφόταν από την ενημέρωση αναφέρεται και μένει ακριβώς όπως είναι.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Τι κάνει

Ο εγκαταστάτης είναι τα checks του Autotroubleshoot που τρέχουν με «repair» σε κενή
φάκελο, με αυτή τη σειρά. Κάθε βήμα είναι idempotent, οπότε ο επαναδιατυπωσμός ενημερώνει
την εγκατάσταση και διορθώνει όσο έχει σπάσει.

| Έλεγχος | Επισκευή |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | χρησιμοποιεί το αντίγραφο του μηχανήματος αν ταιριάζει· αλλιώς ιδιωτικό αντίγραφο στο `.tools\` (MinGit από Git for Windows, Node.js 24.14.0 από nodejs.org, Python από το NuGet πακέτο του). Χωρίς δικαιώματα διαχειριστή. |
| pnpm | το καρφιτσωμένο pnpm 10.33.2 στο `.tools\pnpm10` |
| Χώρος εργασίας ZAICODE | clone του `vacterro/zaicode` branch `master` (πηγαίο launcher, εγκαταστάτης, τεκμηρίωση· η μνήμη `.saipen/` του developer αφήνεται εκτός· branch `workspace` έως 2026-09-27) |
| Πηγαίο εφαρμογής ZAICODE | clone του branch `zaicode` στο `zcode\` |
| SAIPEN | clone του `vacterro/saipen` στο `saipen\`· το `bin\saipen.cmd` του γράφτηκε γι' αυτό το clone και αυτή την Python |
| SAIMAIL | clone του `vacterro/saimail` στο `saimail\`, εγκατεστημένο στο `.venv\` |
| saimail-local | ο πελάτης γραμμής εντολών του SAIMAIL, που χρησιμοποιούν τα πάνελ SAIMAIL του ZAICODE (περιλαμβάνεται από SAIMAIL `0.0.2a3`· ο έλεγχος `saimail-cli` δίνει OK) |
| Πακέτο 9router | `9router` από npm στο `.tools\router`, bundled ώστε το SAIFREN να δουλεύει χωρίς ρύθμιση (WARN αν το npm δεν το προσεγγίσει) |
| Εξαρτήσεις εφαρμογής | `pnpm install --frozen-lockfile` (ξανά όταν αλλάξει το `pnpm-lock.yaml`) |
| Build εφαρμογής | `pnpm bundle:zaicode`· ενώ τρέχει το ZAICODE το νέο build προετοιμάζεται και μπαίνει στην επόμενη εκκίνηση |
| Εναλλαγή staged build | καθαρίζει `win-unpacked.previous` που άφησε αποτυχία εναλλαγής μεγάλης διαδρομής και βάζει build που περιμένει όσο το ZAICODE είναι κλειστό |
| Root launcher | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Συντομεύσεις | Desktop και Start menu `ZAICODE` -> `ZAICODE.exe` |
| Συνδέσεις Claude / Codex | απλώς αναφέρονται: κάθε σύνδεση `~\.claude*` / `~\.codex*` είναι δικό της engine στο ZAICODE (A1, A2, C1, ...)· μια σύνδεση χρειάζεται εσένα, στον browser |

Το root launcher δείχνει στο ZAICODE το εγκατεστημένο SAIPEN (`saipen\`) και βάζει
`.tools\` και `.venv\Scripts` πρώτα στο PATH της εφαρμογής, ώστε η εφαρμογή, τα agents
και οι workers της να χρησιμοποιούν τα εγκατεστημένα αντίγραφα.

## Πολλαπλές συνδρομές

Κάθε σύνδεση Claude Code ή Codex ζει στο δικό της home: `~\.claude`,
`~\.claude-account2`, ... και `~\.codex`, `~\.codex-account2`, ... Το ZAICODE τις
βρίσκει όλες. Για να προετοιμάσετε άλλες κατά την εγκατάσταση:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

Ο εγκαταστάτης δημιουργεί τα homes και τυπώνει την ακριβή εντολή σύνδεσης για
καθένα (`$env:CODEX_HOME = '...'; codex login`). Το ίδιο και μέσα στο ZAICODE: Ρυθμίσεις ->
Μηχανές & όρια -> προσθέστε άλλη σύνδεση.

## Αυτοδιάγνωση

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Κατάσταση ανά έλεγχο: OK, FIXED (ήταν χαλασμένο, διορθώθηκε), WARN (λειτουργεί, αλλά λείπει κάτι
προαιρετικό), INFO (χρειάζεται εσάς: μια σύνδεση), FAIL. Τα logs είναι στο
`install\logs\`; η σύνοψη της τελευταίας εγκατάστασης: `install\install-report.json`.
Στην εφαρμογή, Router -> Autotroubleshoot διορθώνει τον ενεργό router και τα pools.

## Παράμετροι

| Παράμετρος | Προεπιλογή | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | πού πηγαίνει όλα |
| `-ShortcutDir` | Desktop | πού μπαίνει η συντόμευση ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | παράλειψη αυτών των συντομεύσεων |
| `-PortableTools` | | ιδιωτικά Git / Node.js / Python, ακόμη κι αν υπάρχουν ήδη στο μηχάνημα |
| `-Launch` | | εκκίνηση ZAICODE στο τέλος |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | τα repos GitHub | άλλη πηγή (ένα fork, διαδρομή τοπικού clone) |

## Απόδειξη

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
ελέγχει μια φρέσκια εγκατάσταση, σπέρνει βλάβες (συντόμευση και launcher διεγραμμένα, ο launcher
του SAIPEN να δείχνει σε Python που λείπει, venv του SAIMAIL διεγραμμένο, node_modules
καταχωρισμένα για άλλο lockfile, υπολειπόμενος φάκελος build βαθύτερα από το MAX_PATH),
επιβεβαιώνει ότι το doctor αναφέρει και επιδιορθώνει καθεμία, και μετά ξεκινά τον στόχο της
συντόμευσης με απομονωμένο profile και σταματά ακριβώς το δέντρο διεργασιών που ξεκίνησε.

`install\tests\Test-ZaicodeUpdate.ps1` δημιουργεί τέσσερα προσωρινά repositories στον
δίσκο και μια εγκατάσταση των clones τους, και μετά αποδεικνύει ότι ένας έλεγχος δεν αλλάζει τίποτα,
ότι ένα μέρος ενημερώνεται μόνο του μαζί με το follow-up του (launcher SAIPEN, root
launcher), ότι επικαλυπτόμενες τοπικές αλλαγές και τοπικά commits διατηρούνται, και ότι
άγνωστο όνομα μέρους απορρίπτεται. Χωρίς δίκτυο.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
