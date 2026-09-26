import { createServer } from "node:http";

// Une page, la plus simple qui soit : ce qui compte ici est le content-type.
createServer((_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end("<!doctype html><html lang=\"fr\"><head><title>Vitrine</title></head><body><h1>Vitrine</h1></body></html>");
}).listen(39001);

process.on("SIGTERM", () => process.exit(0));
