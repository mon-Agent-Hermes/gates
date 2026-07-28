/**
 * Endpoints DÉCLARÉS par une spec — pour que le garde-fou « smoke » vérifie que
 * l'application livrée SERT vraiment ses fonctionnalités, pas seulement qu'elle
 * démarre.
 *
 * Angle mort constaté au run du 2026-07-25 : le smoke n'interrogeait que `GET /`
 * (racine de santé) et les tests visaient une application JETABLE reconstruite dans
 * le test → tsc, tests et smoke verts alors que `GET /tasks` répondait 404 (routeur
 * jamais monté sur la racine de composition). Un projet peut donc « passer » sans
 * servir sa feature. On extrait les chemins déclarés pour les interroger réellement.
 *
 * Prudence délibérée (zéro faux positif) :
 *  - on ne retient que les endpoints déclarés en **GET** (ou HEAD), plus les URLs
 *    d'exemples (`curl http://…`) : une route POST-only répondrait 404 à un GET dans
 *    la plupart des frameworks (Express n'envoie pas 405) → on ne la sonde jamais ;
 *  - on écarte tout chemin PARAMÉTRÉ (`/tasks/:id`, `/tasks/{id}`) : un 404 y est
 *    légitime (l'identifiant n'existe pas) ;
 *  - on écarte la racine `/` (déjà couverte par le smoke de santé) et les chemins
 *    qui ressemblent à un fichier (`/favicon.ico`).
 *
 * Pur → testable sans réseau ni LLM.
 */

const DYNAMIC = /[:{}<>[\]*]/;

/** Un segment paramétré (`:id`, `{id}`, `<id>`, `[id]`, `*`) rend le chemin non sondable. */
function isProbeable(path: string): boolean {
  if (!path.startsWith("/") || path === "/") return false;
  if (DYNAMIC.test(path)) return false;
  const last = path.split("/").pop() ?? "";
  if (/\.[a-z0-9]{1,5}$/i.test(last)) return false; // /favicon.ico, /index.html…
  return true;
}

/** Normalise un chemin : sans query/ancre, sans ponctuation ni `/` final parasites. */
function normalizePath(raw: string): string {
  let p = raw.split(/[?#]/)[0].replace(/[.,;:!]+$/, "").replace(/[)\]}'"`]+$/, "");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p;
}

/**
 * Chemins à interroger, extraits d'un texte de spec (ordre d'apparition, dédupliqués).
 * `max` borne le coût du smoke (chaque chemin = une requête HTTP).
 */
export function extractEndpoints(text: string, max = 6): string[] {
  if (!text) return [];
  const found: string[] = [];
  const push = (p: string) => {
    const n = normalizePath(p);
    if (isProbeable(n) && !found.includes(n)) found.push(n);
  };

  // `GET /tasks`, `HEAD /health` — méthodes de LECTURE uniquement (cf. en-tête).
  for (const m of text.matchAll(/\b(?:GET|HEAD)\s+(\/[^\s`"'|]*)/gi)) push(m[1]);

  // URLs d'exemple : `curl http://localhost:3000/tasks`, `http://127.0.0.1:8000/health`.
  // Hôte LOCAL uniquement : une URL de documentation (https://expressjs.com/en/guide)
  // n'a rien à voir avec l'appli et ne doit pas devenir un chemin à interroger.
  const LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i;
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s`"'|)]+/gi)) {
    try {
      const u = new URL(m[0]);
      if (LOCAL.test(u.hostname)) push(u.pathname);
    } catch {
      /* URL bancale : ignorée */
    }
  }

  return found.slice(0, Math.max(0, max));
}
