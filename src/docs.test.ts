import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkDocs, validateDocs, type DocsConfig, type ProbeOutcome } from "./docs.js";

/**
 * Juger la DOCUMENTATION comme on juge le reste : en la constatant.
 *
 * Le réflexe naturel serait déclaratif — « il existe un README.md » — et c'est
 * exactement le vert vide que cet outil refuse partout ailleurs : un fichier présent
 * ne prouve ni qu'il documente, ni que ce qu'il raconte fonctionne. Ces tests tiennent
 * donc trois lignes de défense, et rien d'autre :
 *
 *  1. le fichier existe et NOMME sa cible quand il manque (sinon la correction n'est
 *     pas actionnable : « docs: failed » ne dit pas quel fichier écrire) ;
 *  2. il contient assez de matière pour être une documentation, titres exclus —
 *     « présent » n'est pas « documenté » ;
 *  3. les commandes qu'il donne à un nouveau venu sont réellement exécutées par une
 *     probe. C'est la seule partie qui CONSTATE ; le reste ne fait que lire.
 *
 * Le module n'existe pas encore : ces tests sont écrits contre l'interface publique,
 * et ils doivent échouer tant qu'elle n'est pas implémentée.
 */

type Files = Record<string, string>;

async function projet(files: Files): Promise<{ dir: string; clean: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "gates-docs-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return { dir, clean: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Du corps de texte indiscutablement au-dessus du seuil d'AC-D3 (200 caractères), pour
 * que les tests des AUTRES critères ne rougissent jamais par accident de volume.
 */
const CORPS = "Ce projet expose un service de facturation en ligne de commande. ".repeat(8);

const sortie = async (
  files: Files,
  cfg: DocsConfig = {},
  probes: ProbeOutcome[] = [],
) => {
  const { dir, clean } = await projet(files);
  try {
    return await checkDocs({ cfg, projectDir: dir, probes });
  } finally {
    await clean();
  }
};

const probe = (id: string, status: ProbeOutcome["status"]): ProbeOutcome => ({ id, status });

describe("validateDocs — ce qui se refuse au CHARGEMENT (exit 2)", () => {
  it("AC-D1 — un projet qui ne déclare pas de doc n'est pas rougi par surprise", () => {
    // `docs` absent = le check n'existe pas pour ce projet. Le contrat ne doit donc
    // rien reprocher : ajouter un garde-fou ne doit jamais casser les projets qui ne
    // l'ont pas demandé, sinon plus personne ne met à jour l'outil.
    expect(validateDocs(undefined, [])).toEqual([]);
    // Et une section complète et cohérente passe évidemment aussi.
    expect(validateDocs({ file: "DOCS.md", sections: ["Installation"], quickstart: "demarrage" }, ["demarrage"])).toEqual([]);
  });

  it("AC-D5 — un `quickstart` qui ne désigne aucune probe est refusé, et l'id fautif est nommé", () => {
    // C'est LE cas qui justifie une erreur de contrat plutôt qu'un rouge à l'exécution :
    // une clé que personne ne lit est silencieuse. Un `quickstart: "demarage"` (typo)
    // laisserait la doc « vérifiée » par une probe qui n'existe pas, donc verte sans
    // qu'aucune commande n'ait tourné. On refuse avant qu'un seul check ne démarre.
    const e = validateDocs({ quickstart: "demarage" }, ["demarrage"]).join("\n");
    expect(e).toContain("demarage");
  });

  it("AC-D5 — les clés de `docs` sont closes : une clé inconnue est nommée", () => {
    // Même raison : `sectons` ignoré en silence vaut un check qui ne contrôle plus rien.
    const e = validateDocs({ sectons: ["Installation"] }, []).join("\n");
    expect(e).toContain("sectons");
  });
});

describe("checkDocs — le fichier doit exister et documenter", () => {
  it("AC-D2 — fichier absent → failed, et la sortie NOMME le fichier attendu", async () => {
    // « docs: failed » n'est pas actionnable ; « README.md attendu, absent » l'est.
    const defaut = await sortie({ "src/main.ts": "// rien\n" });
    expect(defaut.status).toBe("failed");
    expect(defaut.output).toContain("README.md");

    // Et quand le projet déclare un autre fichier, c'est CELUI-LÀ qui est nommé —
    // sinon la sortie enverrait corriger le mauvais fichier.
    const declare = await sortie({ "README.md": `# Projet\n\n${CORPS}` }, { file: "docs/GUIDE.md" });
    expect(declare.status).toBe("failed");
    expect(declare.output).toContain("docs/GUIDE.md");
  });

  it("AC-D3 — « présent » n'est pas « documenté » : un fichier sans matière → failed", async () => {
    // Le piège que ce critère ferme : un agent à qui on demande une doc peut créer un
    // README.md d'une ligne et satisfaire n'importe quel contrôle déclaratif.
    const vide = await sortie({ "README.md": "" });
    expect(vide.status).toBe("failed");

    const squelette = await sortie({ "README.md": "# Projet\n\nUn petit outil.\n" });
    expect(squelette.status).toBe("failed");

    // Cas le plus retors : le fichier est LONG, mais uniquement en titres. Le volume
    // se mesure donc sur le contenu une fois les titres Markdown retirés, pas sur la
    // taille du fichier — sinon un plan vide suffirait à passer.
    const plan = await sortie({
      "README.md": [
        "# Projet de facturation en ligne de commande",
        "## Installation depuis les sources du dépôt",
        "## Démarrage rapide pour un nouveau venu",
        "## Configuration des variables d'environnement",
        "### Détail des options de la ligne de commande",
        "## Contribution et remontée des anomalies",
      ].join("\n\n"),
    });
    expect(plan.status).toBe("failed");
  });

  it("AC-D4 — un titre déclaré et manquant → failed, et la sortie nomme CE titre", async () => {
    const r = await sortie(
      { "README.md": `# Projet\n\n## Installation\n\n${CORPS}` },
      { sections: ["Installation", "Démarrage rapide"] },
    );
    expect(r.status).toBe("failed");
    // Nommer le titre manquant, pas « une section manque » : la sortie doit dire quoi
    // écrire. Rien n'est affirmé sur la formulation, seulement sur l'information.
    expect(r.output).toContain("Démarrage rapide");
  });

  it("AC-D4 — la comparaison des titres ignore la casse et les espaces de bord", async () => {
    // Un titre reste un titre qu'il soit écrit « Installation » ou « INSTALLATION  » :
    // rougir là-dessus ferait du check un correcteur de style, pas un juge de doc.
    const r = await sortie(
      { "README.md": `# Projet\n\n##   INSTALLATION  \n\n${CORPS}\n\n###  démarrage Rapide\n\n${CORPS}` },
      { sections: ["installation", "Démarrage rapide"] },
    );
    expect(r.status).not.toBe("failed");
  });
});

describe("checkDocs — la doc n'est prouvée que par une exécution", () => {
  const README = `# Projet\n\n## Démarrage rapide\n\n${CORPS}`;
  const cfg: DocsConfig = { sections: ["Démarrage rapide"], quickstart: "demarrage" };

  it("AC-D6 — la probe du quickstart est `failed` → la doc est failed", async () => {
    // La doc décrit des commandes qui ne marchent pas : c'est une doc fausse, et une
    // doc fausse est pire qu'une doc absente pour celui qui suit ses instructions.
    const r = await sortie({ "README.md": README }, cfg, [probe("demarrage", "failed")]);
    expect(r.status).toBe("failed");
    // La probe fautive est nommée, comme partout ailleurs dans l'outil.
    expect(r.output).toContain("demarrage");
  });

  it("AC-D6 — la probe du quickstart est `skipped` → failed AUSSI, et la sortie le dit", async () => {
    // Test distinct du précédent, parce que c'est ici que le faux vert entrerait :
    // `skipped` se lit spontanément comme « non concerné » et un `!== "failed"` le
    // laisserait passer. Une doc vérifiée par une probe ignorée est une doc NON
    // vérifiée — même verdict, mais la sortie doit distinguer les deux cas, sinon on
    // cherchera un échec d'exécution qui n'a jamais eu lieu.
    const r = await sortie({ "README.md": README }, cfg, [probe("demarrage", "skipped")]);
    expect(r.status).toBe("failed");
    expect(r.output).toContain("demarrage");
    expect(r.output).toMatch(/ignor|skip|non exécut|pas exécut/i);
  });

  it("AC-D7 — fichier substantiel, sections présentes, probe verte → passed", async () => {
    const r = await sortie({ "README.md": README }, cfg, [
      probe("autre-probe", "failed"), // une probe sans rapport ne doit pas contaminer le verdict
      probe("demarrage", "passed"),
    ]);
    expect(r.status).toBe("passed");
    expect(r.name).toBe("docs");
  });

  it("AC-D8 — `docs` sans `quickstart` : valide au contrat, mais warn et jamais le vert d'AC-D7", async () => {
    // `quickstart` est facultatif : l'exiger casserait les projets qui documentent sans
    // probe de démarrage, donc aucune erreur de contrat.
    expect(validateDocs({ sections: ["Démarrage rapide"] }, [])).toEqual([]);

    // Mais le verdict retenu est `warn`, pas `passed` : « documenté mais jamais
    // exécuté » est précisément l'état qu'on veut voir signalé. Le rendre `passed`
    // avec une mention dans la sortie le rendrait indiscernable d'AC-D7 pour tout ce
    // qui lit le statut — CI, rapport, agrégation — c'est-à-dire pour tout le monde
    // sauf un humain qui lit le texte. `warn` signale sans bloquer : le projet reste
    // vert globalement, mais l'écart est visible.
    const r = await sortie({ "README.md": README }, { sections: ["Démarrage rapide"] });
    expect(r.status).toBe("warn");
    expect(r.output).toContain("quickstart");
  });
});
