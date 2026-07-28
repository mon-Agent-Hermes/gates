import { execa } from "execa";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckResult } from "./types";

/**
 * `probes` (§2.5) — observer l'artefact EN TRAIN de faire son travail, au niveau où
 * « ça marche » se définit (un code de sortie, un fichier produit, un appel de dessin),
 * pas seulement « ça compile ». `smoke` et `page` sont deux cas particuliers du même
 * geste ; les généraliser fait sortir le montage du web.
 *
 * Trois règles de construction (cf. doc) :
 *  - `$TMP` est un dossier NEUF par probe, effacé ensuite (sinon la probe n°2 valide en
 *    réalité l'effet de la n°1) ;
 *  - une probe doit être reproductible (aucun réseau tiers, graine fixée) ;
 *  - une probe échouée nomme LA PROBE, pas le check (`probes: failed` n'est pas
 *    actionnable ; `init-cree-la-config : fichier attendu absent` l'est).
 *
 * Ce module porte les kinds `cli` et `artifact` (aucun serveur ni navigateur requis).
 * `browser` / `http` / `process` exigent l'app démarrée : leur harnais viendra avec la
 * généralisation de `runSmoke` — d'ici là ils sont `skipped` (jamais un faux vert).
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

/** Probe d'un kind pas encore porté (browser/http/process) — reconnue mais `skipped`. */
export type DeferredProbe = { id: string; criterion?: string; kind: string; [k: string]: unknown };

export type Probe = CliProbe | ArtifactProbe | DeferredProbe;

export type ProbeResult = {
  id: string;
  criterion?: string;
  status: "passed" | "failed" | "skipped";
  output: string;
};

/** Remplace `$TMP` par le dossier jetable de la probe. */
function expand(s: string, tmp: string): string {
  return s.split("$TMP").join(tmp);
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

const DEFERRED_KINDS = new Set(["browser", "http", "process"]);

async function runCliProbe(p: CliProbe, timeoutMs: number): Promise<ProbeResult> {
  const tmp = await mkdtemp(join(tmpdir(), "gates-probe-"));
  const reasons: string[] = [];
  try {
    const exp = p.expect ?? {};
    const res = await execa(expand(p.run, tmp), { shell: true, reject: false, all: true, timeout: timeoutMs });
    if (exp.exitCode !== undefined && res.exitCode !== exp.exitCode) {
      reasons.push(`code de sortie ${res.exitCode} (attendu ${exp.exitCode})`);
    }
    if (exp.stdout && !textMatches(expand(exp.stdout, tmp), res.stdout ?? "")) {
      reasons.push(`stdout ne correspond pas à ${exp.stdout}`);
    }
    if (exp.stderr && !textMatches(expand(exp.stderr, tmp), res.stderr ?? "")) {
      reasons.push(`stderr ne correspond pas à ${exp.stderr}`);
    }
    for (const f of exp.files ?? []) {
      const fp = expand(f, tmp);
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
  return reasons.length
    ? { id: p.id, criterion: p.criterion, status: "failed", output: reasons.join(" ; ") }
    : { id: p.id, criterion: p.criterion, status: "passed", output: "effet observé (code/sortie/fichiers conformes)" };
}

async function runArtifactProbe(p: ArtifactProbe, timeoutMs: number): Promise<ProbeResult> {
  const tmp = await mkdtemp(join(tmpdir(), "gates-probe-"));
  const reasons: string[] = [];
  try {
    const exp = p.expect ?? {};
    if (p.run) await execa(expand(p.run, tmp), { shell: true, reject: false, all: true, timeout: timeoutMs });
    const fp = expand(p.file, tmp);
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
      const cmd = expand(exp.openableBy, tmp).split("{file}").join(fp);
      const r = await execa(cmd, { shell: true, reject: false, all: true, timeout: timeoutMs });
      if (r.exitCode !== 0) reasons.push(`fichier non ouvrable par « ${exp.openableBy} » (code ${r.exitCode})`);
    }
  } catch (err: any) {
    reasons.push(`exécution impossible : ${err?.shortMessage ?? err?.message ?? err}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return reasons.length
    ? { id: p.id, criterion: p.criterion, status: "failed", output: reasons.join(" ; ") }
    : { id: p.id, criterion: p.criterion, status: "passed", output: "artefact produit et valide" };
}

/** Lance une probe selon son kind. Kinds non portés → `skipped` (jamais un faux vert). */
export async function runProbe(p: Probe, timeoutMs = 120_000): Promise<ProbeResult> {
  if (p.kind === "cli") return runCliProbe(p as CliProbe, timeoutMs);
  if (p.kind === "artifact") return runArtifactProbe(p as ArtifactProbe, timeoutMs);
  if (DEFERRED_KINDS.has(p.kind)) {
    return { id: p.id, criterion: p.criterion, status: "skipped", output: `kind « ${p.kind} » pas encore porté (exige l'app démarrée)` };
  }
  return { id: p.id, criterion: p.criterion, status: "skipped", output: `kind « ${p.kind} » inconnu` };
}

/** Lance toutes les probes séquentiellement (isolation par $TMP oblige). */
export async function runProbes(probes: Probe[], timeoutMs = 120_000): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const p of probes) out.push(await runProbe(p, timeoutMs));
  return out;
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
