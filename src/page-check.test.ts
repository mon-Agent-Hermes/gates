import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import {
  classifyPage, findChrome, chromeCandidates, isRelevantConsoleError, isRelevantRequestFailure,
  runPageCheck, type PageObservation,
} from "./page-check";

// Note de portage : le bloc `derivePageRequirements` (déduction des exigences depuis la
// prose de la spec) vivait dans `plan.ts`, jeté avec l'orchestration. Dans le modèle
// `gates`, ces exigences sont DÉCLARÉES dans `gates.json` (§2.4), plus devinées — ce
// test n'a donc plus d'objet ici.

const obs = (over: Partial<PageObservation> = {}): PageObservation => ({
  url: "http://localhost:5173/",
  title: "App",
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  presentSelectors: [],
  missingSelectors: [],
  canvas: { present: true, width: 1280, height: 720, context: "webgl2" },
  drawCalls: 120,
  ...over,
});

describe("classifyPage (verdict sur des faits observés)", () => {
  it("page saine qui rend → passe", () => {
    expect(classifyPage(obs(), { requireCanvas: true, minDrawCalls: 1 }).passed).toBe(true);
  });

  it("écran noir : la page charge mais rien n'est dessiné → échec", () => {
    const r = classifyPage(obs({ drawCalls: 0 }), { requireCanvas: true, minDrawCalls: 1 });
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toMatch(/ne rend RIEN/);
  });

  it("exception non attrapée → échec", () => {
    const r = classifyPage(obs({ pageErrors: ["x is not a function"] }), {});
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toMatch(/exception/);
  });

  it("module ou asset manquant → échec", () => {
    const r = classifyPage(obs({ failedRequests: ["/assets/main.js → HTTP 404"] }), {});
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toMatch(/404/);
  });

  it("canvas sans contexte ou de taille nulle → échec", () => {
    expect(classifyPage(obs({ canvas: { present: true, width: 1280, height: 720, context: null } }), { requireCanvas: true }).passed).toBe(false);
    expect(classifyPage(obs({ canvas: { present: true, width: 0, height: 0, context: "webgl" } }), { requireCanvas: true }).passed).toBe(false);
    expect(classifyPage(obs({ canvas: { present: false, width: 0, height: 0, context: null } }), { requireCanvas: true }).passed).toBe(false);
  });

  it("erreurs console tolérables sur demande explicite", () => {
    const o = obs({ consoleErrors: ["warning bruyant"] });
    expect(classifyPage(o, {}).passed).toBe(false);
    expect(classifyPage(o, { allowConsoleErrors: true }).passed).toBe(true);
  });

  it("sélecteurs exigés absents → échec", () => {
    const r = classifyPage(obs({ missingSelectors: ["#hud"] }), { requireSelectors: ["#hud"] });
    expect(r.passed).toBe(false);
    expect(r.reasons.join()).toMatch(/#hud/);
  });
});

describe("bruit réseau bénin (faux positif corrigé à la validation)", () => {
  it("un favicon absent n'est pas un défaut de l'app", () => {
    expect(isRelevantRequestFailure("http://localhost:5173/favicon.ico")).toBe(false);
    expect(isRelevantRequestFailure("http://localhost:5173/apple-touch-icon.png")).toBe(false);
    expect(isRelevantRequestFailure("http://localhost:5173/main.js.map")).toBe(false);
    expect(isRelevantRequestFailure("http://localhost:5173/assets/game.js")).toBe(true);
  });

  it("le « Failed to load resource » générique est ignoré (doublon du canal réseau)", () => {
    expect(isRelevantConsoleError("Failed to load resource: the server responded with a status of 404")).toBe(false);
    expect(isRelevantConsoleError("TypeError: scene.spawn is not a function")).toBe(true);
  });
});

describe("détection du navigateur", () => {
  it("privilégie la variable d'environnement", () => {
    expect(findChrome({ HERMES_CHROME: "/opt/chrome" }, "linux", (p) => p === "/opt/chrome")).toBe("/opt/chrome");
  });

  it("retombe sur les emplacements usuels de la plateforme", () => {
    const win = chromeCandidates("win32", { "ProgramFiles": "C:\\PF" });
    expect(win[0]).toMatch(/chrome\.exe$/);
    expect(findChrome({}, "linux", (p) => p === "/usr/bin/chromium")).toBe("/usr/bin/chromium");
  });

  it("aucun navigateur → null (gate skippé, pas échoué)", () => {
    expect(findChrome({}, "linux", () => false)).toBeNull();
  });
});

// ── Test d'intégration : un VRAI navigateur sur des pages fabriquées ────────────
// C'est le seul test qui prouve que l'instrumentation compte réellement les appels
// de dessin (WebGL logiciel en headless). Ignoré si la machine n'a pas de Chrome.
const PAGES: Record<string, string> = {
  "/ok.html": `<!doctype html><title>Rend</title><canvas id="c" width="300" height="150"></canvas>
<script>
const gl = document.getElementById('c').getContext('webgl');
const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
const p = gl.createProgram();
gl.attachShader(p, sh(gl.VERTEX_SHADER, 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}'));
gl.attachShader(p, sh(gl.FRAGMENT_SHADER, 'void main(){gl_FragColor=vec4(1.,.3,.1,1.);}'));
gl.linkProgram(p); gl.useProgram(p);
const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,1,-1,-1,1,-1]), gl.STATIC_DRAW);
const l = gl.getAttribLocation(p, 'a'); gl.enableVertexAttribArray(l);
gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
(function f(){ gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES,0,3); requestAnimationFrame(f); })();
</script>`,
  "/black.html": `<!doctype html><title>Ecran noir</title><canvas id="c" width="300" height="150"></canvas>
<script>document.getElementById('c').getContext('webgl');</script>`,
  "/broken.html": `<!doctype html><title>Casse</title><canvas width="300" height="150"></canvas>
<script src="/module-absent.js"></script><script>window.__boom.init();</script>`,
};

const hasChrome = findChrome() !== null;

describe.skipIf(!hasChrome)("contrôle de page dans un vrai navigateur", () => {
  const listen = async (): Promise<{ server: Server; port: number }> => {
    const server = createServer((req, res) => {
      const body = PAGES[req.url ?? ""];
      if (!body) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { server, port: (server.address() as any).port };
  };

  it("distingue une page qui rend, un écran noir et une page cassée", async () => {
    const { server, port } = await listen();
    const req = { requireCanvas: true, minDrawCalls: 1, waitMs: 2500 };
    try {
      const ok = await runPageCheck(`http://127.0.0.1:${port}/ok.html`, req);
      expect(ok.status, ok.output).toBe("passed");
      expect(ok.output).toMatch(/appel\(s\) de dessin/);

      const black = await runPageCheck(`http://127.0.0.1:${port}/black.html`, req);
      expect(black.status).toBe("failed");
      expect(black.output).toMatch(/ne rend RIEN/);

      const broken = await runPageCheck(`http://127.0.0.1:${port}/broken.html`, req);
      expect(broken.status).toBe("failed");
      expect(broken.output).toMatch(/exception|404/);
    } finally {
      server.close();
    }
  }, 120_000);
});
