#!/usr/bin/env node
// Shim CLI SANS shell (leçon n°3 de SETUP-hermes-agent.md, annexe A) : on ne
// concatène jamais d'arguments dans une ligne de commande passée à un shell. Les
// arguments sont passés tels quels via argv. Cross-plateforme (pas de `cmd.exe`,
// pas de `sh -c`).
//
// Deux modes. L'ordre entre eux n'est pas une préférence esthétique, il est imposé
// par la mesure de couverture — voir plus bas.
//
//   1. src/cli.ts via tsx, quand tsx est résolvable. C'est le cas dans le dépôt de
//      gates lui-même, où tsx est une devDependency. tsx est résolu DEPUIS
//      l'emplacement de ce shim (createRequire), jamais depuis le dossier courant :
//      `gates check` doit marcher lancé depuis n'importe quel projet.
//
//   2. dist/cli.js sinon. C'est la voie de distribution : `npm install` depuis git
//      déclenche le script `prepare` (donc `tsc`), si bien qu'un projet tiers faisant
//      `npx --yes github:mon-Agent-Hermes/gates check` exécute du JS compilé. tsx y
//      est absent — c'est une devDependency, qu'une install de production n'installe
//      pas. C'est précisément ce qui rendait le shim précédent inutilisable hors du
//      dépôt : il exigeait tsx partout.
//
// ⚠️ Pourquoi tsx d'abord, alors que dist/ est plus rapide. Parce que gates se
// vérifie lui-même : ses probes relancent ce shim, et le check `coverage` exige que
// `src/**/*.ts` soit exécuté. Si le shim préférait dist/, les probes exécuteraient
// `dist/*.js` et gates se déclarerait intégralement mort — 9 livrables « jamais
// atteints » — alors que tout fonctionne. Le symptôme est spectaculaire et le
// diagnostic non évident : la couverture mesure les fichiers réellement exécutés,
// pas leur source d'origine. Ne pas réinverser sans traiter les source maps.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../src/cli.ts");
const compile = resolve(here, "../dist/cli.js");

let tsxCli = null;
try {
  const require = createRequire(import.meta.url);
  tsxCli = join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");
} catch {
  // tsx absent : install de production ou paquet distribué. dist/ prend le relais.
}

let argv;
if (tsxCli && existsSync(source)) {
  argv = [tsxCli, source, ...process.argv.slice(2)];
} else if (existsSync(compile)) {
  argv = [compile, ...process.argv.slice(2)];
} else {
  // Ni tsx ni dist/ : l'install s'est faite sans exécuter `prepare` (--ignore-scripts,
  // par exemple). Le dire franchement plutôt que d'échouer sur un module introuvable.
  process.stderr.write(
    "gates : ni tsx ni dist/cli.js. Le script `prepare` n'a pas dû s'exécuter — " +
      "relance sans --ignore-scripts, ou lance `npm run build` dans le dépôt de gates.\n",
  );
  process.exit(2);
}

const child = spawn(process.execPath, argv, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  process.stderr.write(`gates : impossible de lancer le runtime : ${err?.message ?? err}\n`);
  process.exit(2);
});
