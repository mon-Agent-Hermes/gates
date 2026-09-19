# gates — spécification

Outil de garde-fous déterministes : il lit le `gates.json` d'un projet, exécute les
vérifications déclarées, et rend un verdict qu'un agent ne peut pas contourner.

## Périmètre

**Dans** : lecture de `gates.json`, exécution des commandes déclarées, atteignabilité
(statique et par exécution), probes d'observation de l'artefact, verdict par critère,
sortie texte et JSON, codes de sortie.

**Hors** : correction du code fautif, jugement de qualité, tout appel réseau pendant la
vérification (un juge joignable par le réseau n'est pas un juge).

## Critères d'acceptation

- **AC-1** — sur un projet sain, `gates check` rend un verdict vert et sort en 0.
- **AC-2** — sur un projet dont un livrable n'est atteignable depuis aucun point d'entrée, `gates check` sort en 1 et **nomme le fichier** en cause.
- **AC-3** — dans un dossier sans `gates.json`, `gates check` sort en 2 (configuration invalide), et non en 1 : l'agent doit corriger la configuration, pas le code.
- **AC-4** — sur un `gates.json` déclarant une clé qu'aucun check ne lit (dans une probe, dans `request`, dans `expect`), `gates check` sort en 2 et **nomme la clé** : une attente que le juge ne comprend pas ne doit jamais se lire comme une attente vérifiée.
- **AC-5** — sous GitHub Actions (`GITHUB_ACTIONS=true`), `gates check` suspend les commandes de workflow avant de lancer quoi que ce soit du projet, les rétablit avec le même jeton, puis émet une annotation `gates etat` qui porte l'état de chaque critère et de chaque check : la sortie du projet jugé ne peut pas se faire passer pour un verdict.
