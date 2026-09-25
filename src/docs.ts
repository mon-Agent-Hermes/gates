import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { CheckResult } from "./types.js";

/**
 * Le check `docs` — la documentation CONSTATÉE, pas déclarée.
 *
 * Vérifier une doc de façon déclarative (« il existe un README.md ») est exactement le
 * vert vide que cet outil refuse partout ailleurs : un agent à qui on demande une
 * documentation peut écrire un fichier d'une ligne et satisfaire le contrôle. Pire, une
 * doc FAUSSE coûte plus cher qu'une doc absente à celui qui suit ses instructions.
 *
 * D'où trois lignes de défense, dont une seule constate vraiment :
 *
 *  1. le fichier existe — et quand il manque, on NOMME celui qu'on attendait ;
 *  2. il porte de la matière, titres exclus : « présent » n'est pas « documenté » ;
 *  3. les commandes qu'il donne à un nouveau venu sont réellement exécutées par une
 *     probe. C'est la seule partie qui prouve quoi que ce soit — le reste ne fait que
 *     lire. Sans `quickstart`, le check ne peut donc pas rendre le même vert.
 */

export type DocsConfig = {
  /** Fichier de documentation. Défaut : `README.md`. */
  file?: string;
  /** Titres Markdown qui doivent exister dans ce fichier. */
  sections?: string[];
  /** Id d'une probe qui exécute réellement les commandes documentées. */
  quickstart?: string;
};

/** Forme minimale d'un résultat de probe consommée ici (évite le couplage à probes.ts). */
export type ProbeOutcome = { id: string; status: "passed" | "failed" | "skipped"; output?: string };

const CLES = new Set(["file", "sections", "quickstart"]);

/**
 * Le volume minimal, en caractères de contenu hors titres, pour qu'un fichier compte
 * comme une documentation. Un seuil bas et assumé : il ne mesure pas la qualité — aucun
 * nombre ne le ferait — il ferme seulement le README d'une ligne écrit pour passer le
 * contrôle. Ce qui juge la qualité, c'est la probe du quickstart.
 */
const MINIMUM = 200;

/**
 * Erreurs de CONTRAT (exit 2), rendues avant qu'un seul check ne tourne.
 *
 * Même règle que les probes : une clé qu'aucun check ne lit est SILENCIEUSE à
 * l'exécution. Un `quickstart: "demarage"` (coquille) laisserait la doc « vérifiée » par
 * une probe qui n'existe pas — donc verte sans qu'une seule commande ait tourné. Le refus
 * tombe ici, où c'est encore une faute de config.
 */
export function validateDocs(docs: unknown, probeIds: string[]): string[] {
  if (docs === undefined) return [];
  if (typeof docs !== "object" || docs === null || Array.isArray(docs)) return ["docs : un objet est attendu"];
  const d = docs as Record<string, unknown>;
  const errors: string[] = [];

  for (const k of Object.keys(d)) if (!CLES.has(k)) errors.push(`docs : clé inconnue « ${k} » (attendues : ${[...CLES].join(", ")})`);

  if (d.file !== undefined) {
    if (typeof d.file !== "string" || !d.file.trim()) errors.push("docs.file : un chemin de fichier est attendu");
    // Le chemin est verrouillé sous le projet. `gates.json` vient d'un contrat approuvé,
    // mais un juge qui lit où on lui dit de lire n'est plus un juge : un `../../README.md`
    // ferait valider la documentation d'un AUTRE dépôt, et le vert ne voudrait rien dire.
    else if (isAbsolute(d.file) || d.file.split(/[\\/]/).includes("..")) {
      errors.push(`docs.file : « ${d.file} » sort du projet — un chemin relatif, sans « .. », est attendu`);
    }
  }

  if (d.sections !== undefined) {
    if (!Array.isArray(d.sections)) errors.push("docs.sections : une liste de titres est attendue");
    else for (const s of d.sections) if (typeof s !== "string" || !s.trim()) errors.push("docs.sections : un titre non vide est attendu");
  }

  if (d.quickstart !== undefined) {
    if (typeof d.quickstart !== "string" || !d.quickstart.trim()) errors.push("docs.quickstart : un id de probe est attendu");
    else if (!probeIds.includes(d.quickstart)) {
      errors.push(
        `docs.quickstart : « ${d.quickstart} » ne désigne aucune probe — la documentation serait ` +
        `déclarée vérifiée sans qu'aucune commande n'ait tourné`,
      );
    }
  }

  return errors;
}

const normaliser = (s: string) => s.trim().toLowerCase();

/**
 * Le contenu, une fois les LIGNES DE TITRE retirées.
 *
 * Mesurer la taille du fichier laisserait passer le cas le plus retors : un plan long
 * mais entièrement fait de titres, qui annonce six sections et n'en écrit aucune.
 */
function corpsUtile(texte: string): string {
  return texte
    .split("\n")
    .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

/** Les titres ATX (`#` … `######`), normalisés. La syntaxe Setext n'est pas lue. */
function titresDe(texte: string): Set<string> {
  const out = new Set<string>();
  for (const ligne of texte.split("\n")) {
    const m = ligne.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (m?.[1]) out.add(normaliser(m[1]));
  }
  return out;
}

const echec = (output: string): CheckResult => ({ name: "docs", status: "failed", output });

export async function checkDocs(input: {
  cfg: DocsConfig;
  projectDir: string;
  probes: ProbeOutcome[];
}): Promise<CheckResult> {
  const { cfg, projectDir, probes } = input;
  const nom = cfg.file ?? "README.md";

  const texte = await readFile(resolve(projectDir, nom), "utf8").catch(() => null);
  if (texte === null) {
    // Nommer le fichier attendu : « docs — failed » n'est pas actionnable, « README.md
    // attendu, absent » l'est.
    return echec(`documentation attendue dans « ${nom} » : fichier absent.`);
  }

  const corps = corpsUtile(texte);
  if (corps.length < MINIMUM) {
    return echec(
      `« ${nom} » existe mais ne documente rien : ${corps.length} caractère(s) de contenu hors titres, ` +
      `${MINIMUM} attendus au minimum. Un fichier présent n'est pas une documentation — et un plan ` +
      `qui annonce des sections sans les écrire non plus.`,
    );
  }

  const titres = titresDe(texte);
  const manquants = (cfg.sections ?? []).filter((s) => !titres.has(normaliser(s)));
  if (manquants.length) {
    return echec(`« ${nom} » : section(s) déclarée(s) absente(s) : ${manquants.join(", ")}.`);
  }

  if (!cfg.quickstart) {
    // `warn` et pas `passed` : « documenté mais jamais exécuté » est précisément l'état
    // qu'on veut voir signalé. En `passed`, il deviendrait indiscernable d'une doc
    // prouvée pour tout ce qui lit le STATUT — la CI, le rapport de nuit, l'agrégation —
    // c'est-à-dire pour tout le monde sauf un humain qui lit le texte.
    return {
      name: "docs",
      status: "warn",
      output:
        `« ${nom} » est documenté, mais RIEN NE LE PROUVE : aucune commande de cette doc n'a été ` +
        `exécutée. Déclare « docs.quickstart » avec l'id d'une probe qui joue le démarrage tel que ` +
        `le fichier le décrit — une doc fausse coûte plus cher qu'une doc absente.`,
    };
  }

  const p = probes.find((x) => x.id === cfg.quickstart);
  if (!p) {
    // Injoignable sur un run complet : `validateDocs` garantit que l'id existe. C'est
    // l'exécution partielle (`--only docs`) qui passe ici, et elle ne doit ni mentir en
    // vert, ni rougir sur une probe qu'on ne lui a pas demandé de lancer.
    return {
      name: "docs", status: "skipped", reason: "not-configured",
      output: `la probe « ${cfg.quickstart} » n'a pas été lancée dans ce run : la documentation n'est ni prouvée, ni infirmée.`,
    };
  }
  if (p.status === "skipped") {
    return echec(
      `la probe « ${p.id} », qui prouve « ${nom} », a été IGNORÉE (${p.output ?? "ignorée"}) — la documentation ` +
      `n'a donc PAS été vérifiée. Une doc contrôlée par une probe ignorée est une doc non contrôlée : ` +
      `ne cherche pas un échec d'exécution, il n'y en a pas eu.`,
    );
  }
  if (p.status === "failed") {
    return echec(
      `la probe « ${p.id} », qui joue le démarrage décrit dans « ${nom} », a ÉCHOUÉ : ${p.output ?? "échec"}. ` +
      `La documentation décrit des commandes qui ne fonctionnent pas — corrige le code ou corrige la doc.`,
    );
  }

  const note = cfg.sections?.length ? `, ${cfg.sections.length} section(s) présente(s)` : "";
  return {
    name: "docs",
    status: "passed",
    output: `« ${nom} » documente le projet${note}, et la probe « ${p.id} » a exécuté ce qu'il décrit.`,
  };
}
