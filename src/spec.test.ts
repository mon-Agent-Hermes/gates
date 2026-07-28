import { describe, it, expect } from "vitest";
import { parseAcceptanceCriteria } from "./spec";

describe("parseAcceptanceCriteria", () => {
  it("lit les AC-n au format imposé (gras + tiret cadratin)", () => {
    const md = `
## Critères d'acceptation

- **AC-1** — après clic sur « Guerrier », le canvas rend ≥ 1 appel de dessin.
- **AC-3** — \`cli init\` crée \`config.json\` et sort en 0.
- **AC-7** — \`GET /tasks\` répond autre chose que 404.
`;
    const crit = parseAcceptanceCriteria(md);
    expect(crit.map((c) => c.id)).toEqual(["AC-1", "AC-3", "AC-7"]);
    expect(crit[0].text).toMatch(/canvas rend/);
  });

  it("tolère les puces *, les AC nus et les séparateurs - / :", () => {
    const md = `* AC-2 - la route répond\n- AC-5 : le fichier est produit`;
    expect(parseAcceptanceCriteria(md).map((c) => c.id)).toEqual(["AC-2", "AC-5"]);
  });

  it("déduplique par identifiant, ignore le texte hors puce", () => {
    const md = `Le critère AC-9 est cité ici en prose (pas une puce).\n- **AC-9** — vraie déclaration\n- **AC-9** — doublon`;
    const crit = parseAcceptanceCriteria(md);
    expect(crit.map((c) => c.id)).toEqual(["AC-9"]);
    expect(crit[0].text).toBe("vraie déclaration");
  });

  it("texte sans critère → liste vide", () => {
    expect(parseAcceptanceCriteria("Un doc sans critère.")).toEqual([]);
    expect(parseAcceptanceCriteria("")).toEqual([]);
  });
});
