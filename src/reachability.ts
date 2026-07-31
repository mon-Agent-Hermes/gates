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
  /** true = `gates.json` déclare un point d'entrée qui n'existe pas → ÉCHEC, pas skip. */
  configError?: boolean;
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

/**
 * Extension écrite dans le specifier → extensions à essayer sur le disque.
 *
 * En TypeScript ESM, un import s'écrit avec l'extension de la sortie COMPILÉE, pas
 * celle du fichier source : `import { x } from "./report.js"` dans `report.ts` désigne
 * `report.ts`. Ce n'est pas une bizarrerie de style, c'est ce que Node exige à
 * l'exécution — une sortie sans extension est irrésolvable en ESM. Un projet
 * TypeScript correct s'écrit donc ainsi, et sans cette table l'analyse le déclarait
 * intégralement injoignable : le pire des faux positifs, puisqu'il frappe le code
 * juste et épargne le code fautif.
 */
const TS_FROM_JS: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".js", ".jsx"],
  ".jsx": [".tsx", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
};

/** Résout un specifier vers un fichier réel (essaie les extensions et /index). */
function resolveRef(projectDir: string, fromFile: string, spec: string): string | null {
  const base = spec.startsWith("/")
    ? resolve(projectDir, spec.replace(/^\/+/, ""))
    : resolve(dirname(fromFile), spec);
  const candidates = [base];
  const ext = extname(base).toLowerCase();
  if (!ext) {
    for (const e of JS_RESOLVE_EXT) candidates.push(base + e);
    for (const e of JS_RESOLVE_EXT) candidates.push(join(base, "index" + e));
  } else if (TS_FROM_JS[ext]) {
    const sansExt = base.slice(0, -ext.length);
    for (const e of TS_FROM_JS[ext]!) candidates.push(sansExt + e);
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * Points d'entrée. Un `entry` DÉCLARÉ dans `gates.json` fait autorité (on déclare, on ne
 * devine pas — défaut n°5) ; à défaut, on retombe sur ce que l'HTML désigne, puis sur les
 * noms conventionnels. Un `entry` déclaré mais introuvable est une ERREUR, pas une
 * invitation à deviner : c'est exactement la façon dont une exigence se décroche en
 * silence de sa vérification.
 */
async function findEntries(projectDir: string, declared?: string): Promise<string[] | { error: string }> {
  if (declared) {
    const p = resolve(projectDir, declared);
    return existsSync(p) ? [p] : { error: `point d'entrée déclaré introuvable : ${declared}` };
  }
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
export async function analyzeReachability(projectDir: string, roots = ["src"], entry?: string): Promise<ReachabilityReport> {
  try {
    const found = await findEntries(projectDir, entry);
    const rel = (p: string) => relative(projectDir, p).replace(/\\/g, "/");
    if (!Array.isArray(found)) {
      return { entries: [], scanned: 0, unreachable: [], conclusive: false, note: found.error, configError: true };
    }
    const entries = found;
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
