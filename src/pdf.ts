// Dev's printer: a document's HTML as PDF bytes, through the browser the
// crawler installs (reports/print.ts). Null when the machine has none; a
// quote then goes out with its lines in the email. Node only: production has
// no browser, and its runtime has no print.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, printToPdf } from "./reports/print";

export async function printPdf(html: string): Promise<Uint8Array | null> {
  const chrome = findChrome();
  if (!chrome) return null;
  const dir = await mkdtemp(join(tmpdir(), "crm-pdf-"));
  try {
    const file = await printToPdf(html, join(dir, "document.pdf"), { chrome, width: 800 });
    return new Uint8Array(await readFile(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
