// "Saved" after a 303, with no JavaScript and no session: the redirect
// carries a code (`?saved=status`, plus `n` for a count) and the page maps
// the code to its own text. The URL never carries the text itself, so a
// crafted link cannot put words in the app's mouth.
//
//   return c.redirect(withFlash(ret, "bulk", rows.length), 303);
//   <Flash code={c.req.query("saved")} n={c.req.query("n")} messages={MESSAGES} />
export type FlashMessages = Record<string, string | ((n: number) => string)>;

export function withFlash(path: string, code: string, n?: number): string {
  const u = new URL(path, "http://x");
  u.searchParams.delete("after");
  u.searchParams.set("saved", code);
  if (n !== undefined) u.searchParams.set("n", String(n));
  else u.searchParams.delete("n");
  // A path that resolves to "//host" would leave the site; send it home.
  return u.pathname.startsWith("//") ? "/" + u.search : u.pathname + u.search;
}

export function Flash({ code, n, messages }: { code?: string | null; n?: string | null; messages: FlashMessages }) {
  const m = code && Object.hasOwn(messages, code) ? messages[code] : null;
  if (!m) return null;
  const count = /^\d{1,9}$/.test(n ?? "") ? Number(n) : 0;
  return (
    <p role="status" class="mb-4 rounded-card border border-line-strong bg-panel px-4 py-2 text-copy text-ink">
      {typeof m === "function" ? m(count) : m}
    </p>
  );
}
