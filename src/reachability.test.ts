import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeReachability, htmlReferences, moduleReferences, cssReferences } from "./reachability";

/** Petit projet jetable : chemins relatifs → contenu. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gates-reach-"));
  for (const [p, content] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

describe("extraction des références", () => {
  it("HTML : script et link locaux, jamais les externes", () => {
    const refs = htmlReferences(
      `<script type="module" src="/src/main.ts"></script>
       <link rel="stylesheet" href="./style.css">
       <script src="https://cdn.example.com/x.js"></script>`,
    );
    expect(refs).toEqual(["/src/main.ts", "./style.css"]);
  });

  it("modules : imports statiques, dynamiques, CSS et require", () => {
    const refs = moduleReferences(
      `import { a } from './a';
       import './ui/styles.css';
       const m = await import("../lazy/mod");
       const r = require('./legacy');
       import x from 'playcanvas';`,
    );
    expect(refs).toEqual(["./a", "./ui/styles.css", "../lazy/mod", "./legacy"]);
  });

  it("CSS : @import local", () => {
    expect(cssReferences('@import "./base.css";\n@import url("theme.css");')).toEqual(["./base.css", "theme.css"]);
  });
});

describe("analyzeReachability", () => {
  it("projet correctement câblé : aucun livrable injoignable", async () => {
    const dir = project({
      "index.html": `<script type="module" src="/src/main.ts"></script>`,
      "src/main.ts": `import './ui/styles.css';\nimport { boot } from './game/boot';\nboot();`,
      "src/game/boot.ts": `import { rules } from './rules';\nexport const boot = () => rules();`,
      "src/game/rules.ts": `export const rules = () => 1;`,
      "src/ui/styles.css": `body { margin: 0 }`,
    });
    const r = await analyzeReachability(dir);
    expect(r.conclusive).toBe(true);
    expect(r.entries).toEqual(["index.html"]);
    expect(r.unreachable).toEqual([]);
    expect(r.scanned).toBe(4);
  });

  it("LE défaut du jeu voxel : le point d'entrée n'atteint qu'un fichier sur quatre", async () => {
    const dir = project({
      "index.html": `<script type="module" src="/src/main.ts"></script>`,
      "src/main.ts": `import { Application } from 'playcanvas';\nnew Application(document.querySelector('canvas'));`,
      "src/game/loop.ts": `export const loop = () => {};`,
      "src/ui/Hud.ts": `export class Hud {}`,
      "src/ui/styles.css": `.hud { color: red }`,
    });
    const r = await analyzeReachability(dir);
    expect(r.unreachable).toEqual(["src/game/loop.ts", "src/ui/Hud.ts", "src/ui/styles.css"]);
  });

  it("un module importé par un module mort reste mort (ce que les orphelins ratent)", async () => {
    const dir = project({
      "index.html": `<script type="module" src="/src/main.ts"></script>`,
      "src/main.ts": `export const noop = 0;`,
      "src/orphan.ts": `import { helper } from './helper';\nexport const o = helper;`,
      "src/helper.ts": `export const helper = 1;`,
    });
    const r = await analyzeReachability(dir);
    // `helper.ts` A un importeur, mais rien ne mène à lui depuis la page.
    expect(r.unreachable).toEqual(["src/helper.ts", "src/orphan.ts"]);
  });

  it("l'asset jamais importé est détecté (l'UI sans style du run réel)", async () => {
    const dir = project({
      "index.html": `<script type="module" src="/src/main.ts"></script>`,
      "src/main.ts": `import './ui/Hud';`,
      "src/ui/Hud.ts": `export class Hud {}`,
      "src/ui/styles.css": `.screen { position: absolute }`,
    });
    expect((await analyzeReachability(dir)).unreachable).toEqual(["src/ui/styles.css"]);
  });

  it("les tests n'ont pas à être atteints par l'application", async () => {
    const dir = project({
      "index.html": `<script type="module" src="/src/main.ts"></script>`,
      "src/main.ts": `export const a = 1;`,
      "src/main.test.ts": `import { a } from './main';`,
      "tests/other.test.ts": `export const t = 1;`,
    });
    expect((await analyzeReachability(dir)).unreachable).toEqual([]);
  });

  it("sans HTML, retombe sur le point d'entrée conventionnel", async () => {
    const dir = project({
      "src/main.ts": `import './used';`,
      "src/used.ts": `export const u = 1;`,
      "src/unused.ts": `export const x = 1;`,
    });
    const r = await analyzeReachability(dir);
    expect(r.entries).toEqual(["src/main.ts"]);
    expect(r.unreachable).toEqual(["src/unused.ts"]);
  });

  it("aucun point d'entrée identifiable → PAS de verdict (jamais de faux blocage)", async () => {
    const dir = project({ "src/lib/thing.py": "def f(): pass" });
    const r = await analyzeReachability(dir);
    expect(r.conclusive).toBe(false);
    expect(r.unreachable).toEqual([]);
  });
});
