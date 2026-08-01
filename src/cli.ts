import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { runGuardrailsInDir, runInstall, checkDeliverables, startApp, smokeAssertions } from "./sandbox.js";
import { analyzeReachability } from "./reachability.js";
import { runProbesAgainst, aggregateProbes, type Probe, type ProbeResult } from "./probes.js";
import { parseAcceptanceCriteria } from "./spec.js";
import { checkSpecCoverage } from "./spec-coverage.js";
import {
  adapterEnv, checkCoverage, collectCoverage, countCoverageFiles, expandCov, listFiles,
  noteServerCoverage, resolveAdapter, type CoverageConfig, type CoverageContext,
} from "./coverage.js";
import type { PageRequirements } from "./page-check.js";
import type { CheckResult } from "./types.js";
import { buildCriteria, buildReport, renderText, type GatesReport } from "./report.js";

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
  /** Atteignabilité PAR EXÉCUTION, mesurée pendant les probes (§2.6). */
  coverage?: CoverageConfig;
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
): Promise<{ ok: boolean; report: GatesReport } | { configError: string } | null> {
  const cfg = await loadConfig(dir);
  if (!cfg) return null;

  const want = (name: string) => !opts.only || opts.only.includes(name);
  const checks: CheckResult[] = [];

  // 0. Instrumentation de couverture (§2.6). Le dossier de mesure est créé AVANT toute
  //    probe : c'est lui qu'on injecte dans l'environnement des process observés.
  const covCfg = cfg.coverage;
  const wantCoverage = want("coverage") && !!covCfg?.requireExecuted?.length;
  let cov: CoverageContext | null = null;
  let covDir: string | null = null;
  let adapter: ReturnType<typeof resolveAdapter> | null = null;
  if (wantCoverage && covCfg) {
    adapter = resolveAdapter(covCfg);
    if ("error" in adapter) return { configError: adapter.error };
    covDir = await mkdtemp(join(tmpdir(), "gates-cov-"));
    cov = { dir: covDir, env: adapterEnv(adapter, covDir), incomplete: [] };
  }

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
  //    Ne conclut que sur un graphe d'imports JS/HTML : hors du web il sort `skipped`,
  //    et c'est `coverage` (§2.6) qui porte alors l'atteignabilité.
  if (want("assembly")) {
    const r = await analyzeReachability(dir, cfg.roots ?? ["src"], cfg.entry);
    if (r.configError) {
      checks.push({ name: "assembly", status: "failed", output: r.note });
    } else if (!r.conclusive) {
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

  // 5+6. App partagée : le check `smoke` ET les probes `http`/`browser` sondent la
  //      MÊME instance, démarrée UNE SEULE fois par le harnais puis arrêtée (au lieu
  //      d'un démarrage pour smoke + un autre pour les probes).
  let probeResults: ProbeResult[] = [];
  {
    const appCfg = cfg.app?.start && cfg.app?.url
      ? { start: cfg.app.start, url: cfg.app.url, readyTimeoutMs: cfg.app.readyTimeoutMs }
      : null;
    const wantSmoke = want("smoke") && !!appCfg;
    const wantProbes = want("probes") && !!cfg.probes?.length;
    const hasServerProbes = (cfg.probes ?? []).some((p) => p.kind === "http" || p.kind === "browser");
    const needStart = !!appCfg && (wantSmoke || (wantProbes && hasServerProbes));
    const runProbesHere = async (baseUrl?: string) => {
      probeResults = await runProbesAgainst(cfg.probes!, { dir, baseUrl, coverage: cov ?? undefined });
      checks.push(aggregateProbes(probeResults));
    };

    if (needStart && appCfg) {
      // L'app partagée est démarrée AVEC l'instrumentation : sans elle, tout projet
      // dont le code ne vit que dans un serveur serait invisible à la couverture.
      const covBefore = cov ? await countCoverageFiles(cov.dir) : 0;
      const started = await startApp(dir, { ...appCfg, env: cov?.env });
      if ("error" in started) {
        if (wantSmoke) checks.push({ name: "smoke", status: "failed", output: `l'appli n'a pas démarré.\nCommande : ${appCfg.start}\n${started.error}` });
        if (wantProbes) await runProbesHere();
      } else {
        try {
          if (wantSmoke) {
            checks.push(await smokeAssertions(started.server.baseUrl, {
              paths: cfg.app!.paths, page: cfg.app!.page, cmd: appCfg.start, startLogs: started.server.logs(),
            }));
          }
          if (wantProbes) await runProbesHere(started.server.baseUrl);
        } finally {
          const stopped = await started.server.stop();
          await noteServerCoverage(cov, "l'app partagée", covBefore, stopped);
        }
      }
    } else if (wantProbes) {
      // Aucun serveur à démarrer : seulement des probes autonomes (cli/artifact/process).
      await runProbesHere();
    }
  }

  // 6bis. Couverture : les probes ont tourné, on normalise puis on lit la mesure.
  if (cov && covDir && covCfg && adapter && !("error" in adapter)) {
    for (const cmd of adapter.report) {
      // Best-effort et SANS opérateur de shell : `coverage combine` échoue légitimement
      // quand une seule mesure existe, ce n'est pas un échec de gate.
      await execa(expandCov(cmd, covDir), { cwd: dir, shell: true, reject: false, timeout: 120_000 }).catch(() => {});
    }
    const projectFiles = await listFiles(dir);
    const data = await collectCoverage(adapter.format, covDir, dir, projectFiles);
    checks.push(await checkCoverage({ cfg: covCfg, projectDir: dir, data, incomplete: cov.incomplete, projectFiles }));
    await rm(covDir, { recursive: true, force: true });
  }

  // 7. spec-coverage : tout AC-n a sa probe, toute probe vise un AC-n réel (§2.7).
  const specText = await readFile(resolve(dir, cfg.specFile ?? "spec.md"), "utf8").catch(() => null);
  const declaredCriteria = specText ? parseAcceptanceCriteria(specText) : [];
  if (want("spec-coverage")) {
    const probeCriteria = (cfg.probes ?? []).map((p) => p.criterion);
    const hasCriteria = probeCriteria.some(Boolean);
    if (specText === null && !hasCriteria) {
      checks.push({ name: "spec-coverage", status: "skipped", reason: "not-configured", output: "aucune spec.md ni critère de probe" });
    } else {
      const r = checkSpecCoverage(declaredCriteria, probeCriteria);
      checks.push(
        r.ok
          ? { name: "spec-coverage", status: "passed", output: `${declaredCriteria.length} critère(s), tous couverts par une probe` }
          : { name: "spec-coverage", status: "failed", output: r.reasons.join("\n") },
      );
    }
  }

  // 8. Verdict PAR CRITÈRE (§2.3) : ce que la boucle rapporte dans Discord.
  //    N'a de sens que si les probes ont réellement tourné — sinon un `--only assembly`
  //    ferait passer tous les critères pour « non vérifiés » alors qu'on ne les a pas
  //    demandés. Cette nuance évite un faux rouge sur les exécutions partielles.
  const ranProbes = want("probes") && !!cfg.probes?.length;
  const criteria = ranProbes ? buildCriteria(declaredCriteria.map((c) => c.id), probeResults) : undefined;

  const report = buildReport(checks, criteria);
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
  if ("configError" in res) {
    // Une config invalide n'est pas un code rouge : l'agent doit corriger `gates.json`,
    // pas le code. Deux causes distinctes → deux codes de sortie distincts.
    process.stderr.write(`gates : gates.json invalide — ${res.configError}\n`);
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
