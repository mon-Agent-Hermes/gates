import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isToolMissing, checkDeliverables, isRouteServed, probeUrl } from "./sandbox.js";

describe("isToolMissing (outil absent vs vrai échec)", () => {
  it("détecte un binaire absent (ENOENT / exit 127 / 9009 / message shell)", () => {
    expect(isToolMissing("ENOENT", "")).toBe(true);
    expect(isToolMissing(undefined, "", 127)).toBe(true);
    expect(isToolMissing(undefined, "", 9009)).toBe(true);
    expect(isToolMissing(undefined, "ruff: command not found")).toBe(true);
    expect(isToolMissing(undefined, "'pytest' n'est pas reconnu en tant que commande")).toBe(true);
    expect(isToolMissing(undefined, "'tsc' is not recognized as an internal or external command")).toBe(true);
  });

  it("NE masque PAS de vrais échecs (import cassé, fichier manquant, test rouge)", () => {
    // C'était le faux pass : ces messages étaient reclassés en "skipped".
    expect(isToolMissing(undefined, "ModuleNotFoundError: No module named 'app'", 1)).toBe(false);
    expect(isToolMissing(undefined, "Error: no such file or directory, open 'src/x.ts'", 1)).toBe(false);
    expect(isToolMissing(undefined, "fichier introuvable", 1)).toBe(false);
    expect(isToolMissing(undefined, "1 test failed", 1)).toBe(false);
  });
});

describe("checkDeliverables (coder-fantôme)", () => {
  it("signale les fichiers déclarés absents et laisse passer ceux qui existent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gates-deliv-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(dir, "src", "empty.py"), ""); // vide mais présent = légitime (ex: __init__)
    const absent = await checkDeliverables(dir, ["src/a.ts", "src/empty.py", "src/manquant.ts"]);
    expect(absent).toEqual(["src/manquant.ts"]);
  });

  it("renvoie [] quand tous les livrables existent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gates-deliv-"));
    writeFileSync(join(dir, "x.ts"), "1");
    expect(await checkDeliverables(dir, ["x.ts"])).toEqual([]);
  });
});

describe("isRouteServed (angle mort d'intégration)", () => {
  it("un 404 sur une route DÉCLARÉE = route non montée → échec", () => {
    expect(isRouteServed(404)).toBe(false);
  });

  it("pas de réponse ou 5xx = l'appli ne sert pas la route", () => {
    expect(isRouteServed(null)).toBe(false);
    expect(isRouteServed(500)).toBe(false);
    expect(isRouteServed(503)).toBe(false);
  });

  it("la route existe dès qu'elle répond (200, 401, 405, 422…) — le métier est jugé ailleurs", () => {
    for (const s of [200, 204, 301, 401, 403, 405, 422]) expect(isRouteServed(s)).toBe(true);
  });
});

describe("probeUrl", () => {
  it("compose l'URL de sonde à partir de l'URL de santé", () => {
    expect(probeUrl("http://localhost:3000/", "/tasks")).toBe("http://localhost:3000/tasks");
    expect(probeUrl("http://127.0.0.1:8000", "/health")).toBe("http://127.0.0.1:8000/health");
  });
});
