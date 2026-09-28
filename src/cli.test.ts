import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { annotationsDuVerdict, check, parseArgs, sortieGitHub } from "./cli.js";
import { buildCriteria, buildReport, fichierEtat, renderAnnotations } from "./report.js";

/**
 * Validation de bout en bout sur PLUSIEURS TYPES DE PROJETS.
 *
 * L'enjeu de ces tests n'est pas le web : c'est que le montage tienne sur ce que
 * l'agent produira réellement — un CLI, un service, un générateur d'artefacts. Le gate
 * d'assemblage, lui, ne conclut que sur un graphe d'imports JS/HTML ; hors de là, c'est
 * `coverage` qui porte SEUL l'atteignabilité. On vérifie donc surtout que la couverture
 * dit vrai, et qu'elle se tait plutôt que de mentir quand elle n'a pas pu observer.
 */

type Files = Record<string, string>;

async function projet(files: Files): Promise<{ dir: string; clean: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "gates-e2e-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return { dir, clean: () => rm(dir, { recursive: true, force: true }) };
}

const byName = (r: any, name: string) => r.report.checks.find((c: any) => c.name === name);

const SPEC = `# Spec\n\n## Critères d'acceptation\n\n- **AC-1** — la commande s'exécute et fait son travail.\n`;

describe("projet CLI (aucun front, aucun serveur)", () => {
  const base: Files = {
    "spec.md": SPEC,
    "src/main.mjs": [
      `import { calculer } from "./calcul.mjs";`,
      `import { afficherAide } from "./aide.mjs"; // importé, JAMAIS appelé`,
      `console.log("resultat", calculer(2));`,
      ``,
    ].join("\n"),
    "src/calcul.mjs": `export function calculer(n) { return n * 2; }\n`,
    "src/aide.mjs": `export function afficherAide() { console.log("aide"); }\n`,
    "gates.json": JSON.stringify({
      entry: "src/main.mjs",
      roots: ["src"],
      probes: [{ id: "lance-la-commande", criterion: "AC-1", kind: "cli", run: "node src/main.mjs", expect: { exitCode: 0 } }],
      coverage: { runtime: "node", requireExecuted: ["src/**/*.mjs"] },
    }),
  };

  it("assemblage VERT et couverture ROUGE sur le module câblé mais jamais appelé", async () => {
    // C'est LE test qui justifie §2.6 : si les deux gates disaient la même chose,
    // la couverture n'apporterait rien à un projet JS. `aide.mjs` est importé (donc
    // atteignable) mais aucune de ses fonctions n'entre en jeu.
    const { dir, clean } = await projet(base);
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");

      expect(byName(r, "assembly").status, byName(r, "assembly").output).toBe("passed");
      const cov = byName(r, "coverage");
      expect(cov.status, cov.output).toBe("failed");
      expect(cov.output).toMatch(/aide\.mjs/);
      expect(cov.output).toMatch(/Chargé mais aucune de ses fonctions/);
      expect(cov.output).not.toMatch(/calcul\.mjs/);
      expect(r.ok).toBe(false);
    } finally { await clean(); }
  }, 60_000);

  it("une fois la fonction réellement appelée, tout est vert et AC-1 est vérifié", async () => {
    const { dir, clean } = await projet({
      ...base,
      "src/main.mjs": [
        `import { calculer } from "./calcul.mjs";`,
        `import { afficherAide } from "./aide.mjs";`,
        `console.log("resultat", calculer(2));`,
        `afficherAide();`,
        ``,
      ].join("\n"),
    });
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");
      expect(byName(r, "coverage").status, byName(r, "coverage").output).toBe("passed");
      expect(r.report.criteria?.["AC-1"].status).toBe("passed");
      expect(r.ok, JSON.stringify(r.report.checks)).toBe(true);
    } finally { await clean(); }
  }, 60_000);

  it("allowUnexecuted exempte explicitement (échappatoire visible dans gates.json)", async () => {
    const { dir, clean } = await projet({
      ...base,
      "gates.json": JSON.stringify({
        entry: "src/main.mjs",
        roots: ["src"],
        probes: [{ id: "lance-la-commande", criterion: "AC-1", kind: "cli", run: "node src/main.mjs", expect: { exitCode: 0 } }],
        coverage: { runtime: "node", requireExecuted: ["src/**/*.mjs"], allowUnexecuted: ["src/aide.mjs"] },
      }),
    });
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");
      expect(byName(r, "coverage").status).toBe("passed");
    } finally { await clean(); }
  }, 60_000);
});

describe("projet générateur d'artefact (ni front, ni serveur, ni routes)", () => {
  it("l'artefact est produit, et le module de mise en forme jamais appelé est vu mort", async () => {
    const { dir, clean } = await projet({
      "spec.md": `# Spec\n\n## Critères d'acceptation\n\n- **AC-2** — la commande produit un rapport non vide.\n`,
      "src/export.mjs": [
        `import { writeFileSync } from "node:fs";`,
        `import { enTexte } from "./format.mjs";`,
        `import { enCsv } from "./csv.mjs"; // jamais appelé`,
        `writeFileSync(process.argv[2], enTexte([1, 2, 3]));`,
        ``,
      ].join("\n"),
      "src/format.mjs": `export function enTexte(xs) { return xs.join("\\n") + "\\n"; }\n`,
      "src/csv.mjs": `export function enCsv(xs) { return xs.join(","); }\n`,
      "gates.json": JSON.stringify({
        entry: "src/export.mjs",
        roots: ["src"],
        probes: [{
          id: "produit-le-rapport", criterion: "AC-2", kind: "artifact",
          run: "node src/export.mjs $TMP/rapport.txt", file: "$TMP/rapport.txt",
          expect: { minBytes: 3 },
        }],
        coverage: { runtime: "node", requireExecuted: ["src/**/*.mjs"] },
      }),
    });
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");
      expect(byName(r, "probes").status, byName(r, "probes").output).toBe("passed");
      expect(r.report.criteria?.["AC-2"].status).toBe("passed");

      const cov = byName(r, "coverage");
      expect(cov.status, cov.output).toBe("failed");
      expect(cov.output).toMatch(/csv\.mjs/);
    } finally { await clean(); }
  }, 60_000);
});

describe("projet service HTTP (le cas majoritaire : le code ne vit que dans le serveur)", () => {
  const serveur = (handleSigterm: boolean) => [
    `import { createServer } from "node:http";`,
    `import { listerTaches } from "./src/taches.mjs";`,
    `import { supprimerTache } from "./src/admin.mjs"; // route jamais montée`,
    `const server = createServer((req, res) => {`,
    `  if (req.url === "/taches") { res.end(JSON.stringify(listerTaches())); return; }`,
    `  res.statusCode = 404; res.end("non");`,
    `});`,
    `server.listen(${"${PORT}"});`,
    handleSigterm
      ? `process.on("SIGTERM", () => { server.close(); process.exit(0); });`
      : `// pas de handler SIGTERM : le process sera tué sans écrire sa couverture`,
    ``,
  ].join("\n");

  const files = (port: number, handleSigterm: boolean): Files => ({
    "spec.md": `# Spec\n\n## Critères d'acceptation\n\n- **AC-7** — GET /taches répond autre chose que 404.\n`,
    "serveur.mjs": serveur(handleSigterm).replace("${PORT}", String(port)),
    "src/taches.mjs": `export function listerTaches() { return [{ id: 1 }]; }\n`,
    "src/admin.mjs": `export function supprimerTache(id) { return id; }\n`,
    "gates.json": JSON.stringify({
      roots: ["src"],
      app: { start: "node serveur.mjs", url: `http://127.0.0.1:${port}/taches`, readyTimeoutMs: 20000 },
      probes: [{
        id: "liste-des-taches", criterion: "AC-7", kind: "http",
        request: { method: "GET", path: "/taches" }, expect: { statusNot: [404, 500] },
      }],
      coverage: { runtime: "node", requireExecuted: ["src/**/*.mjs"] },
    }),
  });

  it("la probe HTTP passe ; la couverture du serveur dépend d'un arrêt propre", async () => {
    const { dir, clean } = await projet(files(38471, true));
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");

      expect(byName(r, "probes").status, byName(r, "probes").output).toBe("passed");
      expect(r.report.criteria?.["AC-7"].status).toBe("passed");

      const cov = byName(r, "coverage");
      if (process.platform === "win32") {
        // Windows n'offre pas d'arrêt propre pour un process console : le serveur est
        // tué de force et n'écrit rien. Le gate doit se SUSPENDRE, pas inventer un rouge.
        expect(cov.status, cov.output).toBe("skipped");
        expect(cov.output).toMatch(/aucune donnée|INCOMPLÈTE/);
      } else {
        // Sur la cible réelle (VPS et CI Linux), le SIGTERM est honoré : la mesure existe
        // et `admin.mjs`, importé mais jamais appelé, apparaît mort.
        expect(cov.status, cov.output).toBe("failed");
        expect(cov.output).toMatch(/admin\.mjs/);
        expect(cov.output).not.toMatch(/taches\.mjs/);
      }
    } finally { await clean(); }
  }, 90_000);

  it("serveur sans handler SIGTERM → couverture SUSPENDUE avec une consigne actionnable", async () => {
    const { dir, clean } = await projet(files(38472, false));
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");
      const cov = byName(r, "coverage");
      expect(cov.status, cov.output).toBe("skipped");
      expect(cov.output).toMatch(/aucune donnée|INCOMPLÈTE/);
    } finally { await clean(); }
  }, 90_000);
});

describe("critères — une exigence ne peut pas disparaître en silence (§8, point 4)", () => {
  const projetAvecCriteres = (specAcs: string[], probeCriterion: string | null): Files => ({
    "spec.md": `# Spec\n\n## Critères d'acceptation\n\n${specAcs.map((id) => `- **${id}** — exigence ${id}.\n`).join("")}`,
    "src/main.mjs": `console.log("ok");\n`,
    "gates.json": JSON.stringify({
      entry: "src/main.mjs",
      roots: ["src"],
      probes: [{
        id: "lance", kind: "cli", run: "node src/main.mjs", expect: { exitCode: 0 },
        ...(probeCriterion ? { criterion: probeCriterion } : {}),
      }],
    }),
  });

  it("un AC-n sans probe → spec-coverage ROUGE et le critère marqué non vérifié", async () => {
    const { dir, clean } = await projet(projetAvecCriteres(["AC-1", "AC-9"], "AC-1"));
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");

      const sc = byName(r, "spec-coverage");
      expect(sc.status, sc.output).toBe("failed");
      expect(sc.output).toMatch(/AC-9/);

      expect(r.report.criteria?.["AC-1"].status).toBe("passed");
      expect(r.report.criteria?.["AC-9"].status).toBe("uncovered");
      expect(r.ok).toBe(false);
      expect(r.report.summary).toMatch(/1\/2 critère/);
    } finally { await clean(); }
  }, 60_000);

  it("un `criterion` renommé (référence inexistante) → ROUGE des deux côtés", async () => {
    // La probe existe et passe, mais elle ne vérifie plus rien de déclaré : l'exigence
    // AC-1 s'est décrochée de sa vérification. C'est exactement ce que le check attrape.
    const { dir, clean } = await projet(projetAvecCriteres(["AC-1"], "AC-10"));
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");

      const sc = byName(r, "spec-coverage");
      expect(sc.status, sc.output).toBe("failed");
      expect(sc.output).toMatch(/AC-1/);   // déclaré mais plus couvert
      expect(sc.output).toMatch(/AC-10/);  // cité mais inexistant dans la spec

      expect(r.report.criteria?.["AC-1"].status).toBe("uncovered");
      expect(r.ok).toBe(false);
    } finally { await clean(); }
  }, 60_000);

  it("probe sans `criterion` du tout → l'AC-n déclaré reste non vérifié", async () => {
    const { dir, clean } = await projet(projetAvecCriteres(["AC-1"], null));
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");
      expect(byName(r, "spec-coverage").status).toBe("failed");
      expect(r.report.criteria?.["AC-1"].status).toBe("uncovered");
      expect(r.ok).toBe(false);
    } finally { await clean(); }
  }, 60_000);
});

describe("configuration", () => {
  it("point d'entrée déclaré mais introuvable → assemblage ROUGE (pas de repli silencieux)", async () => {
    const { dir, clean } = await projet({
      "src/main.mjs": `console.log("ok");\n`,
      "gates.json": JSON.stringify({ entry: "src/inexistant.mjs", roots: ["src"] }),
    });
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");
      const a = byName(r, "assembly");
      expect(a.status).toBe("failed");
      expect(a.output).toMatch(/introuvable/);
    } finally { await clean(); }
  }, 30_000);

  it("runtime de couverture inconnu → exit 2 (corriger gates.json, pas le code)", async () => {
    const { dir, clean } = await projet({
      "gates.json": JSON.stringify({ coverage: { runtime: "cobol", requireExecuted: ["src/**"] } }),
    });
    try {
      const r = await check(dir);
      expect(r && "configError" in r).toBe(true);
    } finally { await clean(); }
  }, 30_000);

  it("`expect: { json }` sur une probe http → exit 2, PAS un rapport vert", async () => {
    // Le faux vert tel qu'il s'est produit : le projet croit vérifier le corps de la
    // réponse, gates ne lit que le statut, `json` est traversé en silence, AC-7 vire au
    // vert. Le refus tombe au CHARGEMENT : aucun serveur n'est démarré, rien ne tourne.
    const { dir, clean } = await projet({
      "spec.md": `# Spec\n\n## Critères d'acceptation\n\n- **AC-7** — GET /taches renvoie la liste.\n`,
      "gates.json": JSON.stringify({
        // `readyTimeoutMs` court : sans le correctif, ce test doit échouer sur son
        // assertion (« attendu configError »), pas s'éterniser à démarrer une app.
        app: { start: "node serveur.mjs", url: "http://127.0.0.1:38999/taches", readyTimeoutMs: 1500 },
        probes: [{
          id: "liste-des-taches", criterion: "AC-7", kind: "http",
          request: { method: "GET", path: "/taches" },
          expect: { status: 200, json: { taches: [] } },
        }],
      }),
    });
    try {
      const r = await check(dir);
      if (!r || !("configError" in r)) throw new Error(`attendu configError, obtenu ${JSON.stringify(r)}`);
      expect(r.configError).toMatch(/json/);
      expect(r.configError).toMatch(/liste-des-taches/);
    } finally { await clean(); }
  }, 30_000);

  it("`--only` ne contourne pas la validation de la config", async () => {
    const { dir, clean } = await projet({
      "gates.json": JSON.stringify({
        probes: [{ id: "p", kind: "cli", run: "node -e \"0\"", expect: { exitCode: 0, contains: "x" } }],
      }),
    });
    try {
      const r = await check(dir, { only: ["assembly"] });
      expect(r && "configError" in r).toBe(true);
    } finally { await clean(); }
  }, 30_000);

  it("aucun gates.json → null (exit 2)", async () => {
    const { dir, clean } = await projet({ "vide.txt": "" });
    try {
      expect(await check(dir)).toBeNull();
    } finally { await clean(); }
  }, 30_000);
});

describe("observation et site — ce que le contrat peut assouplir, et ce qu'il ne peut pas", () => {
  it("`observation: [probes]` → exit 2 : le juge fonctionnel ne se met pas en sourdine", async () => {
    const { dir, clean } = await projet({ "gates.json": JSON.stringify({ observation: ["probes"] }) });
    try {
      const r = await check(dir);
      if (!r || !("configError" in r)) throw new Error("attendu configError");
      expect(r.configError).toMatch(/« probes » ne peut pas être mis en observation/);
    } finally { await clean(); }
  }, 30_000);

  it("une commande rouge en observation → signalée, verdict vert", async () => {
    const { dir, clean } = await projet({
      "gates.json": JSON.stringify({
        commands: { lint: `node -e "process.exit(1)"` },
        observation: ["lint"],
      }),
    });
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");
      expect(byName(r, "lint").status).toBe("warn");
      expect(r.ok).toBe(true);
      expect(r.report.summary).toMatch(/1 signalé/);
    } finally { await clean(); }
  }, 30_000);

  it("clé inconnue dans `site` → exit 2, nommée", async () => {
    const { dir, clean } = await projet({ "gates.json": JSON.stringify({ site: { bloquants: ["a11y"] } }) });
    try {
      const r = await check(dir);
      if (!r || !("configError" in r)) throw new Error("attendu configError");
      expect(r.configError).toMatch(/clé inconnue « bloquants »/);
    } finally { await clean(); }
  }, 30_000);

  it("un projet sans site ne voit jamais les contrôles de site", async () => {
    const { dir, clean } = await projet({
      "src/main.mjs": `console.log("ok");\n`,
      "gates.json": JSON.stringify({ entry: "src/main.mjs", roots: ["src"] }),
    });
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");
      for (const f of ["a11y", "mobile", "budgets", "seo"]) expect(byName(r, f), f).toBeUndefined();
    } finally { await clean(); }
  }, 30_000);

  it("l'app sert une page, le contrat n'a pas de section « site » : les quatre familles le DISENT, sans rougir", async () => {
    // Le trou que ce test ferme : jusqu'ici, un projet web sans section `site` ne
    // produisait AUCUNE ligne pour a11y/mobile/budgets/seo. Pas un « – », rien. Un vert
    // qui n'a regardé ni l'accessibilité ni le rendu à 375 px se lisait comme un vert.
    const { dir, clean } = await projet({
      "serveur.mjs":
        `import { createServer } from "node:http";\n` +
        `createServer((q, s) => { s.setHeader("content-type", "text/html; charset=utf-8"); s.end("<!doctype html><html lang=\\"fr\\"><head><title>Démo</title></head><body><h1>Démo</h1></body></html>"); }).listen(38494);\n` +
        `process.on("SIGTERM", () => process.exit(0));\n`,
      "gates.json": JSON.stringify({
        app: { start: "node serveur.mjs", url: "http://127.0.0.1:38494/", readyTimeoutMs: 20000 },
      }),
    });
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");
      expect(byName(r, "smoke").status).toBe("passed");
      for (const f of ["a11y", "mobile", "budgets", "seo"]) {
        expect(byName(r, f), f).toBeDefined();
        expect(byName(r, f).status, f).toBe("skipped");
        // Ce qu'AC-6 exige, et rien de plus : la clé qui manque et la famille sont
        // nommées. S'accrocher à la phrase exacte ferait d'une reformulation un échec.
        expect(byName(r, f).output, f).toMatch(/section « site »/);
        expect(byName(r, f).output, f).toContain(f);
      }
      // L'omission se VOIT, elle ne rougit pas : auditer se déclare au contrat et passe
      // par `!approuve`. Un juge qui déciderait seul devinerait — défaut n°5.
      expect(r.ok).toBe(true);
    } finally { await clean(); }
  }, 60_000);

  it("une API qui sert du JSON ne reçoit pas ce rappel : elle n'a pas de page", async () => {
    // La contrepartie du test précédent, et la raison pour laquelle le déclencheur est le
    // `content-type` observé et non `app.url` : une API déclare `app.url` comme un site.
    const { dir, clean } = await projet({
      "serveur.mjs":
        `import { createServer } from "node:http";\n` +
        `createServer((q, s) => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ ok: true })); }).listen(38495);\n` +
        `process.on("SIGTERM", () => process.exit(0));\n`,
      "gates.json": JSON.stringify({
        app: { start: "node serveur.mjs", url: "http://127.0.0.1:38495/", readyTimeoutMs: 20000 },
      }),
    });
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");
      expect(byName(r, "smoke").status).toBe("passed");
      for (const f of ["a11y", "mobile", "budgets", "seo"]) expect(byName(r, f), f).toBeUndefined();
      expect(r.ok).toBe(true);
    } finally { await clean(); }
  }, 60_000);

  it("un site dont le smoke est rouge n'est PAS audité : un audit sur une page cassée ne prouve rien", async () => {
    const { dir, clean } = await projet({
      // L'appli démarre (« / » répond) mais la route déclarée n'est pas montée : le smoke
      // est rouge alors que la page d'accueil, elle, serait auditable.
      "serveur.mjs": `import { createServer } from "node:http";\ncreateServer((q, s) => { s.statusCode = q.url === "/" ? 200 : 404; s.end("<h1>ok</h1>"); }).listen(38493);\nprocess.on("SIGTERM", () => process.exit(0));\n`,
      "gates.json": JSON.stringify({
        app: { start: "node serveur.mjs", url: "http://127.0.0.1:38493/", readyTimeoutMs: 20000, paths: ["/reservation"] },
        site: {},
      }),
    });
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");
      expect(byName(r, "smoke").status).toBe("failed");
      for (const f of ["a11y", "mobile", "budgets", "seo"]) {
        expect(byName(r, f).status, f).toBe("skipped");
        expect(byName(r, f).output).toMatch(/smoke n'est pas vert/);
      }
    } finally { await clean(); }
  }, 60_000);
});

describe("sortie sous GitHub Actions", () => {
  it("stop-commands AVANT, puis le même jeton pour rétablir, puis les annotations", () => {
    const sortie: string[] = [];
    const gh = sortieGitHub(false, { GITHUB_ACTIONS: "true" }, (s) => sortie.push(s));
    gh.ouvrir();
    gh.fermer(["::notice title=gates etat::{}"]);
    const [ouverture, fermeture] = sortie;
    const jeton = ouverture.match(/^::stop-commands::([0-9a-f-]{36})\n$/)?.[1];
    expect(jeton).toBeTruthy();
    expect(fermeture).toBe(`::${jeton}::\n::notice title=gates etat::{}\n`);
  });

  it("jeton imprévisible : deux exécutions, deux jetons", () => {
    const jetons = [0, 1].map(() => {
      const s: string[] = [];
      sortieGitHub(false, { GITHUB_ACTIONS: "true" }, (x) => s.push(x)).ouvrir();
      return s[0];
    });
    expect(jetons[0]).not.toBe(jetons[1]);
  });

  it("hors GitHub Actions, ou en --json : rien n'est ajouté à la sortie", () => {
    for (const [json, env] of [[false, {}], [true, { GITHUB_ACTIONS: "true" }]] as const) {
      const s: string[] = [];
      const gh = sortieGitHub(json, env, (x) => s.push(x));
      gh.ouvrir();
      gh.fermer(["x"]);
      expect(s).toEqual([]);
    }
  });

  it("seule la vérification principale annote : une `gates etat` par job, pas trois", () => {
    const rapport = buildReport(
      [{ name: "probes", status: "failed", output: "AC-2 : 404" }],
      buildCriteria(["AC-1", "AC-2"], [
        { id: "a", criterion: "AC-1", status: "passed" },
        { id: "b", criterion: "AC-2", status: "failed", output: "GET / → 404" },
      ]),
    );
    const principale = annotationsDuVerdict(rapport, { baseUrl: null, phaseRouge: false });
    expect(principale.filter((l) => l.startsWith("::notice title=gates etat::"))).toHaveLength(1);
    expect(principale.some((l) => l.startsWith("::error title=gates AC-2::"))).toBe(true);
    // Phase rouge : AC-2 rouge y est ATTENDU — le remonter en échec tromperait le pont.
    expect(annotationsDuVerdict(rapport, { baseUrl: null, phaseRouge: true })).toEqual([]);
    expect(annotationsDuVerdict(rapport, { baseUrl: "https://apercu.example", phaseRouge: false })).toEqual([]);
  });

  it("le verdict en fichier porte le même état et les mêmes échecs que les annotations", () => {
    const rapport = buildReport(
      [{ name: "probes", status: "failed", output: "AC-2 : 404" }],
      buildCriteria(["AC-1", "AC-2"], [
        { id: "a", criterion: "AC-1", status: "passed" },
        { id: "b", criterion: "AC-2", status: "failed", output: "GET / → 404" },
      ]),
    );
    const f = fichierEtat(rapport);
    const annotations = renderAnnotations(rapport);
    expect(f.v).toBe(1);
    expect(`::notice title=gates etat::${JSON.stringify(f.etat)}`).toBe(annotations[0]);
    expect(f.echecs.map((e) => e.titre)).toEqual(["gates AC-2", "gates probes"]);
    expect(annotations.filter((l) => l.startsWith("::error"))).toHaveLength(f.echecs.length);
    expect(fichierEtat(null, "gates.json invalide")).toEqual({
      v: 1, etat: null, echecs: [{ titre: "gates config", message: "gates.json invalide" }],
    });
  });

  it("--etat-fichier : chemin lu, absent ou sans valeur → pas de fichier", () => {
    expect(parseArgs(["--etat-fichier", "/tmp/e.json"]).etatFichier).toBe("/tmp/e.json");
    expect(parseArgs(["--etat-fichier"]).etatFichier).toBeNull();
    expect(parseArgs([]).etatFichier).toBeNull();
  });
});

/**
 * La phase rouge, de bout en bout — LE scénario qui justifie tout ce fichier.
 *
 * Le projet ci-dessous est TOUT VERT au sens du juge ordinaire : 2 critères sur 2
 * vérifiés. Et l'un des deux est un mensonge — sa probe passerait sur un dépôt vide.
 * C'est exactement le faux vert que `VALIDATION.md` a mesuré, remonté d'un cran : ce
 * n'est plus le modèle qui se déclare fini, c'est la probe qui se déclare probante.
 */
describe("phase rouge — la probe qui ne constate rien", () => {
  const base: Files = {
    "spec.md": "# Spec\n\n- **AC-1** — la commande double son entrée.\n- **AC-2** — le projet est livrable.\n",
    "src/calcul.mjs": "export const doubler = (n) => n * 2;\n",
    "src/main.mjs": 'import { doubler } from "./calcul.mjs";\nconsole.log("resultat", doubler(21));\n',
    "gates.json": JSON.stringify({
      roots: ["src"],
      probes: [
        { id: "double-bien", criterion: "AC-1", kind: "cli", run: "node src/main.mjs", expect: { exitCode: 0, stdout: "resultat 42" } },
        // Ne touche jamais au projet : elle rend AC-2 vert en n'observant rien.
        { id: "probe-creuse", criterion: "AC-2", kind: "cli", run: "node -e \"console.log('ok')\"", expect: { exitCode: 0, stdout: "ok" } },
      ],
    }),
  };

  it("le run ordinaire est TOUT VERT — c'est le problème, pas le résultat", async () => {
    const { dir, clean } = await projet(base);
    try {
      const r = await check(dir);
      if (!r || "configError" in r) throw new Error("config invalide");
      expect(r.ok, JSON.stringify(r.report.criteria)).toBe(true);
      expect(r.report.criteria?.["AC-2"].status).toBe("passed");
    } finally {
      await clean();
    }
  });

  it("la phase rouge dénonce la probe creuse, et NOMME son critère", async () => {
    const { dir, clean } = await projet(base);
    try {
      const r = await check(dir, { phaseRouge: true });
      if (!r || "configError" in r) throw new Error("config invalide");
      expect(r.ok).toBe(false);
      const c = byName(r, "phase-rouge");
      expect(c.status).toBe("failed");
      expect(c.output).toContain("probe-creuse");
      expect(c.output).toContain("AC-2");
      // La probe honnête ne doit pas être mise en cause : une phase rouge qui accuse
      // tout le monde n'apprend rien et se fait désactiver.
      expect(c.output).not.toContain("double-bien");
    } finally {
      await clean();
    }
  });

  it("le projet d'origine sort INTACT d'une phase rouge", async () => {
    // L'invariant qui prime sur le verdict : le juge travaille sur une copie. S'il
    // abîmait le dépôt, il coûterait du travail réel — le seul défaut de cet outil qui
    // ne se rattrape pas par une relecture.
    const { dir, clean } = await projet(base);
    try {
      await check(dir, { phaseRouge: true });
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(join(dir, "src/calcul.mjs"), "utf8")).toBe(base["src/calcul.mjs"]);
      expect(await readFile(join(dir, "src/main.mjs"), "utf8")).toBe(base["src/main.mjs"]);
    } finally {
      await clean();
    }
  });

  it("--phase-rouge et --base-url s'excluent (config invalide)", async () => {
    const { dir, clean } = await projet(base);
    try {
      const r = await check(dir, { phaseRouge: true, baseUrl: "https://apercu.example/" });
      expect(r && "configError" in r).toBe(true);
    } finally {
      await clean();
    }
  });
});
