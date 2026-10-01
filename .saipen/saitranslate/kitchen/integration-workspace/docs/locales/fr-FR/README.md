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

ZAICODE est un poste de travail opérateur pour exécuter plusieurs agents de code IA à la fois sur
de nombreux projets, sans avoir à les surveiller. C'est une version modifiée de
[ZCode](https://github.com/zai-org/ZCode) (application de bureau, interface navigateur et agent
CLI) avec une couche produit au-dessus : chaque projet est piloté par le
protocole [SAIPEN](https://github.com/vacterro/saipen), le travail est lancé, repris
et planifié depuis une seule fenêtre, et les CLI d'abonnement que vous payez
déjà (Claude Code, Codex, Antigravity) tournent comme travailleurs ancrés à côté des
agents intégrés.

**0.0.1** est le premier instantané étiqueté : une version personnelle, pensée d'abord pour Windows, utilisée
quotidiennement.

## Installer en un clic

1. Téléchargez **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Faites un double-clic et appuyez sur **INSTALL**.

C'est tout. L'installateur fournit ce qui manque à la machine (Git, Node.js, Python, en copies privées :
pas de droits administrateur), récupère ZAICODE, SAIPEN et SAIMAIL depuis GitHub,
compile l'application sur la machine et place un raccourci ZAICODE sur le bureau. La première
exécution prend 15 à 30 minutes ; la fenêtre affiche chaque étape.

Les modèles gratuits fonctionnent immédiatement : ZAICODE démarre son propre routeur et remplit le pool **SAIFREN**
avec des paliers gratuits sans clé, si bien qu'une tâche saisie dans New task obtient une réponse sans
clé, sans compte et sans réglage. Les abonnements Claude Code, Codex et Antigravity sont
facultatifs et l'on peut s'y connecter à tout moment.

**Un tout, quatre parties.** Le workspace (lanceur, installateur), l'application, SAIPEN et
SAIMAIL sont quatre dépôts. Chacun se met à jour de son côté : *Settings -> ZAICODE ->
Updates* affiche chaque partie et la met à jour à la main ou automatiquement (vérification quelques
minutes après le démarrage puis toutes les six heures). Une nouvelle version de l'application est préparée pendant que ZAICODE tourne
et prend effet au prochain lancement ; vos propres modifications dans un clone ne sont jamais écrasées.
Depuis un terminal : `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Autotroubleshoot : `install\Doctor.cmd`. Détails : [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Tour de l'interface

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

## Ce que ZAICODE ajoute à ZCode

- **Projets avec une session MAIN.** Chaque projet a une session MAIN (START,
  `/goal cc all`) et des sessions auxiliaires (subSaipens : WIKI, TEST, AUDIT, …). La
  vue par défaut de la barre latérale affiche la ligne du projet comme sa MAIN ; ▶
  continue la MAIN au lieu d'ouvrir une autre session. CONTINUE ALL, DONE et CLEAR
  ALL DONE balayent tous les projets ; une session coupée en plein tour affiche
  INTERRUPTED, jamais DONE.
- **Résistance aux plantages.** Les sessions coupées par la mort d'un processus et
  les objectifs encore actifs reprennent d'eux-mêmes après un redémarrage ; les
  workers en cours redémarrent. Les agents dans ZAICODE ne peuvent pas tuer ZAICODE
  par nom de processus.
- **Workers.** Les CLI d'abonnement tournent dans des terminaux ancrés à n'importe
  quel bord de la fenêtre (ou dans leurs propres fenêtres magnétiques). Les
  questions « Trust this folder? » du premier lancement sont répondues ; un worker
  qui atteint sa limite d'usage est signalé et, selon le réglage, fermé ou
  redémarré après la réinitialisation.
- **Limites et réinitialisations.** Compteurs de quota par compte et par pool, un
  minuteur dans la barre de titre pour la réinitialisation la plus proche, la liste
  complète des prochaines au survol.
- **SCHEDULER.** Des prompts qui démarrent d'eux-mêmes : à une heure, quotidiennement,
  toutes les N minutes ou quand une fenêtre de quota se recharge ; dans un projet ou
  une section entière de la barre latérale, les projets les plus en difficulté (le
  plus bloqués / tickets SAIPEN ouverts) d'abord. Les conditions peuvent arrêter en
  priorité les travaux de repli (sessions en pool gratuit, workers moins puissants),
  ne tourner que sur les projets inactifs, ou ne continuer que les sessions marquées.
  Les prompts n'ont pas de limite pratique de longueur.
- **Routage.** Un 9router fourni (MIT) offre des pools sans configuration : SAIFREN
  (paliers gratuits sans clé) et SAIOPP (vos abonnements).
- **SAIHOME, minuteurs, sons, surlignages.** Un accueil opérateur avec statistiques,
  minuteurs et alarmes façon FastPrompter, sons par action et une interface Win95
  dorée sombre, nette au pixel.

## Construire

Prérequis : Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) fait foi).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

L'application packagée démarre toujours en mode ZAICODE. Tant qu'un ZAICODE plus
ancien tourne, le bundler prépare la nouvelle version dans `packages/desktop/dist-next` ; le
lanceur racine (branche `master`, `tools/launcher`) la met en place au prochain
démarrage.
La variante bitmap nette de Verdana utilisée par l'interface ne fait pas partie de
ce dépôt ; sans elle, l'interface retombe sur la Verdana système.

Vérifications : `pnpm typecheck`, `pnpm lint`, et les tests ZAICODE, par exemple
`node --import tsx --test test/zaicode*.test.ts` depuis `packages/ui`.

## Organisation du dépôt

| Branche      | Contenu                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | l'espace de travail canonique : lanceur, installateur (`install/`), docs produit (`UI.md`, `docs/`), état SAIPEN et CHANGELOG |
| `zaicode`   | la source canonique de l'app : historique ZCode amont plus la couche produit ZAICODE utilisée pour les versions et les mises à jour |

Des refs héritées ou créées par l'automatisation peuvent encore apparaître
temporairement, mais ce ne sont pas des branches produit canoniques. Le nouveau
travail sur l'espace de travail va sur `master` ; le travail sur la source de
l'app va sur `zaicode`.

Le code d'app détenu par ZAICODE vit surtout dans `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` et
`packages/desktop/src/main/zaicode*.ts` sur la branche `zaicode`. La
documentation de l'espace de travail et l'outillage du lanceur/update vivent
sur `master`.

## Amont et licence

ZAICODE est dérivé de ZCode par Z.ai et distribué sous la même
[Licence Apache 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE) ; les mentions amont sont conservées dans
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) et [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Les fichiers ont été modifiés par l'auteur de ZAICODE. ZAICODE est un projet
indépendant, non affilié à Z.ai ni approuvé par celui-ci. Le README d'origine de
ZCode est conservé dans [README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) et
[README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Réseau du projet

Ce dépôt fait partie de l'écosystème plus large **SAIPEN / vacterro**.

[**Hub de l'auteur**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**Communauté SAIPEN**](https://discord.gg/SEYaYkuVgN)

Pour des bugs reproductibles et des demandes de fonctionnalités durables, utilisez les [GitHub Issues de ce dépôt](https://github.com/vacterro/zaicode/issues). Utilisez Discord pour les discussions rapides, les captures d'écran et les retours entre projets.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
