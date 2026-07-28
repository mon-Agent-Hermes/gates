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

## Non encore porté (viendra ensuite)

La refonte `probes` / `coverage` (atteignabilité par exécution) / `spec-coverage`
(critères AC-n) décrite aux §2.5-2.7 du doc. Ce premier jet couvre : commandes déclarées,
livrables, assemblage statique, smoke (routes + rendu).
