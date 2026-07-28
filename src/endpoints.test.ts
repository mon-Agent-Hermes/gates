import { describe, it, expect } from "vitest";
import { extractEndpoints } from "./endpoints";

describe("extractEndpoints (routes déclarées à interroger)", () => {
  it("retient les endpoints de LECTURE déclarés dans la spec", () => {
    const spec = `
## Critères d'acceptation
- \`GET /tasks\` renvoie la liste des tâches (200)
- \`POST /tasks\` crée une tâche (201)
- GET /health répond 200
`;
    expect(extractEndpoints(spec)).toEqual(["/tasks", "/health"]);
  });

  it("ignore les routes POST/PUT/DELETE seules (un GET y renverrait 404 à tort)", () => {
    expect(extractEndpoints("POST /login\nDELETE /sessions")).toEqual([]);
  });

  it("ignore les chemins paramétrés (un 404 y est légitime)", () => {
    const spec = "GET /tasks/:id renvoie une tâche ; GET /users/{userId} ; GET /a/<b>";
    expect(extractEndpoints(spec)).toEqual([]);
  });

  it("ignore la racine (déjà couverte par le smoke de santé) et les fichiers", () => {
    expect(extractEndpoints("GET / répond 200\nGET /favicon.ico")).toEqual([]);
  });

  it("récupère les URLs d'exemple LOCALES, pas les liens de documentation", () => {
    const spec = "Vérifier : curl http://localhost:3000/tasks — voir https://expressjs.com/en/guide/routing";
    expect(extractEndpoints(spec)).toEqual(["/tasks"]);
  });

  it("déduplique, normalise et borne le nombre de sondes", () => {
    expect(extractEndpoints("GET /tasks/ et `GET /tasks` et GET /tasks?done=1")).toEqual(["/tasks"]);
    const many = Array.from({ length: 10 }, (_, i) => `GET /r${i}`).join("\n");
    expect(extractEndpoints(many)).toHaveLength(6);
    expect(extractEndpoints(many, 2)).toEqual(["/r0", "/r1"]);
  });

  it("texte vide / sans endpoint → aucune sonde (smoke inchangé)", () => {
    expect(extractEndpoints("")).toEqual([]);
    expect(extractEndpoints("Une bibliothèque de calcul, sans serveur.")).toEqual([]);
  });
});
