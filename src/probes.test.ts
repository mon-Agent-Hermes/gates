import { describe, it, expect } from "vitest";
import { runProbe, runProbes, aggregateProbes, textMatches, type Probe } from "./probes.js";
import { findChrome } from "./page-check.js";

// Commande node portable (cmd.exe et sh) : écrit un fichier dans $TMP et logue.
// `process.argv[1]` vaut le premier argument positionnel après `-e` (ici $TMP).
const WRITE_OK =
  `node -e "require('fs').writeFileSync(require('path').join(process.argv[1],'out.txt'),'ok');console.log('Configuration ecrite')" $TMP`;

describe("textMatches", () => {
  it("regex slashée ou sous-chaîne littérale", () => {
    expect(textMatches("/Config.*ecrite/", "Configuration ecrite")).toBe(true);
    expect(textMatches("ecrite", "Configuration ecrite")).toBe(true);
    expect(textMatches("absent", "Configuration ecrite")).toBe(false);
  });
});

describe("probe cli", () => {
  it("effet observé : code 0, stdout attendu, fichier créé dans $TMP", async () => {
    const p: Probe = {
      id: "init-cree-la-config", criterion: "AC-3", kind: "cli",
      run: WRITE_OK,
      expect: { exitCode: 0, stdout: "/Configuration ecrite/", files: ["$TMP/out.txt"] },
    };
    const r = await runProbe(p, 30_000);
    expect(r.status, r.output).toBe("passed");
    expect(r.criterion).toBe("AC-3");
  });

  it("mauvais code de sortie → échec qui NOMME la probe et la cause", async () => {
    const p: Probe = {
      id: "init-doit-sortir-0", kind: "cli",
      run: `node -e "process.exit(3)"`,
      expect: { exitCode: 0 },
    };
    const r = await runProbe(p, 30_000);
    expect(r.status).toBe("failed");
    expect(r.id).toBe("init-doit-sortir-0");
    expect(r.output).toMatch(/code de sortie 3/);
  });

  it("fichier attendu absent → échec", async () => {
    const p: Probe = {
      id: "produit-un-fichier", kind: "cli",
      run: `node -e "process.exit(0)"`,
      expect: { exitCode: 0, files: ["$TMP/jamais.txt"] },
    };
    const r = await runProbe(p, 30_000);
    expect(r.status).toBe("failed");
    expect(r.output).toMatch(/fichier attendu absent/);
  });
});

describe("probe artifact", () => {
  it("fichier produit et assez gros → passe", async () => {
    const p: Probe = {
      id: "genere-le-blob", criterion: "AC-4", kind: "artifact",
      run: `node -e "require('fs').writeFileSync(require('path').join(process.argv[1],'blob.bin'),Buffer.alloc(200))" $TMP`,
      file: "$TMP/blob.bin",
      expect: { minBytes: 100 },
    };
    const r = await runProbe(p, 30_000);
    expect(r.status, r.output).toBe("passed");
  });

  it("artefact trop petit → échec", async () => {
    const p: Probe = {
      id: "blob-trop-petit", kind: "artifact",
      run: `node -e "require('fs').writeFileSync(require('path').join(process.argv[1],'blob.bin'),Buffer.alloc(5))" $TMP`,
      file: "$TMP/blob.bin",
      expect: { minBytes: 100 },
    };
    const r = await runProbe(p, 30_000);
    expect(r.status).toBe("failed");
    expect(r.output).toMatch(/trop petit/);
  });
});

describe("runProbe hors contexte", () => {
  it("http/browser en autonome → skipped (exigent l'app partagée)", async () => {
    for (const kind of ["http", "browser"]) {
      const r = await runProbe({ id: `x-${kind}`, kind } as Probe);
      expect(r.status).toBe("skipped");
      expect(r.output).toMatch(/app partagée|runProbes/);
    }
  });

  it("process sans url ni logMatch → failed (aucun signal de disponibilité)", async () => {
    const r = await runProbe({ id: "demon-muet", kind: "process", start: "node -e \"0\"" } as Probe);
    expect(r.status).toBe("failed");
    expect(r.output).toMatch(/aucun signal/);
  });

  it("kind inconnu → skipped", async () => {
    const r = await runProbe({ id: "bizarre", kind: "quantique" } as Probe);
    expect(r.status).toBe("skipped");
  });
});

describe("aggregateProbes", () => {
  it("un failed rend le check failed ; sinon passed ; tout skipped → skipped", () => {
    expect(aggregateProbes([
      { id: "a", status: "passed", output: "" },
      { id: "b", status: "failed", output: "boom" },
    ]).status).toBe("failed");
    expect(aggregateProbes([{ id: "a", status: "passed", output: "" }]).status).toBe("passed");
    expect(aggregateProbes([{ id: "a", status: "skipped", output: "" }]).status).toBe("skipped");
  });
});

// ── Harnais serveur : de vrais serveurs Node (aucun Chrome requis) ──────────────
const HTTP_SERVER =
  `node -e "require('http').createServer((q,s)=>{if(q.url==='/health'){s.writeHead(200);s.end('ok')}else if(q.url==='/tasks'){s.writeHead(200,{'content-type':'application/json'});s.end('[]')}else{s.writeHead(404);s.end('nope')}}).listen(39281,'127.0.0.1')"`;

describe("probe http (contre l'app démarrée par le harnais)", () => {
  it("route servie → passe ; route absente (404) → échec, une seule app démarrée", async () => {
    const app = { start: HTTP_SERVER, url: "http://127.0.0.1:39281/health", readyTimeoutMs: 8000 };
    const probes: Probe[] = [
      { id: "liste-des-taches", criterion: "AC-7", kind: "http", request: { method: "GET", path: "/tasks" }, expect: { statusNot: [404, 500], bodyMatch: "/\\[\\]/" } },
      { id: "route-absente", kind: "http", request: { path: "/nope" }, expect: { statusNot: [404] } },
    ];
    const results = await runProbes(probes, { app });
    expect(results[0].status, results[0].output).toBe("passed");
    expect(results[1].status).toBe("failed");
    expect(results[1].output).toMatch(/404/);
  }, 30_000);

  it("probe http sans app déclarée → failed (pas de faux vert)", async () => {
    const results = await runProbes([{ id: "x", kind: "http", request: { path: "/" } }]);
    expect(results[0].status).toBe("failed");
    expect(results[0].output).toMatch(/aucun app/);
  });
});

describe("probe process (le démon tient debout)", () => {
  it("démon qui logue READY → passe", async () => {
    const p: Probe = {
      id: "demon-up", kind: "process",
      start: `node -e "console.log('READY server up');setInterval(()=>{},1000)"`,
      logMatch: "READY", readyTimeoutMs: 8000,
    };
    const r = await runProbe(p);
    expect(r.status, r.output).toBe("passed");
  }, 15_000);

  it("démon qui ne signale jamais → failed avant délai", async () => {
    const p: Probe = {
      id: "demon-muet", kind: "process",
      start: `node -e "setInterval(()=>{},1000)"`,
      logMatch: "JAMAIS", readyTimeoutMs: 1500,
    };
    const r = await runProbe(p);
    expect(r.status).toBe("failed");
    expect(r.output).toMatch(/ne s'est pas levé/);
  }, 10_000);
});

// ── Probe browser : un clic déclenche le rendu (garde Chrome) ───────────────────
// La page ne dessine RIEN au chargement ; un clic sur #b dessine (fillRect). Prouve
// que les `actions` de la probe sont bien jouées avant l'observation.
const BTN_SERVER =
  `node -e "require('http').createServer((q,s)=>{s.writeHead(200,{'content-type':'text/html'});s.end('<canvas></canvas><button id=\\'b\\'>go</button><script>document.querySelector(\\'button\\').onclick=function(){document.querySelector(\\'canvas\\').getContext(\\'2d\\').fillRect(0,0,9,9)}</script>')}).listen(39283,'127.0.0.1')"`;

const hasChrome = findChrome() !== null;

describe.skipIf(!hasChrome)("probe browser (actions jouées avant observation)", () => {
  it("avec clic → dessine → passe ; sans clic → écran noir → échec", async () => {
    const app = { start: BTN_SERVER, url: "http://127.0.0.1:39283/", readyTimeoutMs: 8000 };
    const probes: Probe[] = [
      { id: "clic-dessine", criterion: "AC-1", kind: "browser", path: "/", actions: [{ click: "#b" }, { wait: 300 }], expect: { requireCanvas: true, minDrawCalls: 1 } },
      { id: "sans-clic", kind: "browser", path: "/", expect: { requireCanvas: true, minDrawCalls: 1 } },
    ];
    const results = await runProbes(probes, { app });
    expect(results[0].status, results[0].output).toBe("passed");
    expect(results[1].status).toBe("failed");
    expect(results[1].output).toMatch(/ne rend RIEN/);
  }, 60_000);
});
