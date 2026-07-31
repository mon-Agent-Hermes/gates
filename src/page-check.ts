import { existsSync } from "node:fs";
import type { CheckResult } from "./types.js";

/**
 * Garde-fou FRONT déterministe : la page REND-elle vraiment ?
 *
 * Trou constaté le 2026-07-25 : pour un projet front, le smoke se contentait d'un
 * `GET /` avec un statut < 500. Un jeu qui affiche un écran noir, une app dont le
 * bundle plante au chargement, une page dont un module renvoie 404 : tout passait au
 * VERT. Le pass/fail de hermes doit venir de l'exécution réelle, pas d'une supposition
 * — ici on ouvre donc la page dans un vrai Chrome (headless) et on OBSERVE :
 *   - exceptions non attrapées et erreurs console,
 *   - requêtes en échec (module/asset 404),
 *   - présence des éléments attendus (sélecteurs),
 *   - pour le rendu 2D/3D : un `<canvas>` dimensionné, son contexte, et surtout le
 *     nombre d'APPELS DE DESSIN réellement effectués (instrumentation de WebGL et
 *     Canvas2D avant le chargement de l'app) — 0 appel = rien n'a été dessiné.
 *
 * Aucun LLM : ce sont des faits mesurés. Le juge visuel LLM (`visual-audit.ts`) reste
 * une couche optionnelle par-dessus, pour ce qui ne se mesure pas.
 *
 * Chrome n'est PAS téléchargé : on réutilise celui de la machine (puppeteer-core).
 * Absent → `skipped/tool-missing`, comme n'importe quel outil manquant.
 */

export type PageRequirements = {
  /** Sélecteurs CSS qui doivent exister dans le DOM après chargement. */
  requireSelectors?: string[];
  /** Exiger un <canvas> visible et doté d'un contexte de rendu. */
  requireCanvas?: boolean;
  /** Nombre minimal d'appels de dessin observés (1 = « quelque chose a été rendu »). */
  minDrawCalls?: number;
  /** Tolérer les erreurs console (défaut : non — une erreur console fait échouer). */
  allowConsoleErrors?: boolean;
  /** Temps laissé à l'app pour démarrer/rendre après le `load` (défaut 4000 ms). */
  waitMs?: number;
};

/** Interaction à jouer sur la page avant observation (probe `browser`, §2.5). */
export type PageAction = {
  /** Sélecteur CSS à cliquer. */
  click?: string;
  /** Saisir `text` dans le champ `selector`. */
  type?: { selector: string; text: string };
  /** Attendre N ms (laisser une transition/rendu se faire). */
  wait?: number;
};

export type PageObservation = {
  url: string;
  title: string;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  presentSelectors: string[];
  missingSelectors: string[];
  canvas: { present: boolean; width: number; height: number; context: string | null };
  drawCalls: number;
};

/**
 * Requêtes dont l'échec ne dit RIEN sur la santé de l'app : un `favicon.ico` absent
 * est le cas normal d'un projet en cours, pas un défaut. Sans ce filtre, le gate
 * échouerait sur toutes les pages (faux positif constaté à la validation).
 */
const BENIGN_REQUEST = /\/(favicon\.ico|apple-touch-icon[^/]*\.png|robots\.txt|sitemap\.xml)(\?|$)|\.map(\?|$)/i;

/**
 * Message console purement redondant avec le canal « requête en échec » : Chrome logue
 * un « Failed to load resource » générique (sans URL exploitable) pour chaque 404. On
 * ne garde donc que les erreurs applicatives, où l'information est réelle.
 */
const REDUNDANT_CONSOLE = /^Failed to load resource/i;

/** Faut-il retenir cette requête en échec comme un vrai signal ? (pur → testable) */
export const isRelevantRequestFailure = (url: string): boolean => !BENIGN_REQUEST.test(url);

/** Faut-il retenir ce message console comme un vrai signal ? (pur → testable) */
export const isRelevantConsoleError = (text: string): boolean => !REDUNDANT_CONSOLE.test(text.trim());

/** Emplacements usuels d'un Chrome/Edge installé, par plateforme. */
export function chromeCandidates(platform: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    const pf = env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = env["LOCALAPPDATA"] ?? "";
    return [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      local ? `${local}\\Google\\Chrome\\Application\\chrome.exe` : "",
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ].filter(Boolean);
  }
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
}

/**
 * Chemin du navigateur à piloter. Priorité aux variables d'environnement (CI, chemins
 * exotiques), puis aux emplacements usuels. `null` = aucun navigateur → gate skippé.
 * Pur (le test de présence est injecté) → testable sans navigateur.
 */
export function findChrome(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const explicit = env.HERMES_CHROME ?? env.CHROME_PATH ?? env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit && exists(explicit)) return explicit;
  for (const c of chromeCandidates(platform, env)) if (exists(c)) return c;
  return null;
}

/**
 * Verdict à partir des faits observés (PUR → testable sans navigateur).
 * Une erreur console ou une exception suffit à faire échouer : sur un front, c'est
 * quasi toujours le symptôme d'une page cassée, et le laisser passer est exactement
 * ce qui a permis à un lot « vert » de ne rien afficher.
 */
export function classifyPage(obs: PageObservation, req: PageRequirements): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (obs.pageErrors.length) {
    reasons.push(`exception(s) non attrapée(s) : ${obs.pageErrors.slice(0, 3).join(" | ")}`);
  }
  if (!req.allowConsoleErrors && obs.consoleErrors.length) {
    reasons.push(`erreur(s) console : ${obs.consoleErrors.slice(0, 3).join(" | ")}`);
  }
  if (obs.failedRequests.length) {
    reasons.push(`requête(s) en échec (module/asset manquant) : ${obs.failedRequests.slice(0, 3).join(" | ")}`);
  }
  if (obs.missingSelectors.length) {
    reasons.push(`élément(s) attendu(s) absent(s) du DOM : ${obs.missingSelectors.join(", ")}`);
  }
  if (req.requireCanvas) {
    if (!obs.canvas.present) reasons.push("aucun <canvas> dans la page");
    else if (obs.canvas.width < 2 || obs.canvas.height < 2) {
      reasons.push(`<canvas> de taille nulle (${obs.canvas.width}×${obs.canvas.height})`);
    } else if (!obs.canvas.context) reasons.push("<canvas> sans contexte de rendu (rien ne dessine dessus)");
  }
  const min = req.minDrawCalls ?? 0;
  if (min > 0 && obs.drawCalls < min) {
    reasons.push(
      `${obs.drawCalls} appel(s) de dessin observé(s) (minimum ${min}) — la page se charge mais ne rend RIEN`,
    );
  }
  return { passed: reasons.length === 0, reasons };
}

/** Résumé lisible d'une observation (pour le rapport de gate). */
export function summarize(obs: PageObservation): string {
  const c = obs.canvas.present ? `canvas ${obs.canvas.width}×${obs.canvas.height} (${obs.canvas.context ?? "sans contexte"})` : "aucun canvas";
  return `« ${obs.title || "sans titre"} » · ${c} · ${obs.drawCalls} appel(s) de dessin · ` +
    `${obs.consoleErrors.length} erreur(s) console · ${obs.failedRequests.length} requête(s) en échec`;
}

/**
 * Script injecté AVANT tout code de la page : compte les appels de dessin réels et
 * mémorise le type de contexte demandé au premier `getContext`. C'est la seule façon
 * fiable de distinguer « la page a chargé » de « la page a rendu quelque chose »
 * (un screenshot de WebGL est vide sans `preserveDrawingBuffer`).
 */
const INSTRUMENT = `(() => {
  window.__hermesDraws = 0;
  window.__hermesCtx = null;
  const wrap = (proto, methods) => {
    if (!proto) return;
    for (const m of methods) {
      const orig = proto[m];
      if (typeof orig !== "function") continue;
      proto[m] = function (...a) { window.__hermesDraws++; return orig.apply(this, a); };
    }
  };
  wrap(self.WebGLRenderingContext && self.WebGLRenderingContext.prototype,
    ["drawArrays", "drawElements"]);
  wrap(self.WebGL2RenderingContext && self.WebGL2RenderingContext.prototype,
    ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]);
  wrap(self.CanvasRenderingContext2D && self.CanvasRenderingContext2D.prototype,
    ["fillRect", "strokeRect", "drawImage", "fill", "stroke", "fillText", "putImageData"]);
  const gc = self.HTMLCanvasElement && self.HTMLCanvasElement.prototype.getContext;
  if (gc) {
    self.HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = gc.call(this, type, ...rest);
      if (ctx && !window.__hermesCtx) window.__hermesCtx = type;
      return ctx;
    };
  }
})()`;

/**
 * Ouvre l'URL dans Chrome (headless) et renvoie les faits observés.
 * `null` = aucun navigateur disponible sur la machine (gate skippé, pas échoué).
 */
export async function observePage(
  url: string,
  req: PageRequirements = {},
  actions: PageAction[] = [],
): Promise<PageObservation | null> {
  const executablePath = findChrome();
  if (!executablePath) return null;

  // Import dynamique : hermes reste utilisable (et testable) sans navigateur.
  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    // SwiftShader : rendu WebGL logiciel, indispensable en headless sans GPU.
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.evaluateOnNewDocument(INSTRUMENT);
    page.on("console", (m: any) => {
      const text = String(m.text());
      if (m.type() === "error" && isRelevantConsoleError(text)) consoleErrors.push(text.slice(0, 300));
    });
    page.on("pageerror", (e: any) => pageErrors.push(String(e?.message ?? e).slice(0, 300)));
    page.on("requestfailed", (r: any) => {
      if (isRelevantRequestFailure(r.url())) {
        failedRequests.push(`${r.url()} (${r.failure()?.errorText ?? "échec"})`.slice(0, 300));
      }
    });
    page.on("response", (r: any) => {
      if (r.status() >= 400 && isRelevantRequestFailure(r.url())) {
        failedRequests.push(`${r.url()} → HTTP ${r.status()}`.slice(0, 300));
      }
    });

    await page.goto(url, { waitUntil: "load", timeout: 30_000 }).catch((e: any) => {
      pageErrors.push(`navigation impossible : ${e?.message ?? e}`);
    });
    // Laisser l'app démarrer et rendre au moins une frame.
    await new Promise((r) => setTimeout(r, req.waitMs ?? 4000));

    // Jouer les interactions (probe browser) : clic, saisie, attente. Un sélecteur
    // introuvable est une exception applicative (la feature n'est pas là), donc retenue.
    for (const act of actions) {
      if (act.click) {
        await page.click(act.click).catch((e: any) => pageErrors.push(`clic impossible sur ${act.click} : ${e?.message ?? e}`));
      }
      if (act.type) {
        await page.type(act.type.selector, act.type.text).catch((e: any) => pageErrors.push(`saisie impossible sur ${act.type!.selector} : ${e?.message ?? e}`));
      }
      if (act.wait) await new Promise((r) => setTimeout(r, act.wait));
    }
    // Laisser le rendu consécutif aux actions se produire.
    if (actions.length) await new Promise((r) => setTimeout(r, 500));

    const selectors = req.requireSelectors ?? [];
    const facts = await page.evaluate((sels: string[]) => {
      const present: string[] = [];
      const missing: string[] = [];
      for (const s of sels) {
        try { (document.querySelector(s) ? present : missing).push(s); } catch { missing.push(s); }
      }
      const c = document.querySelector("canvas") as HTMLCanvasElement | null;
      return {
        title: document.title,
        present,
        missing,
        canvas: {
          present: !!c,
          width: c?.width ?? 0,
          height: c?.height ?? 0,
          context: (window as any).__hermesCtx ?? null,
        },
        drawCalls: (window as any).__hermesDraws ?? 0,
      };
    }, selectors);

    return {
      url,
      title: facts.title,
      consoleErrors,
      pageErrors,
      failedRequests,
      presentSelectors: facts.present,
      missingSelectors: facts.missing,
      canvas: facts.canvas,
      drawCalls: facts.drawCalls,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Garde-fou complet, au format des autres checks déterministes de hermes. */
export async function runPageCheck(url: string, req: PageRequirements = {}): Promise<CheckResult> {
  let obs: PageObservation | null;
  try {
    obs = await observePage(url, req);
  } catch (e: any) {
    return { name: "page", status: "failed", output: `contrôle de page impossible : ${e?.message ?? e}` };
  }
  if (!obs) {
    return {
      name: "page",
      status: "skipped",
      reason: "tool-missing",
      output: "aucun Chrome/Edge trouvé sur la machine (définis HERMES_CHROME=<chemin> pour l'activer)",
    };
  }
  const { passed, reasons } = classifyPage(obs, req);
  return passed
    ? { name: "page", status: "passed", output: `page rendue : ${summarize(obs)}` }
    : { name: "page", status: "failed", output: `${reasons.join("\n")}\n(observé : ${summarize(obs)})` };
}
