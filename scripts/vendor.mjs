#!/usr/bin/env node
// Copies the two client libraries out of node_modules into static/vendor/,
// so the CRM loads nothing from a CDN and works on a machine with no
// outbound reach. Runs on every npm install (postinstall) and by hand with
// `npm run vendor`.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const files = [
  ["node_modules/htmx.org/dist/htmx.min.js", "static/vendor/htmx.min.js"],
  ["node_modules/sortablejs/Sortable.min.js", "static/vendor/Sortable.min.js"],
];
mkdirSync("static/vendor", { recursive: true });
for (const [from, to] of files) {
  if (!existsSync(from)) {
    console.error(`${from} is missing: run npm install`);
    process.exit(1);
  }
  copyFileSync(from, to);
}
console.log("vendored: " + files.map(([, t]) => t).join(", "));
