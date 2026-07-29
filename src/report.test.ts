import { describe, it, expect } from "vitest";
import { buildCriteria, buildReport, renderText, type ProbeOutcome } from "./report";
import type { CheckResult } from "./types";

const ok: CheckResult = { name: "tests", status: "passed", output: "12 passed" };

describe("buildCriteria — l'état par AC-n, pas par check", () => {
  it("probe verte → critère vérifié ; probe rouge → critère en échec", () => {
    const probes: ProbeOutcome[] = [
      { id: "init", criterion: "AC-1", status: "passed" },
      { id: "arene", criterion: "AC-2", status: "failed", output: "0 appel de dessin" },
    ];
    const c = buildCriteria(["AC-1", "AC-2"], probes);
    expect(c["AC-1"].status).toBe("passed");
    expect(c["AC-2"].status).toBe("failed");
    expect(c["AC-2"].note).toMatch(/0 appel de dessin/);
  });

  it("critère déclaré sans aucune probe → uncovered", () => {
    const c = buildCriteria(["AC-1", "AC-9"], [{ id: "init", criterion: "AC-1", status: "passed" }]);
    expect(c["AC-9"].status).toBe("uncovered");
    expect(c["AC-9"].probes).toEqual([]);
  });

  it("critère dont toutes les probes sont IGNORÉES → uncovered, pas vérifié", () => {
    // Le faux vert visé : sans Chrome, la probe est « skipped », le check `probes`
    // reste vert, et l'exigence paraît satisfaite alors que personne ne l'a regardée.
    const c = buildCriteria(["AC-1"], [{ id: "arene", criterion: "AC-1", status: "skipped", output: "aucun Chrome" }]);
    expect(c["AC-1"].status).toBe("uncovered");
    expect(c["AC-1"].note).toMatch(/aucun Chrome/);
  });

  it("une probe rouge l'emporte sur une probe verte du même critère", () => {
    const c = buildCriteria(["AC-1"], [
      { id: "a", criterion: "AC-1", status: "passed" },
      { id: "b", criterion: "AC-1", status: "failed", output: "404" },
    ]);
    expect(c["AC-1"].status).toBe("failed");
    expect(c["AC-1"].probes).toEqual(["a", "b"]);
  });

  it("critère cité par une probe mais absent de la spec : présent quand même", () => {
    const c = buildCriteria(["AC-1"], [{ id: "x", criterion: "AC-42", status: "passed" }]);
    expect(Object.keys(c)).toContain("AC-42");
  });

  it("tri naturel : AC-2 avant AC-10", () => {
    const c = buildCriteria(["AC-10", "AC-2", "AC-1"], []);
    expect(Object.keys(c)).toEqual(["AC-1", "AC-2", "AC-10"]);
  });
});

describe("buildReport — un critère non couvert rend le verdict rouge", () => {
  it("tous les checks verts mais un critère non couvert → ok:false", () => {
    const r = buildReport([ok], buildCriteria(["AC-1"], []));
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/0\/1 critère/);
  });

  it("tous verts et tous les critères vérifiés → ok:true", () => {
    const r = buildReport([ok], buildCriteria(["AC-1"], [{ id: "p", criterion: "AC-1", status: "passed" }]));
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/1\/1 critère/);
  });

  it("sans critère déclaré, le bloc est absent et le verdict ne change pas", () => {
    const r = buildReport([ok], {});
    expect(r.criteria).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it("un check rouge suffit, même sans critère", () => {
    expect(buildReport([{ name: "tests", status: "failed", output: "1 failed" }]).ok).toBe(false);
  });
});

describe("renderText", () => {
  it("affiche la section des critères avec leur état", () => {
    const txt = renderText(buildReport([ok], buildCriteria(["AC-1", "AC-9"], [
      { id: "arene", criterion: "AC-1", status: "failed", output: "0 appel de dessin" },
    ])));
    expect(txt).toMatch(/Critères d'acceptation/);
    expect(txt).toMatch(/AC-1 — échec/);
    expect(txt).toMatch(/AC-9 — NON VÉRIFIÉ/);
    expect(txt).toMatch(/ÉCHEC/);
  });
});
