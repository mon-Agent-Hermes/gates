import { describe, it, expect } from "vitest";
import { runProbe, runProbes, aggregateProbes, textMatches, type Probe } from "./probes";

// Commande node portable (cmd.exe et sh) : écrit un fichier dans $TMP et logue.
// `process.argv[1]` vaut le premier argument positionnel après `-e` (ici $TMP).
const WRITE_OK =
  `node -e "require('fs').writeFileSync(require('path').join(process.argv[1],'out.txt'),'ok');console.log('Configuration ecrite')" $TMP`;

describe("textMatches", () => {
  it("regex slashée ou sous-chaîne littérale", () => {
    expect(textMatches("/Config.*ecrite/", "Configuration ecrite")).toBe(true);
    expect(textMatches("ecrite", "Configuration ecrite")).toBe(true);
    expect(textMatches("absent", "Configuration ecrite")).toBe(false);
  });
});

describe("probe cli", () => {
  it("effet observé : code 0, stdout attendu, fichier créé dans $TMP", async () => {
    const p: Probe = {
      id: "init-cree-la-config", criterion: "AC-3", kind: "cli",
      run: WRITE_OK,
      expect: { exitCode: 0, stdout: "/Configuration ecrite/", files: ["$TMP/out.txt"] },
    };
    const r = await runProbe(p, 30_000);
    expect(r.status, r.output).toBe("passed");
    expect(r.criterion).toBe("AC-3");
  });

  it("mauvais code de sortie → échec qui NOMME la probe et la cause", async () => {
    const p: Probe = {
      id: "init-doit-sortir-0", kind: "cli",
      run: `node -e "process.exit(3)"`,
      expect: { exitCode: 0 },
    };
    const r = await runProbe(p, 30_000);
    expect(r.status).toBe("failed");
    expect(r.id).toBe("init-doit-sortir-0");
    expect(r.output).toMatch(/code de sortie 3/);
  });

  it("fichier attendu absent → échec", async () => {
    const p: Probe = {
      id: "produit-un-fichier", kind: "cli",
      run: `node -e "process.exit(0)"`,
      expect: { exitCode: 0, files: ["$TMP/jamais.txt"] },
    };
    const r = await runProbe(p, 30_000);
    expect(r.status).toBe("failed");
    expect(r.output).toMatch(/fichier attendu absent/);
  });
});

describe("probe artifact", () => {
  it("fichier produit et assez gros → passe", async () => {
    const p: Probe = {
      id: "genere-le-blob", criterion: "AC-4", kind: "artifact",
      run: `node -e "require('fs').writeFileSync(require('path').join(process.argv[1],'blob.bin'),Buffer.alloc(200))" $TMP`,
      file: "$TMP/blob.bin",
      expect: { minBytes: 100 },
    };
    const r = await runProbe(p, 30_000);
    expect(r.status, r.output).toBe("passed");
  });

  it("artefact trop petit → échec", async () => {
    const p: Probe = {
      id: "blob-trop-petit", kind: "artifact",
      run: `node -e "require('fs').writeFileSync(require('path').join(process.argv[1],'blob.bin'),Buffer.alloc(5))" $TMP`,
      file: "$TMP/blob.bin",
      expect: { minBytes: 100 },
    };
    const r = await runProbe(p, 30_000);
    expect(r.status).toBe("failed");
    expect(r.output).toMatch(/trop petit/);
  });
});

describe("kinds non portés", () => {
  it("browser/http/process → skipped (jamais un faux vert)", async () => {
    for (const kind of ["browser", "http", "process"]) {
      const r = await runProbe({ id: `x-${kind}`, kind } as Probe);
      expect(r.status).toBe("skipped");
      expect(r.output).toMatch(/pas encore porté/);
    }
  });

  it("kind inconnu → skipped", async () => {
    const r = await runProbe({ id: "bizarre", kind: "quantique" } as Probe);
    expect(r.status).toBe("skipped");
  });
});

describe("aggregateProbes", () => {
  it("un failed rend le check failed ; sinon passed ; tout skipped → skipped", () => {
    expect(aggregateProbes([
      { id: "a", status: "passed", output: "" },
      { id: "b", status: "failed", output: "boom" },
    ]).status).toBe("failed");
    expect(aggregateProbes([{ id: "a", status: "passed", output: "" }]).status).toBe("passed");
    expect(aggregateProbes([{ id: "a", status: "skipped", output: "" }]).status).toBe("skipped");
  });
});
