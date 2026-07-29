import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check } from "./cli";

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

  it("aucun gates.json → null (exit 2)", async () => {
    const { dir, clean } = await projet({ "vide.txt": "" });
    try {
      expect(await check(dir)).toBeNull();
    } finally { await clean(); }
  }, 30_000);
});
