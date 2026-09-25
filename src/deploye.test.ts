import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check, parseArgs } from "./cli.js";

/**
 * Juger le site DÉPLOYÉ, pas celui que la CI saurait relancer.
 *
 * Tant que `gates` démarrait lui-même l'app, « vert » voulait dire « vert dans la CI ».
 * Le lien qu'on envoie à un client, lui, n'était jugé par personne : une variable
 * d'environnement absente chez l'hébergeur, un chemin d'asset qui ne tient qu'en local,
 * un build de production différent du build de développement passaient tous sous le juge.
 * `--base-url` ferme cet écart — et ces tests vérifient surtout qu'il ne retombe PAS en
 * douce sur l'app locale, ce qui rendrait un vert qui n'a rien regardé.
 */

type Files = Record<string, string>;

async function projet(files: Files): Promise<{ dir: string; clean: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "gates-deploye-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return { dir, clean: () => rm(dir, { recursive: true, force: true }) };
}

/** Un « déploiement » : un serveur que `gates` n'a pas lancé et ne peut pas arrêter. */
async function deploiement(routes: Record<string, { status: number; body: string }>): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const r = routes[(req.url ?? "/").split("?")[0]];
    if (!r) { res.writeHead(404, { "content-type": "text/plain" }); res.end("absent"); return; }
    res.writeHead(r.status, { "content-type": "text/html; charset=utf-8" });
    res.end(r.body);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    stop: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

const byName = (r: any, name: string) => r.report.checks.find((c: any) => c.name === name);

describe("--base-url : le juge sonde un site déjà servi", () => {
  it("juge le déploiement SANS lancer `app.start`", async () => {
    // Le test qui porte tout : `app.start` écrirait un fichier témoin s'il tournait.
    // Il ne doit pas tourner — sinon on jugerait une seconde app, pas le déploiement.
    const dep = await deploiement({
      "/": { status: 200, body: "<h1>en ligne</h1>" },
      "/tarifs": { status: 200, body: "<h1>tarifs</h1>" },
    });
    const { dir, clean } = await projet({
      "gates.json": JSON.stringify({
        app: { start: "node -e \"require('fs').writeFileSync('TEMOIN','1')\"", url: "http://127.0.0.1:1/", paths: ["/tarifs"] },
      }),
    });
    try {
      const r = await check(dir, { baseUrl: dep.url, only: ["smoke"] });
      if (!r || "configError" in r) throw new Error("config invalide");
      const smoke = byName(r, "smoke");
      expect(smoke.status).toBe("passed");
      // Le rapport doit DIRE ce qui a été jugé — « déployé », pas « démarré ».
      expect(smoke.output).toContain("déployé");
      expect(smoke.output).toContain("/tarifs");
      const temoin = await import("node:fs/promises").then((fs) => fs.readFile(join(dir, "TEMOIN"), "utf8").catch(() => null));
      expect(temoin).toBeNull();
    } finally {
      await dep.stop();
      await clean();
    }
  });

  it("une route déclarée absente du DÉPLOIEMENT rougit", async () => {
    // L'écart qu'on cherche : la route existe en local, pas chez l'hébergeur.
    const dep = await deploiement({ "/": { status: 200, body: "<h1>en ligne</h1>" } });
    const { dir, clean } = await projet({
      "gates.json": JSON.stringify({ app: { paths: ["/tarifs"] } }),
    });
    try {
      const r = await check(dir, { baseUrl: dep.url, only: ["smoke"] });
      if (!r || "configError" in r) throw new Error("config invalide");
      const smoke = byName(r, "smoke");
      expect(smoke.status).toBe("failed");
      expect(smoke.output).toContain("le site déployé répond");
      expect(smoke.output).toContain("/tarifs");
    } finally {
      await dep.stop();
      await clean();
    }
  });

  it("les probes `http` sondent le déploiement, pas localhost", async () => {
    const dep = await deploiement({ "/api/etat": { status: 200, body: '{"ok":true}' } });
    const { dir, clean } = await projet({
      "spec.md": "# Spec\n\n- **AC-1** — l'état est servi.\n",
      "gates.json": JSON.stringify({
        probes: [{
          id: "etat-en-ligne", criterion: "AC-1", kind: "http",
          request: { method: "GET", path: "/api/etat" },
          expect: { statusNot: [404, 500], bodyMatch: '"ok":true' },
        }],
      }),
    });
    try {
      const r = await check(dir, { baseUrl: dep.url, only: ["probes"] });
      if (!r || "configError" in r) throw new Error("config invalide");
      expect(byName(r, "probes").status).toBe("passed");
      expect(r.report.criteria?.["AC-1"].status).toBe("passed");
    } finally {
      await dep.stop();
      await clean();
    }
  });

  it("un déploiement qui n'est pas en ligne se dit — et ne se confond pas avec un échec de démarrage", async () => {
    // Une PR jugée avant la fin du déploiement doit accuser le déploiement absent, pas
    // faire croire que le code est rouge. Le message est ce que l'agent va lire.
    const { dir, clean } = await projet({
      "gates.json": JSON.stringify({ app: { readyTimeoutMs: 800, paths: ["/"] } }),
    });
    try {
      const r = await check(dir, { baseUrl: "http://127.0.0.1:1/", only: ["smoke"] });
      if (!r || "configError" in r) throw new Error("config invalide");
      const smoke = byName(r, "smoke");
      expect(smoke.status).toBe("failed");
      expect(smoke.output).toContain("n'est pas en ligne");
      expect(smoke.output).not.toContain("Commande");
    } finally {
      await clean();
    }
  });

  it("la couverture SUSPEND son verdict au lieu de déclarer mort ce qu'elle n'a pas pu observer", async () => {
    // Le code du déploiement ne s'exécute pas sur la machine du juge. Sans cette note,
    // un run `--base-url` complet déclarerait mort TOUT le projet — un faux rouge qui
    // ferait boucler l'agent sur du code parfaitement vivant.
    const dep = await deploiement({ "/": { status: 200, body: "<h1>en ligne</h1>" } });
    const { dir, clean } = await projet({
      "spec.md": "# Spec\n\n- **AC-1** — la page répond.\n",
      "src/serveur.mjs": "export function servir() { return 'ok'; }\n",
      "gates.json": JSON.stringify({
        app: { paths: ["/"] },
        probes: [{ id: "page", criterion: "AC-1", kind: "http", request: { method: "GET", path: "/" }, expect: { statusNot: [404] } }],
        coverage: { runtime: "node", requireExecuted: ["src/**/*.mjs"] },
      }),
    });
    try {
      const r = await check(dir, { baseUrl: dep.url });
      if (!r || "configError" in r) throw new Error("config invalide");
      const cov = byName(r, "coverage");
      expect(cov.status).not.toBe("failed");
      expect(cov.output).toContain("verdict suspendu");
      expect(cov.output).toContain("déployé");
    } finally {
      await dep.stop();
      await clean();
    }
  });
});

describe("--base-url : une valeur douteuse est une config invalide, jamais un repli", () => {
  const cas: [string, string][] = [
    ["vide", ""],
    ["relative", "/tarifs"],
    ["sans schéma", "mon-site.vercel.app"],
    ["mauvais protocole", "file:///etc/passwd"],
  ];
  for (const [libelle, valeur] of cas) {
    it(`refuse une URL ${libelle} (exit 2)`, async () => {
      const { dir, clean } = await projet({ "gates.json": JSON.stringify({ app: { paths: ["/"] } }) });
      try {
        const r = await check(dir, { baseUrl: valeur });
        expect(r && "configError" in r).toBe(true);
        expect((r as { configError: string }).configError).toContain("--base-url");
      } finally {
        await clean();
      }
    });
  }

  it("`--base-url` sans valeur reste PRÉSENT et invalide — il ne retombe pas sur l'app locale", () => {
    // Le piège : un `?? null` ferait juger localhost en silence, et rendrait vert un run
    // dont personne n'a regardé la cible. Absent = null ; présent mais vide = "".
    expect(parseArgs(["--base-url"]).baseUrl).toBe("");
    expect(parseArgs(["--json"]).baseUrl).toBeNull();
    expect(parseArgs(["--base-url", "https://apercu.vercel.app/"]).baseUrl).toBe("https://apercu.vercel.app/");
  });
});
