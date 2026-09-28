import { createServer } from "node:http";

// Des données, pas une page : ce projet n'a aucune section « site » à déclarer.
createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}).listen(39002);

process.on("SIGTERM", () => process.exit(0));
