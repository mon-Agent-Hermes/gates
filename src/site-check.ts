import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { findChrome } from "./page-check.js";
import type { CheckResult } from "./types.js";

/**
 * Contrôles de SITE (chantier 9) : accessibilité, mobile, poids, référencement de base.
 *
 * `gates` vérifie depuis le début qu'un site MARCHE. Ces contrôles regardent s'il est
 * PRÉSENTABLE — sans jamais devenir un gate web déguisé en gate universel : ils ne
 * tournent que si le projet déclare un site (`site`, ou `app.page`), et seulement après
 * un `smoke` vert. Un audit d'accessibilité vert sur une page noire est un faux vert.
 *
 * Les six règles de `ROADMAP.md` (chantier 9, B), telles qu'elles s'appliquent ici :
 *
 *  1. conditionnels — cf. ci-dessus ;
 *  2. deux niveaux : chaque constat est BLOQUANT ou SIGNALÉ (`warn`, sans effet sur le
 *     code de sortie) ;
 *  3. tout démarre en observation : par défaut, RIEN ne bloque. Une règle ne bloque que
 *     si le contrat la liste dans `site.bloquant` — donc après un `!approuve` humain ;
 *  4. rien de ce qui fluctue : pas de score Lighthouse, des budgets fixes en octets ;
 *  5. les seuils vivent dans le contrat (`gates.json` approuvé), jamais dans le dépôt ;
 *  6. chaque constat dit quoi corriger, et où : la règle, la page, les éléments fautifs.
 *
 * En accessibilité, seules les violations « serious » et « critical » d'axe-core peuvent
 * bloquer : le reste est toujours signalé. C'est la part objective et stable de l'audit ;
 * la pertinence d'un texte ou l'ordre de lecture restent l'affaire d'un humain.
 */

export type SiteConfig = {
  /** Chemins à auditer (défaut `["/"]`). */
  pages?: string[];
  /** Règles qui BLOQUENT : `a11y`, `a11y:<règle axe>`, `mobile`, `mobile:viewport`… */
  bloquant?: string[];
  /** Budgets fixes, en Ko. */
  budgets?: { poidsKo?: number; jsKo?: number; imageKo?: number };
  /** Temps laissé à la page après `load` (défaut 1500 ms). */
  waitMs?: number;
};

export const FAMILLES = ["a11y", "mobile", "budgets", "seo"] as const;
export type Famille = (typeof FAMILLES)[number];

/** Les règles nommées de chaque famille. `a11y` accepte en plus toute règle d'axe-core. */
export const REGLES: Record<Exclude<Famille, "a11y">, string[]> = {
  mobile: ["viewport", "scroll-horizontal"],
  budgets: ["poids", "js", "image"],
  seo: ["title", "description", "h1"],
};

export const BUDGETS_DEFAUT = { poidsKo: 1500, jsKo: 400, imageKo: 500 };

const SITE_KEYS = new Set(["pages", "bloquant", "budgets", "waitMs"]);
const BUDGET_KEYS = new Set(["poidsKo", "jsKo", "imageKo"]);
const AXE_ID = /^[a-z0-9-]{1,64}$/;

/**
 * Contrôle de la section `site` au chargement. Comme partout dans `gates` : une clé que
 * rien ne lit est une faute de config (exit 2), jamais un réglage silencieusement ignoré.
 * Une faute de frappe dans `bloquant` ne doit pas rendre une règle bloquante inopérante.
 */
export function validateSite(site: unknown): string[] {
  if (site === undefined) return [];
  if (!site || typeof site !== "object" || Array.isArray(site)) return ["site : un objet est attendu"];
  const s = site as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of Object.keys(s)) if (!SITE_KEYS.has(k)) errors.push(`site : clé inconnue « ${k} »`);
  if (s.pages !== undefined) {
    if (!Array.isArray(s.pages) || !s.pages.length) errors.push("site.pages : une liste non vide de chemins est attendue");
    else for (const p of s.pages) {
      if (typeof p !== "string" || !p.startsWith("/")) errors.push(`site.pages : « ${String(p)} » doit commencer par /`);
    }
  }
  if (s.bloquant !== undefined) {
    if (!Array.isArray(s.bloquant)) errors.push("site.bloquant : une liste est attendue");
    else for (const r of s.bloquant) {
      if (typeof r !== "string" || !regleConnue(r)) errors.push(`site.bloquant : règle inconnue « ${String(r)} »`);
    }
  }
  if (s.budgets !== undefined) {
    if (!s.budgets || typeof s.budgets !== "object" || Array.isArray(s.budgets)) errors.push("site.budgets : un objet est attendu");
    else for (const [k, v] of Object.entries(s.budgets as Record<string, unknown>)) {
      if (!BUDGET_KEYS.has(k)) errors.push(`site.budgets : clé inconnue « ${k} »`);
      else if (typeof v !== "number" || !(v > 0)) errors.push(`site.budgets.${k} : un nombre positif est attendu`);
    }
  }
  if (s.waitMs !== undefined && (typeof s.waitMs !== "number" || s.waitMs < 0 || s.waitMs > 30_000)) {
    errors.push("site.waitMs : entre 0 et 30000");
  }
  return errors;
}

function regleConnue(r: string): boolean {
  if ((FAMILLES as readonly string[]).includes(r)) return true;
  const [famille, regle, ...reste] = r.split(":");
  if (reste.length || !regle) return false;
  if (famille === "a11y") return AXE_ID.test(regle);
  return famille in REGLES && REGLES[famille as keyof typeof REGLES].includes(regle);
}

// ── Les faits observés ───────────────────────────────────────────────────────────

export type A11yViolation = { id: string; impact: string | null; help: string; helpUrl: string; cibles: string[]; n: number };

export type SiteObservation = {
  page: string;
  /** `null` : axe n'a pas pu tourner (la raison est dans `a11yErreur`). */
  a11y: A11yViolation[] | null;
  a11yErreur?: string;
  title: string;
  description: boolean;
  h1: number;
  viewport: boolean;
  /** Mesuré à 375 px de large. */
  largeurContenu: number;
  largeurEcran: number;
  /** Les éléments d'où part le débordement horizontal (3 au plus). */
  deborde: string[];
  /** Octets transférés (corps), tels que la page les voit. */
  poids: number;
  js: number;
  imageMax: { url: string; octets: number } | null;
};

export type Constat = { famille: Famille; regle: string; page: string; bloquant: boolean; message: string };

const ko = (octets: number) => Math.round(octets / 1024);
const IMPACTS_BLOQUANTS = new Set(["serious", "critical"]);

/** Verdict à partir des faits (PUR → testable sans navigateur). */
export function evaluateSite(observations: SiteObservation[], cfg: SiteConfig = {}): Constat[] {
  const bloquant = new Set(cfg.bloquant ?? []);
  const bloque = (famille: Famille, regle: string) => bloquant.has(famille) || bloquant.has(`${famille}:${regle}`);
  const budgets = { ...BUDGETS_DEFAUT, ...(cfg.budgets ?? {}) };
  const out: Constat[] = [];
  const push = (famille: Famille, regle: string, page: string, message: string, peutBloquer = true) =>
    out.push({ famille, regle: `${famille}:${regle}`, page, bloquant: peutBloquer && bloque(famille, regle), message });

  for (const o of observations) {
    // 1. Accessibilité
    for (const v of o.a11y ?? []) {
      const grave = IMPACTS_BLOQUANTS.has(v.impact ?? "");
      const cibles = v.cibles.slice(0, 3).join(" · ");
      push("a11y", v.id, o.page,
        `(${v.impact ?? "impact inconnu"}) ${v.help} — ${v.n} élément(s)${cibles ? ` : ${cibles}` : ""}. ${v.helpUrl}`,
        grave);
    }
    // 2. Mobile, à 375 px
    if (!o.viewport) {
      push("mobile", "viewport", o.page,
        `balise <meta name="viewport"> absente — ajoute <meta name="viewport" content="width=device-width, initial-scale=1"> dans <head>`);
    }
    if (o.largeurContenu > o.largeurEcran + 1) {
      push("mobile", "scroll-horizontal", o.page,
        `défilement horizontal à ${o.largeurEcran} px : le contenu fait ${o.largeurContenu} px` +
        (o.deborde.length ? `. Déborde depuis : ${o.deborde.join(" · ")}` : "") +
        ` — une largeur fixe, ou une image sans max-width: 100%`);
    }
    // 3. Budgets — des octets, jamais un score qui fluctue.
    if (o.poids > budgets.poidsKo * 1024) {
      push("budgets", "poids", o.page, `page de ${ko(o.poids)} Ko pour un budget de ${budgets.poidsKo} Ko`);
    }
    if (o.js > budgets.jsKo * 1024) {
      push("budgets", "js", o.page, `${ko(o.js)} Ko de JavaScript pour un budget de ${budgets.jsKo} Ko`);
    }
    if (o.imageMax && o.imageMax.octets > budgets.imageKo * 1024) {
      push("budgets", "image", o.page,
        `image de ${ko(o.imageMax.octets)} Ko (budget ${budgets.imageKo} Ko) : ${o.imageMax.url} — à compresser ou redimensionner`);
    }
    // 4. Référencement de base
    if (!o.title.trim()) push("seo", "title", o.page, "<title> absent ou vide — chaque page a besoin d'un titre qui dit ce qu'elle contient");
    if (!o.description) push("seo", "description", o.page, `<meta name="description"> absente`);
    if (o.h1 !== 1) push("seo", "h1", o.page, `${o.h1} <h1> sur la page (attendu : exactement 1, pour une hiérarchie de titres lisible)`);
  }
  return out;
}

/** Le contrat a-t-il rendu bloquant quoi que ce soit de cette famille ? */
export function familleBloquante(cfg: SiteConfig, famille: Famille): boolean {
  return (cfg.bloquant ?? []).some((r) => r === famille || r.startsWith(`${famille}:`));
}

/**
 * Le verdict d'une famille qu'on N'A PAS PU observer — quelle qu'en soit la cause.
 *
 * Défaut corrigé le 25/09/2026 : toute impossibilité d'observer rendait `warn` ou
 * `skipped`, y compris quand le contrat déclarait la famille **bloquante**. Une
 * dépendance du juge absente (`Cannot find module 'axe-core/axe.min.js'`, constaté en
 * vrai) désactivait donc en silence un contrôle qu'un humain avait explicitement voulu
 * bloquant — la forme exacte du faux vert que cet outil existe pour interdire.
 *
 * La règle est celle du reste de l'outil (`requiredCommands`, `uncovered`) : « je n'ai
 * pas pu vérifier » ne vaut jamais « vérifié » pour ce que le contrat fait bloquer.
 * Ailleurs on ne bloque pas — rien n'allait bloquer de toute façon, et un faux rouge
 * ferait boucler l'agent sur un défaut qui n'est pas dans son code.
 */
export function siteNonObserve(
  familles: readonly Famille[],
  cfg: SiteConfig,
  raison: string,
  outilAbsent = false,
): CheckResult[] {
  return familles.map((famille) => {
    if (familleBloquante(cfg, famille)) {
      return {
        name: famille,
        status: "failed",
        output:
          `${raison} — or le contrat rend « ${famille} » bloquante. « Je n'ai pas pu vérifier » ne vaut ` +
          `pas « vérifié » : répare l'observation (dépendance du juge, navigateur, page qui ne rend pas), ` +
          `ou retire la règle du contrat par un !approuve.`,
      } satisfies CheckResult;
    }
    return outilAbsent
      ? { name: famille, status: "skipped", reason: "tool-missing", output: raison } satisfies CheckResult
      : { name: famille, status: "warn", output: raison } satisfies CheckResult;
  });
}

/** Un check par famille : rouge s'il y a un constat bloquant, signalé s'il y en a d'autres. */
export function siteChecks(
  observations: SiteObservation[],
  cfg: SiteConfig = {},
  familles: readonly Famille[] = FAMILLES,
): CheckResult[] {
  const constats = evaluateSite(observations, cfg);
  const pages = observations.map((o) => o.page).join(", ");
  return familles.map((famille) => {
    const miens = constats.filter((c) => c.famille === famille);
    if (famille === "a11y") {
      const echecs = observations.filter((o) => o.a11y === null);
      if (echecs.length === observations.length && observations.length) {
        // Même règle qu'au-dessus : axe muet sur TOUTES les pages n'est pas un audit
        // réussi. Si le contrat rend l'accessibilité bloquante, c'est un rouge.
        return siteNonObserve(
          [famille], cfg,
          `audit d'accessibilité impossible : ${echecs.map((o) => `${o.page} (${o.a11yErreur ?? "?"})`).join(" ; ")}`,
          true,
        )[0];
      }
    }
    if (!miens.length) return { name: famille, status: "passed", output: `rien à signaler (${pages})` } satisfies CheckResult;
    const lignes = miens.map((c) => `[${c.bloquant ? "bloquant" : "signalé"}] ${c.regle} sur ${c.page} — ${c.message}`);
    const status = miens.some((c) => c.bloquant) ? "failed" : "warn";
    return { name: famille, status, output: lignes.join("\n") } satisfies CheckResult;
  });
}

// ── L'observation, dans un vrai Chrome ───────────────────────────────────────────

const require = createRequire(import.meta.url);

async function sourceAxe(): Promise<{ axe: string; locale: unknown | null }> {
  const axe = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");
  let locale: unknown | null = null;
  try {
    locale = JSON.parse(await readFile(require.resolve("axe-core/locales/fr.json"), "utf8"));
  } catch { /* messages en anglais : moins lisible, pas moins juste */ }
  return { axe, locale };
}

/**
 * Ouvre chaque page deux fois : en 1280 px (accessibilité, poids, référencement), puis en
 * 375 px (mobile). `null` = aucun navigateur sur la machine.
 */
export async function observeSite(baseUrl: string, cfg: SiteConfig = {}): Promise<SiteObservation[] | null> {
  const executablePath = findChrome();
  if (!executablePath) return null;
  const { axe, locale } = await sourceAxe();
  const attente = cfg.waitMs ?? 1500;

  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const out: SiteObservation[] = [];
  try {
    for (const chemin of cfg.pages ?? ["/"]) {
      const url = new URL(chemin, baseUrl).href;
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 1280, height: 720 });
        await page.goto(url, { waitUntil: "load", timeout: 30_000 });
        await new Promise((r) => setTimeout(r, attente));

        // axe-core est évalué par le protocole de débogage : la CSP de la page ne s'y
        // applique pas, et rien n'est ajouté au DOM audité.
        let a11y: A11yViolation[] | null = null;
        let a11yErreur: string | undefined;
        try {
          await page.evaluate(axe);
          if (locale) await page.evaluate((l: unknown) => (window as any).axe.configure({ locale: l }), locale).catch(() => {});
          a11y = await page.evaluate(async () => {
            const r = await (window as any).axe.run(document, { resultTypes: ["violations"] });
            return r.violations.map((v: any) => ({
              id: String(v.id),
              impact: v.impact ?? null,
              help: String(v.help),
              helpUrl: String(v.helpUrl),
              cibles: v.nodes.slice(0, 5).map((n: any) => (Array.isArray(n.target) ? n.target.join(" ") : String(n.target))),
              n: v.nodes.length,
            }));
          });
        } catch (e: any) {
          a11yErreur = String(e?.message ?? e).slice(0, 200);
        }

        const faits = await page.evaluate(() => {
          const taille = (e: any) => e.encodedBodySize || e.transferSize || e.decodedBodySize || 0;
          const nav = performance.getEntriesByType("navigation")[0] as any;
          const ressources = performance.getEntriesByType("resource") as any[];
          let poids = nav ? taille(nav) : 0;
          let js = 0;
          let imageMax: { url: string; octets: number } | null = null;
          for (const r of ressources) {
            const t = taille(r);
            poids += t;
            if (r.initiatorType === "script" || /\.m?js(\?|$)/.test(r.name)) js += t;
            if (r.initiatorType === "img" || /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(r.name)) {
              if (!imageMax || t > imageMax.octets) imageMax = { url: r.name, octets: t };
            }
          }
          return {
            title: document.title ?? "",
            description: !!document.querySelector('meta[name="description"][content]:not([content=""])'),
            h1: document.querySelectorAll("h1").length,
            viewport: !!document.querySelector('meta[name="viewport"]'),
            poids, js, imageMax,
          };
        });

        await page.setViewport({ width: 375, height: 667, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        await page.reload({ waitUntil: "load", timeout: 30_000 });
        await new Promise((r) => setTimeout(r, attente));
        const mobile = await page.evaluate(() => {
          // La largeur de la zone de mise en page, pas `innerWidth` : quand le contenu
          // déborde, le Chrome mobile dézoome pour tout montrer, et `innerWidth` suit le
          // contenu — le débordement deviendrait invisible à la mesure.
          const vw = document.documentElement.clientWidth || window.innerWidth;
          const decrire = (el: Element) => {
            const id = el.id ? `#${el.id}` : "";
            const cls = typeof (el as HTMLElement).className === "string"
              ? (el as HTMLElement).className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join("")
              : "";
            return `${el.tagName.toLowerCase()}${id}${cls}`;
          };
          const deborde: string[] = [];
          const tous = Array.from(document.querySelectorAll("body *")).slice(0, 5000);
          for (const el of tous) {
            if (deborde.length >= 3) break;
            const r = el.getBoundingClientRect();
            if (r.right <= vw + 1) continue;
            const parent = el.parentElement;
            // L'ORIGINE du débordement, pas toute sa descendance.
            if (parent && parent !== document.body && parent.getBoundingClientRect().right > vw + 1) continue;
            deborde.push(decrire(el));
          }
          return { largeurContenu: document.documentElement.scrollWidth, largeurEcran: vw, deborde };
        });

        out.push({ page: chemin, a11y, a11yErreur, ...faits, ...mobile });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return out;
}

/** Les contrôles de site, au format des autres checks. */
export async function runSiteChecks(
  baseUrl: string,
  cfg: SiteConfig = {},
  familles: readonly Famille[] = FAMILLES,
): Promise<CheckResult[]> {
  let obs: SiteObservation[] | null;
  try {
    obs = await observeSite(baseUrl, cfg);
  } catch (e: any) {
    // Deux causes opposées passent ici — une page que Chrome ne sait pas ouvrir (défaut
    // du SITE) et une dépendance du juge absente (défaut de son INSTALLATION) — et on ne
    // sait pas les distinguer d'ici. `siteNonObserve` tranche sur ce qui compte : ce que
    // le contrat a rendu bloquant ne peut pas être éteint par une impossibilité d'observer.
    return siteNonObserve(familles, cfg, `contrôles de site impossibles : ${String(e?.message ?? e).slice(0, 300)}`);
  }
  if (!obs) {
    return siteNonObserve(familles, cfg, "aucun Chrome/Edge trouvé (définis HERMES_CHROME=<chemin>)", true);
  }
  return siteChecks(obs, cfg, familles);
}
