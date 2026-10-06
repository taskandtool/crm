// npm test's reporter: a dot per passing test (s for skipped), each failure
// in full, then one line of counts and why anything was skipped.
import { inspect } from "node:util";

export default async function* reporter(source) {
  const counts = [];
  const skips = new Set();
  for await (const { type, data } of source) {
    if (data?.details?.type === "suite") continue;
    if (type === "test:pass") {
      yield data.skip ? "s" : ".";
      if (typeof data.skip === "string") skips.add(data.skip);
    }
    if (type === "test:fail") yield `\n\nFAIL ${data.name} (${data.file ?? ""}:${data.line ?? ""})\n${inspect(data.details?.error?.cause ?? data.details?.error, { depth: 4 })}\n`;
    if (type === "test:diagnostic" && data.nesting === 0) {
      if (/^(tests|pass|fail|cancelled|skipped) \d+$/.test(data.message)) counts.push(data.message);
      else if (!/^(suites|todo|duration_ms) /.test(data.message)) yield `\n${data.message}`;
    }
  }
  yield `\n${counts.join(", ")}\n`;
  for (const s of skips) yield `skipped: ${s}\n`;
}
