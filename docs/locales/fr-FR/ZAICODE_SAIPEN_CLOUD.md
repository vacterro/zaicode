# Transport cloud ZAICODE SAIPEN

Comment ce checkout et une session Claude Code Cloud exécutent un même espace de travail SAIPEN
avec une localité d'exécuteur différente, et où se situe la frontière entre les deux.


## La forme

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Une seule branche porte l'état du protocole. Pas d'étape de merge, pas de rebase
et pas de seconde branche locale à garder synchronisée : l'exécuteur qui dispose d'un
point de contrôle vérifié le commit et le pousse, et l'autre côté le récupère en
fast-forward.

`master` est l'historique pré-transport et la branche publiée par défaut. Elle
n'est jamais forcée à la mise à jour par le transport.

## Ce qui voyage et ce qui ne voyage pas

Un point de contrôle de ce dépôt porte l'état du protocole SAIPEN, le lanceur
racine, l'installateur, la doc et ces scripts de transport. C'est toute la couche
espace de travail.

Il ne transporte **aucun octet produit**. `zcode/` est un dépôt Git distinct, listé
dans `.saipen/source-nested-repos.json` et ignoré par Git à cette racine
(`/zcode/`). Le travail produit nécessite son propre clone de `vacterro/zaicode` sur la branche
`zaicode`, et ce clone est un second objet, indépendant, avec son propre historique.

La conséquence est facile à rater : un `git status` propre à cette racine ne dit
rien du travail produit non commité, et un fast-forward de `saipen-live` ne dit
rien du code produit. Vérifiez `git -C zcode status` explicitement.

## Moitié locale

Deux scripts, tous deux appartenant au dépôt, pour qu'une nouvelle machine les obtienne
depuis le dépôt plutôt que de mémoire :

| Fichier | Rôle |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | valide, réconcilie la branche, installe et démarre le watcher, écrit l'entrée d'autostart, prouve local == distant |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | la boucle : fetch, comparaison, fast-forward ou push, journal, pause ; puis la passe produit et l'auto-mise à jour |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | aller-retour depuis un exécuteur indépendant plus preuve de récupération à froid |
| `tools/saipen-cloud/Test-ProductSync.ps1` | passe produit et auto-mise à jour sur des dépôts Git jetables (pas de réseau, pas de vrai distant) |

Installation et réparation :

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Il est idempotent. L'état local de la machine réside dans `%APPDATA%\SAIPEN` :
`ZaicodeSaipenLiveWatcher.ps1` (une copie), `ZAICODE_cloud-sync.log` (pivoté à
2 MB vers `.log.1`), `ZAICODE_cloud-sync.lock` (instance unique),
`ZAICODE_cloud-sync.pid`, et une entrée dans le dossier Démarrage
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

L'installateur refuse un arbre sale et ne le nettoie jamais. Si chaque chemin sale est
un état SAIPEN canonique sous `.saipen/`, il le dit et affiche les commandes
de checkpoint exactes ; c'est un état du protocole sans checkpoint, pas une faute
de transport, et l'installateur ne le committera pas dans le dos du protocole.

## Comportement du watcher

| Situation | Action |
|-----------|------|
| propre, le local est un ancêtre du distant | `git merge --ff-only` |
| propre, le distant est un ancêtre du local | `git push` |
| sale | pause ; pas même un fetch |
| sur une autre branche | pause |
| les deux ont avancé, aucun ancêtre commun | pause, journalise les deux ids de commit, ne fusionne rien |
| échec du fetch ou du réseau | journalise en mode dégradé, réessaie au prochain tick |
| une fusion/rebase/cherry-pick est en cours | pause |

Jamais : force push, hard reset, stash, clean, checkout d'une branche étrangère,
commit, ni arrêt par nom de processus. L'installateur n'arrête un watcher que par le
pid qu'il a enregistré dans son propre fichier pid.

Un arbre sale ne coûte rien, car le watcher vérifie la saleté avant de fetch.
Un checkout inactif ne fait donc aucun appel réseau.

### Passe produit (T-90)

`zcode/` est son propre dépôt, donc le tableau ci-dessus ne déplace jamais le code
produit. Ensuite, le même tick gère le checkout produit (`-ProductRepo`,
par défaut `<repo>\zcode` ; branche `-ProductBranch`, par défaut `zaicode`). La
passe produit s'exécute que l'arbre extérieur soit sale ou non. Elle ne fait que pull.

| Situation | Action |
|-----------|------|
| distant en avance, aucun fichier entrant n'est modifié ici | `git merge --ff-only` ; le travail produit non commité reste tel quel |
| distant en avance, un fichier entrant est modifié ici | HELD : consigner les fichiers, ne rien fusionner |
| local en avance | consigner ; **jamais poussé** (le produit est publié par SAIPEN SHIP) |
| divergé | pause, consigner les deux id, ne rien fusionner |
| autre branche, opération git en cours, fetch échoué | pause |
| aucun checkout de `zcode/`, ou `-NoProduct` | ignoré |

git refuse de lui-même un fast-forward qui écraserait une modification locale, donc
le contrôle HELD est une garde antérieure et plus claire, pas la seule. Un
fast-forward produit ne reconstruit rien : pour tester, lancer `pnpm bundle:zaicode` (ou
l'aperçu dev).

### Auto-mise à jour (T-90)

Le watcher s'exécute comme copie sous `%APPDATA%\SAIPEN`, donc un watcher plus récent
dans le dépôt n'a jamais tourné sans réinstallation. En mode loop, il compare
désormais son propre fichier avec la copie committée du dépôt à chaque passe. Il
installe cette copie par-dessus lui-même et redémarre exactement une fois, avec
les mêmes arguments, seulement si tout ce qui suit est vrai :

- les deux fichiers diffèrent ;
- la copie du dépôt n'a aucune modification non commitée ;
- la copie du dépôt se parse sans erreur.

Une copie qui ne se parse pas est refusée et consignée, et le watcher en cours
poursuit son travail.

Les watchers installés avant T-90 n'ont ni la passe produit ni l'auto-mise à jour.
Relancer `Install-SaipenLiveSync.ps1` une fois sur une telle machine ; ensuite, le watcher se met à
jour tout seul.

## Moitié cloud

`CLAUDE.md` à la racine est la règle d'entrée et
`.claude/skills/saipen/SKILL.md` est la procédure d'exécution. La skill récupère
le noyau SAIPEN depuis `github.com/vacterro/saipen` et l'exécute via la
surface moteur déclarée `tools/saipen.py`. Le noyau est épinglé par commit
(`3088eff`), jamais par tag. Le tag `v8.0.1` est un noyau plus ancien avec le même
`VERSION` ; son `validate` mute l'état, et son validateur rejette ce board.

`STATE.saipen_home` consigne le chemin du noyau du dernier exécuteur ayant
fait un checkpoint. Dans le cloud, le premier `saipen continue` sur le noyau `3088eff` le
converge vers le noyau en cours d'exécution en un seul `DEC` journalisé (E-1410). Sur la machine
de l'opérateur, le pointeur arrive mort de la même façon. Un noyau avec
convergence automatique le répare via `continue` ; sinon lancer
`saipen rebind-home --auto`.

**Le retour est observé.** E-1562 (cloud) a convergé le pointeur vers
`/home/user/zaicode/.claude/saipen-protocol` ; E-1571 (machine opérateur)
l'a reconvergé directement vers `V:/.../_SAIPEN`, automatiquement, sans
`rebind-home` manuelle. Les deux sens relèvent de la même convergence
automatique : attendez un `saipen_home` `DEC` par bascule de localité et
traitez cela comme un bruit attendu, pas comme un défaut. Cela reste du bruit
tant que P1-2
(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) ne déplace pas le pointeur hors de l'état versionné ;
n'implémentez pas P1-2 sous prétexte de l'avoir remarqué. Ne modifiez jamais
le pointeur à la main.

`STATE.saipen_home` peut pointer vers un **checkout de développement** kernel
en avance sur le pin, et non vers un clone `3088eff` propre — sur la machine
opérateur, c'est la branche `accepted-debt-rebind` avec du travail non commité. Un kernel
qui n'est pas au commit épinglé n'est pas automatiquement faux, mais ce n'est
pas non plus une source en salle blanche : la règle ci-dessous sur le contrat de
voix s'applique donc avec toute sa force. Ne commitez, ne stash, ne
reset, ne checkout et ne clean jamais quoi que ce soit dans un tel checkout ;
seule une restauration ciblée d'un seul fichier `saipen/STYLE.md` est autorisée, et
uniquement si l'opérateur l'a demandée.

### STYLE.md n'est pas un paramètre local

`saipen/STYLE.md` doit être **rigoureusement identique au fichier du kernel épinglé**
sur chaque machine, dans chaque copie, sans exception ni modification locale. Il
existe plusieurs copies sur une machine opérateur :

- le checkout kernel dans `STATE.saipen_home` (un clone Git, sur la machine
  opérateur un checkout de développement) ;
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, alimenté par la
  tâche planifiée `saipen-inject` (`bootstrap/schedule-run.ps1`). Ce n'est **pas un
  dépôt Git**, donc `git checkout` ne peut jamais le réparer — seul un
  re-sync via l'injecteur, ou une écriture directe du contenu publié,
  fonctionne.

Le jeton `style_contract` dans `.saipen/STATE.md` est un hash du texte de ce fichier
(`tools/validate.py`, `style_contract_token` : CRLF normalisés, ligne
`style_contract:` exclue). Modifiez `reply_language` dans une copie et le
jeton bouge ; l'autre copie et le cloud, qui récupèrent le kernel publié, conservent le
jeton publié, et chaque écriture CLI du côté divergent est refusée avec
`style_contract ... does not match the installed STYLE.md marker`.
C'est toute la panne : le côté local écrit un état que le cloud ne peut pas écrire.

**Changer la langue de réponse est un commit kernel plus un ré-épinglage**,
jamais une modification locale. Changez-la dans le dépôt kernel, publiez-la,
réépinglez le commit dans SKILL.md et mettez à jour `STATE.style_contract` via `saipen recover`. Une
modification locale de `STYLE.md` désynchronise toutes les machines autres que
celle qui la fait.

Un piège à nommer : le `bin/saipen` publié est un shim lié à une machine, qui
fige en dur les chemins absolus d'interpréteur et de checkout d'un seul
opérateur. Il ne fonctionne que sur une seule machine. Le cloud doit utiliser
`python3 tools/saipen.py`.

Raccourcis : `cc` poursuit le Work en cours ; `cc all <text>` ingère tout le
message comme source/appends et poursuit tous les Work éligibles. Aucun ne
demande de confirmation de routine.

## Classification des capacités

**AVAILABLE_IN_CLOUD** — état du protocole et couche espace de travail. Lecture et
écriture de `.saipen/`, le lanceur (`tools/launcher/ZaicodeLauncher.cs`), l'
installateur sous `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` et les
scripts de transport. Lecture Git, commit, push et fetch sur `saipen-live`. Tout
gate qui est une assertion fichier, une revue de diff ou un contrôle texte.

**LOCAL_WINDOWS_ONLY** — les gates qui exigent cette machine.

| Gate | Pourquoi |
|------|-----|
| `tools\launcher\build.cmd` | compile `ZaicodeLauncher.cs` avec .NET Framework `csc` ; pas de Windows SDK sur une image cloud |
| E2E Electron packagé (`zcode` desktop, Solo → file → dispatch) | exige une session bureau et un profil fournisseur préchargé |
| le 9router actif | un service Windows sur cette machine |
| parcours de clics bureau interactif | un humain et un écran |
| les cas runtime propres au watcher | le watcher ne tourne que sur la machine qui détient le checkout |

Ces points sont enregistrés comme limites d'acceptation locales uniquement. Ils ne sont
jamais rapportés comme réussis parce que le diff avait l'air correct.

**SAFE_TO_DEFER** — la couche produit. Une session cloud peut cloner la branche `zaicode` de `vacterro/zaicode` et y travailler. Le travail en couche espace de travail ne requiert pas de travail produit, mais requiert bien le clone : `.saipen/source-nested-repos.json` déclare `zcode/`, et sans lui le valideur échoue avec `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. Les gates `pnpm` exigent pnpm 10.33.2 épinglé et un espace de travail préparé. `pnpm bootstrap` sur une image cloud vierge est la méthode d'accès documentée, et le `package.json` du produit le déclare déjà.

Le cloud ne peut vérifier que les octets produit présents sur `origin/zaicode`. Un
delta produit existant uniquement dans le checkout `zcode/` de l'opérateur est
invisible ici ; tout gate produit correspondant est donc NOT RUN dans le cloud, quel que
soit le gate. T-84 est le premier cas (E-1411) : son correctif était local uniquement
tandis que `origin/zaicode` portait encore le code d'avant correction.

**UNSAFE_TO_EMULATE** — tout ce qui ferait passer pour vert un gate local uniquement.
Ne pas stubber la compilation du lanceur, simuler une run d'application packagée, rejouer un
résultat `pnpm verify:pre-push` enregistré comme s'il venait de s'exécuter, ni convertir « le code
a l'air correct » en ligne PASS dans `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — conformité qui dépend de l'emplacement du checkout.
Sur le noyau `3088eff`, le validateur cloud signale des
`closure-evidence` FAIL (T-47, T-62, T-76, T-78 à l'écriture) que la machine
de l'opérateur ne signale pas.

Le noyau déplace tout événement LOG de plus de 1024 octets dans un
sidecar `.saipen/recovery/log-detail/`. À la lecture, il ne restaure le sidecar que
lorsque le chemin absolu du checkout égale le chemin d'écriture d'origine. Un verdict
VERIFY long écrit sous Windows est donc illisible dans le cloud, et l'inverse
vaut aussi.

Le défaut est dans le noyau et est enregistré sous P1-1 dans
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Tant qu'il n'est pasmerged :

- citez le verdict du cloud et class it comme cette frontière, ticket par ticket
  (`SKILL.md` § 6 contient le contrôle) ;
- ne réécrivez jamais les sidecars, ne revérifiez que pour passer au vert, ne corrigez pas
  la copie du kernel ;
- gardez les événements LOG sous 1024 octets des deux côtés.

La même liaison au chemin de la machine bloque aussi le travail. Le référentiel de dette
d'avant-BUILD est capturé la première fois qu'un ticket entre en BUILD et revérifié à
chaque entrée ultérieure. Un ticket entré pour la première fois en BUILD sur la machine
opérateur ne peut donc pas entrer en BUILD dans le cloud : la transition est refusée avec
`DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 est le cas consigné : DEBT-000079 a été capturé à E-1377 et la
transition refusée à E-1446. Laissez un tel ticket à la machine qui a capturé son référentiel.

## Écart

Si le local et le distant cessent de partager un ancêtre, le watcher s'arrête. Il ne
fusionne pas, ne rebase pas, ne force pas. Les deux ids de commit vont dans le log, la
correction est `git log --left-right --cherry-pick <branch>...origin/<branch>` à la main, et le
résultat est archivé comme tout autre changement.

## L'action exacte côté cloud

### Script de configuration d'environnement (une fois, dans les paramètres de l'environnement cloud)

Menu de l'environnement cloud dans la barre de titre de la session -> Edit -> Setup script. Il
exécute avant chaque nouvelle session, donc chaque session démarre avec la chaîne
d'outils du produit prête :

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

### Le prompt pour chaque nouvelle session

Démarrez la session sur le dépôt `vacterro/zaicode`, branche `saipen-live`, et
assurez-vous que l'agent de la machine opérateur n'écrit pas en même temps.
Remplacez la dernière ligne par `cc all <new list>` pour passer le nouveau travail.

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

Sur la machine opérateur, le watcher fast-forward `zcode` depuis
`origin/zaicode` ; `REBUILD.cmd` (ou `REBUILD_fast.lnk`) le compile, et le
prochain démarrage de ZAICODE installe la nouvelle build.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
