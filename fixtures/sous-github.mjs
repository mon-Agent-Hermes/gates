// Lance `gates check` sur projet-sain comme le ferait GitHub Actions (GITHUB_ACTIONS=true),
// et recopie sa sortie. Sert la probe d'AC-5 : les probes `cli` ne portent pas d'env, et
// `VAR=x commande` n'est pas portable (cmd.exe).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const r = spawnSync(process.execPath, ["../../bin/gates.mjs", "check"], {
  cwd: fileURLToPath(new URL("./projet-sain/", import.meta.url)),
  env: { ...process.env, GITHUB_ACTIONS: "true" },
  encoding: "utf8",
});
process.stdout.write(r.stdout ?? "");
process.stderr.write(r.stderr ?? "");
process.exit(r.status ?? 1);
