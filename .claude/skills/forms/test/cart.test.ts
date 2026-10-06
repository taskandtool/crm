// cart.js run as a browser would, against a small stand-in for the parts of
// the DOM it touches: attributes, querySelector(All) by tag and attribute,
// closest, click and change events, localStorage. No dependency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../cart.js", import.meta.url), "utf8");

type Listener = (e: { target: El }) => void;

class El {
  attrs = new Map<string, string>();
  children: El[] = [];
  parent: El | null = null;
  listeners = new Map<string, Listener[]>();
  value = "";
  textContent = "";
  constructor(readonly tag: string, attrs: Record<string, string> = {}, children: El[] = []) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
    for (const c of children) this.append(c);
  }
  append(c: El) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  get dataset() {
    return new Proxy({}, { set: (_t, k, v) => (this.attrs.set(`data-${String(k)}`, String(v)), true) });
  }
  addEventListener(type: string, f: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]);
  }
  fire(type: string) {
    for (let n: El | null = this; n; n = n.parent) for (const f of n.listeners.get(type) ?? []) f({ target: this });
  }
  matches(sel: string): boolean {
    // "input", "[a]", "[a][b]", '[a="v"]'
    const tag = /^[a-z]+/.exec(sel)?.[0];
    if (tag && this.tag !== tag) return false;
    for (const m of sel.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      if (!this.attrs.has(m[1]) || (m[2] !== undefined && this.attrs.get(m[1]) !== m[2])) return false;
    }
    return true;
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll(sel: string) {
    return this.all().filter((e) => e.matches(sel));
  }
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  closest(sel: string): El | null {
    for (let n: El | null = this; n; n = n.parent) if (n.matches(sel)) return n;
    return null;
  }
}

/** A page, its storage, and cart.js run in it. */
function load(body: El, stored: Record<string, string> = {}, storage = true) {
  const store = new Map(Object.entries(stored));
  const document = Object.assign(body, { readyState: "complete" });
  const localStorage = {
    getItem: (k: string) => {
      if (!storage) throw new Error("blocked");
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (!storage) throw new Error("blocked");
      store.set(k, v);
    },
  };
  runInNewContext(source, { document, localStorage, Element: El, CSS: { escape: (s: string) => s }, Number, Math, JSON, Object, String });
  return store;
}

const button = (item: string, qty?: string) => new El("button", { "data-add-to": "order", "data-item": item, ...(qty ? { "data-qty": qty } : {}) });

test("Add to order keeps the count per item under the form's key, and every count shows the total", () => {
  const count = new El("span", { "data-cart-count": "order" });
  const choc = button("choc-chip"), pb = button("pb", "2");
  const page = new El("body", {}, [choc, pb, count]);
  const store = load(page);
  assert.equal(count.textContent, "0");
  choc.fire("click");
  choc.fire("click");
  pb.fire("click");
  assert.deepEqual(JSON.parse(store.get("cart:order")!), { "choc-chip": 2, pb: 2 });
  assert.equal(count.textContent, "4");
  assert.equal(choc.getAttribute("data-added"), "1");
});

test("the order form starts from the cart, within each item's most, drops what it no longer sells, and its changes go back to the cart", () => {
  const row = (key: string, max: string) => new El("div", { "data-item": key, "data-max": max }, [new El("input")]);
  const choc = row("choc-chip", "12"), pb = row("pb", "3"), other = row("other", "99");
  const set = new El("fieldset", { "data-items-form": "order" }, [choc, pb, other]);
  const store = load(new El("body", {}, [set]), { "cart:order": JSON.stringify({ "choc-chip": 2, pb: 50, gone: 1 }) });
  const input = (r: El) => r.querySelector("input")!;
  assert.equal(input(choc).value, "2");
  assert.equal(input(pb).value, "3", "never more than the form allows");
  assert.equal(input(other).value, "");
  assert.deepEqual(JSON.parse(store.get("cart:order")!), { "choc-chip": 2, pb: 50 }, "gone is no longer sold");
  input(choc).value = "0";
  input(choc).fire("change");
  input(other).value = "5";
  input(other).fire("change");
  assert.deepEqual(JSON.parse(store.get("cart:order")!), { pb: 50, other: 5 });
});

test("the thanks page empties the cart; with storage blocked nothing breaks", () => {
  const count = new El("span", { "data-cart-count": "order" });
  const store = load(new El("body", {}, [new El("div", { "data-cart-clear": "order" }), count]), { "cart:order": JSON.stringify({ pb: 1 }) });
  assert.deepEqual(JSON.parse(store.get("cart:order")!), {});
  assert.equal(count.textContent, "0");

  const b = button("pb");
  const blocked = new El("body", {}, [b, new El("span", { "data-cart-count": "order" })]);
  assert.doesNotThrow(() => load(blocked, {}, false));
  assert.doesNotThrow(() => b.fire("click"));
});
