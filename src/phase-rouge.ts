import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { CheckResult } from "./types.js";

/**
 * La PHASE ROUGE — qui juge les juges.
 *
 * Les probes SONT les tests de ce montage, et rien ne vérifiait qu'elles dépendent du
 * code. Une probe qui passerait sur un dépôt vide rend son critère vert **sans avoir
 * rien constaté** : c'est le défaut d'origine de ce projet, déplacé d'un cran — et le
 * faux vert le plus coûteux qui soit, parce qu'il se présente exactement comme un vrai.
 *
 * On rejoue donc les probes sur une copie du projet dont les livrables sont VIDÉS, et on
 * exige que chacune échoue. Trois invariants gouvernent tout ce fichier :
 *
 *  1. on VIDE, on ne supprime pas — un fichier absent casse la résolution de modules et
 *     la probe échouerait pour une raison étrangère au comportement attendu ;
 *  2. on ne touche JAMAIS au dépôt d'origine ;
 *  3. rien ne doit rendre la phase rouge VACANTE. Des cibles mal choisies ou des
 *     dépendances manquantes feraient échouer toutes les probes pour rien, et on
 *     conclurait « tout est rouge, donc tout va bien » sans avoir rien exécuté.
 *
 * ⚠️ Ce qu'elle ne dit pas : qu'une probe dépende du code ne prouve pas qu'elle vérifie
 * la BONNE chose. Elle ferme la probe *creuse*, pas la probe *complaisante* — celle qui
 * constate ce que le code fait au lieu de ce que la spec demande. Contre celle-là, le
 * seul rempart est l'approbation humaine des critères.
 */

export type ProbeRouge = {
  id: string;
  criterion?: string;
  status: "passed" | "failed" | "skipped";
  output?: string;
};

/** Dossiers RATTACHÉS à l'original (lien) au lieu d'être recopiés : lourds, et nécessaires. */
const LIENS = new Set(["node_modules", ".venv", "venv", "vendor"]);

/**
 * Dossiers ni copiés ni rattachés.
 *
 * `.git` en tête, et pour une raison qui n'est pas la taille : rattaché, une probe qui
 * lance `git` écrirait dans le dépôt réel. Les sorties de compilation suivent — les
 * recopier laisserait une probe passer sur un `dist/` d'avant la neutralisation, donc
 * rendrait creuse une probe qui ne l'est pas.
 */
const IGNORES = new Set([
  ".git", "dist", "build", "out", "coverage", ".next", ".turbo", "target",
  "__pycache__", ".hermes-debug", ".pytest_cache", ".mypy_cache",
]);

/**
 * Fichiers de test, JAMAIS vidés par le repli sur `roots`.
 *
 * Le trou que ça ferme : un projet qui range ses tests sous `src/` verrait la phase rouge
 * les vider aussi. Une suite de tests vide passe — donc la probe qui la lance passerait —
 * donc on dénoncerait comme creuse une probe parfaitement valable. L'exclusion se fait
 * dans la direction SÛRE : ne pas vider un fichier ne peut produire qu'un faux vert
 * (une probe creuse non détectée), jamais un faux rouge qui ferait boucler l'agent.
 *
 * Elle ne s'applique PAS à `deliverables` : ce qui est déclaré est déclaré.
 */
const TESTS = [
  /(^|\/)__tests__\//, /(^|\/)tests?\//,
  /\.(test|spec)\.[^/]+$/, /(^|\/)test_[^/]*\.py$/, /_test\.(go|py|rb)$/,
];

const estUnTest = (f: string) => TESTS.some((re) => re.test(f));

/** `a/b` est-il sous `racine` ? Frontière de DOSSIER, jamais préfixe de chaîne. */
const sousRacine = (fichier: string, racine: string) => {
  const r = racine.replace(/[\\/]+$/, "");
  return r === "." ? true : fichier === r || fichier.startsWith(`${r}/`);
};

/**
 * Les fichiers que la phase rouge videra.
 *
 * `deliverables` d'abord : le contrat dit ce qui compte dans ce projet, et le deviner
 * serait un pari dont les deux issues sont mauvaises — un livrable oublié rend un faux
 * vert, un fichier de trop rend un faux rouge.
 */
export function ciblesDe(
  cfg: { deliverables?: string[]; roots?: string[] },
  fichiersDuProjet: string[],
): string[] {
  const connus = new Set(fichiersDuProjet);

  // `deliverables: []` n'est pas une déclaration : sans ce repli, une clé laissée vide
  // neutraliserait toute la phase rouge en silence — aucun fichier vidé, donc aucune
  // probe en échec, donc un vert qui n'a rien prouvé.
  if (cfg.deliverables?.length) {
    return [...new Set(cfg.deliverables.filter((f) => connus.has(f)))].sort();
  }

  const racines = cfg.roots?.length ? cfg.roots : ["src"];
  return fichiersDuProjet
    .filter((f) => racines.some((r) => sousRacine(f, r)) && !estUnTest(f))
    .sort();
}

async function copier(src: string, dst: string, rates: string[]): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) {
      if (IGNORES.has(e.name)) continue;
      if (LIENS.has(e.name)) {
        // `junction` n'a de sens que sous Windows, où il évite d'exiger un privilège ;
        // ailleurs le type est ignoré. Un échec n'est pas rattrapable en silence : sans
        // dépendances, toutes les probes échoueraient et la phase rouge se prouverait
        // elle-même vacante.
        await symlink(s, d, "junction").catch((err) => rates.push(`${e.name} (${err?.code ?? err})`));
        continue;
      }
      await copier(s, d, rates);
    } else if (e.isFile()) {
      await copyFile(s, d);
    }
    // Les liens déjà présents dans le projet ne sont ni suivis ni recréés : les suivre
    // ferait sortir la copie du projet.
  }
}

export async function preparerArbreNeutralise(
  projectDir: string,
  cibles: string[],
): Promise<{ dir: string; nettoyer: () => Promise<void> } | { erreur: string }> {
  const racine = resolve(projectDir);

  // Une cible qui sort du projet n'est pas une faute à contourner : c'est un juge à qui
  // on désigne quoi abîmer. On refuse avant d'avoir copié quoi que ce soit.
  for (const c of cibles) {
    const rel = relative(racine, resolve(racine, c));
    if (!rel || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
      return { erreur: `cible hors du projet : « ${c} »` };
    }
  }

  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), "gates-rouge-"));
  } catch (e) {
    return { erreur: `impossible de créer l'arbre neutralisé : ${(e as Error).message}` };
  }
  const nettoyer = () => rm(dir, { recursive: true, force: true });

  const rates: string[] = [];
  try {
    await copier(racine, dir, rates);
  } catch (e) {
    await nettoyer();
    return { erreur: `copie du projet impossible : ${(e as Error).message}` };
  }

  if (rates.length) {
    await nettoyer();
    return {
      erreur:
        `dépendances non rattachées (${rates.join(", ")}) — sans elles, toutes les probes échoueraient ` +
        `faute de pouvoir démarrer, et la phase rouge conclurait « tout est rouge » sans avoir rien exécuté`,
    };
  }

  try {
    for (const c of cibles) await writeFile(join(dir, c), "", "utf8").catch(() => {});
  } catch (e) {
    await nettoyer();
    return { erreur: `neutralisation impossible : ${(e as Error).message}` };
  }

  return { dir, nettoyer };
}

const NOM = "phase-rouge";

/** `« id » (AC-n)`, ou `(aucun critère)` — jamais « undefined », que personne ne sait corriger. */
const etiquette = (p: ProbeRouge) => `« ${p.id} » (${p.criterion ?? "aucun critère"})`;

export function verdictPhaseRouge(input: { probes: ProbeRouge[]; cibles: string[] }): CheckResult {
  const { probes, cibles } = input;
  const vides = `${cibles.length} livrable(s) vidé(s)`;

  if (!probes.length) {
    return { name: NOM, status: "skipped", reason: "not-configured", output: "aucune probe à rejouer." };
  }

  const creuses = probes.filter((p) => p.status === "passed");
  const ignorees = probes.filter((p) => p.status === "skipped");
  const eprouvees = probes.filter((p) => p.status === "failed");

  const noteIgnorees = ignorees.length
    ? `\nNon concluant — probe(s) ignorée(s), donc jamais éprouvée(s) : ${ignorees.map(etiquette).join(", ")}.`
    : "";

  if (creuses.length) {
    return {
      name: NOM,
      status: "failed",
      output: [
        `${creuses.length} probe(s) PASSENT alors que le code est vide (${vides}) : ${creuses.map(etiquette).join(", ")}.`,
        `Elles ne constatent rien du projet — le critère qu'elles rendent vert n'est pas vérifié.`,
        `Corrige la PROBE pour qu'elle observe réellement le comportement décrit par son critère ;`,
        `si elle échoue ensuite, c'est le code qu'il faut écrire.${noteIgnorees}`,
      ].join("\n"),
    };
  }

  // Aucune probe verte ET aucune éprouvée : rien n'a tourné. Un `passed` annoncerait ici
  // une garantie qui n'existe pas — c'est le faux vert que ferait un `every(failed)`.
  if (!eprouvees.length) {
    return {
      name: NOM,
      status: "skipped",
      reason: "not-configured",
      output: `aucune probe n'a pu être éprouvée (toutes ignorées) : ${ignorees.map(etiquette).join(", ")}.`,
    };
  }

  return {
    name: NOM,
    status: "passed",
    output: `${eprouvees.length} probe(s) s'effondrent avec le code (${vides}) : chacune dépend bien du projet.${noteIgnorees}`,
  };
}
