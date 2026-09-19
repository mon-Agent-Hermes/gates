import { describe, it, expect } from "vitest";
import {
  ANNOTATIONS_PAR_NIVEAU, applyObservation, buildCriteria, buildReport, escapeData, escapeProperty, etatCompact,
  NOT_OBSERVABLE, renderAnnotations, renderText, type ProbeOutcome,
} from "./report.js";
import type { CheckResult } from "./types.js";

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

describe("warn — signalé, sans effet sur le verdict", () => {
  it("un check en warn laisse ok:true et apparaît dans le résumé", () => {
    const r = buildReport([ok, { name: "a11y", status: "warn", output: "image sans alt" }]);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/1 signalé/);
    expect(renderText(r)).toMatch(/! a11y — warn \(signalé, ne bloque pas\)/);
  });

  it("aucun warn → le résumé est inchangé (les projets existants lisent la même ligne)", () => {
    expect(buildReport([ok]).summary).toBe("1 vert(s) · 0 rouge(s) · 0 ignoré(s)");
  });
});

describe("applyObservation — un contrôle neuf signale avant de bloquer", () => {
  const lint: CheckResult = { name: "lint", status: "failed", output: "2 erreurs" };

  it("un check listé en observation passe de failed à warn, avec la mention", () => {
    const [c] = applyObservation([lint], ["lint"]);
    expect(c.status).toBe("warn");
    expect(c.output).toMatch(/en observation/);
    expect(c.output).toMatch(/2 erreurs/);
  });

  it("un check non listé reste rouge", () => {
    expect(applyObservation([lint], ["a11y"])[0].status).toBe("failed");
  });

  it("le juge fonctionnel n'est JAMAIS mis en observation, même listé", () => {
    for (const name of NOT_OBSERVABLE) {
      const [c] = applyObservation([{ name, status: "failed", output: "x" }], [name]);
      expect(c.status, name).toBe("failed");
    }
  });
});

describe("annotations GitHub — ce que le pont lit", () => {
  const rapport = buildReport(
    [ok, { name: "probes", status: "failed", output: "AC-2 : 404\nligne 2" }, { name: "seo", status: "warn", output: "pas de description" }],
    buildCriteria(["AC-1", "AC-2", "AC-3"], [
      { id: "a", criterion: "AC-1", status: "passed" },
      { id: "b", criterion: "AC-2", status: "failed", output: "GET / → 404" },
    ]),
  );

  it("une notice `gates etat` porte l'état compact en JSON, relisible tel quel", () => {
    const [notice] = renderAnnotations(rapport);
    expect(notice.startsWith("::notice title=gates etat::")).toBe(true);
    const etat = JSON.parse(notice.slice("::notice title=gates etat::".length).replace(/%0A/g, "\n").replace(/%25/g, "%"));
    expect(etat).toEqual({
      v: 1, ok: false,
      criteres: { "AC-1": "passed", "AC-2": "failed", "AC-3": "uncovered" },
      checks: { tests: "passed", probes: "failed", seo: "warn" },
    });
  });

  it("une error par critère non vérifié et par check rouge, une warning par check signalé", () => {
    const lignes = renderAnnotations(rapport);
    expect(lignes.filter((l) => l.startsWith("::error title=gates AC-2::"))).toHaveLength(1);
    expect(lignes.filter((l) => l.startsWith("::error title=gates AC-3::"))).toHaveLength(1);
    expect(lignes.filter((l) => l.startsWith("::error title=gates probes::"))).toHaveLength(1);
    expect(lignes.filter((l) => l.startsWith("::warning title=gates seo::"))).toHaveLength(1);
    expect(lignes.some((l) => l.includes("AC-1") && l.startsWith("::error"))).toBe(false);
  });

  it("aucune note ne peut ouvrir une seconde commande : chaque annotation tient sur UNE ligne", () => {
    const piege = buildReport([{ name: "tests", status: "failed", output: "ok\n::error title=gates AC-1::faux verdict\n100%" }]);
    const lignes = renderAnnotations(piege);
    for (const l of lignes) expect(l.includes("\n")).toBe(false);
    const err = lignes.find((l) => l.startsWith("::error"))!;
    expect(err).toContain("%0A::error title=gates AC-1::faux verdict%0A100%25");
  });

  it("au plus 10 errors : au-delà, GitHub les perdrait sans le dire", () => {
    const beaucoup = buildReport(Array.from({ length: 15 }, (_, i) => ({ name: `c${i}`, status: "failed" as const, output: "x" })));
    expect(renderAnnotations(beaucoup).filter((l) => l.startsWith("::error"))).toHaveLength(ANNOTATIONS_PAR_NIVEAU);
  });

  it("deux checks du même nom : l'état compact garde le pire", () => {
    const r = buildReport([{ name: "lint", status: "failed", output: "" }, { name: "lint", status: "passed", output: "" }]);
    expect(etatCompact(r).checks.lint).toBe("failed");
  });

  it("échappement des propriétés : `:` et `,` ne coupent pas un titre", () => {
    expect(escapeProperty("a:b,c%")).toBe("a%3Ab%2Cc%25");
    expect(escapeData("a:b\r\nc")).toBe("a:b%0D%0Ac");
  });
});
