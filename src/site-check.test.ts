import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { findChrome } from "./page-check.js";
import {
  BUDGETS_DEFAUT, evaluateSite, runSiteChecks, siteChecks, validateSite, type SiteObservation,
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
