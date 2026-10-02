// CSV export that a spreadsheet opens safely. A cell beginning with = + - @
// (or their full-width forms, after any leading spaces or line breaks, or a
// tab or carriage return) is a formula to Excel and Sheets, and a form
// submission is untrusted text, so such a cell is prefixed with a quote mark.
// Rows stream out page by page, so an export of every submission never holds
// them all in memory.
//
//   return csvResponse("submissions.csv", columns, everyPage((after, size) => listPage(db, f, after, size)));   // keyset.ts

// A formula sign, its full-width form, or one after leading spaces or line
// breaks (a spreadsheet may trim those first), or a tab or CR at the start.
const FORMULA = /^[\s\u3000]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]|^[\t\r\n]/;

export type CsvColumn<T> = { label: string; value: (row: T) => unknown };

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (FORMULA.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine<T>(columns: CsvColumn<T>[], row: T): string {
  return columns.map((col) => csvCell(col.value(row))).join(",") + "\r\n";
}

export function csvResponse<T>(filename: string, columns: CsvColumn<T>[], rows: AsyncIterable<T> | Iterable<T>): Response {
  const enc = new TextEncoder();
  const it = (Symbol.asyncIterator in Object(rows) ? (rows as AsyncIterable<T>)[Symbol.asyncIterator]() : (rows as Iterable<T>)[Symbol.iterator]()) as
    | AsyncIterator<T>
    | Iterator<T>;
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (!started) {
        started = true;
        ctrl.enqueue(enc.encode("﻿" + columns.map((c) => csvCell(c.label)).join(",") + "\r\n"));
        return;
      }
      const next = await it.next();
      if (next.done) ctrl.close();
      else ctrl.enqueue(enc.encode(csvLine(columns, next.value)));
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
}
