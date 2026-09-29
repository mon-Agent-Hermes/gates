import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decouper, ecrirePreuves, lirePreuves, nomDeFichier, sha256, TRANCHES_MAX } from "./preuves.js";

describe("preuves — les écrans", () => {
  it("une page est découpée en écrans, et tronquée au-delà du maximum — ce que le manifeste dit", () => {
    expect(decouper(900, 900)).toEqual({ ys: [0], tronquee: false });
    expect(decouper(901, 900)).toEqual({ ys: [0, 900], tronquee: false });
    const long = decouper(900 * (TRANCHES_MAX + 3), 900);
    expect(long.ys).toHaveLength(TRANCHES_MAX);
    expect(long.tronquee).toBe(true);
  });

  it("un chemin de page quelconque donne un nom de fichier sûr", () => {
    expect(nomDeFichier("/", "mobile", 0)).toBe("accueil--mobile--01.png");
    expect(nomDeFichier("/a/../b?x=1", "bureau", 9)).toBe("a_b_x_1--bureau--10.png");
  });
});

describe("preuves — la relecture par le juge", () => {
  const dossier = () => mkdtemp(join(tmpdir(), "gates-preuves-"));

  it("une image modifiée après la capture est une erreur nommée", async () => {
    const d = await dossier();
    await writeFile(join(d, "a.png"), "original");
    await ecrirePreuves(d, {
      ecrans: [{ page: "/", vue: "mobile", hauteurPage: 10, tronquee: false, tranches: [{ fichier: "a.png", sha256: sha256(Buffer.from("original")), y: 0 }] }],
      traces: [], doc: null,
    });
    expect("erreur" in (await lirePreuves(d))).toBe(false);
    await writeFile(join(d, "a.png"), "remplacée");
    expect(await lirePreuves(d)).toMatchObject({ erreur: expect.stringMatching(/empreinte divergente : a\.png/) });
  });

  it("un nom de fichier qui sort du dossier est refusé", async () => {
    const d = await dossier();
    await ecrirePreuves(d, {
      ecrans: [{ page: "/", vue: "mobile", hauteurPage: 10, tronquee: false, tranches: [{ fichier: "../secret.png", sha256: "x", y: 0 }] }],
      traces: [], doc: null,
    });
    expect(await lirePreuves(d)).toMatchObject({ erreur: expect.stringMatching(/refusé/) });
  });

  it("aucune preuve du tout : « rien à juger », pas un jugement sur du vide", async () => {
    const d = await dossier();
    await ecrirePreuves(d, { ecrans: [], traces: [], doc: null });
    expect(await lirePreuves(d)).toMatchObject({ erreur: expect.stringMatching(/rien à juger/) });
  });

  it("des traces seules suffisent — un projet sans écran se juge aussi", async () => {
    const d = await dossier();
    await ecrirePreuves(d, { ecrans: [], traces: [{ id: "aide", status: "passed", trace: "$ x --help" }], doc: null });
    expect("erreur" in (await lirePreuves(d))).toBe(false);
  });
});
