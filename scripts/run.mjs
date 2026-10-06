// What every scripts/<name>.mjs runs: scripts/<name>.ts under tsx, from the
// app root, so a script shares the app's TypeScript without a build step.
// CALLER_CWD keeps where it was run from, for a file argument.
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** @param {string} launcher the launcher's import.meta.url */
export function run(launcher) {
  const file = fileURLToPath(launcher);
  const name = basename(file, ".mjs");
  const root = join(dirname(file), "..");
  const r = spawnSync(join(root, "node_modules", ".bin", "tsx"), [join(root, "scripts", `${name}.ts`), ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, CALLER_CWD: process.cwd() },
  });
  if (r.error) {
    console.error(`${name}: could not start tsx (${r.error.message})\n  Try: npm install`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}
