import { test } from "node:test";
import assert from "node:assert/strict";
import { chromeArgs } from "../print";

test("Chrome never touches the macOS keychain", () => {
  const args = chromeArgs("in.html", "out.pdf");
  assert.ok(args.includes("--use-mock-keychain"));
  assert.ok(args.includes("--password-store=basic"));
});
