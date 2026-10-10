// /_files on the machine's dev server, for the AI's own checks on localhost:
// a photo field's upload (POST) and the photo (GET), through a short-lived
// link Task & Tool signs for this app's project. At the app's addresses the
// routing worker answers /_files itself, so this is mounted only in
// src/server.ts, never the edge Worker, and the machine's token never leaves
// the machine.
//
//   server.route("/", devFiles());   // src/server.ts, before the app
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const ID = /^[\w-]{22}$/;
const PHOTO = /^image\/(png|jpeg|gif|webp|avif)$/;

/** Task & Tool's address and this machine's token: the environment, else ~/.env, as the machine's own scripts read them. */
function machineEnv(): { url: string; token: string } | null {
  const found: Record<string, string> = {};
  try {
    for (const line of readFileSync(join(homedir(), ".env"), "utf8").split("\n")) {
      const m = /^(?:export )?(PHOENIX_URL|MACHINE_TOKEN)=(.*)$/.exec(line.trim());
      if (m) found[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {}
  const url = process.env.PHOENIX_URL || found.PHOENIX_URL;
  const token = process.env.MACHINE_TOKEN || found.MACHINE_TOKEN;
  return url && token ? { url, token } : null;
}

async function signed(body: object): Promise<{ url: string; path?: string; type?: string } | null> {
  const env = machineEnv();
  if (!env) return null;
  const res = await fetch(`${env.url}/api/machine/user-files`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok ? res.json() : null;
}

export function devFiles() {
  const app = new Hono();
  app.post("/_files", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const link = await signed({ method: "put", size: bytes.length, type: c.req.header("content-type") ?? "" });
    if (!link?.path) return c.text("This upload was refused: at most 10 MB, on a machine connected to Task & Tool.", 400);
    const put = await fetch(link.url, { method: "PUT", body: bytes, headers: { "content-type": link.type! } });
    return put.ok ? c.json({ path: link.path }, 201) : c.text("The upload failed.", 502);
  });
  app.get("/_files/:id", async (c) => {
    const id = c.req.param("id");
    const link = ID.test(id) ? await signed({ method: "get", id }) : null;
    const res = link ? await fetch(link.url) : null;
    if (!res?.ok) return c.notFound();
    const type = res.headers.get("content-type") ?? "";
    return new Response(res.body, {
      headers: {
        "content-type": PHOTO.test(type) ? type : "application/octet-stream",
        "content-security-policy": "sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  });
  return app;
}
