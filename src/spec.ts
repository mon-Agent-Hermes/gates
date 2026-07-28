/**
 * Lecture des critères d'acceptation d'une `spec.md` (§2.7, §6.1).
 *
 * Format imposé au cadrage, pour que le check `spec-coverage` puisse le lire SANS
 * heuristique (une déduction floue rejouerait le défaut n°5) :
 *
 *   ## Critères d'acceptation
 *   - **AC-1** — après clic sur « Guerrier », le canvas rend ≥ 1 appel de dessin…
 *   - **AC-3** — `cli init` crée `config.json` et sort en 0.
 *
 * On tolère les puces `-`/`*`, les `**AC-n**` gras ou nus, et les séparateurs `—`,
 * `-` ou `:`. Pur → testable.
 */

export type AcceptanceCriterion = { id: string; text: string };

const AC_LINE = /^\s*[-*]\s+\*{0,2}(AC-\d+)\*{0,2}\s*[—:-]\s*(.+?)\s*$/;

/** Critères d'acceptation déclarés (ordre d'apparition, dédupliqués par identifiant). */
export function parseAcceptanceCriteria(md: string): AcceptanceCriterion[] {
  const out: AcceptanceCriterion[] = [];
  const seen = new Set<string>();
  for (const line of (md ?? "").split(/\r?\n/)) {
    const m = line.match(AC_LINE);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, text: m[2] });
  }
  return out;
}
