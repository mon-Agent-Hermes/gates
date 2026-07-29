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
| `entry` | `assembly` | point d'entrée déclaré ; déclaré mais introuvable = **échec**, pas de repli silencieux |
| `coverage` | `coverage` | atteignabilité par exécution, tous runtimes (voir plus bas) |
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
npm test            # vitest (107 tests, dont un vrai navigateur si Chrome présent)
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

## `coverage` — atteignabilité **par exécution** (§2.6)

C'est le gate qui fait sortir le montage du web. L'assemblage statique ne conclut que
sur un graphe d'imports JS/HTML : sur un projet Python, Go, un CLI ou un service sans
front, il sort `skipped` — **le gate qui avait trouvé les 29 fichiers morts n'existe pas
pour la majorité des projets.** La couverture pose la même question sans graphe :

> Ce fichier s'est-il exécuté quand on a piloté l'artefact comme un utilisateur ?

```json
"coverage": {
  "runtime": "node",
  "requireExecuted": ["src/**/*.ts"],
  "allowUnexecuted": ["src/types.ts", "src/**/*.d.ts"]
}
```

**Vivant = quelque chose s'est exécuté au-delà des déclarations**, pas « ≥ 1 ligne ».
La nuance est ce qui rend le gate plus fort que l'assemblage : importer un module
exécute son corps (en JS comme en Python), donc compter les lignes reviendrait à
recompter « ce fichier est importé ». Un module chargé dont aucune fonction n'est
appelée est signalé pour ce qu'il est :

```
✗ coverage — failed
    2 livrable(s) jamais exercé(s) pendant les probes.
    Jamais atteint : src/mort.py
    Chargé mais aucune de ses fonctions n'a été appelée : src/aide.py
```

Le seuil reste **mort ou vivant**, jamais un pourcentage : un objectif de couverture
chiffré est une métrique gameable qui transformerait un juge en rituel.

### Runtimes

Chaque runtime n'apporte que trois choses : ce qu'on injecte, ce qu'on lance après, ce
qu'on lit. `$COV` (le dossier de mesure) est utilisable dans les commandes de probe.

| `runtime` | Injecté | Le projet doit | Format lu |
|---|---|---|---|
| `node` (défaut) | `NODE_V8_COVERAGE` | rien (natif) | V8 |
| `python` | `COVERAGE_FILE` | lancer ses probes via `python -m coverage run --parallel-mode …` | `coverage json` |
| `go` | `GOCOVERDIR` | construire avec `go build -cover` | `go tool covdata textfmt` |
| `custom` | `env` déclaré | fournir `report` + `format` (`lcov` couvre grcov, jacoco, phpunit…) | au choix |

### Ce qui n'est pas mesuré (et le dit)

- **Serveurs** : un process tué de force ne déroule pas ses hooks de sortie, donc n'écrit
  rien. L'app doit gérer `SIGTERM` et sortir proprement. `gates` **constate** (comptage
  des fichiers de mesure avant/après) et **suspend** le verdict au lieu de rendre un faux
  rouge sur du code qu'il n'a pas su observer.
- **Windows** : pas d'arrêt propre pour un process console → la couverture serveur n'est
  mesurable que sous POSIX (VPS et CI Linux).
- **Navigateur** : non instrumenté (exige CDP + source maps). Signalé comme mesure
  incomplète, jamais compté comme du code mort.

## Verdict par critère

Le JSON et la sortie texte portent un bloc `criteria` : l'état de chaque `AC-n`, qui est
ce que la skill `/verify` doit rapporter (`AC-3 ❌ · AC-9 non couvert`), pas
`probes: failed`. Trois états, et **`uncovered` compte comme un échec** — un critère dont
la seule probe a été ignorée (pas de Chrome sur la machine) n'est pas un critère
satisfait.

## Portée et validation

Commandes déclarées · livrables · assemblage statique · smoke (routes + rendu) ·
probes **`cli` / `artifact` / `http` / `browser` / `process`** · **spec-coverage** ·
**coverage** (node/python/go/custom) · verdict par critère · harnais serveur (app
partagée, un seul démarrage). **107 tests verts.**

Validé de bout en bout sur trois types de projets — CLI, générateur d'artefact, service
HTTP — plus un projet **Python** réel (`assembly` skipped, `coverage` rouge en nommant le
module jamais importé et celui importé sans jamais servir).
