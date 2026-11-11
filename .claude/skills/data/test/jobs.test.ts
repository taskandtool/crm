import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { isJob, jobRoutes } from "../jobs";

test("a job's run is a request under /_jobs/, the path only Task & Tool reaches", async () => {
  const a = new Hono();
  a.all("*", (c) => c.json({ job: isJob(c) }));
  assert.deepEqual(await (await a.request("/_jobs/x", { method: "POST" })).json(), { job: true });
  assert.deepEqual(await (await a.request("/_jobs/x?hour=9", { method: "POST" })).json(), { job: true });
  assert.deepEqual(await (await a.request("/jobs/x", { method: "POST" })).json(), { job: false });
  assert.deepEqual(await (await a.request("/_jobsx", { method: "POST" })).json(), { job: false });
});

test("a job route that throws answers a JSON 500, so the run says why", async () => {
  const jobs = jobRoutes();
  jobs.post("/_jobs/x", () => {
    throw new Error("the database is down");
  });
  jobs.post("/_jobs/ok", (c) => c.json({ ok: true }));
  const a = new Hono().route("/", jobs);
  const res = await a.request("/_jobs/x", { method: "POST" });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ok: false, error: "the database is down" });
  assert.deepEqual(await (await a.request("/_jobs/ok", { method: "POST" })).json(), { ok: true });
});
