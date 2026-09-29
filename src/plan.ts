import { FAMILLES, REGLES, type Famille } from "./site-check.js";

/**
 * `gates plan` — ce que le contrat fera juger, et ce qu'il ne fera PAS juger.
 *
 * Raison d'être : tant que « ce que le juge sait faire » n'existe que dans un README, un
 * agent le RÉCITE. Et il le récite faux — trois fois en une soirée le 26/09/2026, dont
 * deux pour proposer de retirer une exigence du contrat (« mobile d'abord n'est pas
 * vérifiable », « la couverture resterait rouge »). Les deux étaient fausses, et aucune
 * ne coûtait rien à écrire.
 *
 * Ici, la même question a une réponse qui s'exécute. Une affirmation sur les limites du
 * juge devient une sortie de commande à coller, pas un souvenir à croire.
 *
 * ⚠️ Ce module ne lance RIEN. Il lit le contrat, il ne démarre pas d'app, il n'ouvre pas
 * de navigateur, il ne touche pas au réseau. « Jugé » veut donc dire *le contrat le
 * demande*, jamais *ça passera* : un contrôle prévu peut encore être ignoré à
 * l'exécution (Chrome absent, smoke rouge). Le plan le dit en toutes lettres à la fin.
 */

/** Le contrat, vu par le plan. Volontairement structurel : pas d'import depuis `cli.ts`. */
export type ContratPlanifiable = {
  commands?: Record<string, string>;
  requiredCommands?: string[];
  deliverables?: string[];
  entry?: string | string[];
  roots?: string[];
  app?: { start?: string; url?: string; paths?: string[]; page?: unknown };
  probes?: { id: string; kind?: string; criterion?: string }[];
  coverage?: { requireExecuted?: string[]; runtime?: string };
  site?: { bloquant?: string[] };
  docs?: unknown;
  observation?: string[];
  qualite?: { seuil?: number };
  specFile?: string;
};

export type LignePlan = { nom: string; juge: boolean; detail: string };

export type Plan = {
  lignes: LignePlan[];
  /** Critères lus dans la spec, et ceux qu'aucune probe ne couvre. */
  criteres: { total: number; sansProbe: string[]; fichier: string; lisible: boolean };
};

/** Une famille est-elle bloquante ? `site.bloquant` accepte la famille ou `famille:règle`. */
function bloquante(famille: Famille, bloquant: string[]): boolean {
  return bloquant.some((r) => r === famille || r.startsWith(`${famille}:`));
}

export function construirePlan(
  cfg: ContratPlanifiable,
  spec: { fichier: string; lisible: boolean; criteres: string[] },
): Plan {
  const l: LignePlan[] = [];
  const juge = (nom: string, detail: string) => l.push({ nom, juge: true, detail });
  const non = (nom: string, detail: string) => l.push({ nom, juge: false, detail });
  const obs = new Set(cfg.observation ?? []);

  const commandes = Object.entries(cfg.commands ?? {});
  if (!commandes.length) non("commandes", "aucune commande déclarée");
  for (const [nom] of commandes) {
    const marques = [
      (cfg.requiredCommands ?? []).includes(nom) ? "requise" : null,
      obs.has(nom) ? "en observation (signalée, ne bloque pas)" : null,
    ].filter(Boolean);
    juge(nom, `commande déclarée${marques.length ? ` — ${marques.join(", ")}` : ""}`);
  }

  const livrables = cfg.deliverables ?? [];
  if (livrables.length) juge("deliverables", `${livrables.length} fichier(s) attendu(s)`);
  else non("deliverables", "aucun « deliverables » au contrat");

  const entrees = cfg.entry === undefined ? [] : Array.isArray(cfg.entry) ? cfg.entry : [cfg.entry];
  const racines = (cfg.roots ?? ["src"]).join(", ");
  juge(
    "assembly",
    entrees.length
      ? `depuis ${entrees.join(", ")} (racines : ${racines})`
      : `point d'entrée NON déclaré, il sera deviné (index.html, sinon src/main.*) — racines : ${racines}`,
  );

  const app = cfg.app ?? {};
  if (app.start && app.url) juge("smoke", `« ${app.start} » puis ${app.url}`);
  else non("smoke", "il faut « app.start » ET « app.url » au contrat");

  const probes = cfg.probes ?? [];
  if (probes.length) {
    const parKind = new Map<string, number>();
    for (const p of probes) parKind.set(p.kind ?? "?", (parKind.get(p.kind ?? "?") ?? 0) + 1);
    const detail = [...parKind].map(([k, n]) => `${n} ${k}`).join(", ");
    juge("probes", `${probes.length} probe(s) : ${detail}`);
  } else {
    non("probes", "aucune probe déclarée — rien n'observe l'artefact");
  }

  // Le cœur de ce que le plan sert à dire : sans section « site », quatre familles
  // entières sont hors jeu, et c'est l'omission la plus facile à ne pas voir.
  const siteDeclare = cfg.site !== undefined || cfg.app?.page !== undefined;
  const bloquant = cfg.site?.bloquant ?? [];
  for (const f of FAMILLES) {
    if (!siteDeclare) non(f, "pas de section « site » au contrat");
    else if (obs.has(f)) juge(f, "en observation (signalée, ne bloque pas)");
    else juge(f, bloquante(f, bloquant) ? "BLOQUANT" : "signalé, ne bloque pas");
  }

  const req = cfg.coverage?.requireExecuted ?? [];
  if (req.length) juge("coverage", `runtime « ${cfg.coverage?.runtime ?? "node"} », exige ${req.join(", ")}`);
  else non("coverage", "aucun « requireExecuted » déclaré");

  if (!spec.lisible) non("spec-coverage", `${spec.fichier} illisible ou absent`);
  else if (!spec.criteres.length) non("spec-coverage", `aucun « AC-n » dans ${spec.fichier}`);
  else juge("spec-coverage", `${spec.criteres.length} critère(s) dans ${spec.fichier}`);

  if (cfg.docs !== undefined) juge("docs", "section « docs » déclarée");
  else non("docs", "aucune section « docs » au contrat");

  // Le juge de qualité ne tourne pas dans `check` : c'est `gates juge`, dans un job CI à
  // part (il appelle un modèle). Il est prévu pour tout projet ; ce qu'il pourra noter
  // dépend des preuves que le contrat permet de recueillir.
  const grilles = [
    siteDeclare ? "écran (captures de la page)" : null,
    probes.some((p) => p.kind === "cli" || p.kind === "http") || cfg.docs !== undefined ? "usage (traces des probes cli/http, doc)" : null,
  ].filter(Boolean);
  if (grilles.length) juge("qualite", `par « gates juge », seuil ${cfg.qualite?.seuil ?? 7}/10 — grilles : ${grilles.join(", ")}`);
  else non("qualite", "aucune preuve à recueillir : ni page déclarée, ni probe cli/http, ni doc");

  const couverts = new Set(probes.map((p) => p.criterion).filter((c): c is string => !!c));
  return {
    lignes: l,
    criteres: {
      total: spec.criteres.length,
      sansProbe: spec.criteres.filter((c) => !couverts.has(c)),
      fichier: spec.fichier,
      lisible: spec.lisible,
    },
  };
}

export function renderPlan(plan: Plan): string {
  const out: string[] = ["Plan de vérification — rien n'a été exécuté.", ""];
  const large = Math.max(...plan.lignes.map((x) => x.nom.length), 12);
  const bloc = (titre: string, lignes: LignePlan[], icone: string) => {
    out.push(titre);
    if (!lignes.length) out.push("  (aucun)");
    for (const x of lignes) out.push(`  ${icone} ${x.nom.padEnd(large)}  ${x.detail}`);
    out.push("");
  };

  bloc("Ce qui sera jugé", plan.lignes.filter((x) => x.juge), "✓");
  bloc("Ce qui ne sera PAS jugé", plan.lignes.filter((x) => !x.juge), "–");

  if (plan.criteres.lisible && plan.criteres.total) {
    out.push(
      plan.criteres.sansProbe.length
        ? `⚠️ ${plan.criteres.sansProbe.length} critère(s) sans aucune probe : ${plan.criteres.sansProbe.join(", ")} — ils compteront comme des ÉCHECS.`
        : `Les ${plan.criteres.total} critère(s) de ${plan.criteres.fichier} ont chacun au moins une probe.`,
      "",
    );
  }

  out.push("Règles que porte chaque famille de site");
  out.push(`  a11y     toute règle d'axe-core (a11y:image-alt, a11y:label, a11y:color-contrast…) —`);
  out.push(`           seules les violations « serious » et « critical » peuvent bloquer`);
  for (const [f, regles] of Object.entries(REGLES)) {
    out.push(`  ${f.padEnd(8)} ${regles.map((r) => `${f}:${r}`).join(", ")}`);
  }
  out.push("");
  out.push("« Jugé » veut dire : le contrat le demande. Pas : ça passera, ni même que ça tournera —");
  out.push("un contrôle prévu peut encore être ignoré à l'exécution (Chrome absent, smoke rouge).");
  return out.join("\n");
}
