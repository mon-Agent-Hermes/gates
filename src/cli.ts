import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { runGuardrailsInDir, runInstall, checkDeliverables, startApp, smokeAssertions, waitForUrl, sertUnePage } from "./sandbox.js";
import { analyzeReachability } from "./reachability.js";
import { runProbesAgainst, aggregateProbes, validateProbes, type Probe, type ProbeResult } from "./probes.js";
import { parseAcceptanceCriteria } from "./spec.js";
import { checkSpecCoverage } from "./spec-coverage.js";
import {
  adapterEnv, checkCoverage, collectCoverage, countCoverageFiles, expandCov, listFiles,
  noteServerCoverage, resolveAdapter, type CoverageConfig, type CoverageContext,
} from "./coverage.js";
import type { PageRequirements } from "./page-check.js";
import type { CheckResult } from "./types.js";
import {
  applyObservation, buildCriteria, buildReport, escapeData, escapeProperty, NOT_OBSERVABLE,
  fichierEtat, renderAnnotations, renderText, type GatesReport,
} from "./report.js";
import { FAMILLES, runSiteChecks, validateSite, type Famille, type SiteConfig } from "./site-check.js";
import { checkDocs, validateDocs, type DocsConfig } from "./docs.js";
import { ciblesDe, preparerArbreNeutralise, verdictPhaseRouge } from "./phase-rouge.js";

/**
 * Contrat de `gates.json` (§2.4 — version minimale du premier jet).
 * Les commandes sont DÉCLARÉES, jamais devinées de la prose (défaut n°5).
 */
export type GatesConfig = {
  install?: string;
  commands?: Record<string, string>;
  requiredCommands?: string[];
  /** Point(s) d'entrée de l'assemblage. Une LISTE quand le framework en pose plusieurs. */
  entry?: string | string[];
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
  /**
   * Contrôles de site (accessibilité, mobile, budgets, référencement). Actifs quand cette
   * section existe, ou quand `app.page` déclare une page à rendre. Tout y est SIGNALÉ par
   * défaut ; seul ce que `site.bloquant` liste peut bloquer.
   */
  site?: SiteConfig;
  /**
   * Documentation CONSTATÉE : le fichier existe, porte de la matière, et une probe
   * exécute réellement le démarrage qu'il décrit. Absente, le check n'existe pas.
   */
  docs?: DocsConfig;
  /**
   * Checks EN OBSERVATION : rouges, ils sont signalés (`warn`) sans bloquer. Pour un
   * contrôle neuf — un linter qu'on vient de poser. Jamais le juge fonctionnel.
   */
  observation?: string[];
};

async function loadConfig(dir: string): Promise<GatesConfig | null> {
  try {
    return JSON.parse(await readFile(resolve(dir, "gates.json"), "utf8")) as GatesConfig;
  } catch {
    return null;
  }
}

/**
 * Contrôle du CONTRAT de `gates.json`, avant qu'un seul gate ne tourne.
 *
 * Une clé qu'aucun check ne lit n'est pas une coquetterie : elle est SILENCIEUSE à
 * l'exécution, et un `expect` dont la moitié est silencieuse rend un critère vert qui
 * n'a rien vérifié. Le refus doit donc tomber ici, au chargement, où la clé est encore
 * une faute de config — pas à l'évaluation, où elle n'est déjà plus rien.
 */
function validateConfig(cfg: GatesConfig): string[] {
  return [
    ...validateProbes(cfg.probes),
    ...validateSite(cfg.site),
    ...validateDocs(cfg.docs, (cfg.probes ?? []).map((p) => p.id)),
    ...validateObservation(cfg.observation),
  ];
}

/**
 * `observation` ne peut viser que ce qui n'est pas le juge fonctionnel. L'accepter sur
 * `probes` ferait d'un contrat approuvé trop vite un contrat qui ne juge plus rien.
 */
function validateObservation(obs: unknown): string[] {
  if (obs === undefined) return [];
  if (!Array.isArray(obs)) return ["observation : une liste de noms de checks est attendue"];
  const errors: string[] = [];
  for (const n of obs) {
    if (typeof n !== "string" || !n) errors.push("observation : un nom de check est attendu");
    else if (NOT_OBSERVABLE.has(n)) errors.push(`observation : « ${n} » ne peut pas être mis en observation — c'est le juge fonctionnel`);
  }
  return errors;
}

/**
 * `--base-url` désigne un site DÉJÀ servi. Une valeur qui n'est pas une URL absolue
 * `http(s)` est une config invalide (exit 2), pas un rouge : un `--base-url ""` avalé
 * silencieusement ferait juger `localhost` à la place du déploiement, et rendrait vert un
 * run qui n'a pas regardé ce qu'on lui demandait de regarder.
 */
function validateBaseUrl(url: string | null | undefined): string | null {
  if (url === undefined || url === null) return null;
  let u: URL;
  try { u = new URL(url); } catch { return `--base-url : URL absolue attendue, reçu « ${url} »`; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `--base-url : http(s) attendu, reçu « ${u.protocol} »`;
  return null;
}

/**
 * La phase rouge, SEULE : les probes rejouées sur un arbre dont les livrables sont vidés.
 *
 * Seule, et pas en plus du reste, parce qu'elle rejoue toutes les probes : la fondre dans
 * le run normal doublerait le coût de chaque vérification. La CI la lance dans une seconde
 * invocation, après un run vert — une probe déjà rouge n'apprend rien de plus en étant
 * rouge une seconde fois.
 */
async function phaseRouge(dir: string, cfg: GatesConfig): Promise<{ ok: boolean; report: GatesReport }> {
  const rendre = (c: CheckResult) => {
    const report = buildReport([c]);
    return { ok: report.ok, report };
  };
  const pasConcluant = (output: string) =>
    rendre({ name: "phase-rouge", status: "skipped", reason: "not-configured", output });

  const probes = cfg.probes ?? [];
  if (!probes.length) return pasConcluant("aucune probe déclarée : il n'y a rien à éprouver.");

  const cibles = ciblesDe({ deliverables: cfg.deliverables, roots: cfg.roots }, await listFiles(dir));
  if (!cibles.length) {
    return pasConcluant(
      "aucun livrable identifié à vider (ni « deliverables », ni de fichier sous « roots ») — " +
      "on ne peut pas prouver qu'une probe dépend d'un code qu'on n'a pas su nommer.",
    );
  }

  const arbre = await preparerArbreNeutralise(dir, cibles);
  if ("erreur" in arbre) return pasConcluant(`phase rouge impossible : ${arbre.erreur}.`);

  try {
    // ⚠️ `cfg.install` n'est PAS rejoué ici : `node_modules` est rattaché à l'original,
    // et une installation écrirait donc dans les dépendances du projet réel — le juge
    // abîmerait ce qu'il juge.
    const appCfg = cfg.app?.start && cfg.app?.url
      ? { start: cfg.app.start, url: cfg.app.url, readyTimeoutMs: cfg.app.readyTimeoutMs }
      : null;
    const serveur = probes.some((p) => p.kind === "http" || p.kind === "browser");

    let resultats: ProbeResult[];
    if (appCfg && serveur) {
      // L'app peut très bien ne plus démarrer du tout : c'est un résultat, pas une panne.
      // Les probes tournent alors sans URL et échouent — ce qui est exactement la preuve
      // attendue.
      const started = await startApp(arbre.dir, appCfg);
      if ("error" in started) {
        resultats = await runProbesAgainst(probes, { dir: arbre.dir });
      } else {
        try {
          resultats = await runProbesAgainst(probes, { dir: arbre.dir, baseUrl: started.server.baseUrl });
        } finally {
          await started.server.stop();
        }
      }
    } else {
      resultats = await runProbesAgainst(probes, { dir: arbre.dir });
    }

    return rendre(verdictPhaseRouge({ probes: resultats, cibles }));
  } finally {
    await arbre.nettoyer();
  }
}

/**
 * Lance les checks déclarés par `gates.json` dans `dir` et agrège le verdict.
 * exit 0 = tout vert · 1 = au moins un rouge · 2 = config invalide (géré par l'appelant).
 */
export async function check(
  dir: string,
  opts: { only?: string[] | null; baseUrl?: string | null; phaseRouge?: boolean } = {},
): Promise<{ ok: boolean; report: GatesReport } | { configError: string } | null> {
  const cfg = await loadConfig(dir);
  if (!cfg) return null;

  // Config invalide AVANT toute exécution : `--only` ne doit pas pouvoir contourner ce
  // contrôle, sinon la clé silencieuse reviendrait par la porte de service.
  const configErrors = validateConfig(cfg);
  if (configErrors.length) return { configError: configErrors.join("\n  ") };

  const urlError = validateBaseUrl(opts.baseUrl);
  if (urlError) return { configError: urlError };

  // Les deux modes se contredisent : un site déployé n'est pas un arbre qu'on neutralise.
  // Les combiner rendrait un verdict dont personne ne saurait dire ce qu'il a mesuré.
  if (opts.phaseRouge && opts.baseUrl) {
    return { configError: "--phase-rouge et --base-url s'excluent : on ne neutralise pas un site déployé" };
  }
  if (opts.phaseRouge) return phaseRouge(dir, cfg);

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
    // `--base-url` : le site est DÉJÀ servi (une prévisualisation Vercel, par exemple).
    // Rien à démarrer, et `app.start` n'est pas lu — on juge alors ce que le déploiement
    // sert, pas ce que la CI saurait relancer. `app.paths` et `app.page` décrivent le
    // site lui-même : ils s'appliquent aux deux modes sans changer de sens.
    const deployed = opts.baseUrl ?? null;
    const appCfg = deployed
      ? { start: null, url: deployed, readyTimeoutMs: cfg.app?.readyTimeoutMs }
      : cfg.app?.start && cfg.app?.url
        ? { start: cfg.app.start, url: cfg.app.url, readyTimeoutMs: cfg.app.readyTimeoutMs }
        : null;
    const wantSmoke = want("smoke") && !!appCfg;
    const wantProbes = want("probes") && !!cfg.probes?.length;
    const hasServerProbes = (cfg.probes ?? []).some((p) => p.kind === "http" || p.kind === "browser");
    // Contrôles de site : seulement si le projet déclare un site. Un CLI, une API, un
    // projet Python ne les voient jamais.
    const siteDeclared = !!appCfg && (cfg.site !== undefined || cfg.app?.page !== undefined);
    const famillesVoulues: Famille[] = FAMILLES.filter((f) => want(f));
    const siteFamilies: Famille[] = siteDeclared ? famillesVoulues : [];
    const besoinApp = !!appCfg && (wantSmoke || siteFamilies.length > 0 || (wantProbes && hasServerProbes));
    const runProbesHere = async (baseUrl?: string) => {
      probeResults = await runProbesAgainst(cfg.probes!, { dir, baseUrl, coverage: cov ?? undefined });
      checks.push(aggregateProbes(probeResults));
    };

    /**
     * Le corps commun aux deux modes : une app répond sur `baseUrl`, on la sonde.
     * Le smoke passe d'abord — un audit d'accessibilité vert sur une page noire est un
     * faux vert, et l'ordre n'est pas négociable, que l'app soit locale ou déployée.
     */
    const sonder = async (baseUrl: string, cmd: string | null, startLogs: string) => {
      const smoke = wantSmoke || siteFamilies.length
        ? await smokeAssertions(baseUrl, { paths: cfg.app?.paths, page: cfg.app?.page, cmd: cmd ?? undefined, startLogs, deploye: !cmd })
        : null;
      if (wantSmoke && smoke) checks.push(smoke);
      if (siteFamilies.length) {
        if (smoke?.status === "passed") checks.push(...await runSiteChecks(baseUrl, cfg.site ?? {}, siteFamilies));
        else for (const f of siteFamilies) checks.push(siteSkipped(f, "le smoke n'est pas vert"));
      }
      // Rien de déclaré, mais l'app sert une PAGE : les quatre familles ne tourneront pas.
      // Le taire rendrait un vert qui n'a regardé ni l'accessibilité, ni le rendu à 375 px,
      // ni le poids, ni le référencement. `gates` refuse déjà ce silence un cran plus bas —
      // une probe ignorée dit « le critère n'a PAS été vérifié » ; une famille entière
      // jamais déclarée mérite la même phrase. On CONSTATE, on ne décide pas : auditer se
      // déclare au contrat et passe par `!approuve` (chantier 9, règles 3 et 5).
      if (!siteDeclared && famillesVoulues.length && smoke?.status !== "failed" && (await sertUnePage(baseUrl))) {
        for (const f of famillesVoulues) checks.push(siteNonDeclare(f));
      }
      if (wantProbes) await runProbesHere(baseUrl);
    };

    if (deployed && besoinApp) {
      // Distinguer « le site déployé est rouge » de « la prévisualisation n'était pas
      // encore en ligne » : sans cette attente, une PR jugée trop tôt rougirait sur un
      // déploiement qui n'avait pas fini de se construire.
      const ready = appCfg!.readyTimeoutMs ?? 60_000;
      const up = await waitForUrl(deployed, ready);
      if (!up.up) {
        const pourquoi = `pas de réponse de ${deployed} en ${ready / 1000}s — le déploiement jugé n'est pas en ligne`;
        if (wantSmoke) checks.push({ name: "smoke", status: "failed", output: pourquoi });
        for (const f of siteFamilies) checks.push(siteSkipped(f, "le site déployé n'a pas répondu"));
        if (wantProbes) await runProbesHere();
      } else {
        await sonder(deployed, null, "");
        // Un déploiement distant n'est pas instrumenté : la couverture ne peut rien en
        // savoir. On le DIT (verdict suspendu) plutôt que de déclarer mort du code qu'on
        // n'a pas su observer — même règle qu'un serveur tué de force.
        if (cov) {
          cov.incomplete.push(
            `le site jugé est déployé (${deployed}) : son exécution est hors de portée de la mesure — ` +
            `la couverture serveur se lit sur le run local, pas sur celui-ci`,
          );
        }
      }
    } else if (besoinApp && appCfg?.start) {
      // L'app partagée est démarrée AVEC l'instrumentation : sans elle, tout projet
      // dont le code ne vit que dans un serveur serait invisible à la couverture.
      const covBefore = cov ? await countCoverageFiles(cov.dir) : 0;
      const started = await startApp(dir, { start: appCfg.start, url: appCfg.url, readyTimeoutMs: appCfg.readyTimeoutMs, env: cov?.env });
      if ("error" in started) {
        if (wantSmoke) checks.push({ name: "smoke", status: "failed", output: `l'appli n'a pas démarré.\nCommande : ${appCfg.start}\n${started.error}` });
        for (const f of siteFamilies) checks.push(siteSkipped(f, "l'appli n'a pas démarré"));
        if (wantProbes) await runProbesHere();
      } else {
        try {
          await sonder(started.server.baseUrl, appCfg.start, started.server.logs());
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

  // 7bis. Documentation constatée. APRÈS les probes : c'est leur résultat qui dit si la
  //       doc a été prouvée, et non le contraire.
  if (want("docs") && cfg.docs) {
    checks.push(await checkDocs({ cfg: cfg.docs, projectDir: dir, probes: probeResults }));
  }

  // 8. Verdict PAR CRITÈRE (§2.3) : ce que la boucle rapporte dans Discord.
  //    N'a de sens que si les probes ont réellement tourné — sinon un `--only assembly`
  //    ferait passer tous les critères pour « non vérifiés » alors qu'on ne les a pas
  //    demandés. Cette nuance évite un faux rouge sur les exécutions partielles.
  const ranProbes = want("probes") && !!cfg.probes?.length;
  const criteria = ranProbes ? buildCriteria(declaredCriteria.map((c) => c.id), probeResults) : undefined;

  const report = buildReport(applyObservation(checks, cfg.observation), criteria);
  return { ok: report.ok, report };
}

/**
 * Une famille de contrôles que le contrat n'a jamais demandée, alors que l'app sert une
 * page. `skipped` : le verdict ne bouge pas — mais l'omission apparaît dans le rapport et
 * dans le JSON de l'annotation `gates etat`, donc sous les yeux au moment d'`!approuve` et
 * dans le rapport du matin. C'est la différence entre « audité, rien à signaler » et
 * « personne n'a regardé », que rien ne disait jusqu'ici.
 */
function siteNonDeclare(name: Famille): CheckResult {
  return {
    name, status: "skipped", reason: "not-configured",
    output:
      `non audité : pas de section « site » au contrat, alors que l'app sert une page HTML. ` +
      `Ajoute "site": {} au gates.json — ${name} sera signalé, pas bloquant.`,
  };
}

function siteSkipped(name: Famille, why: string): CheckResult {
  return {
    name, status: "skipped", reason: "not-configured",
    output: `non audité : ${why}. Un audit sur une page qui ne rend pas ne prouverait rien.`,
  };
}

export function parseArgs(argv: string[]): {
  json: boolean; only: string[] | null; baseUrl: string | null; phaseRouge: boolean; etatFichier: string | null;
} {
  const json = argv.includes("--json");
  const phaseRouge = argv.includes("--phase-rouge");
  const i = argv.indexOf("--only");
  const only = i >= 0 && argv[i + 1] ? argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean) : null;
  // `--base-url` PRÉSENT mais vide reste présent : c'est `validateBaseUrl` qui le refuse,
  // pas un `?? null` silencieux qui ferait juger l'app locale sans rien dire.
  const j = argv.indexOf("--base-url");
  const baseUrl = j >= 0 ? (argv[j + 1] ?? "") : null;
  const k = argv.indexOf("--etat-fichier");
  const etatFichier = k >= 0 && argv[k + 1] ? argv[k + 1] : null;
  return { json, only, baseUrl, phaseRouge, etatFichier };
}

/**
 * Sous GitHub Actions, la sortie du juge est protégée et annotée.
 *
 *  - `::stop-commands::` AVANT de lancer quoi que ce soit : ce que les processus du projet
 *    impriment — une sortie de test, une note de probe recopiée dans le rapport — ne peut
 *    plus passer pour une commande de workflow. Sans ça, une ligne `::error title=gates
 *    AC-3::…` imprimée par le code jugé se lirait comme un verdict du juge ;
 *  - les annotations APRÈS, une fois les commandes rétablies : c'est ce que le pont lit
 *    pour juger un brief de nuit (`renderAnnotations`).
 *
 * Le jeton vient de `randomUUID` : le code jugé ne peut pas le deviner pour rétablir les
 * commandes avant nous.
 */
export function sortieGitHub(
  json: boolean,
  env: NodeJS.ProcessEnv = process.env,
  ecrire: (s: string) => void = (s) => { process.stdout.write(s); },
): { ouvrir: () => void; fermer: (lignes: string[]) => void } {
  if (env.GITHUB_ACTIONS !== "true" || json) return { ouvrir: () => {}, fermer: () => {} };
  const jeton = randomUUID();
  return {
    ouvrir: () => ecrire(`::stop-commands::${jeton}\n`),
    fermer: (lignes) => ecrire([`::${jeton}::`, ...lignes].join("\n") + "\n"),
  };
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] !== "check") {
    process.stderr.write("usage : gates check [--json] [--only nom1,nom2] [--base-url https://…] [--phase-rouge] [--etat-fichier chemin]\n");
    return 2;
  }
  const { json, only, baseUrl, phaseRouge, etatFichier } = parseArgs(argv.slice(1));
  const gh = sortieGitHub(json);
  const erreurConfig = (msg: string) => [`::error title=${escapeProperty("gates config")}::${escapeData(msg)}`];
  // Comme les annotations : seule la vérification principale écrit le verdict en fichier.
  const ecrireEtat = async (report: GatesReport | null, erreur?: string) => {
    if (etatFichier && !phaseRouge && baseUrl === null) {
      await writeFile(etatFichier, JSON.stringify(fichierEtat(report, erreur)) + "\n");
    }
  };
  gh.ouvrir();
  const res = await check(process.cwd(), { only, baseUrl, phaseRouge });
  if (!res) {
    process.stderr.write("gates : aucun gates.json lisible dans le dossier courant (config invalide, exit 2)\n");
    gh.fermer(erreurConfig("aucun gates.json lisible (config invalide, exit 2)"));
    await ecrireEtat(null, "aucun gates.json lisible (config invalide, exit 2)");
    return 2;
  }
  if ("configError" in res) {
    // Une config invalide n'est pas un code rouge : l'agent doit corriger `gates.json`,
    // pas le code. Deux causes distinctes → deux codes de sortie distincts.
    process.stderr.write(`gates : gates.json invalide — ${res.configError}\n`);
    gh.fermer(erreurConfig(`gates.json invalide — ${res.configError}`));
    await ecrireEtat(null, `gates.json invalide — ${res.configError}`);
    return 2;
  }
  process.stdout.write((json ? JSON.stringify(res.report, null, 2) : renderText(res.report)) + "\n");
  gh.fermer(annotationsDuVerdict(res.report, { baseUrl, phaseRouge }));
  await ecrireEtat(res.report);
  return res.ok ? 0 : 1;
}

/**
 * Seule la vérification principale annote. Le workflow partagé lance le juge jusqu'à trois
 * fois dans le même job (principale, `--phase-rouge`, `--base-url`) : le pont refuse de lire
 * l'état s'il trouve plus d'une `gates etat`, et il lirait les critères rouges de la phase
 * rouge — attendus, le code y étant retiré — comme de vrais échecs. Les passes secondaires
 * rendent leur verdict par le code de sortie ; le workflow pose sa propre annotation
 * (`gates phase-rouge`, `gates deploiement`).
 */
export function annotationsDuVerdict(
  report: GatesReport,
  mode: { baseUrl: string | null; phaseRouge: boolean },
): string[] {
  return mode.phaseRouge || mode.baseUrl !== null ? [] : renderAnnotations(report);
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
