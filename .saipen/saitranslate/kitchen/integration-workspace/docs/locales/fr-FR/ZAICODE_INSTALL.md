# Installer ZAICODE

ZAICODE réunit trois projets qui fonctionnent comme un seul : l'application
ZAICODE, SAIPEN (le protocole qui garde le travail des agents sur les rails) et
SAIMAIL (la messagerie que les agents utilisent pour se transmettre des
informations). Les installer à la main signifie trois clones, une chaîne
d'outils Node.js, un environnement Python et une compilation. L'installeur fait
tout cela : lancez-le, attendez, et un raccourci ZAICODE apparaît sur le bureau.

## En un clic

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)** :
  téléchargez, double-cliquez, appuyez sur **INSTALL**. La fenêtre (or sur fond
  sombre, bannière SAIPEN) affiche chaque étape au fil de son exécution, le temps
  écoulé et le journal à la demande ; à la fin **START ZAICODE**, ou **TRY AGAIN**
  / **Autotroubleshoot** / **Open log** si une étape n'est pas terminée. Si vous
  pointez vers un dossier ZAICODE existant, le bouton indique **UPDATE** : la même
  exécution met à jour et répare. L'exe contient les scripts d'installation et n'a
  besoin de rien à côté de lui ; il est compilé par `install\setup\build.cmd` (le compilateur
  .NET Framework présent sur chaque Windows 10/11).
- `install\Setup-ZAICODE.cmd` (double-clic) : la même installation dans une console.
- À partir de zéro, dans PowerShell :

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Options d'installation : `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (dossier prédéfini),
`/auto` (démarre tout de suite), `/quiet` (sans fenêtre : installateur console, code de
sortie = résultat). La première exécution construit l'app sur cette machine, ce qui prend du temps ;
les suivantes ne font que mettre à jour et réparer.

## Modèles gratuits, rien à configurer

L'app embarque son propre 9router. Sur une machine sans 9router, ZAICODE l'exécute en
privé (mode isolé, port 20138), remplit **SAIFREN** avec les paliers gratuits sans clé et
met `SAIRoute / SAIFREN` comme modèle des nouvelles tâches : la première tâche saisie dans Nouvelle
tâche obtient une réponse. Ni clé, ni compte, ni réglage. Les connexions Claude
Code, Codex et Antigravity sont facultatives ; une connexion non configurée sur la
machine s'affiche comme « facultatif, connectez-vous quand vous voulez », pas comme un
élément « vous est nécessaire ».
Preuve : `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
démarre l'app empaquetée sur un profil vide (ses propres HOME, APPDATA et
LOCALAPPDATA) et ne réussit que si le routeur est isolé, si SAIFREN répond à sa sonde
de premier jeton et si une tâche de Nouvelle tâche reçoit une réponse.

## Mises à jour : quatre parties, un ZAICODE

L'espace de travail (lanceur, installateur), l'app, SAIPEN et SAIMAIL sont quatre clones.
Chacun se met à jour séparément : **Paramètres -> ZAICODE -> Mises à jour** les liste avec leur
version et leur commit, permet de les mettre à jour une par une ou toutes, et offre une
option « automatiquement » par partie (activée par défaut dans un ZAICODE installé, désactivée
dans un checkout développeur). ZAICODE vérifie quelques minutes après le démarrage, puis toutes
les six heures. Après une mise à jour, chaque partie reçoit ce qu'il lui faut : l'app ses
dépendances (quand `pnpm-lock.yaml` a changé) et un nouveau build (préparé pendant que
ZAICODE tourne, lancé au démarrage suivant), SAIPEN son lanceur, SAIMAIL son
installation `.venv`, l'espace de travail un nouveau lanceur racine. Un clone sur une autre
branche, avec des commits locaux ou des modifications que la mise à jour écraserait est
signalé et laissé exactement tel quel.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Ce qu'il fait

L'installateur est la suite de contrôles Autotroubleshoot exécutés avec « repair » sur un dossier
vide, dans cet ordre. Chaque étape est idempotente : la relancer met à jour l'installation
et répare ce qui est cassé.

| Vérification | Réparation |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | utilise la copie de la machine si elle convient ; sinon une copie privée dans `.tools\` (MinGit de Git for Windows, Node.js 24.14.0 de nodejs.org, Python depuis son paquet NuGet). Aucun droit administrateur. |
| pnpm | le pnpm 10.33.2 épinglé dans `.tools\pnpm10` |
| Espace de travail ZAICODE | clone de `vacterro/zaicode` branche `master` (source du lanceur, installateur, docs ; la `.saipen/` du développeur est exclue ; branche `workspace` jusqu'au 2026-09-27) |
| Source de l'app ZAICODE | clone de la branche `zaicode` dans `zcode\` |
| SAIPEN | clone de `vacterro/saipen` dans `saipen\` ; son `bin\saipen.cmd` est écrit pour ce clone et ce Python |
| SAIMAIL | clone de `vacterro/saimail` dans `saimail\`, installé dans `.venv\` |
| saimail-local | le client en ligne de commande de SAIMAIL, utilisé par les panneaux SAIMAIL de ZAICODE (livré depuis SAIMAIL `0.0.2a3` ; la vérification `saimail-cli` indique OK) |
| paquet 9router | `9router` depuis npm dans `.tools\router`, bundlé pour que SAIFREN fonctionne sans configuration (WARN si npm ne peut pas l'atteindre) |
| Dépendances de l'app | `pnpm install --frozen-lockfile` (à nouveau quand `pnpm-lock.yaml` change) |
| Build de l'app | `pnpm bundle:zaicode` ; pendant l'exécution de ZAICODE le nouveau build est mis en attente et échangé au prochain démarrage |
| Échange du build en attente | efface un `win-unpacked.previous` laissé par un échec d'échange dû à un chemin trop long et installe un build en attente pendant que ZAICODE est fermé |
| Lanceur racine | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Raccourcis | Bureau et menu Démarrer `ZAICODE` -> `ZAICODE.exe` |
| Connexions Claude / Codex | uniquement signalées : chaque connexion `~\.claude*` / `~\.codex*` est son propre moteur dans ZAICODE (A1, A2, C1, ...) ; une connexion vous nécessite, dans le navigateur |

Le lanceur racine pointe ZAICODE vers le SAIPEN installé (`saipen\`) et place
`.tools\` et `.venv\Scripts` en tête du PATH de l'app, pour que l'app, ses agents
et ses workers utilisent les copies installées.

## Plusieurs abonnements

Chaque login Claude Code ou Codex vit dans son propre home : `~\.claude`,
`~\.claude-account2`, ... et `~\.codex`, `~\.codex-account2`, ... ZAICODE les
trouve tous. Pour en préparer d'autres à l'installation :

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

L'installeur crée les homes et affiche la commande de login exacte pour chacun
(`$env:CODEX_HOME = '...'; codex login`). Même chose dans ZAICODE : Settings ->
Engines & limits -> ajouter un autre login.

## Dépannage automatique

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Statut par vérification : OK, FIXED (cassé, réparé), WARN (fonctionne, mais un
élément optionnel manque), INFO (à vous de jouer : un login), FAIL. Logs dans
`install\logs\` ; le résumé de la dernière installation est `install\install-report.json`.
Dans l'app, Router -> Autotroubleshoot répare le routeur en cours et les pools.

## Paramètres

| Paramètre | Défaut | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | où tout va |
| `-ShortcutDir` | Desktop | où va le raccourci ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | ignorer ces raccourcis |
| `-PortableTools` | | Git / Node.js / Python privés même si la machine les a |
| `-Launch` | | lancer ZAICODE une fois terminé |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | les repos GitHub | une autre source (un fork, un clone local) |

## Preuve

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
contrôle une installation neuve, injecte des pannes (raccourci et lanceur supprimés, lanceur SAIPEN
pointant vers un Python manquant, venv de SAIMAIL supprimé, node_modules
enregistré pour un autre lockfile, un dossier de build résiduel plus profond que MAX_PATH),
vérifie que le doctor signale et répare chacune, puis démarre la cible du raccourci
avec un profil isolé et arrête exactement l'arbre de processus qu'il a lancé.

`install\tests\Test-ZaicodeUpdate.ps1` construit quatre repos jetables sur
disque et une installation de leurs clones, puis prouve qu'une vérification ne change rien, qu'une partie
se met à jour seule avec sa suite (lanceur SAIPEN, lanceur racine), que les modifications
locales et commits locaux chevauchants sont conservés, et qu'un nom de partie
inconnu est refusé. Aucun réseau.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
