import { describe, it, expect } from "vitest";
import { construirePlan, renderPlan } from "./plan.js";

const spec = (criteres: string[]) => ({ fichier: "spec.md", lisible: true, criteres });
const ligne = (p: ReturnType<typeof construirePlan>, nom: string) => p.lignes.find((x) => x.nom === nom)!;

describe("gates plan — ce que le contrat fera juger", () => {
  it("une famille listée dans `bloquant` se distingue d'une famille seulement signalée", () => {
    // La distinction que le plan existe pour rendre lisible AVANT `!approuve` : par
    // défaut rien ne bloque, et c'est le contrat approuvé qui décide de ce qui rougit.
    const p = construirePlan({ site: { bloquant: ["mobile:viewport", "seo"] } }, spec([]));
    expect(ligne(p, "mobile").detail).toBe("BLOQUANT");
    expect(ligne(p, "seo").detail).toBe("BLOQUANT");
    expect(ligne(p, "a11y").detail).toMatch(/ne bloque pas/);
    for (const f of ["a11y", "mobile", "budgets", "seo"]) expect(ligne(p, f).juge, f).toBe(true);
  });

  it("`app.page` suffit à activer les familles, sans section `site`", () => {
    const p = construirePlan({ app: { page: {} } }, spec([]));
    expect(ligne(p, "budgets").juge).toBe(true);
  });

  it("un critère sans probe est annoncé comme un ÉCHEC à venir, pas comme un oubli mineur", () => {
    const p = construirePlan(
      { probes: [{ id: "a", kind: "cli", criterion: "AC-1" }] },
      spec(["AC-1", "AC-2"]),
    );
    expect(p.criteres.sansProbe).toEqual(["AC-2"]);
    expect(renderPlan(p)).toMatch(/AC-2 — ils compteront comme des ÉCHECS/);
  });

  it("le juge de qualité est annoncé pour tout type de projet, avec les grilles que ses preuves permettent", () => {
    const site = construirePlan({ site: {} }, spec([]));
    expect(ligne(site, "qualite").detail).toMatch(/écran/);
    const cli = construirePlan({ probes: [{ id: "a", kind: "cli" }], qualite: { seuil: 8 } }, spec([]));
    expect(ligne(cli, "qualite").detail).toMatch(/seuil 8\/10.*usage/);
    expect(ligne(cli, "qualite").detail).not.toMatch(/écran/);
    expect(ligne(construirePlan({}, spec([])), "qualite").juge).toBe(false);
  });

  it("le rendu dit toujours qu'il n'a rien exécuté — un plan n'est pas un verdict", () => {
    const texte = renderPlan(construirePlan({}, spec([])));
    expect(texte).toMatch(/rien n'a été exécuté/);
    expect(texte).toMatch(/peut encore être ignoré à l'exécution/);
  });
});
