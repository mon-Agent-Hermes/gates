import { describe, it, expect } from "vitest";
import { checkSpecCoverage } from "./spec-coverage";
import type { AcceptanceCriterion } from "./spec";

const ac = (...ids: string[]): AcceptanceCriterion[] => ids.map((id) => ({ id, text: id }));

describe("checkSpecCoverage", () => {
  it("tous les AC couverts par une probe → vert", () => {
    const r = checkSpecCoverage(ac("AC-1", "AC-2"), ["AC-1", "AC-2"]);
    expect(r.ok).toBe(true);
    expect(r.uncovered).toEqual([]);
    expect(r.dangling).toEqual([]);
  });

  it("un AC déclaré sans probe = uncovered → ROUGE (pas « plus tard »)", () => {
    const r = checkSpecCoverage(ac("AC-1", "AC-9"), ["AC-1"]);
    expect(r.ok).toBe(false);
    expect(r.uncovered).toEqual(["AC-9"]);
  });

  it("une probe visant un critère absent de la spec = dangling → ROUGE (renommage/typo)", () => {
    const r = checkSpecCoverage(ac("AC-1"), ["AC-1", "AC-42"]);
    expect(r.ok).toBe(false);
    expect(r.dangling).toEqual(["AC-42"]);
  });

  it("ignore les probes sans criterion (undefined)", () => {
    const r = checkSpecCoverage(ac("AC-1"), ["AC-1", undefined]);
    expect(r.ok).toBe(true);
  });

  it("aucun critère ni probe → vert (rien à couvrir)", () => {
    expect(checkSpecCoverage([], []).ok).toBe(true);
  });
});
