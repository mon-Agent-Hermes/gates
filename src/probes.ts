import { execa } from "execa";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startApp, probeUrl } from "./sandbox";
import { observePage, classifyPage, type PageRequirements, type PageAction } from "./page-check";
import { countCoverageFiles, noteServerCoverage, type CoverageContext } from "./coverage";
import type { CheckResult } from "./types";

export type { CoverageContext };

/**
 * `probes` (§2.5) — observer l'artefact EN TRAIN de faire son travail, au niveau où
 * « ça marche » se définit (un code de sortie, un fichier produit, une route qui
 * répond, un appel de dessin), pas seulement « ça compile ». `smoke` et `page` sont
 * deux cas particuliers du même geste ; les généraliser fait sortir le montage du web.
 *
 * Trois règles de construction (cf. doc) :
 *  - `$TMP` est un dossier NEUF par probe, effacé ensuite (sinon la probe n°2 valide en
 *    réalité l'effet de la n°1) ;
 *  - une probe doit être reproductible (aucun réseau tiers, graine fixée) ;
 *  - une probe échouée nomme LA PROBE, pas le check (`probes: failed` n'est pas
 *    actionnable ; `init-cree-la-config : fichier attendu absent` l'est).
 *
 * Kinds portés : `cli`, `artifact` (autonomes) ; `http`, `browser` (contre l'app
 * démarrée par le harnais) ; `process` (un démon qui doit tenir debout).
 */

export type CliProbe = {
  id: string;
  criterion?: string;
  kind: "cli";
  /** Commande à lancer ; `$TMP` y est remplacé par un dossier neuf et jetable. */
  run: string;
  expect?: { exitCode?: number; stdout?: string; stderr?: string; files?: string[] };
};

export type ArtifactProbe = {
  id: string;
  criterion?: string;
  kind: "artifact";
  /** Commande produisant le fichier (optionnelle si le fichier préexiste). `$TMP` géré. */
  run?: string;
  /** Chemin du fichier produit à contrôler. `$TMP` géré. */
  file: string;
  expect?: {
    minBytes?: number;
    /** Commande qui doit sortir en 0 sur le fichier ; `{file}` y est remplacé. */
    openableBy?: string;
  };
};

export type HttpProbe = {
  id: string;
  criterion?: string;
  kind: "http";
  request: { method?: string; path: string; headers?: Record<string, string>; body?: string };
  expect?: {
    status?: number;
    /** Statuts INTERDITS (typiquement `[404, 500]` : la route doit exister). */
    statusNot?: number[];
    /** Le corps de réponse doit correspondre (`/regex/` ou sous-chaîne). */
    bodyMatch?: string;
    /** Chaque en-tête attendu doit être présent (valeur : correspondance par sous-chaîne). */
    headers?: Record<string, string>;
  };
};

export type BrowserProbe = {
  id: string;
  criterion?: string;
  kind: "browser";
  /** Chemin ouvert (défaut `/`). */
  path?: string;
  /** Interactions jouées avant observation (clic, saisie, attente). */
  actions?: PageAction[];
  expect?: {
    requireSelectors?: string[];
    requireCanvas?: boolean;
    minDrawCalls?: number;
    waitMs?: number;
    /** `false` tolère les erreurs console ; sinon (défaut) une erreur console échoue. */
    noConsoleErrors?: boolean;
  };
};

export type ProcessProbe = {
  id: string;
  criterion?: string;
  kind: "process";
  /** Commande qui lance le démon. */
  start: string;
  /** Prêt = réponse HTTP sur cette URL… */
  url?: string;
  /** …ou une ligne de log qui correspond (`/regex/` ou sous-chaîne). */
  logMatch?: string;
  readyTimeoutMs?: number;
  /** Une fois levé : un log attendu supplémentaire (optionnel). */
  expect?: { logMatch?: string };
};

/** Probe d'un kind inconnu — reconnue mais `skipped` (jamais un faux vert). */
export type UnknownProbe = { id: string; criterion?: string; kind: string; [k: string]: unknown };

export type Probe = CliProbe | ArtifactProbe | HttpProbe | BrowserProbe | ProcessProbe | UnknownProbe;

export type ProbeResult = {
  id: string;
  criterion?: string;
  status: "passed" | "failed" | "skipped";
  output: string;
};

/** Config de l'app partagée que démarrent les probes `http`/`browser`. */
export type ProbeAppConfig = { start: string; url: string; readyTimeoutMs?: number };

/** Remplace `$TMP` (dossier jetable de la probe) et `$COV` (dossier de mesure). */
function expand(s: string, tmp: string, cov?: CoverageContext): string {
  const withTmp = s.split("$TMP").join(tmp);
  return cov ? withTmp.split("$COV").join(cov.dir) : withTmp;
}

/**
 * `"/regex/flags"` → test par expression régulière ; sinon sous-chaîne littérale.
 * (Le doc écrit les attentes comme `"/Configuration écrite/"`.)
 */
export function textMatches(pattern: string, text: string): boolean {
  const m = pattern.match(/^\/(.*)\/([a-z]*)$/s);
  if (m) {
    try {
      return new RegExp(m[1], m[2]).test(text);
    } catch {
      return text.includes(pattern);
    }
  }
  return text.includes(pattern);
}

const pass = (p: { id: string; criterion?: string }, output: string): ProbeResult => ({ id: p.id, criterion: p.criterion, status: "passed", output });
const fail = (p: { id: string; criterion?: string }, output: string): ProbeResult => ({ id: p.id, criterion: p.criterion, status: "failed", output });
const skip = (p: { id: string; criterion?: string }, output: string): ProbeResult => ({ id: p.id, criterion: p.criterion, status: "skipped", output });

// ── Probes autonomes (aucun serveur) ────────────────────────────────────────────

async function runCliProbe(p: CliProbe, timeoutMs: number, dir: string, cov?: CoverageContext): Promise<ProbeResult> {
  const tmp = await mkdtemp(join(tmpdir(), "gates-probe-"));
  const reasons: string[] = [];
  try {
    const exp = p.expect ?? {};
    const res = await execa(expand(p.run, tmp, cov), {
      cwd: dir, // la probe s'exécute DANS le projet, pas dans le dossier d'où `gates` est lancé
      shell: true, reject: false, all: true, timeout: timeoutMs,
      // Instrumentation du runtime déclaré (§2.6) : le process écrit sa couverture
      // dans `$COV` à sa sortie — d'où l'exigence d'une sortie PROPRE.
      env: cov?.env,
    });
    if (exp.exitCode !== undefined && res.exitCode !== exp.exitCode) {
      reasons.push(`code de sortie ${res.exitCode} (attendu ${exp.exitCode})`);
    }
    if (exp.stdout && !textMatches(expand(exp.stdout, tmp, cov), res.stdout ?? "")) {
      reasons.push(`stdout ne correspond pas à ${exp.stdout}`);
    }
    if (exp.stderr && !textMatches(expand(exp.stderr, tmp, cov), res.stderr ?? "")) {
      reasons.push(`stderr ne correspond pas à ${exp.stderr}`);
    }
    for (const f of exp.files ?? []) {
      const fp = expand(f, tmp, cov);
      try {
        if (!(await stat(fp)).isFile()) reasons.push(`fichier attendu non régulier : ${f}`);
      } catch {
        reasons.push(`fichier attendu absent : ${f}`);
      }
    }
  } catch (err: any) {
    reasons.push(`exécution impossible : ${err?.shortMessage ?? err?.message ?? err}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return reasons.length ? fail(p, reasons.join(" ; ")) : pass(p, "effet observé (code/sortie/fichiers conformes)");
}

async function runArtifactProbe(p: ArtifactProbe, timeoutMs: number, dir: string, cov?: CoverageContext): Promise<ProbeResult> {
  const tmp = await mkdtemp(join(tmpdir(), "gates-probe-"));
  const reasons: string[] = [];
  try {
    const exp = p.expect ?? {};
    if (p.run) await execa(expand(p.run, tmp, cov), {
      cwd: dir,
      shell: true, reject: false, all: true, timeout: timeoutMs,
      env: cov?.env,
    });
    const fp = expand(p.file, tmp, cov);
    let size = -1;
    try {
      const st = await stat(fp);
      if (!st.isFile()) reasons.push(`artefact non régulier : ${p.file}`);
      size = st.size;
    } catch {
      reasons.push(`artefact absent : ${p.file}`);
    }
    if (size >= 0 && exp.minBytes !== undefined && size < exp.minBytes) {
      reasons.push(`artefact trop petit : ${size} octet(s) (minimum ${exp.minBytes})`);
    }
    if (size >= 0 && exp.openableBy) {
      const cmd = expand(exp.openableBy, tmp, cov).split("{file}").join(fp);
      const r = await execa(cmd, { cwd: dir, shell: true, reject: false, all: true, timeout: timeoutMs });
      if (r.exitCode !== 0) reasons.push(`fichier non ouvrable par « ${exp.openableBy} » (code ${r.exitCode})`);
    }
  } catch (err: any) {
    reasons.push(`exécution impossible : ${err?.shortMessage ?? err?.message ?? err}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return reasons.length ? fail(p, reasons.join(" ; ")) : pass(p, "artefact produit et valide");
}

async function runProcessProbe(p: ProcessProbe, dir: string, cov?: CoverageContext): Promise<ProbeResult> {
  if (!p.url && !p.logMatch) return fail(p, "probe process sans `url` ni `logMatch` : aucun signal de disponibilité");
  const covBefore = cov ? await countCoverageFiles(cov.dir) : 0;
  const started = await startApp(dir, {
    start: p.start, url: p.url, logMatch: p.logMatch, readyTimeoutMs: p.readyTimeoutMs ?? 15_000, env: cov?.env,
  });
  if ("error" in started) return fail(p, `le démon ne s'est pas levé : ${started.error}`);
  try {
    const exp = p.expect ?? {};
    if (exp.logMatch && !textMatches(exp.logMatch, started.server.logs())) {
      return fail(p, `démon levé mais log attendu absent : ${exp.logMatch}`);
    }
    return pass(p, "démon levé et stable");
  } finally {
    const stopped = await started.server.stop();
    // Un démon qui n'écrit pas sa couverture rendrait « morts » des fichiers bien
    // vivants : on le CONSTATE (comptage avant/après) au lieu de le supposer.
    await noteServerCoverage(cov, `la probe « ${p.id} »`, covBefore, stopped);
  }
}

// ── Probes contre l'app partagée (démarrée par le harnais) ───────────────────────

async function runHttpProbe(p: HttpProbe, baseUrl: string): Promise<ProbeResult> {
  const url = probeUrl(baseUrl, p.request.path);
  const method = (p.request.method ?? "GET").toUpperCase();
  let status: number | null = null;
  let body = "";
  let headers: Headers | null = null;
  let netErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method, headers: p.request.headers, body: p.request.body });
      status = res.status;
      headers = res.headers;
      body = await res.text().catch(() => "");
      break;
    } catch (e: any) {
      netErr = e?.message ?? String(e);
      await sleep(500); // routes parfois montées juste après la santé
    }
  }
  const exp = p.expect ?? {};
  const reasons: string[] = [];
  if (status === null) {
    reasons.push(`aucune réponse (${netErr})`);
  } else {
    if (exp.status !== undefined && status !== exp.status) reasons.push(`statut ${status} (attendu ${exp.status})`);
    if (exp.statusNot?.includes(status)) reasons.push(`statut ${status} interdit (route non montée ?)`);
    if (exp.bodyMatch && !textMatches(exp.bodyMatch, body)) reasons.push(`corps ne correspond pas à ${exp.bodyMatch}`);
    for (const [k, v] of Object.entries(exp.headers ?? {})) {
      const got = headers?.get(k) ?? "";
      if (!got.includes(v)) reasons.push(`en-tête ${k} = « ${got} » (attendu contenir « ${v} »)`);
    }
  }
  return reasons.length ? fail(p, `${method} ${p.request.path} : ${reasons.join(" ; ")}`) : pass(p, `${method} ${p.request.path} → ${status}`);
}

async function runBrowserProbe(p: BrowserProbe, baseUrl: string): Promise<ProbeResult> {
  const req: PageRequirements = {
    requireSelectors: p.expect?.requireSelectors,
    requireCanvas: p.expect?.requireCanvas,
    minDrawCalls: p.expect?.minDrawCalls,
    waitMs: p.expect?.waitMs,
    // Seul `noConsoleErrors:false` explicite relâche la contrainte ; défaut = strict.
    allowConsoleErrors: p.expect?.noConsoleErrors === false,
  };
  const url = probeUrl(baseUrl, p.path ?? "/");
  let obs;
  try {
    obs = await observePage(url, req, p.actions ?? []);
  } catch (e: any) {
    return fail(p, `contrôle de page impossible : ${e?.message ?? e}`);
  }
  if (!obs) return skip(p, "aucun Chrome/Edge sur la machine (probe browser ignorée)");
  const { passed, reasons } = classifyPage(obs, req);
  return passed ? pass(p, `page rendue (${obs.drawCalls} appel(s) de dessin)`) : fail(p, reasons.join(" ; "));
}

// ── Orchestration ────────────────────────────────────────────────────────────────

/**
 * Probe unique HORS contexte serveur (cli/artifact ; process avec son propre démon).
 * Les kinds `http`/`browser` exigent l'app partagée → utiliser `runProbes`.
 */
export async function runProbe(p: Probe, timeoutMs = 120_000, dir = process.cwd()): Promise<ProbeResult> {
  if (p.kind === "cli") return runCliProbe(p as CliProbe, timeoutMs, dir);
  if (p.kind === "artifact") return runArtifactProbe(p as ArtifactProbe, timeoutMs, dir);
  if (p.kind === "process") return runProcessProbe(p as ProcessProbe, dir);
  if (p.kind === "http" || p.kind === "browser") {
    return skip(p, `kind « ${p.kind} » : exige l'app partagée (passer par runProbes avec app)`);
  }
  return skip(p, `kind « ${p.kind} » inconnu`);
}

/**
 * Lance toutes les probes contre une app DÉJÀ démarrée (ou aucune). Ne gère PAS le
 * cycle de vie du serveur : `baseUrl` est fourni par l'appelant, qui l'a démarré et
 * l'arrêtera. C'est ce qui permet de partager une seule instance entre `smoke` et les
 * probes serveur (cf. cli.ts). L'ordre de sortie suit l'ordre d'entrée.
 */
export async function runProbesAgainst(
  probes: Probe[],
  opts: { dir?: string; baseUrl?: string; timeoutMs?: number; coverage?: CoverageContext } = {},
): Promise<ProbeResult[]> {
  const dir = opts.dir ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const cov = opts.coverage;
  const results: (ProbeResult | null)[] = probes.map(() => null);

  // 1. Probes autonomes (cli, artifact, process, inconnu).
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    if (p.kind === "cli") results[i] = await runCliProbe(p as CliProbe, timeoutMs, dir, cov);
    else if (p.kind === "artifact") results[i] = await runArtifactProbe(p as ArtifactProbe, timeoutMs, dir, cov);
    else if (p.kind === "process") results[i] = await runProcessProbe(p as ProcessProbe, dir, cov);
    else if (p.kind !== "http" && p.kind !== "browser") results[i] = skip(p, `kind « ${p.kind} » inconnu`);
  }

  // Le pilotage NAVIGATEUR n'est pas encore instrumenté (il exige CDP + source maps) :
  // les fichiers qui ne s'exécutent que là paraîtraient morts. On le signale.
  if (cov && probes.some((p) => p.kind === "browser")) {
    cov.incomplete.push("les probes « browser » ne sont pas instrumentées (couverture navigateur non portée)");
  }

  // 2. Probes serveur (http, browser) : contre l'app déjà démarrée.
  const serverProbes = probes.map((p, i) => ({ p, i })).filter((x) => x.p.kind === "http" || x.p.kind === "browser");
  for (const { p, i } of serverProbes) {
    if (!opts.baseUrl) {
      results[i] = fail(p, "aucun app.start/url démarré : impossible de lancer la probe serveur");
      continue;
    }
    results[i] = p.kind === "http"
      ? await runHttpProbe(p as HttpProbe, opts.baseUrl)
      : await runBrowserProbe(p as BrowserProbe, opts.baseUrl);
  }

  return results.map((r, i) => r ?? skip(probes[i], "non exécutée"));
}

/**
 * Lance toutes les probes en gérant le cycle de vie : si des probes serveur existent et
 * qu'une `app` est fournie, démarre l'app UNE fois, sonde, puis l'arrête. Sinon délègue
 * à `runProbesAgainst` (probes autonomes ; les serveur échouent faute d'app). Entrée
 * autonome pratique ; cli.ts, lui, partage l'app avec `smoke` via `runProbesAgainst`.
 */
export async function runProbes(
  probes: Probe[],
  opts: { dir?: string; app?: ProbeAppConfig; timeoutMs?: number; coverage?: CoverageContext } = {},
): Promise<ProbeResult[]> {
  const hasServer = probes.some((p) => p.kind === "http" || p.kind === "browser");
  const sub = { dir: opts.dir, timeoutMs: opts.timeoutMs, coverage: opts.coverage };
  if (hasServer && opts.app?.start && opts.app?.url) {
    const covBefore = opts.coverage ? await countCoverageFiles(opts.coverage.dir) : 0;
    const started = await startApp(opts.dir ?? process.cwd(), { ...opts.app, env: opts.coverage?.env });
    if ("error" in started) {
      const base = await runProbesAgainst(probes, sub);
      return probes.map((p, i) =>
        p.kind === "http" || p.kind === "browser" ? fail(p, `l'app n'a pas démarré : ${started.error}`) : base[i],
      );
    }
    try {
      return await runProbesAgainst(probes, { ...sub, baseUrl: started.server.baseUrl });
    } finally {
      const stopped = await started.server.stop();
      await noteServerCoverage(opts.coverage, "l'app partagée", covBefore, stopped);
    }
  }
  return runProbesAgainst(probes, sub);
}

/** Agrège les probes en un seul CheckResult (un skipped ne bloque pas ; un failed oui). */
export function aggregateProbes(results: ProbeResult[]): CheckResult {
  const anyFailed = results.some((r) => r.status === "failed");
  const anyRan = results.some((r) => r.status !== "skipped");
  const status: CheckResult["status"] = anyFailed ? "failed" : anyRan ? "passed" : "skipped";
  const lines = results.map(
    (r) => `- ${r.id}${r.criterion ? ` [${r.criterion}]` : ""} → ${r.status} : ${r.output}`,
  );
  return { name: "probes", status, output: lines.join("\n") };
}
