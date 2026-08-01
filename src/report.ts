import type { CheckResult } from "./types.js";

/**
 * Format de sortie de `gates check` (§2.3).
 *
 * Deux niveaux de lecture, et le second est celui qui compte pour la boucle :
 *  - `checks` : le détail par garde-fou, pour comprendre et corriger ;
 *  - `criteria` : l'état de chaque critère d'acceptation `AC-n`. C'est ce que la skill
 *    `/verify` doit rapporter (« AC-3 ❌ · AC-9 non couvert »), pas `probes: failed` —
 *    seule forme qui reste lisible quand la spec grossit, et seule qui parle la langue
 *    de la spec plutôt que celle de l'outil.
 *
 * Trois états seulement, et `uncovered` COMPTE COMME UN ÉCHEC : « aucune probe ne l'a
 * vérifié » n'est pas « pas de problème ». C'est ce qui ferme le faux vert du critère
 * dont la seule probe a été ignorée (pas de navigateur sur la machine, par exemple) :
 * sans cette règle, l'absence de vérification se lit comme une vérification réussie.
 */
export type CriterionStatus = "passed" | "failed" | "uncovered";

export type CriterionReport = {
  status: CriterionStatus;
  /** Identifiants des probes qui portent ce critère (vide si aucune). */
  probes: string[];
  /** Pourquoi ce critère n'est pas vert (probe rouge, probe ignorée, aucune probe). */
  note?: string;
};

export type GatesReport = {
  ok: boolean;
  checks: { name: string; status: CheckResult["status"]; output: string }[];
  /** Absent quand le projet ne déclare aucun critère (`spec.md` sans `AC-n`). */
  criteria?: Record<string, CriterionReport>;
  summary: string;
};

/** Forme minimale d'un résultat de probe consommée ici (évite le couplage à probes.ts). */
export type ProbeOutcome = { id: string; criterion?: string; status: "passed" | "failed" | "skipped"; output?: string };

/** Tri naturel : AC-2 avant AC-10 (l'ordre lexicographique mentirait). */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "fr", { numeric: true, sensitivity: "base" });
}

/**
 * Croise les critères déclarés (`spec.md`) et les probes qui les portent.
 * Les critères cités par une probe mais absents de la spec sont inclus : c'est un
 * renommage ou une faute de frappe, `spec-coverage` le signale, et le voir ici évite
 * de chercher pourquoi un `AC-n` a disparu du rapport.
 */
export function buildCriteria(declared: string[], probes: ProbeOutcome[]): Record<string, CriterionReport> {
  const ids = [...new Set([...declared, ...probes.map((p) => p.criterion).filter((c): c is string => !!c)])];
  const out: Record<string, CriterionReport> = {};
  for (const id of ids.sort(naturalCompare)) {
    const mine = probes.filter((p) => p.criterion === id);
    const failed = mine.filter((p) => p.status === "failed");
    const passed = mine.filter((p) => p.status === "passed");
    if (failed.length) {
      out[id] = { status: "failed", probes: mine.map((p) => p.id), note: failed.map((p) => `${p.id} : ${p.output ?? "échec"}`).join(" ; ") };
    } else if (passed.length) {
      out[id] = { status: "passed", probes: mine.map((p) => p.id) };
    } else if (mine.length) {
      out[id] = {
        status: "uncovered",
        probes: mine.map((p) => p.id),
        note: `probe(s) ignorée(s) : ${mine.map((p) => `${p.id} (${p.output ?? "ignorée"})`).join(" ; ")} — le critère n'a donc PAS été vérifié`,
      };
    } else {
      out[id] = { status: "uncovered", probes: [], note: "aucune probe ne vérifie ce critère" };
    }
  }
  return out;
}

export function buildReport(checks: CheckResult[], criteria?: Record<string, CriterionReport>): GatesReport {
  const passed = checks.filter((c) => c.status === "passed").length;
  const failed = checks.filter((c) => c.status === "failed").length;
  const skipped = checks.filter((c) => c.status === "skipped").length;

  const crit = criteria && Object.keys(criteria).length ? criteria : undefined;
  const critEntries = crit ? Object.values(crit) : [];
  const critOk = critEntries.filter((c) => c.status === "passed").length;

  // Un critère rouge OU non couvert rend le verdict rouge, même si tous les checks
  // passent : c'est le seul moyen d'empêcher « non vérifié » de se lire « vérifié ».
  const ok = checks.every((c) => c.status !== "failed") && critEntries.every((c) => c.status === "passed");

  const parts = [`${passed} vert(s) · ${failed} rouge(s) · ${skipped} ignoré(s)`];
  if (crit) parts.push(`${critOk}/${critEntries.length} critère(s)`);

  return {
    ok,
    checks: checks.map((c) => ({ name: c.name, status: c.status, output: c.output })),
    ...(crit ? { criteria: crit } : {}),
    summary: parts.join(" · "),
  };
}

const ICON: Record<CheckResult["status"], string> = { passed: "✓", failed: "✗", skipped: "–" };
const CRIT_ICON: Record<CriterionStatus, string> = { passed: "✓", failed: "✗", uncovered: "?" };
const CRIT_LABEL: Record<CriterionStatus, string> = { passed: "vérifié", failed: "échec", uncovered: "NON VÉRIFIÉ" };

export function renderText(report: GatesReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`${ICON[c.status]} ${c.name} — ${c.status}`);
    if (c.output) for (const l of c.output.split("\n")) lines.push(`    ${l}`);
  }
  if (report.criteria) {
    lines.push("");
    lines.push("Critères d'acceptation");
    for (const [id, c] of Object.entries(report.criteria)) {
      lines.push(`${CRIT_ICON[c.status]} ${id} — ${CRIT_LABEL[c.status]}`);
      if (c.note) lines.push(`    ${c.note}`);
    }
  }
  lines.push("");
  lines.push(`${report.ok ? "✓ TOUT VERT" : "✗ ÉCHEC"} · ${report.summary}`);
  return lines.join("\n");
}
