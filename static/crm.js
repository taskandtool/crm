// The CRM's only client script: drag on the deal board, Home's figures
// counting up, the current tab kept in view on a narrow screen, a menu closing as a menu does, the
// sidebar's drawer on a phone, "/" to search, clean filter addresses, and a
// proposal's picture shrunk before upload. Everything else is plain forms and htmx attributes.
// A drop posts the same stage change the card's own select makes, and the
// server's answer (the whole pipeline) replaces the board, so a drop that
// fails leaves nothing pretending it worked. Without this file, or without
// JavaScript, each card's select and Save button do the same.
(function () {
  function wire() {
    if (!window.Sortable || !window.htmx) return;
    document.querySelectorAll("#pipeline [data-cards]").forEach(function (list) {
      if (list.dataset.sortable) return;
      list.dataset.sortable = "1";
      new Sortable(list, {
        group: "pipeline",
        sort: false,
        animation: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 120,
        draggable: "[data-deal-id]",
        // On a phone a swipe across a card scrolls the board; press and hold to drag.
        delay: 250,
        delayOnTouchOnly: true,
        // Pointer-driven rather than the browser's own drag, so a drag can
        // start on the title link and a drop never also opens the deal.
        forceFallback: true,
        fallbackTolerance: 4,
        filter: "button, input, select, option, label",
        preventOnFilter: false,
        onEnd: function (evt) {
          var stage = evt.to.dataset.stage;
          if (evt.from === evt.to || !stage) {
            if (evt.from !== evt.to) evt.from.appendChild(evt.item);
            return;
          }
          htmx.ajax("POST", "/deals/" + evt.item.dataset.dealId + "/stage", {
            target: "#pipeline",
            swap: "outerHTML",
            values: { stage: stage, return: "/deals" },
          });
        },
      });
    });
  }
  // On a phone the nav and a section's tabs scroll sideways; start each with
  // its current tab in view, as GitHub's and Gmail's do, not cut off at the edge.
  function showCurrent() {
    document.querySelectorAll("nav [aria-current=page]").forEach(function (a) {
      var row = a.parentElement;
      while (row && row !== document.body && row.scrollWidth <= row.clientWidth) row = row.parentElement;
      if (!row || row === document.body) return;
      var at = a.getBoundingClientRect(), box = row.getBoundingClientRect();
      row.scrollLeft += at.left + at.width / 2 - (box.left + box.width / 2);
    });
  }
  // A row's menu (<details data-menu>) closes on a click outside it or Escape, as a menu does.
  function closeMenus(except) {
    document.querySelectorAll("details[data-menu][open]").forEach(function (d) {
      if (d !== except) d.removeAttribute("open");
    });
  }
  document.addEventListener("click", function (e) {
    closeMenus(e.target.closest && e.target.closest("details[data-menu]"));
  });
  // Search's matches under the box close on a click outside it or Escape, as a menu does.
  function closePeek() {
    var peek = document.getElementById("search-peek");
    // Back to the empty placeholder the next answer swaps: no box, no ring.
    if (peek && peek.firstChild) {
      peek.className = "";
      peek.replaceChildren();
    }
  }
  document.addEventListener("click", function (e) {
    if (!(e.target.closest && e.target.closest("[data-search-form]"))) closePeek();
  });
  // The sidebar as a drawer below lg: the menu button opens it (without this,
  // its #nav link does through :target), Escape or the backdrop closes it.
  var html = document.documentElement;
  function setNav(open) {
    html.classList.toggle("nav-open", open);
    // A modal drawer: the page behind it is out of reach until it closes.
    document.querySelectorAll("[data-nav-inert]").forEach(function (el) { el.inert = open; });
    var button = document.querySelector("[data-nav-open]");
    if (button) button.setAttribute("aria-expanded", String(open));
    if (open) document.querySelector("#nav [data-nav-close]").focus();
    else if (button) button.focus();
  }
  // Widened past lg with the drawer open: the sidebar is simply there, so nothing stays inert.
  window.matchMedia("(min-width: 64rem)").addEventListener("change", function (m) {
    if (!m.matches || !html.classList.contains("nav-open")) return;
    html.classList.remove("nav-open");
    document.querySelectorAll("[data-nav-inert]").forEach(function (el) { el.inert = false; });
  });
  document.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest("[data-nav-open], [data-nav-close]");
    if (!t) return;
    e.preventDefault();
    if (location.hash === "#nav") history.replaceState(null, "", location.pathname + location.search);
    setNav(t.hasAttribute("data-nav-open"));
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      closePeek();
      var open = document.querySelector("details[data-menu][open]");
      if (open) {
        closeMenus(null);
        open.querySelector("summary").focus();
      } else if (html.classList.contains("nav-open")) setNav(false);
      return;
    }
    // "/" searches from anywhere, as GitHub's and Linear's; not while typing.
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.target.closest("input, textarea, select, [contenteditable]")) {
      var search = document.querySelector("[data-search]");
      if (search && search.offsetParent) {
        e.preventDefault();
        search.focus();
      }
    }
  });
  // A filter left at "Any" is not sent, so the address bar reads /customers?stage=lead,
  // not a row of empty parameters.
  document.addEventListener("htmx:configRequest", function (e) {
    if (e.detail.verb !== "get") return;
    var params = e.detail.parameters;
    var keys = typeof params.keys === "function" ? Array.from(params.keys()) : Object.keys(params);
    keys.forEach(function (k) {
      var v = typeof params.get === "function" ? params.get(k) : params[k];
      if (v === "" || v == null) typeof params.delete === "function" ? params.delete(k) : delete params[k];
    });
  });
  // A list's search keeps up as it is used: Clear shows once anything is
  // searched or filtered, and the Filters button on a phone counts the filters in use.
  function searchState(e) {
    var form = e.target.closest && e.target.closest("form[role=search]");
    if (!form) return;
    var used = Array.from(form.querySelectorAll("select")).filter(function (s) { return s.value; }).length;
    var q = form.querySelector("input[name=q]");
    var clear = form.querySelector("[data-clear]");
    if (clear) clear.hidden = !(used || (q && q.value.trim()));
    var summary = form.querySelector("details > summary");
    if (summary) summary.textContent = used ? "Filters (" + used + ")" : "Filters";
  }
  // A picture for a proposal (input[data-resize=1600]) is made at most that
  // many pixels wide, as a JPEG, before it is uploaded: the page carries it
  // whole. Without this the server takes one already small enough.
  document.addEventListener("change", function (e) {
    var input = e.target;
    if (!input.matches || !input.matches("input[type=file][data-resize]") || !input.files || !input.files[0]) return;
    var file = input.files[0], max = Number(input.dataset.resize) || 1600;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || !window.createImageBitmap || !window.DataTransfer) return;
    createImageBitmap(file).then(function (img) {
      var scale = Math.min(1, max / img.width);
      // A small PNG (a logo with a clear background) stays as it is.
      if (scale === 1 && file.size <= 400 * 1024) return;
      var canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        if (!blob) return;
        var dt = new DataTransfer();
        dt.items.add(new File([blob], file.name.replace(/\.[a-z0-9]+$/i, "") + ".jpg", { type: "image/jpeg" }));
        input.files = dt.files;
      }, "image/jpeg", 0.85);
    });
  });
  // A link shown once (data-select-all) is selected when it is clicked, ready to copy.
  document.addEventListener("focusin", function (e) {
    if (e.target.matches && e.target.matches("input[data-select-all]")) e.target.select();
  });
  document.addEventListener("change", searchState);
  document.addEventListener("input", searchState);
  // Home's figures count up once as the page opens, as stat cards do in
  // TailAdmin and Preline: from 0 to the figure in 700ms, easing out. The
  // text the server wrote is what is left at the end; reduced motion, or no
  // JavaScript, shows it straight away.
  function countUp() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    document.querySelectorAll("[data-count]").forEach(function (el) {
      var to = Number(el.dataset.count), done = el.textContent;
      if (!(to > 0)) return;
      var fmt = el.dataset.currency
        ? new Intl.NumberFormat("en-US", { style: "currency", currency: el.dataset.currency, maximumFractionDigits: 0 })
        : new Intl.NumberFormat("en-US");
      var start = performance.now();
      function step(now) {
        var t = Math.min(1, (now - start) / 700);
        el.textContent = t < 1 ? fmt.format(Math.round(to * (1 - Math.pow(1 - t, 3)))) : done;
        if (t < 1) requestAnimationFrame(step);
      }
      el.textContent = fmt.format(0);
      requestAnimationFrame(step);
    });
  }
  document.addEventListener("DOMContentLoaded", countUp);
  document.addEventListener("DOMContentLoaded", showCurrent);
  document.addEventListener("DOMContentLoaded", wire);
  document.addEventListener("htmx:afterSettle", wire);
})();
