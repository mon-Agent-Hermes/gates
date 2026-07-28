#!/usr/bin/env node
// Shim CLI SANS shell (leçon n°3 de SETUP-hermes-agent.md, annexe A) : on ne
// concatène jamais d'arguments dans une ligne de commande passée à un shell. On
// lance directement le CLI tsx de `gates` sur src/cli.ts, en passant les args
// tels quels via argv. Cross-plateforme (pas de `cmd.exe`, pas de `sh -c`).
//
// tsx est résolu DEPUIS l'emplacement de ce shim (createRequire), pas depuis le
// dossier courant : `gates check` doit marcher lancé depuis n'importe quel projet,
// où `tsx` n'est pas installé. (Le premier jet passe par tsx, sans build préalable ;
// pour la distribution `npx github:.../gates`, on remplacera par dist/cli.js compilé.)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../src/cli.ts");

const require = createRequire(import.meta.url);
const tsxCli = join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");

const child = spawn(process.execPath, [tsxCli, cli, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  process.stderr.write(`gates : impossible de lancer le runtime : ${err?.message ?? err}\n`);
  process.exit(2);
});
