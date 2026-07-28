import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckResult } from "./types";

/**
 * `coverage` (§2.6) — atteignabilité PAR EXÉCUTION, la généralisation du gate
 * d'assemblage. L'assemblage répond « ce fichier est-il importé depuis le point
 * d'entrée ? » ; la couverture pose la question plus forte :
 *
 *   « Ce fichier s'est-il exécuté quand on a piloté l'artefact comme un utilisateur ? »
 *
 * On lance les PROBES sous couverture et on échoue sur tout livrable jamais exécuté.
 * Strictement plus fort que l'assemblage statique : un module importé mais dont le
 * code n'est jamais atteint (écran câblé mais jamais ouvert) passe l'assemblage et
 * échoue ici.
 *
 * ⚠️ Sémantique « mort ou vivant », pas un pourcentage (cf. doc) : le seuil est
 * « ≥ 1 ligne exécutée », le gate ne juge pas la QUALITÉ des tests.
 *
 * ⚠️ Périmètre actuel : couverture Node via `NODE_V8_COVERAGE` (aucune dépendance),
 * mesurée pendant les probes `cli`/`artifact` (processus à SORTIE PROPRE). Un serveur
 * tué (probe http/browser/process) ne vide pas sa couverture V8, et le navigateur
 * exige CDP + source maps : ces voies ne sont pas encore mesurées. En l'absence totale
 * de données, le check est `skipped` (jamais un faux rouge).
 */

export type CoverageConfig = {
  during?: "probes";
  /** Globs des livrables qui DOIVENT s'exécuter (ex: `src/**​/*.ts`). */
  requireExecuted?: string[];
  /** Globs exemptés (types purs, `.d.ts`, générés…) — la seule échappatoire. */
  allowUnexecuted?: string[];
  /** Accepté pour compat ; sémantique mort/vivant (≥ 1) appliquée pour l'instant. */
  minExecutedLinesPerFile?: number;
};

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage",
  ".hermes-debug", ".venv", "venv", "__pycache__", ".next", ".turbo", "target", "vendor",
]);

/** Glob simple (`**`, `*`, `?`) → RegExp ancrée. `/` est un séparateur strict. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } // **/ → zéro ou plus de dossiers
        else { re += ".*"; i += 1; } // ** → n'importe quoi
      } else {
        re += "[^/]*"; // * → tout sauf le séparateur
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

const matchesAny = (rel: string, res: RegExp[]): boolean => res.some((r) => r.test(rel));

/** Liste les fichiers du projet en chemins relatifs POSIX (hors dossiers ignorés). */
async function listFiles(dir: string, root = dir, acc: string[] = []): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      await listFiles(p, root, acc);
    } else if (e.isFile()) {
      acc.push(relative(root, p).replace(/\\/g, "/"));
    }
  }
  return acc;
}

/**
 * Lit les rapports `coverage-*.json` (format V8) d'un dossier `NODE_V8_COVERAGE` et
 * renvoie l'ensemble des livrables du projet RÉELLEMENT exécutés (≥ 1 plage count>0),
 * plus le nombre de rapports lus (0 = aucune donnée → check `skipped`).
 */
export async function collectV8Coverage(covDir: string, projectDir: string): Promise<{ executed: Set<string>; files: number }> {
  const executed = new Set<string>();
  let entries: string[];
  try {
    entries = await readdir(covDir);
  } catch {
    return { executed, files: 0 };
  }
  let files = 0;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    let data: any;
    try {
      data = JSON.parse(await readFile(join(covDir, name), "utf8"));
    } catch {
      continue;
    }
    files++;
    for (const script of data.result ?? []) {
      const url: string = script.url ?? "";
      if (!url.startsWith("file:")) continue;
      let p: string;
      try {
        p = fileURLToPath(url);
      } catch {
        continue;
      }
      const rel = relative(projectDir, p);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(/[\\/]/).includes("node_modules")) continue;
      const anyExec = (script.functions ?? []).some((fn: any) =>
        (fn.ranges ?? []).some((r: any) => r.count > 0 && r.endOffset > r.startOffset),
      );
      if (anyExec) executed.add(resolve(projectDir, rel));
    }
  }
  return { executed, files };
}

/**
 * Verdict de couverture : tout livrable requis (requireExecuted, moins allowUnexecuted)
 * qui n'a pas été exécuté pendant les probes est ROUGE. Sans donnée, `skipped`.
 */
export async function checkCoverage(
  cfg: CoverageConfig,
  projectDir: string,
  executed: Set<string>,
  hadData: boolean,
): Promise<CheckResult> {
  const req = cfg.requireExecuted ?? [];
  if (!req.length) {
    return { name: "coverage", status: "skipped", reason: "not-configured", output: "aucun requireExecuted déclaré" };
  }
  if (!hadData) {
    return {
      name: "coverage",
      status: "skipped",
      reason: "not-configured",
      output: "couverture non mesurée : aucune probe Node à exécution instrumentée (cli/artifact). Le pilotage navigateur/serveur n'est pas encore couvert.",
    };
  }
  const allFiles = await listFiles(projectDir);
  const reReq = req.map(globToRegExp);
  const reAllow = (cfg.allowUnexecuted ?? []).map(globToRegExp);
  const required = allFiles.filter((f) => matchesAny(f, reReq) && !matchesAny(f, reAllow));
  const dead = required.filter((f) => !executed.has(resolve(projectDir, f))).sort();

  if (dead.length) {
    return {
      name: "coverage",
      status: "failed",
      output: `${dead.length} livrable(s) à 0 ligne exécutée pendant les probes : ${dead.join(", ")}`,
    };
  }
  return { name: "coverage", status: "passed", output: `${required.length} livrable(s) requis, tous exécutés pendant les probes` };
}
