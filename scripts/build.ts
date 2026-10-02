// Build the CRM for production on Cloudflare:
//   dist/            every static file (the built CSS, the vendored htmx and
//                    SortableJS, crm.js, the favicon), served as assets
//   build/worker.mjs the app bundled as one ES module, reached by every path
//                    that is not a file in dist/
// Run with `npm run build`; `npm run deploy` runs it too.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { build, type Plugin } from "esbuild";

const dist = "dist";
const out = "build";

function run(label: string, cmd: string, args: string[]) {
  console.log(`== ${label}`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`${label} failed`);
    process.exit(r.status ?? 1);
  }
}

run("css", "npm", ["run", "--silent", "css"]);
run("vendor", "npm", ["run", "--silent", "vendor"]);

console.log("== static assets");
rmSync(dist, { recursive: true, force: true });
cpSync("static", dist, { recursive: true });

// pg is CommonJS: its `require("events")` and friends would be left as
// calls an ES module Worker cannot make. Each becomes an import of the
// runtime's own `node:` module (what wrangler does too); an import stays
// external. pg-native is optional and stays a require pg never makes here.
const builtins = new Set(builtinModules.filter((m) => !m.startsWith("_")));
const nodeRequires: Plugin = {
  name: "node-requires",
  setup(b) {
    b.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) => {
      const name = args.path.replace(/^node:/, "");
      if (!builtins.has(name)) return undefined;
      if (args.kind === "require-call") return { path: name, namespace: "node-require" };
      return { path: `node:${name}`, external: true };
    });
    b.onLoad({ filter: /.*/, namespace: "node-require" }, (args) => ({
      contents: `export * from "node:${args.path}"; export { default } from "node:${args.path}";`,
      loader: "js",
    }));
  },
};

console.log("== worker");
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  format: "esm",
  outfile: join(out, "worker.mjs"),
  platform: "neutral",
  // `workerd` makes pg pick its Cloudflare socket (pg-cloudflare); Node's
  // built-ins and cloudflare:sockets come from the runtime (nodejs_compat).
  conditions: ["workerd", "worker"],
  mainFields: ["module", "main"],
  external: ["cloudflare:*", "pg-native"],
  plugins: [nodeRequires],
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "hono/jsx",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
console.log(`built: ${dist}/ and ${join(out, "worker.mjs")}`);
