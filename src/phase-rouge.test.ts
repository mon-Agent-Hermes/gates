import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ciblesDe,
  preparerArbreNeutralise,
  verdictPhaseRouge,
  type ProbeRouge,
} from "./phase-rouge.js";

/**
 * La PHASE ROUGE : prouver qu'une probe dépend vraiment du projet qu'elle juge.
 *
 * Le trou qu'on ferme ici : rien ne garantit qu'une probe rattachée à `AC-n` constate
 * quoi que ce soit. Une probe qui passerait sur un dépôt vide rend un critère vert sans
 * avoir rien observé — c'est le faux vert le plus coûteux de l'outil, parce qu'il se
 * présente exactement comme un vrai. On le débusque mécaniquement : on rejoue les probes
 * sur une COPIE du projet dont les livrables sont vidés, et on exige que chacune échoue.
 *
 * Trois invariants gouvernent tous les tests qui suivent :
 *
 *  1. on VIDE, on ne supprime pas — un fichier absent casse la résolution de modules et
 *     la probe échouerait pour une raison sans rapport avec le comportement attendu ;
 *  2. on ne touche JAMAIS au dépôt d'origine — un juge qui abîme ce qu'il juge est pire
 *     que pas de juge ;
 *  3. rien ne doit rendre la phase rouge vacante : ni des cibles mal choisies, ni des
 *     dépendances manquantes, qui feraient échouer toutes les probes pour rien et
 *     conclureraient « tout est rouge, donc tout va bien ».
 *
 * Le module n'existe pas encore : ces tests sont écrits contre la seule interface
 * publique et doivent échouer tant qu'elle n'est pas implémentée. La phase rouge
 * s'applique ici à elle-même.
 */

type Files = Record<string, string>;

async function projet(files: Files): Promise<{ dir: string; clean: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "gates-rouge-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return { dir, clean: () => rm(dir, { recursive: true, force: true }) };
}

const existe = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * AC-R5 exige un lien (ou une jonction) vers `node_modules`. Certaines plateformes ou
 * certains comptes l'interdisent ; on veut alors un test qui DIT qu'il n'a pas pu
 * vérifier, jamais un test vert qui n'a rien constaté.
 */
async function lienDeDossierPossible(): Promise<boolean> {
  const racine = await mkdtemp(join(tmpdir(), "gates-rouge-lien-"));
  try {
    await mkdir(join(racine, "cible"), { recursive: true });
    await symlink(join(racine, "cible"), join(racine, "lien"), "junction");
    return true;
  } catch {
    return false;
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
}

const probe = (
  id: string,
  status: ProbeRouge["status"],
  criterion?: string,
): ProbeRouge => (criterion === undefined ? { id, status } : { id, status, criterion });

describe("ciblesDe — désigner ce qu'on videra, et rien d'autre", () => {
  it("AC-R1 — `deliverables` déclaré fait loi et PRIME sur `roots`", () => {
    // Le contrat dit ce qui compte dans ce projet ; le deviner à partir de l'arborescence
    // serait un pari, et un mauvais pari ici rend la phase rouge fausse dans les deux
    // sens (livrable oublié = faux vert, fichier de trop = faux rouge).
    const fichiers = ["src/jeu.ts", "src/hud.ts", "lib/moteur.ts", "gates.json"];
    const cibles = ciblesDe({ deliverables: ["lib/moteur.ts", "src/jeu.ts"], roots: ["src"] }, fichiers);

    expect(cibles).toContain("lib/moteur.ts");
    expect(cibles).toContain("src/jeu.ts");
    // `src/hud.ts` est sous `roots` mais n'est pas déclaré : `roots` n'a pas voix au
    // chapitre dès que `deliverables` existe, sinon « déclarer » ne servirait à rien.
    expect(cibles).not.toContain("src/hud.ts");
    // Triées : la liste sert à des sorties et des comparaisons, l'ordre du système de
    // fichiers ne doit pas rendre les résultats instables d'une machine à l'autre.
    expect(cibles).toEqual([...cibles].sort());

    // Frontière explicite du critère : `deliverables: []` n'est pas une déclaration, on
    // retombe sur `roots`. Sans ça, une clé laissée vide neutraliserait toute la phase
    // rouge en silence — aucun fichier vidé, donc aucune probe en échec, donc « vert ».
    expect(ciblesDe({ deliverables: [], roots: ["src"] }, fichiers)).toEqual(["src/hud.ts", "src/jeu.ts"]);
  });

  it("AC-R2 — sans `deliverables`, les cibles sont les fichiers sous `roots` (défaut `src`)", () => {
    const fichiers = ["src/jeu.ts", "src/ui/hud.ts", "lib/moteur.ts", "gates.json", "README.md"];

    // `roots` explicite : la descente est récursive, et tout ce qui est en dehors est
    // hors de portée. Vider `gates.json` ou un fichier de test ferait échouer les probes
    // pour une raison étrangère au comportement, et la phase rouge conclurait à tort que
    // tout va bien — c'est le faux vert exact qu'elle est censée interdire.
    expect(ciblesDe({ roots: ["src"] }, fichiers)).toEqual(["src/jeu.ts", "src/ui/hud.ts"]);

    // `roots` absent : le défaut est `["src"]`, pas « tout le dépôt ».
    expect(ciblesDe({}, fichiers)).toEqual(["src/jeu.ts", "src/ui/hud.ts"]);

    // Plusieurs racines, et le résultat reste trié globalement, pas racine par racine.
    const deux = ciblesDe({ roots: ["src", "lib"] }, fichiers);
    expect(deux).toEqual(["lib/moteur.ts", "src/jeu.ts", "src/ui/hud.ts"]);

    // Le piège qui rend une phase rouge destructrice : `srcs/` et `source.ts` commencent
    // par `src` sans être dans `src/`. La correspondance est sur la frontière de dossier,
    // pas sur le préfixe de chaîne.
    expect(ciblesDe({ roots: ["src"] }, ["srcs/autre.ts", "source.ts", "src/jeu.ts"])).toEqual(["src/jeu.ts"]);
  });

  it("AC-R3 — quand rien ne correspond, la liste est vide (et non « tout »)", () => {
    // Le cas où l'on n'a pas su identifier le code du projet. Renvoyer une liste vide
    // permet à l'appelant de rendre `skipped` : on ne peut pas prouver qu'une probe
    // dépend d'un code qu'on n'a pas su nommer. L'alternative tentante — se rabattre sur
    // tous les fichiers — viderait la configuration et les tests, et donnerait un rouge
    // massif présenté comme une preuve.
    expect(ciblesDe({ roots: ["lib"] }, ["src/jeu.ts", "gates.json"])).toEqual([]);
    expect(ciblesDe({}, ["index.js", "package.json"])).toEqual([]);
    expect(ciblesDe({}, [])).toEqual([]);
  });
});

describe("preparerArbreNeutralise — une copie vidée, un original intact", () => {
  it("AC-R4 — les cibles sont VIDÉES dans la copie, le reste est conservé, l'original est intact", async () => {
    const JEU = "export const tirer = () => 42;\n";
    const HUD = "export const afficher = () => 'hud';\n";
    const CONF = '{ "entry": "src/jeu.ts" }\n';
    const { dir: origine, clean } = await projet({
      "src/jeu.ts": JEU,
      "src/ui/hud.ts": HUD,
      "gates.json": CONF,
    });

    let nettoyer: (() => Promise<void>) | undefined;
    try {
      const r = await preparerArbreNeutralise(origine, ["src/jeu.ts", "src/ui/hud.ts"]);
      if ("erreur" in r) throw new Error(r.erreur);
      nettoyer = r.nettoyer;

      // On travaille bien AILLEURS : neutraliser sur place reviendrait à saborder le
      // dépôt jugé pour la durée du jugement.
      expect(r.dir).not.toBe(origine);

      // Vidé, pas supprimé : le fichier existe toujours (`readFile` le prouve), son
      // contenu ne fait plus rien. Le module se charge, la résolution tient, la probe
      // échoue sur l'absence de COMPORTEMENT — la seule raison d'échouer qui prouve
      // quelque chose.
      expect(await readFile(join(r.dir, "src/jeu.ts"), "utf8")).toBe("");
      expect(await readFile(join(r.dir, "src/ui/hud.ts"), "utf8")).toBe("");

      // Ce qui n'est pas une cible arrive intact, sinon la probe échouerait pour une
      // configuration illisible et non pour un livrable creux.
      expect(await readFile(join(r.dir, "gates.json"), "utf8")).toBe(CONF);

      // L'invariant qui prime sur tous les autres : le dépôt d'origine n'a pas bougé,
      // CIBLES COMPRISES. C'est le seul défaut de cet outil qui coûterait du travail
      // réel à l'utilisateur plutôt qu'un verdict faux.
      expect(await readFile(join(origine, "src/jeu.ts"), "utf8")).toBe(JEU);
      expect(await readFile(join(origine, "src/ui/hud.ts"), "utf8")).toBe(HUD);
      expect(await readFile(join(origine, "gates.json"), "utf8")).toBe(CONF);
    } finally {
      await nettoyer?.();
      await clean();
    }
  });

  it("AC-R4 — après `nettoyer()`, la copie a disparu et l'original est toujours là", async () => {
    // Le juge tourne en boucle sur la même machine : une copie par exécution qui survit,
    // c'est le disque qui se remplit et, tôt ou tard, des exécutions qui échouent pour
    // une raison qui n'a rien à voir avec le projet jugé.
    const { dir: origine, clean } = await projet({ "src/jeu.ts": "export const x = 1;\n" });
    try {
      const r = await preparerArbreNeutralise(origine, ["src/jeu.ts"]);
      if ("erreur" in r) throw new Error(r.erreur);

      await r.nettoyer();
      expect(await existe(r.dir)).toBe(false);
      expect(await readFile(join(origine, "src/jeu.ts"), "utf8")).toBe("export const x = 1;\n");
    } finally {
      await clean();
    }
  });

  it("AC-R5 — `node_modules` n'est pas recopié mais reste ATTEIGNABLE depuis la copie", async () => {
    // Sans les dépendances, chaque probe échouerait faute de pouvoir démarrer, et la
    // phase rouge se prouverait elle-même vacante : elle annoncerait « tout est rouge »
    // sans avoir rien exécuté. Et les recopier coûterait des secondes à chaque probe.
    const { dir: origine, clean } = await projet({
      "src/jeu.ts": "export const x = 1;\n",
      "node_modules/une-dep/index.js": "module.exports = 1;\n",
    });

    let nettoyer: (() => Promise<void>) | undefined;
    try {
      if (!(await lienDeDossierPossible())) {
        // Constaté explicitement : un test qui se tairait ici laisserait AC-R5 sans
        // aucune vérification tout en affichant du vert.
        expect.fail(
          "les liens/jonctions de dossier sont impossibles sur cette plateforme : AC-R5 n'a PAS pu être vérifié",
        );
      }

      const r = await preparerArbreNeutralise(origine, ["src/jeu.ts"]);
      if ("erreur" in r) throw new Error(r.erreur);
      nettoyer = r.nettoyer;

      // Atteignable : c'est la seule chose qui compte pour les probes.
      expect(await readFile(join(r.dir, "node_modules/une-dep/index.js"), "utf8")).toBe("module.exports = 1;\n");

      // Non recopié : on l'observe sans rien supposer du mécanisme (lien, jonction,
      // montage) — un fichier ajouté à l'original APRÈS la copie doit être visible
      // depuis la copie, ce qu'une recopie ne permettrait pas.
      await mkdir(join(origine, "node_modules/apres"), { recursive: true });
      await writeFile(join(origine, "node_modules/apres/index.js"), "module.exports = 2;\n", "utf8");
      expect(await readFile(join(r.dir, "node_modules/apres/index.js"), "utf8")).toBe("module.exports = 2;\n");

      // Corollaire indispensable de ce choix : effacer la copie doit s'arrêter au lien.
      // Un effacement qui le traverse supprimerait les dépendances du projet jugé — la
      // pire façon possible de terminer un jugement.
      await nettoyer();
      nettoyer = undefined;
      expect(await readFile(join(origine, "node_modules/une-dep/index.js"), "utf8")).toBe("module.exports = 1;\n");
    } finally {
      await nettoyer?.();
      await clean();
    }
  });
});

describe("verdictPhaseRouge — ce que prouve une probe rejouée sur du vide", () => {
  const cibles = ["src/jeu.ts"];

  it("AC-R6 — une probe `passed` sur l'arbre neutralisé → failed, en nommant la probe ET son critère", async () => {
    // Le cœur du garde-fou. Cette probe passe alors que le livrable ne fait plus rien :
    // elle ne constate donc pas le projet, et le critère qu'elle rend vert est vide.
    const r = verdictPhaseRouge({
      probes: [
        probe("tir-touche", "failed", "AC-1"),
        probe("hud-affiche", "passed", "AC-3"),
      ],
      cibles,
    });
    expect(r.status).toBe("failed");
    // Nommer les deux : l'id pour savoir quelle probe réécrire, le critère pour savoir
    // lequel n'est plus couvert. « phase-rouge: failed » n'est pas actionnable.
    expect(r.output).toContain("hud-affiche");
    expect(r.output).toContain("AC-3");
  });

  it("AC-R7 — toutes les probes `failed` → passed", async () => {
    // Le cas nominal : chaque probe s'est effondrée avec le code qu'elle est censée
    // observer. C'est la seule configuration qui prouve la dépendance.
    const r = verdictPhaseRouge({
      probes: [
        probe("tir-touche", "failed", "AC-1"),
        probe("hud-affiche", "failed", "AC-3"),
      ],
      cibles,
    });
    expect(r.status, r.output).toBe("passed");
  });

  it("AC-R8 — une probe `skipped` ne prouve rien : le verdict tient, mais elle est signalée", async () => {
    // `skipped` se lit spontanément comme « non concerné », et un simple
    // `every(p => p.status === "failed")` la compterait comme un échec de plus — donc
    // comme une preuve. Une probe qui n'a pas tourné n'a rien constaté : le verdict des
    // autres reste bon, mais la sortie doit dire qu'un critère n'a pas été éprouvé.
    const r = verdictPhaseRouge({
      probes: [
        probe("tir-touche", "failed", "AC-1"),
        probe("hud-affiche", "skipped", "AC-3"),
      ],
      cibles,
    });
    expect(r.status, r.output).toBe("passed");
    expect(r.output).toContain("hud-affiche");
    expect(r.output).toMatch(/ignor|skip|non conclu|non exécut|pas exécut/i);
  });

  it("AC-R8 — TOUTES les probes `skipped` → skipped : rien n'a été prouvé", async () => {
    // Test distinct du précédent parce que c'est ici qu'entrerait le faux vert : aucune
    // probe verte, donc « rien à reprocher », donc `passed` — alors qu'aucune probe n'a
    // tourné. Un `passed` annoncerait une garantie qui n'existe pas.
    const r = verdictPhaseRouge({
      probes: [
        probe("tir-touche", "skipped", "AC-1"),
        probe("hud-affiche", "skipped", "AC-3"),
      ],
      cibles,
    });
    expect(r.status).toBe("skipped");
  });

  it("AC-R9 — une probe sans `criterion` est jugée comme les autres, sans « undefined » dans la sortie", async () => {
    // Une probe non rattachée reste creuse si elle passe sur du vide : l'exempter
    // ouvrirait une échappatoire triviale — retirer `criterion` pour échapper au juge.
    const r = verdictPhaseRouge({ probes: [probe("probe-libre", "passed")], cibles });
    expect(r.status).toBe("failed");
    expect(r.output).toContain("probe-libre");
    // La sortie est lue par un humain qui doit corriger : un « AC-undefined » le
    // enverrait chercher un critère qui n'existe pas.
    expect(r.output).not.toMatch(/undefined/);

    // Et l'absence de `criterion` ne doit pas non plus salir une sortie par ailleurs
    // verte.
    const vert = verdictPhaseRouge({ probes: [probe("probe-libre", "failed")], cibles });
    expect(vert.status, vert.output).toBe("passed");
    expect(vert.output).not.toMatch(/undefined/);
  });
});
