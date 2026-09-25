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
gates check --base-url https://apercu.vercel.app/   # juger un site DÉJÀ déployé
gates check --phase-rouge  # les probes échouent-elles quand le code est vidé ?
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
| `docs` | `docs` | la doc **constatée** : fichier présent, sections déclarées, et une probe qui exécute le démarrage qu'il décrit |

Le check `assembly` suit le graphe réel depuis le point d'entrée (`index.html`, sinon
`src/main.*`) et échoue sur tout livrable jamais atteint — assets CSS compris.

## `--base-url` — juger le site déployé, pas celui que la CI relance

Jusqu'au 25/09/2026, « vert » voulait dire *vert dans la CI* : `gates` démarrait l'app
lui-même par `app.start`. Le lien qu'on envoie à un client, lui, n'était jugé par
personne. Entre les deux passent une variable d'environnement absente chez l'hébergeur,
un chemin d'asset qui ne tient qu'en local, un build de production différent du build de
développement.

`--base-url <url>` désigne un site **déjà servi**. `app.start` n'est alors **pas lu** —
on juge ce que le déploiement sert, pas ce que la CI saurait relancer. `app.paths`,
`app.page` et la section `site` décrivent le site lui-même : ils s'appliquent aux deux
modes sans changer de sens, et les probes `http`/`browser` sondent l'URL distante.

```bash
gates check --base-url "$URL" --only smoke,probes,a11y,mobile,budgets,seo
```

- Le juge **attend** que l'URL réponde (`app.readyTimeoutMs`, 60 s par défaut) : une PR
  jugée avant la fin du déploiement doit accuser *« le déploiement n'est pas en ligne »*,
  pas faire croire que le code est rouge.
- Le rapport dit **ce qui a été jugé** : `déployé : … a répondu`, jamais `démarré`.
- La **couverture ne peut rien savoir** d'un process distant : elle le dit et **suspend**
  son verdict, au lieu de déclarer mort tout le projet. La couverture serveur se lit sur
  le run local, pas sur celui-ci.
- Une valeur qui n'est pas une URL absolue `http(s)` — y compris `--base-url` sans valeur
  — est une **config invalide (exit 2)**, jamais un repli silencieux sur `localhost` : un
  repli rendrait vert un run qui n'a pas regardé ce qu'on lui demandait de regarder.

⚠️ **Le drapeau est générique, son déclenchement ne l'est pas.** Une API déployée ailleurs
se jugerait de la même façon. Mais le job CI qui le lance automatiquement ne s'active que
si le contrat déclare un site (`site` ou `app.page`) : un CLI, une API, un projet Python
n'ont pas de prévisualisation à juger, et n'en verront jamais.

## Chrome (gate de rendu)

Réutilise le navigateur de la machine (puppeteer-core, rien de téléchargé). Priorité à
`HERMES_CHROME` / `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH`, puis emplacements usuels.
Absent → gate `skipped` (jamais un faux rouge). En CI, on installe Chrome et on exporte
`HERMES_CHROME`.

## Développement

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (118 tests, dont un vrai navigateur si Chrome présent)
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

### Toute clé inconnue est une config invalide (exit 2)

Les clés d'une probe, de son `request` et de son `expect` sont **closes** : une clé
qu'aucun check ne lit fait sortir `gates check` en **2** en la nommant, comme un
`gates.json` illisible. Sans ce refus, `expect: { "json": … }` sur une probe `http`
rendait un critère **vert** qui n'avait vérifié que le code HTTP — le corps de la
réponse, l'objet même du projet, n'était jamais contrôlé. Un `kind` inconnu, lui, reste
accepté : il est `skipped` (jamais vert) et son schéma est par définition inconnaissable.

### Probes serveur — `http`, `browser`, `process`

Les probes `http` et `browser` sondent l'**app démarrée par le harnais** (déclarée dans
`app`, démarrée une fois puis arrêtée). `process` lance son propre démon et vérifie qu'il
tient debout (réponse HTTP sur `url`, ou ligne de log `logMatch`).

```json
"probes": [
  { "id": "liste", "criterion": "AC-7", "kind": "http",
    "request": { "method": "GET", "path": "/tasks" },
    "expect": { "statusNot": [404, 500], "bodyMatch": "[",
                "headerMatch": { "content-type": "/application\\/json/" } } },

  { "id": "selection-puis-arene", "criterion": "AC-1", "kind": "browser",
    "path": "/", "actions": [{ "click": "#choix-guerrier" }, { "wait": 300 }],
    "expect": { "requireCanvas": true, "minDrawCalls": 1, "requireSelectors": ["#hud"] } },

  { "id": "worker-demarre", "criterion": "AC-5", "kind": "process",
    "start": "node worker.mjs", "logMatch": "/ready/i", "readyTimeoutMs": 8000 }
]
```

Deux clés pour les en-têtes, deux sémantiques **assumées** : `headers` compare par
**sous-chaîne littérale**, `headerMatch` suit la convention de `bodyMatch` (`"/regex/"`
ou sous-chaîne). Écrire une regex dans `headers` cherche donc les slashs eux-mêmes dans
la valeur reçue, et rougit à tort — `headerMatch` est là pour ça. (`headers` n'a pas été
converti aux regex : cela aurait changé le sens des `gates.json` déjà écrits sans que
personne ne les édite.)

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

## `--phase-rouge` — qui juge les juges

> Si le même agent écrit le code puis les probes en lisant ce code, les probes vérifient
> ce que le code **fait**, pas ce qu'il **devrait** faire.

Les probes sont les tests de ce montage, et rien ne vérifiait qu'elles dépendent du code.
Une probe qui passerait sur un dépôt vide rend son critère vert **sans avoir rien
constaté** : c'est le défaut d'origine, déplacé d'un cran.

```bash
gates check --phase-rouge
```

Les probes sont rejouées sur une **copie** du projet dont les livrables ont été **vidés**,
et chacune doit **échouer**. Celle qui passe est nommée, avec son critère.

- **Vidés, pas supprimés.** Un fichier absent casse la résolution de modules : la probe
  échouerait pour une raison sans rapport avec le comportement, et la phase rouge
  conclurait « tout va bien » sans avoir rien mesuré. Vidé, le module se charge et ne fait
  rien — l'échec porte alors sur l'absence de **comportement**.
- **Les cibles viennent du contrat** : `deliverables` s'il est déclaré, sinon les fichiers
  sous `roots` (défaut `src`). Rien hors de là n'est touché : vider un fichier de
  configuration ferait échouer les probes pour une raison sans rapport.
- **Une copie, jamais le dépôt.** Le projet d'origine reste intact. Un juge qui abîme ce
  qu'il juge est pire que pas de juge. `node_modules` et les autres dossiers lourds ne
  sont pas recopiés mais restent atteignables : sans eux, chaque probe échouerait faute de
  dépendances, et la phase rouge se prouverait elle-même vacante.
- **Une probe ignorée ne prouve rien** : elle est signalée, jamais comptée comme preuve.
  Toutes ignorées → `skipped`, parce que rien n'a été établi.

⚠️ **Ce qu'elle ne dit pas.** Qu'une probe dépende du code ne prouve pas qu'elle vérifie la
bonne chose. Elle ferme la probe *creuse*, pas la probe *complaisante* — celle qui constate
ce que le code fait au lieu de ce que la spec demande. Contre celle-là, le seul rempart est
l'approbation humaine des critères.

Elle est lancée par la CI, où l'agent ne peut pas la désactiver (modifier un workflow exige
la permission `Workflows`, que son PAT n'a pas), et démarre en `observation`.

## `docs` — la documentation constatée, pas déclarée

Vérifier une doc de façon déclarative — « il existe un `README.md` » — est le vert vide
que cet outil refuse partout ailleurs : un agent à qui on demande une documentation écrit
un fichier d'une ligne et satisfait le contrôle. Et une doc **fausse** coûte plus cher
qu'une doc absente à celui qui suit ses instructions.

```json
"docs": {
  "file": "README.md",
  "sections": ["Installation", "Démarrage rapide"],
  "quickstart": "readme-demarrage"
}
```

Trois lignes de défense, dont **une seule constate vraiment** :

1. le fichier existe — et quand il manque, la sortie **nomme** celui qu'on attendait
   (`docs — failed` n'est pas actionnable) ;
2. il porte de la matière : au moins 200 caractères de contenu **titres exclus**, ce qui
   ferme le cas retors du plan long qui annonce six sections et n'en écrit aucune ;
3. `quickstart` nomme **l'id d'une probe** qui joue le démarrage tel que le fichier le
   décrit. C'est la seule partie qui prouve quelque chose ; le reste ne fait que lire.

```json
{ "id": "readme-demarrage", "criterion": "AC-8", "kind": "cli",
  "run": "node bin/cli.mjs init $TMP && node bin/cli.mjs export $TMP/out.pdf",
  "expect": { "exitCode": 0, "files": ["$TMP/out.pdf"] } }
```

- **Sans `quickstart`**, le check rend **`warn`**, jamais `passed` : « documenté mais
  jamais exécuté » est l'état qu'on veut voir signalé. En vert, il serait indiscernable
  d'une doc prouvée pour tout ce qui lit le *statut* — la CI, le rapport de nuit,
  l'agrégation —, c'est-à-dire pour tout le monde sauf un humain qui lit le texte.
- Une probe de quickstart **ignorée** vaut un **échec**, pas un vert : même règle qu'un
  critère `uncovered`. La sortie le distingue d'un échec d'exécution, pour qu'on ne
  cherche pas une panne qui n'a pas eu lieu.
- `quickstart` qui ne désigne **aucune** probe → **exit 2**. Une coquille laisserait la
  doc « vérifiée » par une probe inexistante, donc verte sans qu'une commande ait tourné.
- `file` est **verrouillé sous le projet** : un `../../README.md` ferait valider la
  documentation d'un autre dépôt. Un juge qui lit où on lui dit de lire n'est plus un juge.

`docs` est un contrôle neuf : il peut être mis en `observation` le temps qu'il fasse ses
preuves. Le seuil de 200 caractères ne mesure pas la qualité — aucun nombre ne le ferait —
il ferme seulement le README écrit pour passer le contrôle. Ce qui juge la qualité, c'est
la probe.

## Signalé : l'état `warn` et `observation`

Depuis le 19/09/2026, un check peut rendre **`warn`** — *signalé, ne bloque pas* — à côté de
`passed`, `failed` et `skipped`. `warn` ne change ni `ok` ni le code de sortie ; il apparaît
dans la sortie (`! a11y — warn (signalé, ne bloque pas)`) et dans le résumé (`2 signalé(s)`).

C'est l'état des contrôles **en observation** : tout contrôle neuf signale d'abord, et ne bloque
qu'après plusieurs projets sans faux positif (`ROADMAP.md`, chantier 9, règle 3). Pour mettre
une commande déclarée en observation — un linter qu'on vient de poser :

```json
{ "commands": { "lint": "npm run lint" }, "observation": ["lint"] }
```

⚠️ **Le juge fonctionnel ne se met pas en observation.** `probes`, `smoke`, `page`,
`deliverables`, `assembly`, `coverage` et `spec-coverage` listés dans `observation` → exit 2 :
un contrat approuvé trop vite ne doit pas pouvoir éteindre le juge.

## Contrôles de site (chantier 9)

Actifs **seulement** quand le projet déclare un site — une section `site`, ou `app.page` — et
**seulement après un `smoke` vert** : un audit d'accessibilité vert sur une page noire est un
faux vert. Un CLI, une API, un projet Python ne les voient jamais.

Quatre checks, un par famille, dans un vrai Chrome :

| Check | Ce qui est mesuré | Règles |
|---|---|---|
| `a11y` | axe-core, messages en français | toute règle d'axe (`a11y:image-alt`, `a11y:label`…) ; **seules les violations `serious` et `critical` peuvent bloquer** |
| `mobile` | la page à 375 px de large | `mobile:viewport` (balise absente), `mobile:scroll-horizontal` (avec l'élément d'où part le débordement) |
| `budgets` | octets transférés, vus par la page | `budgets:poids`, `budgets:js`, `budgets:image` — jamais un score qui fluctue |
| `seo` | le document | `seo:title`, `seo:description`, `seo:h1` (exactement un) |

**Par défaut, rien ne bloque** : chaque constat est signalé. Une règle ne bloque que si le
contrat la liste — donc après un `!approuve` humain :

```json
{
  "site": {
    "pages": ["/", "/contact"],
    "bloquant": ["a11y", "mobile:viewport", "seo:title"],
    "budgets": { "poidsKo": 1500, "jsKo": 400, "imageKo": 500 },
    "waitMs": 1500
  }
}
```

`bloquant` accepte une famille entière (`a11y`, `mobile`, `budgets`, `seo`) ou une règle
(`famille:règle`). Toute clé inconnue, toute règle inconnue → exit 2 : une faute de frappe ne
doit pas rendre une règle bloquante inopérante. Chaque constat dit la règle, la page, les
éléments fautifs et la correction attendue.

## Couverture navigateur (chantier 7)

Les probes `browser` sont instrumentées depuis le 19/09/2026 (`page.coverage` de puppeteer) :
un script servi **tel qu'il est dans le dépôt** (`/app.js` → `public/app.js`) compte comme
exécuté, au même titre que le code d'un serveur. Ce qui ne se rattache pas à un seul fichier du
projet — un bundle, faute de source maps, ou un nom ambigu — rend la mesure incomplète, et le
verdict se suspend plutôt que de déclarer morts des fichiers qu'on n'a pas su observer.

## Sous GitHub Actions : sortie protégée, état annoté

Quand `GITHUB_ACTIONS=true` (et hors `--json`), `gates check` :

1. suspend les commandes de workflow (`::stop-commands::<jeton aléatoire>`) **avant** de lancer
   quoi que ce soit du projet : ce que le code jugé imprime ne peut plus passer pour une
   annotation du juge ;
2. les rétablit avec le même jeton une fois le rapport écrit ;
3. émet une annotation `notice` titrée **`gates etat`**, portant en JSON l'état de chaque critère
   et de chaque check — c'est ce que le pont lit pour juger un brief de nuit —, puis une `error`
   par critère non vérifié et par check rouge (10 au plus, la limite de GitHub par étape), et
   une `warning` par check signalé.

Le code de sortie ne change pas. `AC-5` de la spec de `gates` le vérifie.

## Verdict par critère

Le JSON et la sortie texte portent un bloc `criteria` : l'état de chaque `AC-n`, qui est
ce que la skill `/verify` doit rapporter (`AC-3 ❌ · AC-9 non couvert`), pas
`probes: failed`. Trois états, et **`uncovered` compte comme un échec** — un critère dont
la seule probe a été ignorée (pas de Chrome sur la machine) n'est pas un critère
satisfait.

## Portée et validation

Commandes déclarées · livrables · assemblage statique · smoke (routes + rendu) ·
probes **`cli` / `artifact` / `http` / `browser` / `process`** · **spec-coverage** ·
**coverage** (node/python/go/custom) · contrôles de site (a11y, mobile, budgets, seo) ·
**`docs`** · verdict par critère · harnais serveur (app partagée, un seul démarrage) ·
**`--base-url`** (site déployé) · **`--phase-rouge`** (les probes dépendent-elles du
code ?). **189 tests**, dont un vrai navigateur quand Chrome est présent.

Validé de bout en bout sur trois types de projets — CLI, générateur d'artefact, service
HTTP — plus un projet **Python** réel (`assembly` skipped, `coverage` rouge en nommant le
module jamais importé et celui importé sans jamais servir).
