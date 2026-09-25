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

/**
 * Les checks qu'on peut mettre EN OBSERVATION (`observation` dans `gates.json`) : ils
 * signalent sans bloquer. Seulement ce qui n'est pas le juge fonctionnel — les commandes
 * déclarées (lint, par exemple) et les contrôles de site. Un `observation: ["probes"]`
 * glissé dans un contrat approuvé trop vite éteindrait le juge : c'est refusé au
 * chargement, pas découvert après coup.
 */
export const NOT_OBSERVABLE = new Set(["probes", "smoke", "deliverables", "assembly", "coverage", "spec-coverage", "page"]);

/** Un check en observation qui échoue devient `warn` : signalé, sans effet sur le verdict. */
export function applyObservation(checks: CheckResult[], observed: string[] | undefined): CheckResult[] {
  if (!observed?.length) return checks;
  const set = new Set(observed);
  return checks.map((c) =>
    c.status === "failed" && set.has(c.name) && !NOT_OBSERVABLE.has(c.name)
      ? { ...c, status: "warn" as const, output: `(en observation : signalé, ne bloque pas)\n${c.output}` }
      : c,
  );
}

export function buildReport(checks: CheckResult[], criteria?: Record<string, CriterionReport>): GatesReport {
  const passed = checks.filter((c) => c.status === "passed").length;
  const failed = checks.filter((c) => c.status === "failed").length;
  const skipped = checks.filter((c) => c.status === "skipped").length;
  const warned = checks.filter((c) => c.status === "warn").length;

  const crit = criteria && Object.keys(criteria).length ? criteria : undefined;
  const critEntries = crit ? Object.values(crit) : [];
  const critOk = critEntries.filter((c) => c.status === "passed").length;

  // Un critère rouge OU non couvert rend le verdict rouge, même si tous les checks
  // passent : c'est le seul moyen d'empêcher « non vérifié » de se lire « vérifié ».
  const ok = checks.every((c) => c.status !== "failed") && critEntries.every((c) => c.status === "passed");

  const parts = [`${passed} vert(s) · ${failed} rouge(s) · ${skipped} ignoré(s)`];
  // `warn` ne change pas le verdict, mais il ne doit pas disparaître du résumé : c'est
  // la seule ligne que tout le monde lit.
  if (warned) parts.push(`${warned} signalé(s)`);
  if (crit) parts.push(`${critOk}/${critEntries.length} critère(s)`);

  return {
    ok,
    checks: checks.map((c) => ({ name: c.name, status: c.status, output: c.output })),
    ...(crit ? { criteria: crit } : {}),
    summary: parts.join(" · "),
  };
}

const ICON: Record<CheckResult["status"], string> = { passed: "✓", failed: "✗", skipped: "–", warn: "!" };
const LABEL: Record<CheckResult["status"], string> = {
  passed: "passed", failed: "failed", skipped: "skipped", warn: "warn (signalé, ne bloque pas)",
};
const CRIT_ICON: Record<CriterionStatus, string> = { passed: "✓", failed: "✗", uncovered: "?" };
const CRIT_LABEL: Record<CriterionStatus, string> = { passed: "vérifié", failed: "échec", uncovered: "NON VÉRIFIÉ" };

export function renderText(report: GatesReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`${ICON[c.status]} ${c.name} — ${LABEL[c.status]}`);
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

// ── Annotations GitHub — ce que le pont lit pour juger une nuit ─────────────────

/**
 * Échappement des commandes de workflow. Le message est une donnée : seuls `%`, `\r` et
 * `\n` y sont spéciaux — c'est ce qui empêche une note de probe multi-lignes d'ouvrir une
 * seconde commande. Les propriétés (`title=`) échappent en plus `:` et `,`.
 */
export function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** GitHub garde au plus 10 annotations de chaque niveau par étape : au-delà, perdues. */
export const ANNOTATIONS_PAR_NIVEAU = 10;
const LONGUEUR_NOTE = 500;

const tronquer = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** L'état compact du verdict, tel que le pont le relit : `{ v, ok, criteres, checks }`. */
export function etatCompact(report: GatesReport): {
  v: 1; ok: boolean; criteres: Record<string, CriterionStatus>; checks: Record<string, CheckResult["status"]>;
} {
  const checks: Record<string, CheckResult["status"]> = {};
  // Deux checks du même nom (deux commandes) : le pire l'emporte, jamais le dernier lu.
  const rang: Record<CheckResult["status"], number> = { failed: 3, warn: 2, skipped: 1, passed: 0 };
  for (const c of report.checks) {
    const avant = checks[c.name];
    if (avant === undefined || rang[c.status] > rang[avant]) checks[c.name] = c.status;
  }
  const criteres: Record<string, CriterionStatus> = {};
  for (const [id, c] of Object.entries(report.criteria ?? {})) criteres[id] = c.status;
  return { v: 1, ok: report.ok, criteres, checks };
}

/**
 * Les annotations d'un verdict, une commande de workflow par ligne :
 *  - UNE `notice` titrée `gates etat`, portant `etatCompact` en JSON. C'est elle que le
 *    pont lit pour savoir, critère par critère, où en est un brief de nuit ;
 *  - une `error` par critère non vérifié, puis par check rouge, titrée `gates <nom>` ;
 *  - une `warning` par check signalé.
 *
 * Ne sort que sous GitHub Actions (cf. `main`). Le code de sortie ne change pas.
 */
export function renderAnnotations(report: GatesReport): string[] {
  const lines = [`::notice title=${escapeProperty("gates etat")}::${escapeData(JSON.stringify(etatCompact(report)))}`];

  const errors: { title: string; msg: string }[] = [];
  for (const [id, c] of Object.entries(report.criteria ?? {})) {
    if (c.status !== "passed") errors.push({ title: `gates ${id}`, msg: `${CRIT_LABEL[c.status]}${c.note ? ` — ${c.note}` : ""}` });
  }
  for (const c of report.checks) {
    if (c.status === "failed") errors.push({ title: `gates ${c.name}`, msg: c.output || "échec" });
  }
  for (const e of errors.slice(0, ANNOTATIONS_PAR_NIVEAU)) {
    lines.push(`::error title=${escapeProperty(e.title)}::${escapeData(tronquer(e.msg, LONGUEUR_NOTE))}`);
  }

  const warns = report.checks.filter((c) => c.status === "warn");
  for (const c of warns.slice(0, ANNOTATIONS_PAR_NIVEAU)) {
    lines.push(`::warning title=${escapeProperty(`gates ${c.name}`)}::${escapeData(tronquer(c.output || "signalé", LONGUEUR_NOTE))}`);
  }
  return lines;
}
