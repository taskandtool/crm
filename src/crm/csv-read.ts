// Reading the spreadsheet a business runs on today: a small CSV reader
// (RFC 4180: quotes, doubled quotes, newlines in quotes, a BOM, CRLF) and
// the loose date reader a spreadsheet export needs.

/**
 * A spreadsheet file's bytes as text. Excel on Windows saves "CSV" in the
 * machine's code page and "Unicode text" as UTF-16; read as UTF-8, either
 * turns every accented name into U+FFFD for good. UTF-8 (with or without a
 * BOM) is the default; a UTF-16 BOM says UTF-16; bytes that are not valid
 * UTF-8 are read as Windows-1252, the code page those exports use.
 */
export function decodeCsv(bytes: Uint8Array): { text: string; encoding: "utf-8" | "utf-16le" | "utf-16be" | "windows-1252" } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: windows1252(bytes), encoding: "windows-1252" };
  }
}

// 0x80-0x9F are where Windows-1252 differs from Latin-1 (curly quotes,
// dashes, the euro sign). Mapped by hand: Node built without full ICU
// decodes "windows-1252" as Latin-1 and turns ’ into a control character.
const CP1252_HIGH =
  "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f" +
  "\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";

function windows1252(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b);
  return out;
}

/**
 * Rows of a CSV. The separator is a comma, or a semicolon or tab when the
 * header line has those and no comma (Excel in much of Europe saves "CSV"
 * with semicolons). A quote left open throws, naming its line: read on, it
 * would swallow every row after it without a word.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let quoteLine = 0;
  const src = text.replace(/^\uFEFF/, "");
  const head = src.slice(0, src.search(/\r|\n|$/));
  const sep = head.includes(",") ? "," : head.includes(";") ? ";" : head.includes("\t") ? "\t" : ",";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\n") line++;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
      quoteLine = line;
    } else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") {
        i++;
        line++;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (quoted) throw new Error(`a quote opened on line ${quoteLine} is never closed`);
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * A date from a spreadsheet: 2026-10-02, 10/2/2026 (month first unless the
 * first number cannot be a month), 2/10/26, or anything Date.parse reads.
 * Returns YYYY-MM-DD, or null.
 */
export function parseDate(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? "20" + m[3] : m[3];
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [mm, dd] = a > 12 ? [b, a] : [a, b];
    return valid(y, String(mm), String(dd));
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function valid(y: string, m: string, d: string): string | null {
  const s = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const t = new Date(s + "T00:00:00Z");
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
}
