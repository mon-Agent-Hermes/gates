import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, extname, join, relative } from "node:path";

/**
 * Gate d'ASSEMBLAGE : ce qui a été livré est-il atteignable depuis le point d'entrée ?
 *
 * Différence essentielle avec `orphans.ts`, et raison d'être de ce module : les orphelins
 * répondent à « quelqu'un importe-t-il ce fichier ? ». C'est trop faible. Un module
 * importé par un autre module lui-même jamais atteint reste du code mort, et un fichier
 * dont le nom ressemble à un point d'entrée (`app.ts`) est exclu du verdict. Sur le run
 * du jeu voxel (2026-07-26), `orphans.ts` annonçait 13 modules morts ; la réalité était
 * **29 fichiers sur 30 injoignables depuis `src/main.ts`** — le projet entier, sauf son
 * amorce. Les 8 lots avaient pourtant tous leurs gates au vert.
 *
 * Ici on part des points d'entrée RÉELS et on suit le graphe :
 *   index.html → <script src> / <link href> → modules → imports (y compris CSS) → …
 * Tout livrable non atteint est du code mort, quel que soit son nom.
 *
 * Les ASSETS comptent : `src/ui/styles.css` n'était importé de nulle part sur ce même
 * run, donc jamais inclus par le bundler — toute l'interface s'affichait sans style,
 * les trois écrans empilés. Aucun garde-fou ne le voyait, un détecteur de MODULES étant
 * par construction aveugle aux feuilles de style.
 *
 * Prudence : verdict rendu uniquement pour les projets web/JS (HTML, JS/TS, CSS), où la
 * résolution est fiable. Ailleurs (Python, Go, Rust), on ne conclut PAS — mieux vaut pas
 * de verdict qu'un faux positif qui bloquerait un lot correct.
 */

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ASSET_EXT = new Set([".css", ".scss", ".sass", ".less"]);
const JS_RESOLVE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage",
  ".hermes-debug", ".hermes-fixtures", ".venv", "venv", "__pycache__", ".next", ".turbo", "target", "vendor",
]);
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
/** Points d'entrée conventionnels, quand il n'y a pas d'HTML pour les désigner. */
const ENTRY_CANDIDATES = ["src/main", "src/index", "src/app", "main", "index", "app"];

export type ReachabilityReport = {
  /** Points d'entrée retenus (relatifs au projet). */
  entries: string[];
  /** Livrables analysés (code + assets, hors tests et configs racine). */
  scanned: number;
  /** Livrables JAMAIS atteints depuis un point d'entrée = code mort. */
  unreachable: string[];
  /** false = projet hors périmètre d'analyse (pas de verdict, jamais bloquant). */
  conclusive: boolean;
  note: string;
};

async function walk(dir: string, acc: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      await walk(p, acc);
    } else if (e.isFile()) {
      const ext = extname(e.name);
      if (CODE_EXT.has(ext) || ASSET_EXT.has(ext)) acc.push(p);
    }
  }
}

/** Chemins référencés par une page HTML (`<script src>`, `<link href>`), hors externes. */
export function htmlReferences(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const ref = m[1]!;
    if (/^(?:https?:)?\/\//i.test(ref) || ref.startsWith("data:") || ref.startsWith("#")) continue;
    out.push(ref);
  }
  return out;
}

/** Specifiers locaux d'un module JS/TS : imports statiques, dynamiques, et CSS. */
export function moduleReferences(code: string): string[] {
  const out: string[] = [];
  const re =
    /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of code.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec && (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/"))) out.push(spec);
  }
  return out;
}

/** `@import` d'une feuille de style (une CSS peut en tirer d'autres). */
export function cssReferences(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1]!;
    if (!/^(?:https?:)?\/\//i.test(spec)) out.push(spec);
  }
  return out;
}

/** Résout un specifier vers un fichier réel (essaie les extensions et /index). */
function resolveRef(projectDir: string, fromFile: string, spec: string): string | null {
  const base = spec.startsWith("/")
    ? resolve(projectDir, spec.replace(/^\/+/, ""))
    : resolve(dirname(fromFile), spec);
  const candidates = [base];
  if (!extname(base)) {
    for (const ext of JS_RESOLVE_EXT) candidates.push(base + ext);
    for (const ext of JS_RESOLVE_EXT) candidates.push(join(base, "index" + ext));
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Points d'entrée : d'abord ceux que l'HTML désigne, sinon les noms conventionnels. */
async function findEntries(projectDir: string): Promise<string[]> {
  const html = ["index.html", join("src", "index.html"), join("public", "index.html")]
    .map((p) => resolve(projectDir, p))
    .filter((p) => existsSync(p));
  if (html.length) return html;
  for (const c of ENTRY_CANDIDATES) {
    for (const ext of JS_RESOLVE_EXT) {
      const p = resolve(projectDir, c + ext);
      if (existsSync(p)) return [p];
    }
  }
  return [];
}

/**
 * Parcourt le graphe depuis les points d'entrée et renvoie les livrables jamais atteints.
 * `roots` : dossiers de livrables à contrôler (défaut `src/`).
 */
export async function analyzeReachability(projectDir: string, roots = ["src"]): Promise<ReachabilityReport> {
  try {
    const entries = await findEntries(projectDir);
    const rel = (p: string) => relative(projectDir, p).replace(/\\/g, "/");
    if (!entries.length) {
      return { entries: [], scanned: 0, unreachable: [], conclusive: false, note: "aucun point d'entrée web identifié — pas de verdict" };
    }

    const deliverables: string[] = [];
    for (const r of roots) await walk(resolve(projectDir, r), deliverables);
    if (!deliverables.length) {
      return { entries: entries.map(rel), scanned: 0, unreachable: [], conclusive: false, note: "aucun livrable à contrôler" };
    }

    // Parcours en largeur du graphe réel.
    const seen = new Set(entries);
    const queue = [...entries];
    while (queue.length) {
      const file = queue.pop()!;
      let content = "";
      try { content = await readFile(file, "utf8"); } catch { continue; }
      const ext = extname(file).toLowerCase();
      const specs =
        ext === ".html" ? htmlReferences(content)
        : ASSET_EXT.has(ext) ? cssReferences(content)
        : CODE_EXT.has(ext) ? moduleReferences(content)
        : [];
      for (const spec of specs) {
        const target = resolveRef(projectDir, file, spec);
        if (target && !seen.has(target)) { seen.add(target); queue.push(target); }
      }
    }

    const unreachable = deliverables
      .filter((f) => !seen.has(f))
      .map(rel)
      .filter((r) => !TEST_PATH.test("/" + r)) // un test n'a pas à être atteint par l'appli
      .sort();

    return {
      entries: entries.map(rel),
      scanned: deliverables.length,
      unreachable,
      conclusive: true,
      note: "graphe réel depuis le point d'entrée (HTML → modules → imports, assets CSS compris)",
    };
  } catch {
    return { entries: [], scanned: 0, unreachable: [], conclusive: false, note: "analyse d'atteignabilité ignorée (erreur non bloquante)" };
  }
}
