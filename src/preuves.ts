import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findChrome } from "./page-check.js";

/**
 * Les PREUVES du juge de qualité (`gates juge`) — ce qu'un utilisateur verrait du projet.
 *
 * Ce n'est pas un check : rien ici ne change le verdict. `gates check --preuves <dossier>`
 * les recueille pendant la vérification, quel que soit le type de projet :
 *
 *  - des ÉCRANS, quand le projet en a un (site, app web, jeu) : la page photographiée en
 *    mobile et en bureau, écran par écran ;
 *  - des TRACES, quand ses probes en produisent : la commande et sa sortie, la requête et
 *    sa réponse — l'usage d'un CLI, d'une API, d'un service ;
 *  - sa DOC, quand le contrat en déclare une.
 *
 * Le jugement vit AILLEURS, dans un job qui n'exécute aucune ligne du projet : c'est là
 * seulement qu'une clé d'API peut exister. Le manifeste porte l'empreinte de chaque
 * fichier ; il protège le transport entre les deux jobs, pas contre un processus du projet
 * qui réécrirait manifeste et images ensemble avant l'envoi (même limite que `gates-etat`).
 */

export type Vue = { nom: "mobile" | "bureau"; largeur: number; hauteur: number; echelle: number; mobile: boolean };

export const VUES: Vue[] = [
  { nom: "mobile", largeur: 390, hauteur: 844, echelle: 2, mobile: true },
  { nom: "bureau", largeur: 1440, hauteur: 900, echelle: 1, mobile: false },
];

/**
 * Au-delà, l'écran est tronqué — et le manifeste le dit. Une page longue réduite pour tenir
 * dans la limite d'image du modèle devient illisible : une tranche = ce qu'un visiteur voit
 * réellement en faisant défiler.
 */
export const TRANCHES_MAX = 6;
export const DOC_MAX = 12_000;

export type Tranche = { fichier: string; sha256: string; y: number };
export type Ecran = { page: string; vue: Vue["nom"]; hauteurPage: number; tronquee: boolean; tranches: Tranche[] };
export type Trace = { id: string; criterion?: string; status: string; trace: string };
export type Manifeste = { version: 1; ecrans: Ecran[]; traces: Trace[]; doc: { fichier: string; texte: string } | null };

/** Les ordonnées des tranches d'une page de hauteur `h` (pur → testable). */
export function decouper(h: number, hauteurVue: number, max = TRANCHES_MAX): { ys: number[]; tronquee: boolean } {
  const n = Math.max(1, Math.ceil(h / hauteurVue));
  const ys = Array.from({ length: Math.min(n, max) }, (_, i) => i * hauteurVue);
  return { ys, tronquee: n > max };
}

/** Nom de fichier stable et sans caractère exotique, pour un chemin de page quelconque. */
export function nomDeFichier(page: string, vue: string, i: number): string {
  const base = page.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9-]+/g, "_") || "accueil";
  return `${base}--${vue}--${String(i + 1).padStart(2, "0")}.png`;
}

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * Photographie chaque page dans chaque vue. `null` = aucun navigateur sur la machine.
 *
 * La page est d'abord parcourue jusqu'en bas : les images en chargement différé ne se
 * chargent qu'en approchant de l'écran, et une capture sans elles jugerait des trous que
 * le visiteur ne voit jamais. `prefers-reduced-motion` est émulé : une animation d'entrée
 * capturée à mi-course ferait juger un état transitoire.
 */
export async function capturerEcrans(baseUrl: string, pages: string[], dossier: string, attenteMs = 1000): Promise<Ecran[] | null> {
  const executablePath = findChrome();
  if (!executablePath) return null;
  await mkdir(dossier, { recursive: true });
  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const ecrans: Ecran[] = [];
  try {
    for (const chemin of pages) {
      for (const vue of VUES) {
        const page = await browser.newPage();
        try {
          await page.setViewport({ width: vue.largeur, height: vue.hauteur, deviceScaleFactor: vue.echelle, isMobile: vue.mobile, hasTouch: vue.mobile });
          await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
          await page.goto(new URL(chemin, baseUrl).href, { waitUntil: "load", timeout: 30_000 });
          await page.evaluate(async (pas: number) => {
            for (let y = 0; y < document.documentElement.scrollHeight; y += pas) {
              window.scrollTo(0, y);
              await new Promise((r) => setTimeout(r, 120));
            }
            window.scrollTo(0, 0);
            await (document as any).fonts?.ready;
          }, vue.hauteur);
          await new Promise((r) => setTimeout(r, attenteMs));
          const hauteurPage = await page.evaluate(() => document.documentElement.scrollHeight);
          const { ys, tronquee } = decouper(hauteurPage, vue.hauteur);
          const tranches: Tranche[] = [];
          for (const [i, y] of ys.entries()) {
            const h = Math.min(vue.hauteur, hauteurPage - y);
            const png = await page.screenshot({ type: "png", clip: { x: 0, y, width: vue.largeur, height: h }, captureBeyondViewport: true });
            const fichier = nomDeFichier(chemin, vue.nom, i);
            await writeFile(join(dossier, fichier), png);
            tranches.push({ fichier, sha256: sha256(png), y });
          }
          ecrans.push({ page: chemin, vue: vue.nom, hauteurPage, tronquee, tranches });
        } finally {
          await page.close().catch(() => {});
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return ecrans;
}

export async function ecrirePreuves(dossier: string, m: Omit<Manifeste, "version">): Promise<Manifeste> {
  await mkdir(dossier, { recursive: true });
  const manifeste: Manifeste = { version: 1, ...m, doc: m.doc ? { fichier: m.doc.fichier, texte: m.doc.texte.slice(0, DOC_MAX) } : null };
  await writeFile(join(dossier, "manifeste.json"), JSON.stringify(manifeste, null, 2) + "\n");
  return manifeste;
}

/**
 * Relit un dossier de preuves et vérifie chaque empreinte. Une image absente ou différente
 * de celle qu'on a capturée est une erreur nommée, jamais une preuve de moins en silence.
 */
export async function lirePreuves(dossier: string): Promise<{ manifeste: Manifeste; images: Map<string, Buffer> } | { erreur: string }> {
  let m: Manifeste;
  try {
    m = JSON.parse(await readFile(join(dossier, "manifeste.json"), "utf8"));
  } catch {
    return { erreur: `aucun manifeste.json lisible dans ${dossier}` };
  }
  if (m?.version !== 1 || !Array.isArray(m.ecrans) || !Array.isArray(m.traces)) return { erreur: "manifeste.json : format inattendu" };
  const images = new Map<string, Buffer>();
  for (const e of m.ecrans) {
    for (const t of e.tranches ?? []) {
      if (typeof t.fichier !== "string" || !/^[\w.-]+\.png$/.test(t.fichier)) return { erreur: `nom de capture refusé : ${String(t.fichier)}` };
      let b: Buffer;
      try { b = await readFile(join(dossier, t.fichier)); } catch { return { erreur: `capture absente : ${t.fichier}` }; }
      if (sha256(b) !== t.sha256) return { erreur: `empreinte divergente : ${t.fichier}` };
      images.set(t.fichier, b);
    }
  }
  if (!images.size && !m.traces.length && !m.doc) return { erreur: "aucune preuve recueillie (ni écran, ni trace, ni doc) : il n'y a rien à juger" };
  return { manifeste: m, images };
}
