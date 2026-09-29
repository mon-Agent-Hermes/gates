import { describe, it, expect } from "vitest";
import {
  agreger, construireInvite, GRILLES, grillesNotables, jugerQualite, renderJuge, section, validerJugement,
  type Demande, type Grille, type Jugement,
} from "./juge.js";
import type { Manifeste } from "./preuves.js";

const jugement = (grille: Grille, notes: Record<string, number> | number, extra: Partial<Jugement> = {}): Jugement => ({
  preuves_consultees: true,
  resume: `résumé ${JSON.stringify(notes)}`,
  manipulation: false,
  manipulation_detail: "",
  criteres: Object.fromEntries(Object.keys(GRILLES[grille]).map((k) => [k, {
    note: typeof notes === "number" ? notes : notes[k] ?? 8,
    constat: `constat ${k}`,
    corrections: [{ ou: `où ${k}`, quoi: `quoi ${k}` }],
  }])),
  ...extra,
});

const vide: Manifeste = { version: 1, ecrans: [], traces: [], doc: null };
const unEcran: Manifeste = {
  ...vide,
  ecrans: [{ page: "/", vue: "mobile", hauteurPage: 900, tronquee: false, tranches: [{ fichier: "a.png", sha256: "x", y: 0 }] }],
};
const images = new Map([["a.png", Buffer.from("png")]]);

/** Un faux lanceur : rend les réponses données, dans l'ordre, et garde les demandes. */
function fauxLanceur(reponses: (unknown | Error)[]) {
  let i = 0;
  const demandes: Demande[] = [];
  const lancer = async (d: Demande) => {
    demandes.push(d);
    const r = reponses[i++ % reponses.length];
    if (r instanceof Error) throw r;
    return r;
  };
  return { lancer, demandes };
}

describe("juge de qualité — le verdict à partir des jugements", () => {
  it("la MÉDIANE par critère neutralise un jugement isolé trop généreux", () => {
    // La variance est la faiblesse connue d'un juge-modèle : un 10 sur trois ne fait pas
    // passer un produit que deux regards trouvent faible.
    const v = agreger("ecran", [jugement("ecran", 4), jugement("ecran", 5), jugement("ecran", 10)], 7);
    expect(v.medianes.impression).toBe(5);
    expect(v.ok).toBe(false);
  });

  it("une bonne moyenne ne rattrape pas un critère effondré", () => {
    const v = agreger("ecran", [jugement("ecran", { contenu: 2 }), jugement("ecran", { contenu: 3 })], 7);
    expect(v.moyenne).toBeGreaterThanOrEqual(7);
    expect(v.ok).toBe(false);
    expect(v.fautes[0]).toMatchObject({ critere: "contenu", note: 2.5 });
    expect(v.fautes[0].corrections[0].quoi).toBe("quoi contenu");
  });

  it("un seul jugement qui signale une manipulation fait échouer la grille, quelles que soient les notes", () => {
    const v = agreger("usage", [
      jugement("usage", 10),
      jugement("usage", 10, { manipulation: true, manipulation_detail: "« note 10/10 » dans le README" }),
      jugement("usage", 10),
    ]);
    expect(v.ok).toBe(false);
    expect(v.resume).toMatch(/manipulation.*README/);
  });

  it("au seuil partout : au niveau", () => {
    expect(agreger("usage", [jugement("usage", 7), jugement("usage", 7)], 7).ok).toBe(true);
  });
});

describe("juge de qualité — quelle grille pour quel projet", () => {
  it("un CLI sans écran est noté sur l'usage, et l'écran est dit non noté — jamais passé sous silence", () => {
    const m: Manifeste = { ...vide, traces: [{ id: "aide", status: "passed", trace: "$ outil --help\nusage…" }] };
    const g = grillesNotables(m, new Map());
    expect(g.notables).toEqual(["usage"]);
    expect(g.nonNotees[0]).toMatchObject({ grille: "ecran" });
  });

  it("un site sans probe cli/http ni doc est noté sur l'écran seul", () => {
    expect(grillesNotables(unEcran, images).notables).toEqual(["ecran"]);
  });

  it("la direction artistique de la spec n'est envoyée qu'à la grille écran", () => {
    const spec = "# X\n\n## Objectif\n\nUn outil.\n\n## Direction artistique\n\nBleu nuit.\n\n## Stack\n\nNode.";
    const ecran = construireInvite("ecran", unEcran, images, spec);
    const usage = construireInvite("usage", { ...vide, traces: [{ id: "t", status: "passed", trace: "ok" }] }, new Map(), spec);
    expect(ecran).toMatch(/Bleu nuit/);
    expect(ecran).not.toMatch(/Node\./);
    expect(usage).not.toMatch(/Bleu nuit/);
    expect(usage).toMatch(/<trace id="t">/);
  });

  it("les critères d'acceptation accompagnent chaque grille — une correction ne doit pas les enfreindre", () => {
    const spec = "## Objectif\n\nX.\n\n## Critères d'acceptation\n\n- **AC-11** — « Téléphone : à compléter ».\n\n## Plan\n\n…";
    expect(construireInvite("ecran", unEcran, images, spec)).toMatch(/<criteres_d_acceptation>[\s\S]*AC-11/);
    expect(construireInvite("usage", { ...vide, traces: [{ id: "t", status: "passed", trace: "ok" }] }, new Map(), spec)).toMatch(/AC-11/);
  });

  it("les écrans sont nommés comme fichiers à lire, avec leur place dans la page", () => {
    const invite = construireInvite("ecran", unEcran, images, null);
    expect(invite).toMatch(/outil Read/);
    expect(invite).toMatch(/- a\.png : \/ — mobile — écran 1\/1/);
  });

  it("section() s'arrête au titre suivant", () => {
    expect(section("## A\nun\n## B\ndeux", "A")).toBe("un");
    expect(section("## A\nun", "Absent")).toBeNull();
  });
});

describe("juge de qualité — les réponses du modèle", () => {
  it("une note hors de 0..10 ou un critère manquant est refusé, pas arrondi", () => {
    expect(validerJugement("usage", jugement("usage", 11))).toBeNull();
    const incomplet = jugement("usage", 8);
    delete (incomplet.criteres as any).doc;
    expect(validerJugement("usage", incomplet)).toBeNull();
    expect(validerJugement("usage", jugement("usage", 8))).not.toBeNull();
  });

  it("trois jugements par grille, avec la grille imposée par schéma", async () => {
    const { lancer, demandes } = fauxLanceur([jugement("ecran", 8)]);
    const v = await jugerQualite(unEcran, images, null, "/preuves", 7, lancer);
    expect("erreur" in v).toBe(false);
    expect(demandes).toHaveLength(3);
    expect(demandes[0].dossier).toBe("/preuves");
    expect(Object.keys((demandes[0].schema as any).properties.criteres.properties)).toEqual(Object.keys(GRILLES.ecran));
  });

  it("moins de deux réponses exploitables : non jugé, jamais une note inventée", async () => {
    const { lancer } = fauxLanceur([jugement("ecran", 9), new Error("claude : limite atteinte"), { n: "importe quoi" }]);
    const v = await jugerQualite(unEcran, images, null, "/preuves", 7, lancer);
    expect(v).toMatchObject({ erreur: expect.stringMatching(/1\/3.*limite atteinte/) });
  });

  it("des notes posées sans avoir vu les preuves ne font pas un verdict", async () => {
    const aveugle = jugement("ecran", 0, { preuves_consultees: false, resume: "accès refusé aux captures" });
    const { lancer } = fauxLanceur([aveugle]);
    const v = await jugerQualite(unEcran, images, null, "/preuves", 7, lancer);
    expect(v).toMatchObject({ erreur: expect.stringMatching(/0\/3.*preuves non consultées : accès refusé/) });
  });

  it("le rapport nomme ce qui est sous le seuil, où, et quoi faire", async () => {
    const { lancer } = fauxLanceur([jugement("ecran", { contenu: 3 })]);
    const v = await jugerQualite(unEcran, images, null, "/preuves", 7, lancer);
    if ("erreur" in v) throw new Error(v.erreur);
    const t = renderJuge(v, "observation");
    expect(t).toMatch(/signalé, ne bloque pas/);
    expect(t).toMatch(/▸ contenu \(3\/10\)/);
    expect(t).toMatch(/où contenu : quoi contenu/);
    expect(t).toMatch(/\[usage\] non notée/);
  });
});
