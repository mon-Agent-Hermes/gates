import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  adapterEnv, checkCoverage, collectCoverage, countCoverageFiles, globToRegExp,
  noteServerCoverage, resolveAdapter, toProjectFile, type CoverageContext,
} from "./coverage";

async function fixture(): Promise<{ project: string; cov: string; clean: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "gates-cov-test-"));
  const project = join(root, "projet");
  const cov = join(root, "cov");
  await mkdir(join(project, "src", "ui"), { recursive: true });
  await mkdir(cov, { recursive: true });
  for (const f of ["src/main.ts", "src/ui/hud.ts", "src/mort.ts", "src/types.ts"]) {
    await writeFile(join(project, f), "// fixture\n", "utf8");
  }
  return { project, cov, clean: () => rm(root, { recursive: true, force: true }) };
}

describe("adaptateurs de runtime", () => {
  it("chaque runtime intégré fournit son triplet (env, report, format)", () => {
    const node = resolveAdapter({ runtime: "node" });
    expect(node).toMatchObject({ env: { NODE_V8_COVERAGE: "$COV" }, format: "v8" });

    const py = resolveAdapter({ runtime: "python" });
    expect(py).toMatchObject({ format: "coverage-py" });
    expect("report" in py && py.report.length).toBeGreaterThan(0);

    const go = resolveAdapter({ runtime: "go" });
    expect(go).toMatchObject({ env: { GOCOVERDIR: "$COV" }, format: "go" });
  });

  it("node est le défaut quand le runtime n'est pas déclaré", () => {
    expect(resolveAdapter({})).toMatchObject({ runtime: "node", format: "v8" });
  });

  it("custom sans format = configuration invalide (on ne devine pas)", () => {
    expect(resolveAdapter({ runtime: "custom" })).toHaveProperty("error");
    expect(resolveAdapter({ runtime: "custom", format: "lcov", env: { X: "$COV/x" } })).toMatchObject({ format: "lcov" });
  });

  it("runtime inconnu = erreur explicite, jamais un silence", () => {
    expect(resolveAdapter({ runtime: "cobol" as any })).toHaveProperty("error");
  });

  it("$COV est résolu dans l'environnement injecté", () => {
    const a = resolveAdapter({ runtime: "python" });
    if ("error" in a) throw new Error(a.error);
    expect(adapterEnv(a, "/mesure")).toEqual({ COVERAGE_FILE: "/mesure/.coverage" });
  });
});

describe("globToRegExp", () => {
  it("** traverse les dossiers, * ne franchit pas le séparateur", () => {
    const deep = globToRegExp("src/**/*.ts");
    expect(deep.test("src/main.ts")).toBe(true);
    expect(deep.test("src/ui/hud.ts")).toBe(true);
    expect(deep.test("test/main.ts")).toBe(false);

    const flat = globToRegExp("src/*.ts");
    expect(flat.test("src/main.ts")).toBe(true);
    expect(flat.test("src/ui/hud.ts")).toBe(false);
  });

  it("les métacaractères de regex sont littéraux", () => {
    expect(globToRegExp("src/a.b.ts").test("src/a.b.ts")).toBe(true);
    expect(globToRegExp("src/a.b.ts").test("src/axb.ts")).toBe(false);
  });
});

describe("toProjectFile", () => {
  const files = ["src/main.go", "src/ui/hud.ts", "pkg/serveur/routes.go"];

  it("chemin absolu dans le projet → relatif ; hors projet → null", () => {
    expect(toProjectFile(resolve("/projet", "src/ui/hud.ts"), "/projet", files)).toBe("src/ui/hud.ts");
    expect(toProjectFile(resolve("/ailleurs", "src/ui/hud.ts"), "/projet", files)).toBeNull();
  });

  it("URL file: (format V8)", () => {
    const url = pathToFileURL(resolve("/projet", "src/ui/hud.ts")).href;
    expect(toProjectFile(url, "/projet", files)).toBe("src/ui/hud.ts");
  });

  it("node_modules est exclu (ce n'est pas un livrable)", () => {
    expect(toProjectFile(resolve("/projet", "node_modules/x/index.js"), "/projet", files)).toBeNull();
  });

  it("chemin préfixé du module (format Go) → résolu par suffixe", () => {
    expect(toProjectFile("exemple.com/mod/pkg/serveur/routes.go", "/projet", files)).toBe("pkg/serveur/routes.go");
  });

  it("un suffixe qui ne correspond à aucun fichier réel → null", () => {
    expect(toProjectFile("autre/module/inconnu.go", "/projet", files)).toBeNull();
  });
});

describe("lecture des formats de couverture", () => {
  const script = (project: string, file: string, fns: { name: string; count: number }[]) => ({
    url: pathToFileURL(join(project, file)).href,
    functions: fns.map((f) => ({ functionName: f.name, ranges: [{ startOffset: 0, endOffset: 10, count: f.count }] })),
  });

  it("v8 (Node) : vivant = une FONCTION appelée, pas seulement le module chargé", async () => {
    const { project, cov, clean } = await fixture();
    try {
      await writeFile(join(cov, "coverage-1.json"), JSON.stringify({
        result: [
          // corps exécuté + fonction appelée → vivant
          script(project, "src/main.ts", [{ name: "", count: 1 }, { name: "demarrer", count: 1 }]),
          // corps exécuté (le module est importé) mais aucune fonction appelée → PAS vivant
          script(project, "src/ui/hud.ts", [{ name: "", count: 1 }, { name: "afficherHud", count: 0 }]),
          // jamais chargé du tout
          script(project, "src/mort.ts", [{ name: "", count: 0 }, { name: "orphelin", count: 0 }]),
        ],
      }), "utf8");
      const data = await collectCoverage("v8", cov, project);
      expect(data.sources).toBe(1);
      expect([...data.executed]).toEqual(["src/main.ts"]);
      expect([...data.loadedOnly]).toEqual(["src/ui/hud.ts"]);
    } finally { await clean(); }
  });

  it("v8 : un fichier SANS fonction (constantes) est vivant dès qu'il est chargé", async () => {
    const { project, cov, clean } = await fixture();
    try {
      await writeFile(join(cov, "coverage-1.json"), JSON.stringify({
        result: [script(project, "src/types.ts", [{ name: "", count: 1 }])],
      }), "utf8");
      const data = await collectCoverage("v8", cov, project);
      expect([...data.executed]).toEqual(["src/types.ts"]);
      expect([...data.loadedOnly]).toEqual([]);
    } finally { await clean(); }
  });

  it("v8 : vivant dans UN process suffit (plusieurs mesures agrégées)", async () => {
    const { project, cov, clean } = await fixture();
    try {
      await writeFile(join(cov, "coverage-1.json"), JSON.stringify({
        result: [script(project, "src/ui/hud.ts", [{ name: "", count: 1 }, { name: "afficherHud", count: 0 }])],
      }), "utf8");
      await writeFile(join(cov, "coverage-2.json"), JSON.stringify({
        result: [script(project, "src/ui/hud.ts", [{ name: "", count: 1 }, { name: "afficherHud", count: 1 }])],
      }), "utf8");
      const data = await collectCoverage("v8", cov, project);
      expect([...data.executed]).toEqual(["src/ui/hud.ts"]);
      expect([...data.loadedOnly]).toEqual([]);
    } finally { await clean(); }
  });

  it("coverage-py : vivant = une ligne exécutée AU-DELÀ des déclarations", async () => {
    const { project, cov, clean } = await fixture();
    try {
      // `main` fait vraiment quelque chose ; `hud` n'a été qu'importé (seul son `def`
      // s'est exécuté) ; `mort` n'apparaît pas du tout dans la mesure.
      await writeFile(join(project, "src/main.py"), "import os\nprint('ok')\n", "utf8");
      await writeFile(join(project, "src/hud.py"), "def afficher():\n    print('hud')\n", "utf8");
      await writeFile(join(cov, "coverage.json"), JSON.stringify({
        files: {
          "src/main.py": { executed_lines: [1, 2] },
          "src/hud.py": { executed_lines: [1] },
        },
      }), "utf8");
      const data = await collectCoverage("coverage-py", cov, project);
      expect([...data.executed]).toEqual(["src/main.py"]);
      expect([...data.loadedOnly]).toEqual(["src/hud.py"]);
    } finally { await clean(); }
  });

  it("coverage-py : un module de constantes exécuté est vivant", async () => {
    const { project, cov, clean } = await fixture();
    try {
      await writeFile(join(project, "src/config.py"), "COULEURS = ['rouge']\n", "utf8");
      await writeFile(join(cov, "coverage.json"), JSON.stringify({ files: { "src/config.py": { executed_lines: [1] } } }), "utf8");
      const data = await collectCoverage("coverage-py", cov, project);
      expect([...data.executed]).toEqual(["src/config.py"]);
    } finally { await clean(); }
  });

  it("go (covdata textfmt) : compte d'exécution > 0", async () => {
    const { project, cov, clean } = await fixture();
    try {
      await writeFile(join(cov, "cov.txt"), [
        "mode: set",
        "exemple.com/m/src/main.ts:1.1,3.2 2 1",
        "exemple.com/m/src/mort.ts:1.1,4.2 3 0",
      ].join("\n"), "utf8");
      const data = await collectCoverage("go", cov, project);
      expect([...data.executed]).toEqual(["src/main.ts"]);
    } finally { await clean(); }
  });

  it("lcov : DA:<ligne>,<compte> — au moins un compte > 0", async () => {
    const { project, cov, clean } = await fixture();
    try {
      await writeFile(join(cov, "lcov.info"), [
        `SF:${join(project, "src/main.ts")}`, "DA:1,4", "DA:2,0", "end_of_record",
        `SF:${join(project, "src/mort.ts")}`, "DA:1,0", "end_of_record",
      ].join("\n"), "utf8");
      const data = await collectCoverage("lcov", cov, project);
      expect([...data.executed]).toEqual(["src/main.ts"]);
    } finally { await clean(); }
  });

  it("dossier de mesure vide → aucune source (le verdict se suspendra)", async () => {
    const { project, cov, clean } = await fixture();
    try {
      expect((await collectCoverage("v8", cov, project)).sources).toBe(0);
      expect(await countCoverageFiles(cov)).toBe(0);
    } finally { await clean(); }
  });
});

describe("verdict de couverture", () => {
  const data = (executed: string[], sources = 1, loadedOnly: string[] = []) =>
    ({ executed: new Set(executed), loadedOnly: new Set(loadedOnly), sources });

  it("sans requireExecuted → skipped (rien n'est déclaré)", async () => {
    const { project, clean } = await fixture();
    try {
      const r = await checkCoverage({ cfg: {}, projectDir: project, data: data([]) });
      expect(r.status).toBe("skipped");
    } finally { await clean(); }
  });

  it("aucune donnée → skipped, jamais un faux rouge", async () => {
    const { project, clean } = await fixture();
    try {
      const r = await checkCoverage({ cfg: { requireExecuted: ["src/**/*.ts"] }, projectDir: project, data: data([], 0) });
      expect(r.status).toBe("skipped");
      expect(r.output).toMatch(/aucune donnée/);
    } finally { await clean(); }
  });

  it("livrable jamais exécuté → ROUGE, en le nommant", async () => {
    const { project, clean } = await fixture();
    try {
      const r = await checkCoverage({
        cfg: { requireExecuted: ["src/**/*.ts"] },
        projectDir: project,
        data: data(["src/main.ts", "src/ui/hud.ts", "src/types.ts"]),
      });
      expect(r.status).toBe("failed");
      expect(r.output).toMatch(/src\/mort\.ts/);
    } finally { await clean(); }
  });

  it("distingue « jamais atteint » de « chargé mais jamais appelé »", async () => {
    const { project, clean } = await fixture();
    try {
      const r = await checkCoverage({
        cfg: { requireExecuted: ["src/**/*.ts"] },
        projectDir: project,
        data: data(["src/main.ts", "src/types.ts"], 1, ["src/ui/hud.ts"]),
      });
      expect(r.status).toBe("failed");
      expect(r.output).toMatch(/Jamais atteint : src\/mort\.ts/);
      expect(r.output).toMatch(/Chargé mais aucune de ses fonctions.*src\/ui\/hud\.ts/s);
    } finally { await clean(); }
  });

  it("allowUnexecuted exempte (la seule échappatoire)", async () => {
    const { project, clean } = await fixture();
    try {
      const r = await checkCoverage({
        cfg: { requireExecuted: ["src/**/*.ts"], allowUnexecuted: ["src/mort.ts", "src/types.ts"] },
        projectDir: project,
        data: data(["src/main.ts", "src/ui/hud.ts"]),
      });
      expect(r.status, r.output).toBe("passed");
    } finally { await clean(); }
  });

  it("mesure incomplète + fichiers apparemment morts → skipped (verdict suspendu)", async () => {
    const { project, clean } = await fixture();
    try {
      const r = await checkCoverage({
        cfg: { requireExecuted: ["src/**/*.ts"] },
        projectDir: project,
        data: data(["src/main.ts"]),
        incomplete: ["l'app partagée n'a écrit aucune couverture"],
      });
      expect(r.status).toBe("skipped");
      expect(r.output).toMatch(/INCOMPLÈTE/);
    } finally { await clean(); }
  });

  it("mesure incomplète mais tout est vivant → vert, avec l'avertissement", async () => {
    const { project, clean } = await fixture();
    try {
      const r = await checkCoverage({
        cfg: { requireExecuted: ["src/**/*.ts"] },
        projectDir: project,
        data: data(["src/main.ts", "src/ui/hud.ts", "src/mort.ts", "src/types.ts"]),
        incomplete: ["probe browser non instrumentée"],
      });
      expect(r.status).toBe("passed");
      expect(r.output).toMatch(/avertissement/);
    } finally { await clean(); }
  });
});

describe("noteServerCoverage — constater plutôt que supposer", () => {
  it("aucun fichier de mesure produit → avertissement actionnable", async () => {
    const { cov, clean } = await fixture();
    try {
      const ctx: CoverageContext = { dir: cov, env: {}, incomplete: [] };
      await noteServerCoverage(ctx, "l'app partagée", 0, { graceful: false, note: "arrêt forcé" });
      expect(ctx.incomplete).toHaveLength(1);
      expect(ctx.incomplete[0]).toMatch(/SIGTERM/);
    } finally { await clean(); }
  });

  it("un fichier de mesure est apparu → aucun avertissement", async () => {
    const { cov, clean } = await fixture();
    try {
      const ctx: CoverageContext = { dir: cov, env: {}, incomplete: [] };
      await writeFile(join(cov, "coverage-1.json"), "{}", "utf8");
      await noteServerCoverage(ctx, "l'app partagée", 0, { graceful: true });
      expect(ctx.incomplete).toEqual([]);
    } finally { await clean(); }
  });
});
