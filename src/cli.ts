import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGuardrailsInDir, runInstall, runSmoke, checkDeliverables, type SmokeConfig } from "./sandbox";
import { analyzeReachability } from "./reachability";
import { runProbes, aggregateProbes, type Probe } from "./probes";
import { parseAcceptanceCriteria } from "./spec";
import { checkSpecCoverage } from "./spec-coverage";
import type { PageRequirements } from "./page-check";
import type { CheckResult } from "./types";
import { buildReport, renderText, type GatesReport } from "./report";

/**
 * Contrat de `gates.json` (§2.4 — version minimale du premier jet).
 * Les commandes sont DÉCLARÉES, jamais devinées de la prose (défaut n°5).
 */
export type GatesConfig = {
  install?: string;
  commands?: Record<string, string>;
  requiredCommands?: string[];
  entry?: string;
  roots?: string[];
  app?: {
    start?: string;
    url?: string;
    readyTimeoutMs?: number;
    paths?: string[];
    page?: PageRequirements;
  };
  deliverables?: string[];
  /** Scénarios d'observation de l'artefact (§2.5). */
  probes?: Probe[];
  /** Fichier des critères d'acceptation pour `spec-coverage` (défaut `spec.md`). */
  specFile?: string;
};

async function loadConfig(dir: string): Promise<GatesConfig | null> {
  try {
    return JSON.parse(await readFile(resolve(dir, "gates.json"), "utf8")) as GatesConfig;
  } catch {
    return null;
  }
}

/**
 * Lance les checks déclarés par `gates.json` dans `dir` et agrège le verdict.
 * exit 0 = tout vert · 1 = au moins un rouge · 2 = config invalide (géré par l'appelant).
 */
export async function check(
  dir: string,
  opts: { only?: string[] | null } = {},
): Promise<{ ok: boolean; report: GatesReport } | null> {
  const cfg = await loadConfig(dir);
  if (!cfg) return null;

  const want = (name: string) => !opts.only || opts.only.includes(name);
  const checks: CheckResult[] = [];

  // 1. Dépendances (best-effort, silencieux) — pytest/uvicorn ne s'auto-installent pas.
  if (cfg.install) await runInstall(dir, cfg.install);

  // 2. Commandes déclarées (typecheck / tests / build / lint…).
  if (cfg.commands) {
    const filtered = Object.fromEntries(Object.entries(cfg.commands).filter(([n]) => want(n)));
    if (Object.keys(filtered).length) {
      const res = await runGuardrailsInDir(dir, filtered);
      const required = new Set(cfg.requiredCommands ?? []);
      for (const c of res.checks) {
        // Un gate REQUIS dont l'outil est absent = ÉCHEC, pas « skipped » (§2.4).
        if (c.status === "skipped" && c.reason === "tool-missing" && required.has(c.name)) {
          checks.push({ ...c, status: "failed", output: `${c.output} — or ce gate est REQUIS (requiredCommands)` });
        } else {
          checks.push(c);
        }
      }
    }
  }

  // 3. Livrables déclarés présents (ferme le « coder-fantôme »).
  if (want("deliverables") && cfg.deliverables?.length) {
    const absent = await checkDeliverables(dir, cfg.deliverables);
    checks.push(
      absent.length
        ? { name: "deliverables", status: "failed", output: `fichiers déclarés absents : ${absent.join(", ")}` }
        : { name: "deliverables", status: "passed", output: `${cfg.deliverables.length} livrable(s) présent(s)` },
    );
  }

  // 4. Assemblage : tout livrable atteignable depuis le point d'entrée (§2.1).
  if (want("assembly")) {
    const r = await analyzeReachability(dir, cfg.roots ?? ["src"]);
    if (!r.conclusive) {
      checks.push({ name: "assembly", status: "skipped", reason: "not-configured", output: r.note });
    } else if (r.unreachable.length) {
      checks.push({
        name: "assembly",
        status: "failed",
        output: `${r.unreachable.length} livrable(s) jamais atteint(s) depuis ${r.entries.join(", ")} : ${r.unreachable.join(", ")}`,
      });
    } else {
      checks.push({ name: "assembly", status: "passed", output: `${r.scanned} livrable(s), tous atteignables depuis ${r.entries.join(", ")}` });
    }
  }

  // 5. Smoke : l'app démarre, répond, sert ses routes déclarées et rend sa page.
  if (want("smoke") && cfg.app?.start && cfg.app?.url) {
    const smoke: SmokeConfig = {
      cmd: cfg.app.start,
      url: cfg.app.url,
      readyTimeoutMs: cfg.app.readyTimeoutMs,
      paths: cfg.app.paths,
      page: cfg.app.page,
    };
    checks.push(await runSmoke(dir, smoke, cfg.app.readyTimeoutMs ?? 30_000));
  }

  // 6. Probes : l'artefact fait-il son travail ? (cli/artifact ; §2.5)
  if (want("probes") && cfg.probes?.length) {
    checks.push(aggregateProbes(await runProbes(cfg.probes)));
  }

  // 7. spec-coverage : tout AC-n a sa probe, toute probe vise un AC-n réel (§2.7).
  if (want("spec-coverage")) {
    const specText = await readFile(resolve(dir, cfg.specFile ?? "spec.md"), "utf8").catch(() => null);
    const probeCriteria = (cfg.probes ?? []).map((p) => p.criterion);
    const hasCriteria = probeCriteria.some(Boolean);
    if (specText === null && !hasCriteria) {
      checks.push({ name: "spec-coverage", status: "skipped", reason: "not-configured", output: "aucune spec.md ni critère de probe" });
    } else {
      const criteria = specText ? parseAcceptanceCriteria(specText) : [];
      const r = checkSpecCoverage(criteria, probeCriteria);
      checks.push(
        r.ok
          ? { name: "spec-coverage", status: "passed", output: `${criteria.length} critère(s), tous couverts par une probe` }
          : { name: "spec-coverage", status: "failed", output: r.reasons.join("\n") },
      );
    }
  }

  const report = buildReport(checks);
  return { ok: report.ok, report };
}

function parseArgs(argv: string[]): { json: boolean; only: string[] | null } {
  const json = argv.includes("--json");
  const i = argv.indexOf("--only");
  const only = i >= 0 && argv[i + 1] ? argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean) : null;
  return { json, only };
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] !== "check") {
    process.stderr.write("usage : gates check [--json] [--only nom1,nom2]\n");
    return 2;
  }
  const { json, only } = parseArgs(argv.slice(1));
  const res = await check(process.cwd(), { only });
  if (!res) {
    process.stderr.write("gates : aucun gates.json lisible dans le dossier courant (config invalide, exit 2)\n");
    return 2;
  }
  process.stdout.write((json ? JSON.stringify(res.report, null, 2) : renderText(res.report)) + "\n");
  return res.ok ? 0 : 1;
}

// Exécution directe uniquement (pas quand le module est importé par un test).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`gates : erreur inattendue : ${e?.stack ?? e}\n`);
      process.exit(2);
    });
}
