import { test } from "node:test";
import assert from "node:assert/strict";
import { devFiles } from "../files";

// Task & Tool and R2 stand in: the first signs, the second stores.
function stubFetch() {
  const stored = new Map<string, { bytes: BodyInit; type: string }>();
  const calls: { url: string; body?: unknown }[] = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith("/api/machine/user-files")) {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      assert.equal((init.headers as Record<string, string>).authorization, "Bearer machine-token");
      if (body.method === "put") return Response.json({ url: "https://r2.example/k1", path: "/_files/" + "c".repeat(22), type: body.type });
      return body.id === "c".repeat(22) ? Response.json({ url: "https://r2.example/k1" }) : new Response("no", { status: 400 });
    }
    if (init.method === "PUT") {
      stored.set(url, { bytes: init.body as BodyInit, type: (init.headers as Record<string, string>)["content-type"] });
      return new Response(null, { status: 200 });
    }
    const o = stored.get(url);
    return o ? new Response(o.bytes, { headers: { "content-type": o.type } }) : new Response(null, { status: 404 });
  }) as typeof fetch;
  return calls;
}

test("the dev server uploads and shows a photo through links Task & Tool signs", async () => {
  process.env.PHOENIX_URL = "https://phoenix.example";
  process.env.MACHINE_TOKEN = "machine-token";
  const calls = stubFetch();
  const app = devFiles();

  const up = await app.request("/_files", { method: "POST", body: "jpeg-bytes", headers: { "content-type": "image/jpeg" } });
  assert.equal(up.status, 201);
  const { path } = await up.json();
  assert.equal(path, "/_files/" + "c".repeat(22));
  assert.deepEqual(calls[0].body, { method: "put", size: 10, type: "image/jpeg" });

  const shown = await app.request(path);
  assert.equal(shown.status, 200);
  assert.equal(await shown.text(), "jpeg-bytes");
  assert.equal(shown.headers.get("content-type"), "image/jpeg");
  assert.equal(shown.headers.get("content-security-policy"), "sandbox");

  assert.equal((await app.request("/_files/" + "d".repeat(22))).status, 404);
  assert.equal((await app.request("/_files/short")).status, 404);
});
