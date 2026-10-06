// The cart: "Add to order" buttons anywhere on the site keep what was chosen
// in this browser, and the order form's `items` field starts from it.
// Submitting the form is the checkout; there is no server side. Load it on
// every page (<script src="/cart.js" defer>; a website's layout does it
// once site.cart is true). Copy as is.
//
//   <button type="button" data-add-to="order" data-item="choc-chip">Add to order</button>
//   <a href="/order">Your order (<span data-cart-count="order">0</span>)</a>
//
// `order` is the form's key, `choc-chip` an item's key in its `items` field.
// The form's thanks page empties the cart (it carries data-cart-clear); a
// form with its own thanks page (redirect_to) puts
// <div data-cart-clear="order" hidden></div> on it.
(() => {
  const read = (form) => {
    try {
      const v = JSON.parse(localStorage.getItem(`cart:${form}`) || "{}");
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  };
  const write = (form, cart) => {
    try {
      localStorage.setItem(`cart:${form}`, JSON.stringify(cart));
    } catch {
      // Storage off (a private window): the buttons still lead to the form.
    }
    count(form);
  };
  const count = (form) => {
    const n = Object.values(read(form)).reduce((s, q) => s + (Number(q) || 0), 0);
    for (const el of document.querySelectorAll(`[data-cart-count="${CSS.escape(form)}"]`)) el.textContent = String(n);
  };

  document.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-add-to][data-item]") : null;
    if (!b) return;
    const form = b.getAttribute("data-add-to");
    const cart = read(form);
    const key = b.getAttribute("data-item");
    cart[key] = Math.min((Number(cart[key]) || 0) + (Number(b.getAttribute("data-qty")) || 1), 9999);
    write(form, cart);
    b.setAttribute("aria-live", "polite");
    b.dataset.added = "1";
  });

  const start = () => {
    for (const el of document.querySelectorAll("[data-cart-clear]")) write(el.getAttribute("data-cart-clear"), {});
    // The order form: fill empty quantities from the cart, and keep the cart in step with them.
    for (const set of document.querySelectorAll("[data-items-form]")) {
      const form = set.getAttribute("data-items-form");
      const cart = read(form);
      // Something the form no longer sells leaves the cart, and the count with it.
      const sold = new Set([...set.querySelectorAll("[data-item]")].map((row) => row.getAttribute("data-item")));
      if (Object.keys(cart).some((k) => !sold.has(k))) write(form, Object.fromEntries(Object.entries(cart).filter(([k]) => sold.has(k))));
      for (const row of set.querySelectorAll("[data-item]")) {
        const input = row.querySelector("input");
        const key = row.getAttribute("data-item");
        const max = Number(row.getAttribute("data-max")) || 99;
        if (input && !input.value && cart[key]) input.value = String(Math.min(Number(cart[key]) || 0, max));
        input?.addEventListener("change", () => {
          const now = read(form);
          const n = Number(input.value);
          if (Number.isInteger(n) && n > 0) now[key] = n;
          else delete now[key];
          write(form, now);
        });
      }
    }
    for (const el of document.querySelectorAll("[data-cart-count]")) count(el.getAttribute("data-cart-count"));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
