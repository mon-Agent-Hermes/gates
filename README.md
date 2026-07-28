# gates

Garde-fous **déterministes** autonomes : le juge que l'agent ne peut pas truquer.

Le pass/fail ne vient pas d'un LLM mais de l'exécution réelle d'outils dans le vrai
projet. Extrait de `hermes-ts` (cf. `SETUP-hermes-agent.md`, §2) : c'est la seule pièce
de ce travail à valeur prouvée — sur le run du jeu voxel (2026-07-26), ces gates ont vu
ce qu'aucun juge LLM n'a vu (29 fichiers sur 30 injoignables, écran noir, route 404).

## Utilisation

```bash
gates check              # dans un projet portant un gates.json ; lit ./gates.json
gates check --json       # sortie machine (pour la skill /verify d'Hermes)
gates check --only assembly,smoke
```

- **exit 0** = tout vert · **exit 1** = au moins un check rouge · **exit 2** = config invalide.

Premier jet : exécution via `tsx` (pas de build). Localement, sans installation globale :

```bash
node bin/gates.mjs check          # depuis le dossier du projet à vérifier
# ou, dans ce repo : npm run gates -- check
```

## `gates.json` — le contrat que chaque projet déclare

Les commandes sont **déclarées, jamais devinées** de la prose (défaut n°5 du doc : un jeu
navigateur classé « API HTTP » parce que la spec contenait le mot *server*).

```json
{
  "install": "pnpm install",
  "commands": {
    "typecheck": "pnpm exec tsc --noEmit",
    "tests": "pnpm test",
    "build": "pnpm run build"
  },
  "requiredCommands": ["tests"],
  "roots": ["src"],
  "deliverables": ["src/main.ts", "src/ui/styles.css"],
  "app": {
    "start": "pnpm run dev",
    "url": "http://localhost:5173/",
    "readyTimeoutMs": 45000,
    "paths": ["/tasks"],
    "page": { "requireCanvas": true, "minDrawCalls": 1, "waitMs": 6000 }
  }
}
```

| Clé | Check | Rôle |
|-----|-------|------|
| `install` | — | deps installées avant les gates (best-effort ; pytest/uvicorn ne s'auto-installent pas) |
| `commands` | `typecheck`/`tests`/… | commandes déclarées lancées dans le vrai projet |
| `requiredCommands` | — | un gate requis dont l'outil est **absent** = échec, pas « skipped » |
| `deliverables` | `deliverables` | fichiers qui doivent exister (ferme le « coder-fantôme ») |
| `roots` | `assembly` | dossiers de livrables à contrôler (défaut `src`) |
| `app.start`+`url` | `smoke` | l'app démarre et répond ; `paths` = routes qui ne doivent pas répondre 404 |
| `app.page` | `smoke` | rendu réel dans Chrome headless (canvas, appels de dessin, erreurs console) |
| `probes` | `probes` | scénarios d'observation de l'artefact (kinds `cli`, `artifact`) — `$TMP` neuf par probe |
| `specFile` | `spec-coverage` | fichier des `AC-n` (défaut `spec.md`) : chaque critère doit avoir une probe |

Le check `assembly` suit le graphe réel depuis le point d'entrée (`index.html`, sinon
`src/main.*`) et échoue sur tout livrable jamais atteint — assets CSS compris.

## Chrome (gate de rendu)

Réutilise le navigateur de la machine (puppeteer-core, rien de téléchargé). Priorité à
`HERMES_CHROME` / `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH`, puis emplacements usuels.
Absent → gate `skipped` (jamais un faux rouge). En CI, on installe Chrome et on exporte
`HERMES_CHROME`.

## Développement

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (38 tests, dont un vrai navigateur si Chrome présent)
```

## Probes (§2.5)

```json
"probes": [
  { "id": "init-cree-la-config", "criterion": "AC-3", "kind": "cli",
    "run": "node bin/cli.mjs init $TMP",
    "expect": { "exitCode": 0, "stdout": "/Configuration écrite/", "files": ["$TMP/config.json"] } },
  { "id": "genere-le-rapport", "criterion": "AC-4", "kind": "artifact",
    "run": "node bin/cli.mjs export $TMP/out.pdf", "file": "$TMP/out.pdf",
    "expect": { "minBytes": 1000 } }
]
```

`$TMP` est un dossier neuf par probe, effacé ensuite. Une probe échouée nomme **la
probe** (`init-cree-la-config : fichier attendu absent`), pas le check. `stdout`/`stderr`
acceptent une regex slashée (`"/…/"`) ou une sous-chaîne littérale.

### Probes serveur — `http`, `browser`, `process`

Les probes `http` et `browser` sondent l'**app démarrée par le harnais** (déclarée dans
`app`, démarrée une fois puis arrêtée). `process` lance son propre démon et vérifie qu'il
tient debout (réponse HTTP sur `url`, ou ligne de log `logMatch`).

```json
"probes": [
  { "id": "liste", "criterion": "AC-7", "kind": "http",
    "request": { "method": "GET", "path": "/tasks" },
    "expect": { "statusNot": [404, 500], "bodyMatch": "[" } },

  { "id": "selection-puis-arene", "criterion": "AC-1", "kind": "browser",
    "path": "/", "actions": [{ "click": "#choix-guerrier" }, { "wait": 300 }],
    "expect": { "requireCanvas": true, "minDrawCalls": 1, "requireSelectors": ["#hud"] } },

  { "id": "worker-demarre", "criterion": "AC-5", "kind": "process",
    "start": "node worker.mjs", "logMatch": "/ready/i", "readyTimeoutMs": 8000 }
]
```

Le check `smoke` et les probes `http`/`browser` partagent **une seule** instance : quand
`app` et des probes serveur coexistent, l'app est démarrée **une fois** puis arrêtée (pas
un démarrage par check).

## En cours — `coverage` (§2.6)

Atteignabilité **par exécution** : lancer les probes sous couverture et échouer sur tout
livrable jamais exécuté (« mort ou vivant », seuil ≥ 1 ligne, pas un pourcentage).
Strictement plus fort que l'assemblage statique — un module importé mais dont le code
n'est jamais atteint passe l'assemblage et échoue ici.

**État : amorcé, PAS encore câblé ni validé.**
- ✅ écrit : `src/coverage.ts` (lecture des rapports `NODE_V8_COVERAGE`, glob
  `requireExecuted`/`allowUnexecuted`, verdict) + instrumentation des probes `cli`/`artifact`
  (variable `covDir` transmise à leur process Node).
- ⬜ reste : câbler dans `gates check` (créer le dossier de couverture, le passer aux
  probes, agréger le verdict), **écrire les tests**, valider en bout-en-bout (§8 point 3 :
  `assembly` vert + `coverage` rouge sur un fichier atteignable mais jamais exécuté).
- ⬜ hors périmètre du jet Node : couverture navigateur (`Profiler.takePreciseCoverage`
  par CDP + source maps) et serveur (un process tué ne vide pas sa couverture V8).

> Le module `coverage.ts` n'est encore appelé par personne : il compile mais n'est pas
> testé. À reprendre là avant tout autre chantier.

## Déjà porté et validé

Commandes déclarées · livrables · assemblage statique · smoke (routes + rendu) ·
probes **`cli` / `artifact` / `http` / `browser` / `process`** · **spec-coverage** ·
harnais serveur (app partagée, un seul démarrage). **62 tests verts.**
