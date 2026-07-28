import type { CheckResult } from "./types";

/**
 * Format de sortie de `gates check` (§2.3 de SETUP-hermes-agent.md, version minimale).
 * Le bloc `criteria` par AC-n (spec-coverage) viendra avec §2.7 ; ici on rend seulement
 * les checks bruts + un résumé, de quoi trancher 0/1 et lire le verdict dans un terminal.
 */
export type GatesReport = {
  ok: boolean;
  checks: { name: string; status: CheckResult["status"]; output: string }[];
  summary: string;
};

export function buildReport(checks: CheckResult[]): GatesReport {
  const ok = checks.every((c) => c.status !== "failed");
  const passed = checks.filter((c) => c.status === "passed").length;
  const failed = checks.filter((c) => c.status === "failed").length;
  const skipped = checks.filter((c) => c.status === "skipped").length;
  return {
    ok,
    checks: checks.map((c) => ({ name: c.name, status: c.status, output: c.output })),
    summary: `${passed} vert(s) · ${failed} rouge(s) · ${skipped} ignoré(s)`,
  };
}

const ICON: Record<CheckResult["status"], string> = { passed: "✓", failed: "✗", skipped: "–" };

export function renderText(report: GatesReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`${ICON[c.status]} ${c.name} — ${c.status}`);
    if (c.output) for (const l of c.output.split("\n")) lines.push(`    ${l}`);
  }
  lines.push("");
  lines.push(`${report.ok ? "✓ TOUT VERT" : "✗ ÉCHEC"} · ${report.summary}`);
  return lines.join("\n");
}
