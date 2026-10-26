import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { isJob, jobRoutes } from "../jobs";

function app() {
  const a = new Hono();
  a.post("/jobs/x", (c) => (isJob(c) ? c.json({ ok: true }) : c.notFound()));
  return a;
}

test("production: a job is the routing Worker's props.job, never anything a visitor sends", async () => {
  const ctx = (props: object) => ({ waitUntil() {}, passThroughOnException() {}, props }) as never;
  assert.equal((await app().request("/jobs/x", { method: "POST" }, {}, ctx({ job: "x" }))).status, 200);
  assert.equal((await app().request("/jobs/x", { method: "POST" }, {}, ctx({ job: "y" }))).status, 404, "another job's dispatch");
  assert.equal((await app().request("/jobs/x", { method: "POST" }, {}, ctx({ tt: {} }))).status, 404);
  assert.equal((await app().request("/jobs/x", { method: "POST", headers: { authorization: "Bearer guess" } }, {}, ctx({}))).status, 404);
});

test("on the machine: the machine token the dev server holds, and nothing else", async () => {
  process.env.MACHINE_TOKEN = "mt-secret";
  try {
    const node = { incoming: {}, outgoing: {} };
    assert.equal((await app().request("/jobs/x", { method: "POST", headers: { authorization: "Bearer mt-secret" } }, node)).status, 200);
    assert.equal((await app().request("/jobs/x", { method: "POST", headers: { authorization: "Bearer mt-secreT" } }, node)).status, 404);
    assert.equal((await app().request("/jobs/x", { method: "POST" }, node)).status, 404);
  } finally {
    delete process.env.MACHINE_TOKEN;
  }
});

test("a job route that throws answers a JSON 500, so the run says why", async () => {
  const jobs = jobRoutes();
  jobs.post("/jobs/x", () => {
    throw new Error("the database is down");
  });
  const a = new Hono().route("/", jobs);
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: { job: "x" } } as never;
  const res = await a.request("/jobs/x", { method: "POST" }, {}, ctx);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ok: false, error: "the database is down" });
  assert.equal((await a.request("/jobs/x", { method: "POST" }, {}, { ...(ctx as object), props: {} } as never)).status, 404);
});
