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

async function killTree(child: ResultPromise): Promise<void> {
  const pid = child.pid;
  try {
    if (process.platform === "win32" && pid) {
      await execa("taskkill", ["/pid", String(pid), "/T", "/F"]).catch(() => {});
    } else if (pid) {
      // detached:true => le process est chef de groupe ; on tue tout le groupe.
      try { process.kill(-pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    }
  } catch {
    /* meilleur effort */
  }
}

export async function runSmoke(dir: string, smoke: SmokeConfig, timeoutMs = 30_000): Promise<CheckResult> {
  const ready = smoke.readyTimeoutMs ?? timeoutMs;
  const port = portFromUrl(smoke.url);
  // Libère le port d'un éventuel serveur fantôme (itération/lot précédent) avant
  // de démarrer, sinon EADDRINUSE ferait échouer ce smoke à tort.
  if (port) await killByPort(port);
  let logs = "";
  const child = execa(smoke.cmd, {
    cwd: dir,
    shell: true,
    reject: false,
    all: true,
    detached: process.platform !== "win32", // groupe de process tuable sur posix
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  child.all?.on("data", (d: Buffer) => {
    logs += d.toString();
    if (logs.length > 8000) logs = logs.slice(-8000);
  });
  child.catch(() => {}); // un kill n'est pas une erreur

  try {
    const res = await waitForUrl(smoke.url, ready);
    if (res.up) {
      const started = `démarré : ${smoke.url} a répondu (HTTP ${res.status})`;

      // Front : « répond 200 » ne veut rien dire tant qu'on n'a pas regardé la page.
      // Le contrôle de page ouvre un vrai navigateur et exige un rendu (cf. page-check).
      if (smoke.page) {
        const pc = await runPageCheck(smoke.url, smoke.page);
        if (pc.status === "failed") {
          return {
            name: "smoke",
            status: "failed",
            output: `l'appli démarre mais la PAGE ne rend pas correctement.\n${pc.output}\n` +
              `Commande : ${smoke.cmd}\n--- logs de démarrage ---\n${logs.slice(-2000)}`,
          };
        }
        const note = pc.status === "skipped" ? `contrôle de page ignoré (${pc.output})` : pc.output;
        const declaredPaths = (smoke.paths ?? []).filter(Boolean);
        if (!declaredPaths.length) return { name: "smoke", status: "passed", output: `${started} ; ${note}` };
      }

      const declared = (smoke.paths ?? []).filter(Boolean);
      if (!declared.length) return { name: "smoke", status: "passed", output: started };

      // L'appli démarre : sert-elle les routes DÉCLARÉES ? (angle mort d'intégration)
      const probes = await probePaths(smoke.url, declared);
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
            `Sondes : ${detail}\nCommande : ${smoke.cmd}\n--- logs de démarrage ---\n${logs.slice(-2000)}`,
        };
      }
      return { name: "smoke", status: "passed", output: `${started} ; routes déclarées servies (${detail})` };
    }
    return {
      name: "smoke",
      status: "failed",
      output: `l'appli n'a pas répondu sur ${smoke.url} en ${ready / 1000}s (démarrage échoué ?).\n` +
        `Commande : ${smoke.cmd}\n--- logs de démarrage ---\n${logs.slice(-2500)}`,
    };
  } finally {
    await killTree(child);
    // Filet : si l'arbre a laissé un enfant (reloader uvicorn, wrapper shell…),
    // on libère quand même le port pour ne pas polluer l'itération suivante.
    if (port) await killByPort(port);
  }
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
