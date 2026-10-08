// MACHINE ONLY: node:zlib, for scripts/import.ts. Never import this from a page.
// The first sheet of an Excel workbook (.xlsx) as rows of strings, the same
// shape parseCsv returns. No dependency: an .xlsx is a zip of XML parts.
// Dates come out as YYYY-MM-DD (with the time when there is one).
import { inflateRawSync } from "node:zlib";

export function readXlsx(buf: Buffer): string[][] {
  const parts = unzip(buf);
  const part = (name: string) => parts.get(name)?.toString("utf8");
  const shared = [...(part("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")));
  const dates = dateStyles(part("xl/styles.xml") ?? "");
  const sheet = part(firstSheet(part("xl/workbook.xml") ?? "", part("xl/_rels/workbook.xml.rels") ?? ""));
  if (!sheet) throw new Error("no worksheet in the workbook");

  const rows: string[][] = [];
  for (const [, body] of sheet.matchAll(/<row\b(?:[^>]*[^/>])?>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const [, attrs, inner = ""] of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const col = ref ? [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : row.length;
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? 0);
      const v = unescape(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
      let cell = v;
      if (type === "s") cell = shared[Number(v)] ?? "";
      else if (type === "inlineStr") cell = texts(inner);
      else if (type === "b") cell = v === "1" ? "TRUE" : "FALSE";
      else if ((!type || type === "n") && v !== "" && dates.has(style)) cell = serialDate(Number(v));
      while (row.length < col) row.push("");
      row[col] = cell;
    }
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// Entries of a zip by name, from its central directory.
function unzip(buf: Buffer): Map<string, Buffer> {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not an .xlsx file (no zip directory)");
  const files = new Map<string, Buffer>();
  let p = buf.readUInt32LE(end + 16);
  for (let i = buf.readUInt16LE(end + 10); i > 0; i--) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(raw) : raw);
    p += 46 + nameLen + extra + comment;
  }
  return files;
}

function firstSheet(workbook: string, rels: string): string {
  const id = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const target = id && new RegExp(`<Relationship\\b[^>]*\\bId="${id}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1]
    || id && new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${id}"`).exec(rels)?.[1];
  if (!target) return "xl/worksheets/sheet1.xml";
  return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
}

// The cell styles (by index) whose number format is a date.
function dateStyles(styles: string): Set<number> {
  const custom = new Map<number, string>();
  for (const [, id, code] of styles.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) custom.set(Number(id), unescape(code));
  const isDate = (id: number) =>
    (id >= 14 && id <= 22) || (id >= 45 && id <= 47) ||
    /[dmy]/i.test((custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, ""));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  const out = new Set<number>();
  [...xfs.matchAll(/<xf\b([^>]*)/g)].forEach(([, attrs], i) => {
    if (isDate(Number(/numFmtId="(\d+)"/.exec(attrs)?.[1] ?? 0))) out.add(i);
  });
  return out;
}

// Excel's day count from 1899-12-30.
function serialDate(n: number): string {
  if (!Number.isFinite(n)) return "";
  const iso = new Date(Math.round((n - 25569) * 86400) * 1000).toISOString();
  return n % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
}

function texts(xml: string): string {
  return [...xml.matchAll(/<t\b(?:[^>]*[^/>])?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join("");
}

function unescape(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]);
}
