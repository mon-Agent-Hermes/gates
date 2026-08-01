import { readdir, readFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckResult } from "./types.js";

/**
 * `coverage` (§2.6) — atteignabilité PAR EXÉCUTION.
 *
 * L'assemblage statique répond « ce fichier est-il importé depuis le point d'entrée ? ».
 * Il ne sait le faire que sur un graphe d'imports JS/HTML : sur un projet Python, Go, un
 * CLI ou un service sans front, il n'a RIEN à dire et sort `skipped`. Or c'est le gate qui
 * a trouvé les 29 fichiers morts. Sa version universelle pose la question autrement :
 *
 *   « Ce fichier s'est-il exécuté quand on a piloté l'artefact comme un utilisateur ? »
 *
 * On lance les PROBES sous couverture et on échoue sur tout livrable jamais exécuté.
 * C'est le SEUL gate d'atteignabilité disponible hors du web — et il est strictement plus
 * fort que la version statique (un module importé mais jamais appelé passe l'assemblage).
 *
 * ⚠️ Sémantique « mort ou vivant », pas un pourcentage : le seuil est « ≥ 1 ligne
 * exécutée ». Le gate ne juge pas la QUALITÉ des tests — un objectif en pourcentage est
 * une métrique gameable qui transformerait un juge en rituel.
 *
 * ⚠️ La couverture se mesure pendant les PROBES, jamais pendant les tests : la couverture
 * des tests est circulaire (l'agent écrit les tests, donc fabrique sa propre couverture).
 *
 * Universalité : la mécanique est la même partout — injecter des variables d'environnement
 * dans les process de probe, éventuellement lancer une commande de normalisation, puis lire
 * un format. Seul ce triplet change d'un runtime à l'autre → un ADAPTATEUR par runtime.
 */

export type CoverageRuntime = "node" | "python" | "go" | "custom";
export type CoverageFormat = "v8" | "coverage-py" | "go" | "lcov";

export type CoverageConfig = {
  during?: "probes";
  /** Runtime instrumenté (défaut `node`). `custom` = tout est déclaré à la main. */
  runtime?: CoverageRuntime;
  /** Globs des livrables qui DOIVENT s'exécuter (ex: `src/**​/*.py`). */
  requireExecuted?: string[];
  /** Globs exemptés (types purs, `.d.ts`, générés…) — la seule échappatoire. */
  allowUnexecuted?: string[];
  /** Accepté pour compat ; sémantique mort/vivant (≥ 1) appliquée pour l'instant. */
  minExecutedLinesPerFile?: number;
  /** `custom` : variables injectées dans les process de probe (`$COV` = dossier de mesure). */
  env?: Record<string, string>;
  /** `custom` : commande(s) de normalisation lancées APRÈS les probes (`$COV` géré). */
  report?: string | string[];
  /** `custom` : format du fichier produit dans `$COV`. */
  format?: CoverageFormat;
};

/** Ce qu'un adaptateur fournit au harnais. */
export type CoverageAdapter = {
  runtime: CoverageRuntime;
  /** Variables injectées dans l'environnement des probes (`$COV` non encore résolu). */
  env: Record<string, string>;
  /** Commandes de normalisation lancées après les probes (best-effort, `$COV` géré). */
  report: string[];
  format: CoverageFormat;
};

/**
 * Adaptateurs intégrés. Chacun n'a besoin que de trois choses : ce qu'on injecte, ce
 * qu'on lance après, et ce qu'on lit. Aucun n'exige de dépendance côté `gates`.
 *
 * - `node`   : `NODE_V8_COVERAGE` — natif, rien à installer côté projet ;
 * - `python` : `COVERAGE_FILE` + `coverage json` — le projet déclare ses probes avec
 *              `python -m coverage run --parallel-mode …` (on DÉCLARE, on ne devine pas) ;
 * - `go`     : `GOCOVERDIR` — le binaire doit être construit avec `go build -cover` ;
 * - `custom` : tout est déclaré (`env`, `report`, `format`) — la porte de sortie pour
 *              Rust/grcov, PHP, Java, ou n'importe quel outil produisant du lcov.
 */
export function resolveAdapter(cfg: CoverageConfig): CoverageAdapter | { error: string } {
  const runtime: CoverageRuntime = cfg.runtime ?? "node";
  switch (runtime) {
    case "node":
      return { runtime, env: { NODE_V8_COVERAGE: "$COV" }, report: [], format: "v8" };
    case "python":
      return {
        runtime,
        env: { COVERAGE_FILE: "$COV/.coverage" },
        // Deux commandes SÉPARÉES : pas d'opérateur de shell (`;`/`&&` ne sont pas
        // portables cmd.exe ↔ sh). Chacune est best-effort : `combine` échoue
        // légitimement quand une seule mesure existe.
        report: [
          "python -m coverage combine --data-file=$COV/.coverage --keep",
          "python -m coverage json --data-file=$COV/.coverage -o $COV/coverage.json",
        ],
        format: "coverage-py",
      };
    case "go":
      return {
        runtime,
        env: { GOCOVERDIR: "$COV" },
        report: ["go tool covdata textfmt -i=$COV -o=$COV/cov.txt"],
        format: "go",
      };
    case "custom": {
      if (!cfg.format) return { error: "coverage.runtime « custom » exige `format` (v8, coverage-py, go ou lcov)" };
      const report = cfg.report === undefined ? [] : Array.isArray(cfg.report) ? cfg.report : [cfg.report];
      return { runtime, env: cfg.env ?? {}, report, format: cfg.format };
    }
    default:
      return { error: `coverage.runtime « ${runtime} » inconnu (node, python, go, custom)` };
  }
}

/** Remplace `$COV` par le dossier de mesure, dans une chaîne ou une table d'env. */
export function expandCov(s: string, covDir: string): string {
  return s.split("$COV").join(covDir);
}

export function adapterEnv(adapter: CoverageAdapter, covDir: string): Record<string, string> {
  return Object.fromEntries(Object.entries(adapter.env).map(([k, v]) => [k, expandCov(v, covDir)]));
}

/**
 * Contexte d'instrumentation fourni au harnais de probes.
 * `env` vient de l'adaptateur ; `$COV` est utilisable dans les commandes de probe.
 * `incomplete` recueille tout ce qui rend la mesure non concluante — c'est lui qui
 * permet au verdict de se SUSPENDRE plutôt que de rendre un faux rouge.
 */
export type CoverageContext = {
  dir: string;
  env: Record<string, string>;
  incomplete: string[];
};

/**
 * Nombre de fichiers de mesure présents dans `$COV`.
 *
 * Sert à répondre par l'OBSERVATION à la question « ce process a-t-il écrit sa
 * couverture ? » : on compte avant de démarrer un serveur, on recompte après l'avoir
 * arrêté. Aucun nouveau fichier = le process est mort sans dérouler ses hooks de sortie
 * (typiquement : pas de handler SIGTERM). Sans ce comptage, les fichiers qui ne
 * s'exécutent QUE dans le serveur passeraient pour du code mort — un faux rouge, et
 * l'agent s'épuiserait à « réparer » du code qui marche.
 */
export async function countCoverageFiles(covDir: string): Promise<number> {
  try {
    return (await readdir(covDir)).length;
  } catch {
    return 0;
  }
}

/**
 * Constate si un process serveur a produit sa mesure entre `before` et maintenant, et
 * consigne un avertissement ACTIONNABLE sinon. On constate, on ne déduit pas.
 */
export async function noteServerCoverage(
  cov: CoverageContext | undefined | null,
  label: string,
  before: number,
  stopped: { graceful: boolean; note?: string },
): Promise<void> {
  if (!cov) return;
  if ((await countCoverageFiles(cov.dir)) > before) return; // mesure bien écrite
  const why = stopped.graceful ? "arrêt propre, mais aucune mesure écrite" : stopped.note ?? "arrêt forcé";
  cov.incomplete.push(
    `${label} n'a écrit aucune couverture (${why}) — pour être mesurée, l'app doit gérer ` +
    `SIGTERM et sortir proprement (les hooks de sortie ne tournent pas sur un process tué)`,
  );
}

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
export async function listFiles(dir: string, root = dir, acc: string[] = []): Promise<string[]> {
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
 * Ramène un chemin sorti d'un outil de couverture à un fichier DU PROJET (relatif POSIX),
 * ou `null` s'il n'en fait pas partie. Trois formes rencontrées :
 *  - absolu (`v8`, `lcov` la plupart du temps) ;
 *  - relatif au projet (`coverage-py`) ;
 *  - préfixé du chemin de module (`go` : `exemple.com/mod/pkg/fichier.go`).
 * Le dernier cas se résout par correspondance de SUFFIXE sur les fichiers réels.
 */
export function toProjectFile(raw: string, projectDir: string, projectFiles: string[]): string | null {
  let p = raw.trim();
  if (!p) return null;
  if (p.startsWith("file:")) {
    try { p = fileURLToPath(p); } catch { return null; }
  }
  const posix = p.replace(/\\/g, "/");

  if (isAbsolute(p)) {
    const rel = relative(projectDir, p).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel.split("/").includes("node_modules") ? null : rel;
  }

  const direct = posix.replace(/^\.\//, "");
  if (projectFiles.includes(direct)) return direct;

  // Suffixe : `mod/pkg/f.go` → `pkg/f.go`. On exige un vrai bord de segment pour ne pas
  // confondre `ui/hud.ts` avec `mon-ui/hud.ts`.
  const candidates = projectFiles.filter((f) => posix === f || posix.endsWith("/" + f));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return candidates.sort((a, b) => b.length - a.length)[0];
  return null;
}

export type CoverageData = {
  /** Fichiers du projet (relatifs POSIX) réellement VIVANTS. */
  executed: Set<string>;
  /**
   * Fichiers CHARGÉS mais dont aucune fonction n'a été appelée.
   *
   * La distinction n'est pas cosmétique, c'est ce qui rend le gate plus fort que
   * l'assemblage statique : en JS, importer un module exécute son corps. Compter
   * « ≥ 1 ligne exécutée » reviendrait donc à recompter « ce fichier est importé » —
   * exactement ce que l'assemblage dit déjà. L'écran câblé mais jamais ouvert atterrit
   * ici, et le message peut le dire à l'agent en ces termes.
   */
  loadedOnly: Set<string>;
  /** Nombre de sources de mesure lues. 0 = aucune donnée → check `skipped`. */
  sources: number;
};

const empty = (): CoverageData => ({ executed: new Set<string>(), loadedOnly: new Set<string>(), sources: 0 });

// ── Lecteurs de format ───────────────────────────────────────────────────────────

/**
 * V8/Node (`NODE_V8_COVERAGE`) : un `coverage-*.json` par process, écrit à la SORTIE
 * PROPRE du process (d'où l'exigence d'un arrêt maîtrisé pour les serveurs).
 *
 * Vivant = au moins une FONCTION du fichier a été appelée. Un fichier sans fonction
 * (constantes, table de configuration) est vivant dès qu'il a été chargé — il n'a rien
 * d'autre à faire. Le cas ambigu (fichier chargé, fonctions jamais appelées) part dans
 * `loadedOnly` : c'est un signal, pas un verdict silencieux.
 */
async function readV8(covDir: string, projectDir: string, files: string[]): Promise<CoverageData> {
  const out = empty();
  let entries: string[];
  try { entries = await readdir(covDir); } catch { return out; }
  const ran = (fn: any) => (fn?.ranges ?? []).some((r: any) => r.count > 0 && r.endOffset > r.startOffset);
  for (const name of entries) {
    if (!name.endsWith(".json") || !name.startsWith("coverage")) continue;
    let data: any;
    try { data = JSON.parse(await readFile(join(covDir, name), "utf8")); } catch { continue; }
    if (!Array.isArray(data?.result)) continue;
    out.sources++;
    for (const script of data.result) {
      const url: string = script?.url ?? "";
      if (!url.startsWith("file:")) continue;
      const rel = toProjectFile(url, projectDir, files);
      if (!rel) continue;
      const fns: any[] = script.functions ?? [];
      // Le wrapper de script porte un `functionName` vide ; les fonctions anonymes
      // aussi, ce qui fait retomber les cas douteux du côté « vivant » (jamais un
      // faux rouge : on ne bloque que sur une certitude).
      const inner = fns.filter((f) => f?.functionName);
      const topRan = fns.some((f) => !f?.functionName && ran(f));
      if (inner.length === 0) {
        if (topRan) out.executed.add(rel);
      } else if (inner.some(ran)) {
        out.executed.add(rel);
      } else if (topRan) {
        out.loadedOnly.add(rel);
      }
    }
  }
  // Un même fichier vu par plusieurs process : vivant quelque part = vivant.
  for (const f of out.executed) out.loadedOnly.delete(f);
  return out;
}

/**
 * Lignes qui ne font que DÉCLARER : les exécuter ne prouve rien d'autre que
 * « le module a été importé » — en Python comme en JS, importer exécute le corps.
 */
const PY_DECLARATION = /^\s*(?:@|def\s|class\s|async\s+def\s|import\s|from\s+\S+\s+import\s)/;

/**
 * coverage.py (`coverage json`) : `{ files: { "src/a.py": { executed_lines: [...] } } }`.
 *
 * Même exigence que pour V8 : vivant = quelque chose s'est exécuté AU-DELÀ des
 * déclarations. Sinon un module simplement importé (ses `def` s'exécutent) passerait
 * pour vivant, et le gate ne dirait rien de plus que « ce fichier est importé ».
 */
async function readCoveragePy(covDir: string, projectDir: string, files: string[]): Promise<CoverageData> {
  const out = empty();
  let data: any;
  try { data = JSON.parse(await readFile(join(covDir, "coverage.json"), "utf8")); } catch { return out; }
  if (!data?.files || typeof data.files !== "object") return out;
  out.sources++;
  for (const [raw, info] of Object.entries<any>(data.files)) {
    const rel = toProjectFile(raw, projectDir, files);
    if (!rel) continue;
    const lines: number[] = Array.isArray(info?.executed_lines) ? info.executed_lines : [];
    if (!lines.length) continue;

    let source: string[] | null = null;
    try { source = (await readFile(join(projectDir, rel), "utf8")).split(/\r?\n/); } catch { source = null; }
    // Source illisible → on ne bloque pas sur une supposition : le fichier est vivant.
    const reel = !source || lines.some((n) => {
      const l = source![n - 1] ?? "";
      return l.trim().length > 0 && !PY_DECLARATION.test(l);
    });
    if (reel) out.executed.add(rel);
    else out.loadedOnly.add(rel);
  }
  for (const f of out.executed) out.loadedOnly.delete(f);
  return out;
}

/** Go (`go tool covdata textfmt`) : `mode: set` puis `chemin:l.c,l.c nbInstr compte`. */
async function readGo(covDir: string, projectDir: string, files: string[]): Promise<CoverageData> {
  const out = empty();
  let text: string;
  try { text = await readFile(join(covDir, "cov.txt"), "utf8"); } catch { return out; }
  out.sources++;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(.+):\d+\.\d+,\d+\.\d+\s+\d+\s+(\d+)\s*$/);
    if (!m) continue;
    if (Number(m[2]) <= 0) continue;
    const rel = toProjectFile(m[1], projectDir, files);
    if (rel) out.executed.add(rel);
  }
  return out;
}

/** lcov (`*.info`) : format pivot de la plupart des outils (grcov, jacoco, phpunit…). */
async function readLcov(covDir: string, projectDir: string, files: string[]): Promise<CoverageData> {
  const out = empty();
  let entries: string[];
  try { entries = await readdir(covDir); } catch { return out; }
  const infos = entries.filter((n) => n.endsWith(".info") || n.toLowerCase() === "lcov.dat");
  for (const name of infos) {
    let text: string;
    try { text = await readFile(join(covDir, name), "utf8"); } catch { continue; }
    out.sources++;
    let current: string | null = null;
    let hits = 0;
    const flush = () => {
      if (current && hits > 0) out.executed.add(current);
      current = null;
      hits = 0;
    };
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("SF:")) {
        flush();
        current = toProjectFile(line.slice(3), projectDir, files);
      } else if (line.startsWith("DA:")) {
        const count = Number(line.slice(3).split(",")[1] ?? "0");
        if (count > 0) hits++;
      } else if (line.startsWith("LH:")) {
        hits += Number(line.slice(3)) || 0;
      } else if (line.startsWith("end_of_record")) {
        flush();
      }
    }
    flush();
  }
  return out;
}

const READERS: Record<CoverageFormat, (covDir: string, projectDir: string, files: string[]) => Promise<CoverageData>> = {
  "v8": readV8,
  "coverage-py": readCoveragePy,
  "go": readGo,
  "lcov": readLcov,
};

/** Lit le dossier de mesure au format de l'adaptateur et renvoie les fichiers exécutés. */
export async function collectCoverage(
  format: CoverageFormat,
  covDir: string,
  projectDir: string,
  projectFiles?: string[],
): Promise<CoverageData> {
  const files = projectFiles ?? (await listFiles(projectDir));
  const reader = READERS[format];
  if (!reader) return empty();
  return reader(covDir, projectDir, files);
}

// ── Verdict ──────────────────────────────────────────────────────────────────────

export type CoverageVerdictInput = {
  cfg: CoverageConfig;
  projectDir: string;
  data: CoverageData;
  /** Avertissements rendant la mesure INCOMPLÈTE (serveur tué de force, etc.). */
  incomplete?: string[];
  projectFiles?: string[];
};

/**
 * Verdict : tout livrable requis (`requireExecuted` moins `allowUnexecuted`) qui n'a
 * exécuté aucune ligne pendant les probes est ROUGE.
 *
 * Deux garde-fous contre le FAUX ROUGE, qui serait pire qu'un gate absent (il rendrait
 * la boucle non convergente — règle n°1 de §3.4, « tout gate bloquant doit être
 * actionnable ») :
 *  - aucune donnée du tout → `skipped` ;
 *  - mesure incomplète (un process instrumenté n'a pas pu écrire sa couverture) →
 *    `skipped` en DISANT quoi corriger, jamais un rouge sur des fichiers qu'on n'a
 *    simplement pas su observer.
 */
export async function checkCoverage(input: CoverageVerdictInput): Promise<CheckResult> {
  const { cfg, projectDir, data } = input;
  const req = cfg.requireExecuted ?? [];
  if (!req.length) {
    return { name: "coverage", status: "skipped", reason: "not-configured", output: "aucun requireExecuted déclaré" };
  }
  if (data.sources === 0) {
    return {
      name: "coverage",
      status: "skipped",
      reason: "not-configured",
      output:
        `aucune donnée de couverture produite (runtime « ${cfg.runtime ?? "node"} »). ` +
        `Vérifie que les probes lancent bien le code instrumenté — ` +
        `Node : sortie propre du process ; Python : « python -m coverage run --parallel-mode … » ; ` +
        `Go : binaire construit avec « go build -cover ». Le pilotage navigateur n'est pas encore instrumenté.`,
    };
  }

  const allFiles = input.projectFiles ?? (await listFiles(projectDir));
  const reReq = req.map(globToRegExp);
  const reAllow = (cfg.allowUnexecuted ?? []).map(globToRegExp);
  const required = allFiles.filter((f) => matchesAny(f, reReq) && !matchesAny(f, reAllow));
  const dead = required.filter((f) => !data.executed.has(f)).sort();

  if (dead.length && input.incomplete?.length) {
    return {
      name: "coverage",
      status: "skipped",
      reason: "not-configured",
      output:
        `mesure INCOMPLÈTE, verdict suspendu (pas de faux rouge) : ${input.incomplete.join(" ; ")}. ` +
        `${dead.length} livrable(s) apparaissent morts, mais l'observation n'a pas pu être menée à son terme.`,
    };
  }
  if (dead.length) {
    // Deux causes, deux corrections différentes : on les distingue au lieu de laisser
    // l'agent deviner (une probe manquante ne se répare pas comme un module mort).
    const jamais = dead.filter((f) => !data.loadedOnly.has(f));
    const charges = dead.filter((f) => data.loadedOnly.has(f));
    const lignes: string[] = [`${dead.length} livrable(s) jamais exercé(s) pendant les probes.`];
    if (jamais.length) lignes.push(`Jamais atteint : ${jamais.join(", ")}`);
    if (charges.length) {
      lignes.push(
        `Chargé mais aucune de ses fonctions n'a été appelée : ${charges.join(", ")} ` +
        `(le module est importé — l'assemblage le voit donc « atteignable » — mais rien n'y entre à l'exécution)`,
      );
    }
    lignes.push(
      `Un fichier jamais exercé n'est pas « pas encore testé » : soit il est mort, soit la ` +
      `fonctionnalité n'est pas câblée, soit aucune probe ne l'emprunte.`,
    );
    return { name: "coverage", status: "failed", output: lignes.join("\n") };
  }
  const note = input.incomplete?.length ? ` (avertissement : ${input.incomplete.join(" ; ")})` : "";
  return {
    name: "coverage",
    status: "passed",
    output: `${required.length} livrable(s) requis, tous exécutés pendant les probes${note}`,
  };
}
