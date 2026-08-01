import type { AcceptanceCriterion } from "./spec.js";

/**
 * Check `spec-coverage` (§2.7) — purement mécanique, il referme le dernier trou du
 * montage : l'agent garde le droit de réécrire les tests d'un fichier, mais il ne peut
 * plus faire DISPARAÎTRE une exigence, car :
 *
 *  1. tout `AC-n` déclaré dans spec.md doit être référencé par ≥ 1 probe ;
 *  2. tout `criterion` cité par une probe doit exister dans spec.md (attrape renommages
 *     et fautes de frappe qui décrochent silencieusement une exigence de sa vérif) ;
 *  3. un critère orphelin est ROUGE, pas « à couvrir plus tard » — `uncovered` compte
 *     comme un échec.
 *
 * Pur → testable sans FS.
 */

export type SpecCoverageResult = {
  ok: boolean;
  /** AC-n déclarés dans la spec mais qu'aucune probe ne référence. */
  uncovered: string[];
  /** `criterion` cités par une probe mais absents de la spec (renommage / typo). */
  dangling: string[];
  reasons: string[];
};

export function checkSpecCoverage(
  criteria: AcceptanceCriterion[],
  probeCriteria: (string | undefined)[],
): SpecCoverageResult {
  const declared = new Set(criteria.map((c) => c.id));
  const referenced = new Set(probeCriteria.filter((c): c is string => Boolean(c)));

  const uncovered = [...declared].filter((id) => !referenced.has(id)).sort();
  const dangling = [...referenced].filter((id) => !declared.has(id)).sort();

  const reasons: string[] = [];
  if (uncovered.length) reasons.push(`critère(s) non couvert(s) par une probe : ${uncovered.join(", ")}`);
  if (dangling.length) reasons.push(`probe(s) visant un critère absent de la spec : ${dangling.join(", ")}`);

  return { ok: uncovered.length === 0 && dangling.length === 0, uncovered, dangling, reasons };
}
