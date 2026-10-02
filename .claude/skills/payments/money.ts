// Money as Stripe counts it: an integer in the currency's minor unit. Most
// currencies have two decimals, but yen and won have none, and the Gulf dinars
// have three, so "multiply by 100" is wrong for them. Never a float in storage.
//
//   toMinor("12.50", "usd")  // 1250
//   toMinor("1200", "jpy")   // 1200
//   formatMoney(1250, "usd") // "$12.50"

// Stripe's zero-decimal and three-decimal currencies (docs.stripe.com/currencies).
// HUF, ISK and TWD are absent on purpose: Stripe takes them in hundredths.
const ZERO = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
const THREE = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

/** How many decimal places one major unit has in Stripe's amounts. */
export function decimals(currency: string): number {
  const c = currency.toLowerCase();
  return ZERO.has(c) ? 0 : THREE.has(c) ? 3 : 2;
}

/** A lowercase ISO 4217 code, or null. */
export function currencyCode(input: unknown): string | null {
  return typeof input === "string" && /^[a-z]{3}$/i.test(input.trim()) ? input.trim().toLowerCase() : null;
}

/**
 * Parse what a person typed ("12.5", "12.50", "1,200") into minor units; null
 * when it is not an amount. A comma is only a thousands separator in groups of
 * three: "12,50" (a decimal comma) is refused, never read as 1250.
 */
export function toMinor(input: string, currency: string): number | null {
  const d = decimals(currency);
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d*))?$/.exec(input.trim());
  if (!m || (m[2] ?? "").length > d) return null;
  const n = Number(m[1].replace(/,/g, "")) * 10 ** d + Number((m[2] ?? "").padEnd(d, "0") || 0);
  return Number.isSafeInteger(n) ? n : null;
}

/** Minor units as a person reads them, in the currency's own symbol and decimals. */
export function formatMoney(minor: number | string | bigint, currency: string, locale = "en"): string {
  const d = decimals(currency);
  const n = Number(minor) / 10 ** d;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    }).format(n);
  } catch {
    return `${n.toFixed(d)} ${currency.toUpperCase()}`;
  }
}
