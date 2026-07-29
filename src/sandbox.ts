import { execa, type ResultPromise } from "execa";
import { mkdtemp, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runPageCheck, type PageRequirements } from "./page-check";
import type { CheckResult, FileSpec, GuardrailResult } from "./types";

/**
 * Garde-fous DÉTERMINISTES.
 *
 * Principe clé: le pass/fail ne vient PAS d'un LLM mais de l'exécution réelle
 * d'outils (tsc, vitest, semgrep, gitleaks…) dans un dossier isolé et jetable.
 * Un LLM propose et explique ; ces checks tranchent.
 *
 * ⚠️ Sandbox "best effort" (dossier temp local). Pour de la vraie isolation,
 * remplace `runCmd` par une exécution dans un conteneur Docker jetable
 * (ex: `docker run --rm -v <dir>:/work -w /work <image> <cmd>`).
 */

/**
 * Vrai « outil absent » (binaire introuvable dans le PATH) — À NE PAS confondre
 * avec un vrai échec d'exécution. On ne se fie qu'à des signaux NON ambigus :
 *  - code de spawn ENOENT/ENOTDIR (execa) ;
 *  - code de sortie 127 (POSIX « command not found ») ou 9009 (Windows) ;
 *  - message du shell : « command not found » / « is not recognized » / « n'est pas reconnu ».
 * On EXCLUT volontairement `no such file`, `introuvable`, `ModuleNotFoundError`,
 * `Aucun fichier` : ce sont de VRAIS échecs (import cassé, fichier manquant) que
 * l'ancienne heuristique masquait en « skipped » (faux pass). Pur → testable.
 */
export function isToolMissing(code: unknown, message: string, exitCode?: number): boolean {
  if (code === "ENOENT" || code === "ENOTDIR") return true;
  if (exitCode === 127 || exitCode === 9009) return true;
  return /command not found|is not recognized|n['’]est pas reconnu/i.test(message);
}

/**
 * Contrôle déterministe des LIVRABLES du lot (pur FS, agnostique au langage) :
 * renvoie les fichiers déclarés du lot qui n'existent PAS après le passage du coder.
 * Ferme le « coder-fantôme » : un lot marqué vert alors qu'aucun fichier demandé
 * n'a été produit. On ne teste que l'ABSENCE (un fichier vide légitime comme
 * `__init__.py` ne doit pas faire échouer un lot).
 */
export async function checkDeliverables(dir: string, lotFiles: string[]): Promise<string[]> {
  const absent: string[] = [];
  for (const f of lotFiles) {
    try {
      const st = await stat(resolve(dir, f));
      if (!st.isFile()) absent.push(f);
    } catch {
      absent.push(f);
    }
  }
  return absent;
}

async function materialize(files: FileSpec[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gates-sandbox-"));
  for (const f of files) {
    const full = join(dir, f.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.content, "utf8");
  }
  return dir;
}

async function runCmd(name: string, cmd: string | undefined, cwd: string, timeoutMs = 120_000): Promise<CheckResult> {
  if (!cmd || cmd.trim() === "") {
    return { name, status: "skipped", reason: "not-configured", output: "commande non configurée" };
  }
  try {
    // Exécution via le shell : gère guillemets, arguments, chemins à espaces et
    // opérateurs (&&, |) — contrairement à un split(" ") naïf. Multi-plateforme.
    const { stdout, stderr } = await execa(cmd, {
      cwd,
      timeout: timeoutMs,
      reject: true,
      all: true,
      shell: true,
    });
    return { name, status: "passed", output: (stdout + stderr).slice(-4000) };
  } catch (err: any) {
    // Le message d'erreur peut atterrir dans n'importe quel champ (stdout, stderr,
    // all, message) selon la plateforme/le shell : on les concatène TOUS.
    const msg = [err?.all, err?.stdout, err?.stderr, err?.shortMessage, err?.message]
      .filter(Boolean)
      .join("\n");
    // Outil réellement ABSENT (binaire introuvable) -> skipped/tool-missing (non
    // bloquant par défaut ; devient bloquant si le gate est marqué "required").
    // Un VRAI échec d'exécution (import cassé, test rouge) reste "failed".
    if (isToolMissing(err?.code, msg, err?.exitCode)) {
      return { name, status: "skipped", reason: "tool-missing", output: `outil introuvable: ${cmd.split(" ")[0]}` };
    }
    if (err?.timedOut) {
      return { name, status: "failed", output: `délai dépassé (${timeoutMs / 1000}s): ${cmd}` };
    }
    return { name, status: "failed", output: msg.slice(-4000) };
  }
}

/**
 * Installe les dépendances de la stack AVANT les gates/smoke (best-effort).
 * Nécessaire pour les stacks dont les outils ne s'auto-installent pas : `pytest`,
 * `uvicorn` n'apparaissent pas tout seuls (contrairement à `pnpm exec` qui
 * déclenche un install). Non bloquant : un échec (réseau, pas de manifeste) est
 * ignoré — ce sont les gates qui tranchent. Idempotent (pip/pnpm ne réinstallent
 * pas ce qui est déjà satisfait), donc rejouable à chaque itération sans coût.
 */
export async function runInstall(dir: string, cmd: string | null | undefined, timeoutMs = 300_000): Promise<void> {
  if (!cmd || cmd.trim() === "") return;
  try {
    await execa(cmd, { cwd: dir, timeout: timeoutMs, shell: true, reject: true, all: true });
  } catch {
    /* best-effort : les gates diront la vérité si une dépendance manque vraiment */
  }
}

// ── Garde-fou "smoke" : l'application DÉMARRE-t-elle vraiment ? ──────────────────
/**
 * Vérifie que le projet DÉMARRE et RÉPOND (pas seulement qu'il compile).
 *
 * Problème traité (défaut 2) : le typecheck passe sur un projet dont le point
 * d'entrée ne se lance jamais (serveur rangé dans le dernier lot). Le smoke lance
 * la commande de démarrage (ex: `pnpm run dev`), attend une réponse HTTP sur une
 * URL, puis tue l'arbre de process. Générique (Node, Python/uvicorn, …) : piloté
 * par la config `smoke` déduite de la stack au moment du `plan`.
 */
export type SmokeConfig = {
  cmd: string;
  url: string;
  readyTimeoutMs?: number;
  /**
   * Chemins DÉCLARÉS par la spec à interroger une fois l'appli démarrée (déduits par
   * `plan` via `extractEndpoints`). Ferme l'angle mort d'intégration : une appli qui
   * démarre et répond sur `/` mais renvoie 404 sur sa feature n'est PAS livrable.
   */
  paths?: string[];
  /**
   * Contrôle de PAGE pour un front (déduit par `plan`) : ouvre l'URL dans un vrai
   * Chrome headless et vérifie que ça REND (exceptions, erreurs console, requêtes en
   * échec, éléments attendus, appels de dessin). Sans lui, un écran noir passe au vert.
   */
  page?: PageRequirements;
};

/**
 * Verdict sur une route DÉCLARÉE par la spec (pur → testable) :
 *  - 404 = la route n'est pas montée sur l'application qui tourne → ÉCHEC (c'est
 *    exactement le défaut d'intégration recherché) ;
 *  - 5xx / pas de réponse = l'appli ne sert pas la route → ÉCHEC ;
 *  - tout le reste (200, 204, 401, 403, 405, 422…) = la route EXISTE et répond ;
 *    on ne juge pas le métier ici, seulement le montage (les tests jugent le reste).
 */
export function isRouteServed(status: number | null): boolean {
  return status !== null && status !== 404 && status < 500;
}

/** Compose l'URL d'une sonde à partir de l'URL de santé du smoke (pur → testable). */
export function probeUrl(baseUrl: string, path: string): string {
  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return baseUrl.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
  }
}

/**
 * Interroge les routes déclarées (une requête GET chacune). Un échec réseau est
 * retenté brièvement : la santé répond parfois avant que tout soit monté.
 */
async function probePaths(baseUrl: string, paths: string[]): Promise<{ path: string; status: number | null; ok: boolean }[]> {
  const out: { path: string; status: number | null; ok: boolean }[] = [];
  for (const path of paths) {
    const url = probeUrl(baseUrl, path);
    let status: number | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        status = (await fetch(url, { method: "GET" })).status;
        break;
      } catch {
        await sleep(500); // serveur encore en train de monter ses routes
      }
    }
    out.push({ path, status, ok: isRouteServed(status) });
  }
  return out;
}

async function waitForUrl(url: string, timeoutMs: number): Promise<{ up: boolean; status?: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      // Toute réponse HTTP (même 404) prouve que le serveur écoute et répond.
      if (res.status < 500) return { up: true, status: res.status };
    } catch {
      /* pas encore prêt */
    }
    await sleep(700);
  }
  return { up: false };
}

/** Port d'une URL `http://host:PORT/...` (null si absent/invalide). */
function portFromUrl(url: string): number | null {
  const m = url.match(/:(\d{2,5})(?:\D|$)/);
  const p = m ? Number(m[1]) : null;
  return p && p >= 1 && p <= 65535 ? p : null;
}

/**
 * Tue tout process qui ÉCOUTE sur `port` (durcissement autonome). Un smoke d'une
 * itération précédente mal terminé laisse un serveur -> EADDRINUSE au tour suivant :
 * le nouveau serveur ne démarre pas et le smoke échoue/boucle. On libère le port
 * AVANT de démarrer et en filet après le kill de l'arbre. Best-effort, multi-OS.
 */
async function killByPort(port: number): Promise<void> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execa("netstat", ["-ano"], { reject: false });
      const pids = new Set<string>();
      const re = new RegExp(`[:.]${port}\\b`);
      for (const line of stdout.split(/\r?\n/)) {
        if (/LISTENING/i.test(line) && re.test(line)) {
          const pid = line.trim().split(/\s+/).pop();
          if (pid && /^\d+$/.test(pid) && pid !== "0") pids.add(pid);
        }
      }
      for (const pid of pids) await execa("taskkill", ["/PID", pid, "/T", "/F"], { reject: false }).catch(() => {});
    } else {
      const { stdout } = await execa("bash", ["-c", `lsof -ti tcp:${port} -s TCP:LISTEN 2>/dev/null || true`], { reject: false });
      for (const pid of stdout.split(/\s+/).filter(Boolean)) {
        await execa("kill", ["-9", pid], { reject: false }).catch(() => {});
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Arrêt d'un arbre de process, en DEUX temps : on demande d'abord poliment, on force
 * ensuite. Ce n'est pas de la politesse — c'est ce qui décide si la couverture (§2.6)
 * existe pour les projets serveur.
 *
 * Un process tué de force ne déroule pas ses hooks de sortie : `NODE_V8_COVERAGE`
 * n'écrit rien, `coverage.py` ne vide pas sa base. Sans arrêt propre, TOUT projet dont
 * le code ne s'exécute que dans un serveur (API, démon, worker — la majorité de ce que
 * l'agent produira) est invisible à la couverture. On signale donc explicitement quand
 * l'arrêt a dû être forcé : le verdict de couverture s'en sert pour se suspendre au lieu
 * de rendre un faux rouge.
 *
 * Windows n'a pas d'équivalent fiable de SIGTERM pour un process console : `taskkill /T`
 * sans `/F` échoue le plus souvent. On tente, puis on force, et on le DIT.
 */
async function stopTree(child: ResultPromise, graceMs: number): Promise<{ graceful: boolean; note?: string }> {
  const pid = child.pid;
  if (!pid) return { graceful: false, note: "process sans PID" };

  const exited = child.then(() => true, () => true);
  const waitExit = async (ms: number): Promise<boolean> =>
    Promise.race([exited, sleep(ms).then(() => false)]);

  // Windows : `taskkill /T` sans `/F` ne termine pas un process console. Inutile
  // d'attendre le délai de grâce pour rien — on force tout de suite et on le DIT.
  if (process.platform !== "win32") {
    try {
      // detached:true => le process est chef de groupe ; on signale tout le groupe.
      try { process.kill(-pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    } catch {
      /* meilleur effort */
    }
    if (await waitExit(graceMs)) return { graceful: true };
  }

  try {
    if (process.platform === "win32") {
      await execa("taskkill", ["/pid", String(pid), "/T", "/F"], { reject: false }).catch(() => {});
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
  } catch {
    /* meilleur effort */
  }
  await waitExit(2000);
  return {
    graceful: false,
    note:
      process.platform === "win32"
        ? "arrêt forcé (Windows n'offre pas d'arrêt propre pour un process console)"
        : `arrêt forcé après ${graceMs / 1000}s : le process n'a pas rendu la main sur SIGTERM`,
  };
}

/**
 * Assertions de smoke SUR une app DÉJÀ démarrée (sa disponibilité a été confirmée par
 * `startApp`) : rendu de page (front) puis routes déclarées servies. Isolé de `runSmoke`
 * pour pouvoir partager UNE seule instance entre le check `smoke` et les probes serveur
 * (plus de double démarrage).
 */
export async function smokeAssertions(
  baseUrl: string,
  opts: { paths?: string[]; page?: PageRequirements; cmd?: string; startLogs?: string } = {},
): Promise<CheckResult> {
  const started = `démarré : ${baseUrl} a répondu`;
  const logs = opts.startLogs ?? "";
  const cmdNote = opts.cmd ? `\nCommande : ${opts.cmd}` : "";

  // Front : « répond 200 » ne veut rien dire tant qu'on n'a pas regardé la page.
  if (opts.page) {
    const pc = await runPageCheck(baseUrl, opts.page);
    if (pc.status === "failed") {
      return {
        name: "smoke",
        status: "failed",
        output: `l'appli démarre mais la PAGE ne rend pas correctement.\n${pc.output}${cmdNote}\n--- logs ---\n${logs.slice(-2000)}`,
      };
    }
    const note = pc.status === "skipped" ? `contrôle de page ignoré (${pc.output})` : pc.output;
    if (!(opts.paths ?? []).filter(Boolean).length) return { name: "smoke", status: "passed", output: `${started} ; ${note}` };
  }

  const declared = (opts.paths ?? []).filter(Boolean);
  if (!declared.length) return { name: "smoke", status: "passed", output: started };

  // L'appli démarre : sert-elle les routes DÉCLARÉES ? (angle mort d'intégration)
  const probes = await probePaths(baseUrl, declared);
  const detail = probes.map((p) => `${p.path} → ${p.status ?? "aucune réponse"}`).join(", ");
  const missing = probes.filter((p) => !p.ok);
  if (missing.length) {
    return {
      name: "smoke",
      status: "failed",
      output:
        `l'appli démarre mais ne sert PAS les routes déclarées : ${missing.map((p) => p.path).join(", ")}.\n` +
        `Un 404 ici = route jamais montée sur l'application réellement lancée (racine de composition) — ` +
        `monte-la à l'endroit que la commande de démarrage lance, ne crée pas d'application parallèle.\n` +
        `Sondes : ${detail}${cmdNote}`,
    };
  }
  return { name: "smoke", status: "passed", output: `${started} ; routes déclarées servies (${detail})` };
}

/**
 * Garde-fou `smoke` autonome : démarre l'app, confirme qu'elle répond, joue les
 * assertions, puis l'arrête. Quand des probes serveur coexistent, l'appelant partage
 * plutôt un seul `startApp` + `smokeAssertions` (cf. cli.ts) pour ne pas démarrer deux fois.
 */
export async function runSmoke(dir: string, smoke: SmokeConfig, timeoutMs = 30_000): Promise<CheckResult> {
  const started = await startApp(dir, { start: smoke.cmd, url: smoke.url, readyTimeoutMs: smoke.readyTimeoutMs ?? timeoutMs });
  if ("error" in started) {
    return { name: "smoke", status: "failed", output: `l'appli n'a pas répondu (démarrage échoué ?).\nCommande : ${smoke.cmd}\n${started.error}` };
  }
  try {
    return await smokeAssertions(started.server.baseUrl, { paths: smoke.paths, page: smoke.page, cmd: smoke.cmd, startLogs: started.server.logs() });
  } finally {
    await started.server.stop();
  }
}

/** Attend qu'une ligne de log corresponde à `pattern` (`/regex/` ou sous-chaîne). */
async function waitForLog(getLogs: () => string, pattern: string, timeoutMs: number): Promise<boolean> {
  const m = pattern.match(/^\/(.*)\/([a-z]*)$/s);
  let test: (s: string) => boolean;
  if (m) {
    try {
      const re = new RegExp(m[1], m[2]);
      test = (s) => re.test(s);
    } catch {
      test = (s) => s.includes(pattern);
    }
  } else {
    test = (s) => s.includes(pattern);
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (test(getLogs())) return true;
    await sleep(200);
  }
  return false;
}

export type StartedApp = {
  /** URL de base pour composer les sondes (vide pour un démon sans HTTP). */
  baseUrl: string;
  /** Logs de démarrage accumulés (tronqués). */
  logs: () => string;
  /**
   * Arrête l'app : demande l'arrêt, attend, force si nécessaire, libère le port.
   * `graceful: false` signifie que le process n'a PAS déroulé ses hooks de sortie —
   * donc qu'il n'a pas écrit sa couverture (cf. `stopTree`).
   */
  stop: () => Promise<{ graceful: boolean; note?: string }>;
};

/**
 * Démarre l'app et la LAISSE tourner (contrairement à `runSmoke` qui teste puis tue).
 * C'est le harnais des probes serveur (§2.5) : démarrer UNE fois, lancer toutes les
 * probes `http`/`browser` contre l'app vivante, puis l'arrêter. Sert aussi aux probes
 * `process` (un démon qui doit tenir debout).
 *
 * Prêt = réponse HTTP sur `url`, sinon (démon sans HTTP) une ligne de log qui
 * correspond à `logMatch`. Sans l'un ni l'autre, on considère l'app levée après un
 * court délai (best-effort). Réutilise `killByPort`/`killTree`/`waitForUrl` du smoke.
 */
export async function startApp(
  dir: string,
  cfg: {
    start: string;
    url?: string;
    logMatch?: string;
    readyTimeoutMs?: number;
    /** Variables injectées (instrumentation de couverture, §2.6). */
    env?: Record<string, string>;
    /** Délai laissé au process pour s'arrêter proprement avant de forcer. */
    graceMs?: number;
  },
): Promise<{ server: StartedApp } | { error: string }> {
  const ready = cfg.readyTimeoutMs ?? 30_000;
  const port = cfg.url ? portFromUrl(cfg.url) : null;
  if (port) await killByPort(port); // serveur fantôme d'une itération précédente

  let logs = "";
  const child = execa(cfg.start, {
    cwd: dir,
    shell: true,
    reject: false,
    all: true,
    detached: process.platform !== "win32",
    env: { ...process.env, FORCE_COLOR: "0", ...(cfg.env ?? {}) },
  });
  child.all?.on("data", (d: Buffer) => {
    logs += d.toString();
    if (logs.length > 8000) logs = logs.slice(-8000);
  });
  child.catch(() => {}); // un kill n'est pas une erreur

  const stop = async () => {
    const res = await stopTree(child, cfg.graceMs ?? 5000);
    if (port) await killByPort(port);
    return res;
  };

  let up = false;
  if (cfg.url) up = (await waitForUrl(cfg.url, ready)).up;
  else if (cfg.logMatch) up = await waitForLog(() => logs, cfg.logMatch, ready);
  else {
    await sleep(Math.min(ready, 1500));
    up = true;
  }

  if (!up) {
    await stop();
    const how = cfg.url ? `réponse sur ${cfg.url}` : `log « ${cfg.logMatch} »`;
    return { error: `pas de ${how} en ${ready / 1000}s\n--- logs ---\n${logs.slice(-1500)}` };
  }
  return { server: { baseUrl: cfg.url ?? "", logs: () => logs, stop } };
}

/** Écrit code + tests dans un sandbox et lance les garde-fous fournis (config projet). */
export async function runGuardrails(
  files: FileSpec[],
  gates: Record<string, string | null | undefined>,
): Promise<GuardrailResult> {
  const dir = await materialize(files);
  try {
    const entries = Object.entries(gates);
    const checks = await Promise.all(
      entries.map(([name, cmd]) => runCmd(name, cmd ?? undefined, dir)),
    );
    // Un check "skipped" ne bloque pas ; seul "failed" fait échouer le gate.
    const passed = checks.every((c) => c.status !== "failed");
    return { passed, checks };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Lance les garde-fous DANS un dossier existant (le vrai projet), sans le créer
 * ni le supprimer. Les tests, le typecheck, etc. voient donc TOUT le projet
 * (code des lots précédents inclus) -> validation incrémentale + anti-régression.
 * Exécution séquentielle pour un log lisible.
 */
export async function runGuardrailsInDir(
  dir: string,
  gates: Record<string, string | null | undefined>,
  timeoutMs = 120_000,
): Promise<GuardrailResult> {
  const checks: CheckResult[] = [];
  for (const [name, cmd] of Object.entries(gates)) {
    checks.push(await runCmd(name, cmd ?? undefined, dir, timeoutMs));
  }
  const passed = checks.every((c) => c.status !== "failed");
  return { passed, checks };
}
