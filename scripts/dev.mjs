#!/usr/bin/env node
// The development loop in one process: Tailwind rebuilding static/crm.css
// on every change and the server restarting when src/ or the config
// changes. This is what the `web` service runs on a Task & Tool machine, so
// an edit is live on refresh.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

for (const b of ["node_modules/.bin/tailwindcss", "node_modules/.bin/tsx"]) {
  if (!existsSync(b)) {
    console.error(`${b} is missing: run npm install first`);
    process.exit(1);
  }
}

const children = [
  // `--watch=always` keeps watching when stdin is closed, which it is under a
  // service; plain --watch exits then and would take the server down with it.
  spawn("npm", ["run", "--silent", "css:watch"], { stdio: "inherit" }),
  spawn("node_modules/.bin/tsx", ["watch", "--clear-screen=false", "--include", "crm.config.json", "--include", "schema.sql", "src/server.ts"], { stdio: "inherit" }),
];

let stopping = false;
const stop = (signal, code) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill(signal);
  process.exit(code ?? 0);
};
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => stop(s, 0));
for (const c of children) c.on("exit", (code) => stop("SIGTERM", code ?? 1));
