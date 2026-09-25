import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { findChrome } from "./page-check.js";
import {
  BUDGETS_DEFAUT, evaluateSite, runSiteChecks, siteChecks, siteNonObserve, validateSite,
  type SiteObservation,
} from "./site-check.js";

const propre = (over: Partial<SiteObservation> = {}): SiteObservation => ({
  page: "/",
  a11y: [],
  title: "Cabinet Dupont — Accueil",
  description: true,
  h1: 1,
  viewport: true,
  largeurContenu: 375,
  largeurEcran: 375,
  deborde: [],
  poids: 200 * 1024,
  js: 20 * 1024,
  imageMax: null,
  ...over,
});

const imageSansAlt = {
  id: "image-alt", impact: "critical", help: "Les images doivent avoir un texte alternatif",
  helpUrl: "https://dequeuniversity.com/rules/axe/4.13/image-alt", cibles: ["img.hero"], n: 1,
};
const ordreTitres = {
  id: "heading-order", impact: "moderate", help: "Les niveaux de titre ne doivent augmenter que d'un",
  helpUrl: "https://dequeuniversity.com/rules/axe/4.13/heading-order", cibles: ["h4"], n: 1,
};

describe("validateSite — une faute de frappe ne rend pas une règle inopérante", () => {
  it("config absente ou correcte → aucune erreur", () => {
    expect(validateSite(undefined)).toEqual([]);
    expect(validateSite({ pages: ["/", "/contact"], bloquant: ["a11y", "mobile:viewport", "seo:title", "a11y:color-contrast"], budgets: { jsKo: 300 }, waitMs: 500 })).toEqual([]);
  });

  it("clé inconnue, règle inconnue, page sans /, budget négatif → nommés", () => {
    const e = validateSite({ page: ["/"], bloquant: ["mobil", "seo:titre"], pages: ["contact"], budgets: { jsKo: -1, cssKo: 3 } }).join("\n");
    expect(e).toMatch(/clé inconnue « page »/);
    expect(e).toMatch(/règle inconnue « mobil »/);
    expect(e).toMatch(/règle inconnue « seo:titre »/);
    expect(e).toMatch(/« contact » doit commencer par \//);
    expect(e).toMatch(/jsKo/);
    expect(e).toMatch(/clé inconnue « cssKo »/);
  });
});

describe("evaluateSite — tout démarre en observation", () => {
  it("une page propre → aucun constat", () => {
    expect(evaluateSite([propre()])).toEqual([]);
  });

  it("par défaut, RIEN ne bloque : même une violation critique est signalée", () => {
    const c = evaluateSite([propre({ a11y: [imageSansAlt] })]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ regle: "a11y:image-alt", bloquant: false });
    expect(c[0].message).toMatch(/img\.hero/);
  });

  it("`bloquant: [a11y]` ne fait bloquer que les violations graves et critiques", () => {
    const c = evaluateSite([propre({ a11y: [imageSansAlt, ordreTitres] })], { bloquant: ["a11y"] });
    expect(c.find((x) => x.regle === "a11y:image-alt")!.bloquant).toBe(true);
    expect(c.find((x) => x.regle === "a11y:heading-order")!.bloquant).toBe(false);
  });

  it("une règle nommée bloque seule, pas sa famille", () => {
    const o = propre({ viewport: false, largeurContenu: 900, deborde: ["div.bandeau"] });
    const c = evaluateSite([o], { bloquant: ["mobile:viewport"] });
    expect(c.find((x) => x.regle === "mobile:viewport")!.bloquant).toBe(true);
    const scroll = c.find((x) => x.regle === "mobile:scroll-horizontal")!;
    expect(scroll.bloquant).toBe(false);
    expect(scroll.message).toMatch(/900 px/);
    expect(scroll.message).toMatch(/div\.bandeau/);
  });

  it("budgets : des octets contre des seuils fixes, ceux du contrat quand il en donne", () => {
    const lourd = propre({ poids: 3000 * 1024, js: 600 * 1024, imageMax: { url: "/hero.png", octets: 900 * 1024 } });
    expect(evaluateSite([lourd]).map((c) => c.regle).sort()).toEqual(["budgets:image", "budgets:js", "budgets:poids"]);
    expect(evaluateSite([lourd], { budgets: { poidsKo: 4000, jsKo: 700, imageKo: 1000 } })).toEqual([]);
    expect(BUDGETS_DEFAUT.jsKo).toBeGreaterThan(0);
  });

  it("référencement : titre vide, pas de description, deux h1", () => {
    const c = evaluateSite([propre({ title: " ", description: false, h1: 2 })], { bloquant: ["seo:title"] });
    expect(c.map((x) => `${x.regle}:${x.bloquant}`).sort()).toEqual(["seo:description:false", "seo:h1:false", "seo:title:true"]);
  });
});

describe("siteChecks — un check par famille, rouge seulement sur du bloquant", () => {
  it("signalé → warn ; bloquant → failed ; rien → passed", () => {
    const obs = [propre({ a11y: [imageSansAlt], description: false })];
    const par = Object.fromEntries(siteChecks(obs, { bloquant: ["a11y"] }).map((c) => [c.name, c]));
    expect(par.a11y.status).toBe("failed");
    expect(par.a11y.output).toMatch(/\[bloquant\] a11y:image-alt sur \//);
    expect(par.seo.status).toBe("warn");
    expect(par.seo.output).toMatch(/\[signalé\] seo:description/);
    expect(par.mobile.status).toBe("passed");
    expect(par.budgets.status).toBe("passed");
  });

  it("axe n'a pu tourner sur aucune page → a11y ignoré, jamais un faux vert", () => {
    const [a11y] = siteChecks([propre({ a11y: null, a11yErreur: "boom" })], {}, ["a11y"]);
    expect(a11y.status).toBe("skipped");
    expect(a11y.output).toMatch(/boom/);
  });
});

// ── Dans un vrai Chrome ─────────────────────────────────────────────────────────

const hasChrome = findChrome() !== null;

describe.skipIf(!hasChrome)("contrôles de site dans un vrai navigateur", () => {
  it("trouve l'image sans alt, le débordement mobile et le h1 manquant — sans rien bloquer", async () => {
    // Deux pages, parce que les deux règles mobiles s'excluent : SANS balise viewport, le
    // Chrome mobile met la page en page sur 980 px — un bloc de 900 px n'y déborde pas.
    const pages: Record<string, string> = {
      "/": [
        '<!doctype html><html lang="fr"><head><title>Démo</title>',
        '<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>',
        '<img src="/photo.png">',
        '<div class="bandeau" style="width:900px">trop large</div>',
        "</body></html>",
      ].join(""),
      "/sans-viewport": '<!doctype html><html lang="fr"><head><title>Démo</title></head><body><h1>Titre</h1></body></html>',
    };
    const server: Server = createServer((req, res) => {
      if (req.url === "/photo.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.alloc(64));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pages[req.url ?? "/"] ?? pages["/"]);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    try {
      const checks = await runSiteChecks(`http://127.0.0.1:${port}/`, { waitMs: 100, pages: ["/", "/sans-viewport"] });
      const par = Object.fromEntries(checks.map((c) => [c.name, c]));
      expect(par.a11y.status, par.a11y.output).toBe("warn");
      expect(par.a11y.output).toMatch(/image-alt/);
      expect(par.mobile.status, par.mobile.output).toBe("warn");
      expect(par.mobile.output).toMatch(/mobile:viewport sur \/sans-viewport/);
      expect(par.mobile.output).toMatch(/mobile:scroll-horizontal sur \/ — .*div\.bandeau/);
      expect(par.seo.output).toMatch(/0 <h1> sur la page/);
      expect(checks.every((c) => c.status !== "failed")).toBe(true);

      const bloquant = await runSiteChecks(`http://127.0.0.1:${port}/`, { waitMs: 100, bloquant: ["a11y"] });
      expect(bloquant.find((c) => c.name === "a11y")!.status).toBe("failed");
    } finally {
      server.close();
    }
  }, 90_000);
});

/**
 * Quand on n'a PAS PU observer le site.
 *
 * Le défaut trouvé le 25/09/2026 : toute impossibilité d'observer rendait `warn` pour
 * toutes les familles. Or deux causes très différentes passaient par là — une page que
 * Chrome n'ouvre pas (défaut du SITE) et une dépendance du juge qui manque (défaut de
 * son INSTALLATION, constaté en vrai : `Cannot find module 'axe-core/axe.min.js'`).
 *
 * Conséquence : un contrat qui déclare `bloquant: ["a11y"]` — donc approuvé à la main
 * par un humain qui a voulu que ça bloque — était SILENCIEUSEMENT désactivé par une
 * dépendance absente. C'est la forme exacte du faux vert que cet outil existe pour
 * interdire : un contrôle qui a l'air configuré et qui ne peut plus rien rougir.
 *
 * La règle, uniforme et alignée sur le reste de l'outil (`requiredCommands`, `uncovered`) :
 * « je n'ai pas pu vérifier » ne vaut jamais « vérifié » pour ce que le contrat a rendu
 * bloquant. Ailleurs, on ne bloque pas — rien n'allait bloquer de toute façon.
 */
describe("site non observé — « je n'ai pas pu vérifier » ne vaut pas « vérifié »", () => {
  const par = (checks: ReturnType<typeof siteNonObserve>) =>
    Object.fromEntries(checks.map((c) => [c.name, c]));

  it("rien de bloquant au contrat → signalé, jamais un rouge", () => {
    // Le cas courant : les contrôles de site sont en observation. Une impossibilité
    // d'observer ne doit pas rougir un projet dont personne n'a demandé qu'il rougisse.
    const c = par(siteNonObserve(["a11y", "seo"], {}, "Chrome a fermé la page"));
    expect(c.a11y.status).toBe("warn");
    expect(c.seo.status).toBe("warn");
    // La raison reste lisible : sans elle, personne ne sait quoi réparer.
    expect(c.a11y.output).toContain("Chrome a fermé la page");
  });

  it("une FAMILLE bloquante au contrat → rouge, et la sortie dit qu'on n'a pas pu vérifier", () => {
    const c = par(siteNonObserve(["a11y", "seo"], { bloquant: ["a11y"] }, "axe-core introuvable"));
    expect(c.a11y.status).toBe("failed");
    expect(c.a11y.output).toContain("axe-core introuvable");
    // Les autres familles ne sont pas contaminées : seul ce que l'humain a rendu
    // bloquant mérite un rouge.
    expect(c.seo.status).toBe("warn");
  });

  it("une RÈGLE bloquante suffit à rougir sa famille", () => {
    // `bloquant: ["seo:title"]` dit qu'un titre absent doit bloquer. Ne pas avoir pu
    // regarder le titre n'est pas « le titre est là ».
    const c = par(siteNonObserve(["a11y", "seo"], { bloquant: ["seo:title"] }, "page illisible"));
    expect(c.seo.status).toBe("failed");
    expect(c.a11y.status).toBe("warn");
  });

  it("outil absent et rien de bloquant → skipped, avec la cause", () => {
    // Comportement conservé : sans Chrome, on se tait plutôt que de rendre un faux rouge.
    const c = par(siteNonObserve(["a11y"], {}, "aucun Chrome/Edge trouvé", true));
    expect(c.a11y.status).toBe("skipped");
    expect(c.a11y.reason).toBe("tool-missing");
  });

  it("outil absent MAIS une règle bloquante → rouge quand même", () => {
    // Le point qui fait la différence : un contrôle que l'humain a rendu bloquant ne
    // peut pas être éteint par l'absence d'un outil sur la machine du juge. Sinon il
    // suffirait que Chrome disparaisse pour que l'accessibilité cesse d'exister.
    const c = par(siteNonObserve(["a11y"], { bloquant: ["a11y:image-alt"] }, "aucun Chrome/Edge trouvé", true));
    expect(c.a11y.status).toBe("failed");
    expect(c.a11y.output).toContain("Chrome");
  });
});
